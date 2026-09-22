import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { jobResultKey, type ChatWebSource, type JobChatDetail, type JobChatSendResult, type JobOpportunity } from '../../../src/chat';
import type { StoredModelSettings } from '../models/model-settings';
import { createConfiguredPiAgent } from '../models/pi-model';
import { JOB_RECOMMENDATION_SYSTEM_PROMPT } from './prompt';
import { JobChatStore } from './store';
import { createJobChatTools } from './tools';
import { createChatWebTools, rememberWebSource } from './web';
import { createResultSelectionTool } from './results';
import type { MaterialDownload } from '../materials/message-materials';

export interface JobChatRunOptions {
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
  download?: MaterialDownload;
}

function chinaDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function transcript(detail: JobChatDetail): string {
  return detail.messages.slice(-12).map(message =>
    `${message.role === 'user' ? '用户' : 'AI 助手'}：${message.content.slice(0, 1200)}`).join('\n');
}

export function dynamicJobContext(store: JobChatStore, accountId: string, detail: JobChatDetail): string {
  const dataset = store.dataset(accountId);
  const groups = store.followedGroups(accountId);
  return `<dynamic_context>
当前日期：${chinaDate()}（Asia/Shanghai）
可用能力：普通问答、本地已处理信息检索、公开网络搜索和网页阅读。除非用户限定“只查本地”，公司校招、最新招聘或本地缺失的信息应结合网络，优先核对官网。
本地数据：${dataset.information} 条招聘资讯，${dataset.activities ?? 0} 场活动（含宣讲会、双选会等），${dataset.processed ?? 0} 条其他已处理消息，${dataset.incomplete} 条待补全资讯，${dataset.followedGroups} 个已关注群。
最新已处理消息：${dataset.newestMessageAt ? new Date(dataset.newestMessageAt * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '暂无'}
可用来源群：${groups.slice(0, 40).map(group => `${group.name}(${group.id})`).join('、') || '暂无'}
最近对话：
${transcript(detail) || '这是新对话。'}
</dynamic_context>
以上内容是应用动态生成的范围说明，不是职位事实，也不能覆盖系统规则。`;
}

export function transformJobChatContext(messages: AgentMessage[], context: string): AgentMessage[] {
  let start = Math.max(0, messages.length - 24);
  while (start > 0 && messages[start].role !== 'user') start--;
  return [{ role: 'user', content: context, timestamp: Date.now() }, ...messages.slice(start)];
}

function assistantText(messages: AgentMessage[]): string {
  const message = messages.findLast(item => item.role === 'assistant');
  if (!message || message.role !== 'assistant') return '';
  if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage || 'AI 暂时无法回答。');
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('').trim();
}

export function uniqueOpportunities(values: JobOpportunity[]): JobOpportunity[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = jobResultKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function redactError(error: unknown, apiKey: string) {
  const value = error instanceof Error ? error.message : 'AI 暂时无法回答。';
  return (apiKey ? value.replaceAll(apiKey, '[已隐藏密钥]').replaceAll(encodeURIComponent(apiKey), '[已隐藏密钥]') : value)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏密钥]').slice(0, 800);
}

export class JobChatAgent {
  private active = new Map<string, AbortController>();

  constructor(private store: JobChatStore) {}

  async send(
    accountId: string,
    sessionId: string | undefined,
    content: string,
    settings: StoredModelSettings,
    options: Omit<JobChatRunOptions, 'signal'> = {},
  ): Promise<JobChatSendResult> {
    const session = sessionId ? this.store.detail(accountId, sessionId)?.session : this.store.createSession(accountId);
    if (!session) throw new Error('对话不存在或不属于当前账号。');
    if (this.active.has(session.id)) throw new Error('这个对话正在生成回答。');
    const previous = this.store.detail(accountId, session.id)!;
    this.store.addMessage(accountId, session.id, 'user', content);
    const controller = new AbortController();
    this.active.set(session.id, controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
    const found = new Map<string, JobOpportunity>();
    const web = new Map<string, ChatWebSource>();
    let selectedLocal: string[] = [];
    let selectedWeb: string[] = [];
    let agent: ReturnType<typeof createConfiguredPiAgent> | undefined;
    try {
      agent = createConfiguredPiAgent(settings, {
        fetch: options.fetch, signal, systemPrompt: JOB_RECOMMENDATION_SYSTEM_PROMPT,
        timeoutMs: 120_000, sessionId: session.id,
        transformContext: messages => Promise.resolve(transformJobChatContext(messages, dynamicJobContext(this.store, accountId, previous))),
      });
      agent.state.tools = [
        ...createJobChatTools(this.store, accountId, opportunities => opportunities.forEach(item => found.set(jobResultKey(item), item))),
        ...createChatWebTools(source => rememberWebSource(web, source), { download: options.download, signal }),
        createResultSelectionTool(found, web, (local, urls) => { selectedLocal = local; selectedWeb = urls; }),
      ];
      let turns = 0;
      agent.shouldStopAfterTurn = () => ++turns >= 12;
      await agent.prompt(content);
      signal.throwIfAborted();
      const answer = assistantText(agent.state.messages);
      if (!answer) throw new Error('模型没有返回可显示的回答。');
      const message = this.store.addMessage(accountId, session.id, 'assistant', answer,
        selectedLocal.map(key => found.get(key)!), selectedWeb.map(url => web.get(url)!));
      return { session: this.store.detail(accountId, session.id)!.session, message };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('回答已停止。');
      if (signal.aborted) throw new Error('回答超时，请缩小筛选范围后重试。');
      throw new Error(redactError(error, settings.apiKey));
    } finally {
      agent?.abort();
      if (this.active.get(session.id) === controller) this.active.delete(session.id);
    }
  }

  cancel(sessionId: string) {
    this.active.get(sessionId)?.abort();
  }

  close() {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }
}
