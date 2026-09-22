import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Bot, MessageSquare, LoaderCircle, MessageSquarePlus, Send, Settings2, Square, Trash2 } from 'lucide-react';
import type { AppState } from './shared';
import type { JobChatDetail, JobChatMessage, JobChatOverview, JobChatSession } from './chat';
import { bridge, isDesktop } from './bridge';
import common from './App.module.css';
import s from './JobChatPage.module.css';
import { ChatMarkdown } from './chat/ChatMarkdown';
import { ChatResults } from './chat/ChatResults';

const emptyOverview: JobChatOverview = { sessions: [], dataset: { information: 0, incomplete: 0, followedGroups: 0 } };
const suggestions = [
  '帮我看看字节跳动的校招，优先查询招聘官网',
  '筛选工作内容偏数据分析、商业分析的校招机会',
  '查找最近的宣讲会和双选会，列出时间、地点与报名入口',
];
const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试。')
  .replace(/^Error invoking remote method '[^']+': Error: /, '');
const messageTime = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
function MessageItem({ message, onError }: { message: JobChatMessage; onError: (message: string) => void }) {
  // Older saved replies used numbered references. Display their actual stored titles instead.
  const text = message.role === 'assistant' ? message.content.replace(/\[机会\s*(\d+)\]/g, (_match, number) => {
    const item = message.opportunities.find(item => (item as { reference?: number }).reference === Number(number));
    return item?.title ?? '相关信息';
  }) : message.content;
  return <article className={`${s.message} ${message.role === 'user' ? s.userMessage : s.assistantMessage}`}>
    <div className={s.messageIdentity}>
      <span>{message.role === 'user' ? '我' : <Bot size={15} />}</span>
      <strong>{message.role === 'user' ? '你的需求' : 'AI 助手'}</strong>
      <time>{messageTime(message.createdAt)}</time>
    </div>
    <div className={s.messageContent}>{message.role === 'assistant'
      ? <ChatMarkdown text={text} onError={onError} /> : text}</div>
    <ChatResults items={message.opportunities} webSources={message.webSources} />
  </article>;
}

export function JobChatPage({ state, onModels }: { state: AppState; onModels: () => void }) {
  const [overview, setOverview] = useState(emptyOverview);
  const [detail, setDetail] = useState<JobChatDetail | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const selectedId = detail?.session.id;
  const accountId = state.localAccount?.id;
  const requestId = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);

  const loadOverview = useCallback(async (preferredId?: string) => {
    const ticket = ++requestId.current;
    setLoading(true);
    try {
      const next = await bridge.jobChatOverview();
      if (ticket !== requestId.current) return;
      setOverview(next);
      const target = preferredId ?? selectedId ?? next.sessions[0]?.id;
      const nextDetail = target ? await bridge.jobChatSession(target) : null;
      if (ticket !== requestId.current) return;
      setDetail(nextDetail);
      setError('');
    } catch (error) {
      if (ticket === requestId.current) setError(errorText(error));
    } finally {
      if (ticket === requestId.current) setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => { setDetail(null); void loadOverview(); return () => { requestId.current++; }; }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'auto' }));
  }, [detail?.messages.length, sending]);

  const selectSession = async (session: JobChatSession) => {
    const ticket = ++requestId.current;
    setLoading(true); setError('');
    try {
      const value = await bridge.jobChatSession(session.id);
      if (ticket === requestId.current) setDetail(value);
    } catch (error) { if (ticket === requestId.current) setError(errorText(error)); }
    finally { if (ticket === requestId.current) setLoading(false); }
  };
  const removeSession = async (session: JobChatSession) => {
    if (!confirm(`删除对话“${session.title}”？`)) return;
    try {
      await bridge.deleteJobChat(session.id);
      if (selectedId === session.id) setDetail(null);
      await loadOverview();
    } catch (error) { setError(errorText(error)); }
  };
  const send = async (value = draft) => {
    const content = value.trim();
    if (!content || sending) return;
    setSending(true); setError('');
    if (value === draft) setDraft('');
    try {
      const result = await bridge.sendJobChat({ ...(selectedId ? { sessionId: selectedId } : {}), content });
      await loadOverview(result.session.id);
    } catch (error) { setError(errorText(error)); }
    finally { setSending(false); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void send(); };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault(); void send();
    }
  };

  return <section className={s.page} aria-label="助手">
    <aside className={s.sessions} aria-label="求职咨询列表">
      <header><div><h1>AI 求职助手</h1></div>
        <button type="button" className={common.iconButton} title="新建对话" aria-label="新建对话"
          onClick={() => { setDetail(null); setDraft(''); setError(''); }}><MessageSquarePlus size={18} /></button>
      </header>
      <div className={s.dataset}>
        <strong>{overview.dataset.information + overview.dataset.incomplete + (overview.dataset.activities ?? 0) + (overview.dataset.processed ?? 0)}</strong><span>条本地信息</span>
        <small>{overview.dataset.activities ?? 0} 场活动 · {overview.dataset.followedGroups} 个关注群</small>
      </div>
      <div className={s.sessionList}>
        {overview.sessions.map(session => <div key={session.id} className={`${s.sessionRow} ${selectedId === session.id ? s.selectedSession : ''}`}>
          <button type="button" onClick={() => void selectSession(session)}>
            <strong>{session.title}</strong><span>{session.preview || '新的求职咨询'}</span>
          </button>
          <button type="button" className={s.deleteButton} title="删除对话" aria-label={`删除对话：${session.title}`}
            onClick={() => void removeSession(session)}><Trash2 size={14} /></button>
        </div>)}
        {!loading && overview.sessions.length === 0 && <p className={s.noSessions}>还没有求职咨询</p>}
      </div>
      <footer>结合本地已处理信息与公开网络查询。联网时仅搜索公开关键词。</footer>
    </aside>
    <div className={s.conversation}>
      <header className={s.conversationHeader}>
        <div><MessageSquare size={19} /><span><strong>{detail?.session.title ?? '新的求职咨询'}</strong>
          <small>城市、地域、公司性质、工作内容都可以直接描述</small></span></div>
      </header>
      <div className={s.messages} ref={scroller} aria-live="polite" aria-label="聊天记录">
        {loading ? <p className={s.detailState}><LoaderCircle size={20} className={common.spin} />正在读取聊天</p> : !detail?.messages.length ? <div className={s.empty}>
          <span className={s.botMark}><Bot size={27} /></span><h2>说说你在找什么机会</h2>
          <p>可以查招聘官网和本地消息，也可以聊岗位选择、简历和面试。{!accountId && '保存模型配置后即可开始聊天；连接账号后还能查找本地消息。'}</p>
          <div className={s.suggestions}>{suggestions.map(item => <button type="button" key={item} onClick={() => void send(item)}>{item}</button>)}</div>
        </div> : detail.messages.map(message => <MessageItem key={message.id} message={message} onError={setError} />)}
        {sending && <article className={`${s.message} ${s.assistantMessage} ${s.thinking}`}>
          <div className={s.messageIdentity}><span><Bot size={15} /></span><strong>AI 助手</strong></div>
          <p><LoaderCircle size={15} className={common.spin} />正在理解需求并查找相关信息</p>
        </article>}
      </div>
      {error && <div className={s.error} role="alert">{error}{/模型配置/.test(error) && <button type="button" onClick={onModels}><Settings2 size={14} />配置模型</button>}</div>}
      <form className={s.composer} onSubmit={submit}>
        <textarea aria-label="描述求职需求" placeholder="例如：杭州或上海，偏后端开发，希望国企或大型制造业……"
          value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={keyDown} maxLength={4000} rows={3}
          disabled={!isDesktop || sending} />
        <div><span>Enter 发送 · Shift + Enter 换行</span>
          {sending && selectedId ? <button type="button" className={common.secondaryButton} onClick={() => void bridge.cancelJobChat(selectedId)}>
            <Square size={13} fill="currentColor" />停止
          </button> : <button type="submit" className={common.primaryButton} disabled={sending || !draft.trim() || !isDesktop}>
            <Send size={15} />发送
          </button>}
        </div>
      </form>
    </div>
  </section>;
}
