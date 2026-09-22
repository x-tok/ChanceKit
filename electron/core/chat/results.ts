import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { jobResultKey, type ChatWebSource, type JobOpportunity, type JobResultRef } from '../../../src/chat';

export function createResultSelectionTool(
  local: Map<string, JobOpportunity>,
  web: Map<string, ChatWebSource>,
  select: (localKeys: string[], webUrls: string[]) => void,
): AgentTool {
  return {
    name: 'select_chat_results', label: '整理相关信息',
    description: 'Choose the sources relevant to your final answer for clickable cards. Call before answering whenever you found useful sources. Only select results already returned by tools in this run. Do not include exploratory results for unrelated companies. Empty arrays clear cards. Each call replaces the selection. Use all relevant results, not just the first four; the UI handles overflow.',
    parameters: Type.Object({
      localResults: Type.Array(Type.Object({
        messageKey: Type.String({ pattern: '^[a-f0-9]{64}$' }),
        activityId: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
      }, { additionalProperties: false }), { maxItems: 200 }),
      webUrls: Type.Array(Type.String({ maxLength: 2048 }), { maxItems: 40 }),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_id, raw) {
      const input = raw as { localResults: JobResultRef[]; webUrls: string[] };
      const keys = [...new Set(input.localResults.map(jobResultKey))];
      const urls = [...new Set(input.webUrls)];
      if (keys.some(key => !local.has(key)) || urls.some(url => !web.has(url))) throw new Error('只能展示本轮工具已返回的来源，请复制原始标识或网址。');
      select(keys, urls);
      return { content: [{ type: 'text', text: `已选择 ${keys.length} 条本地信息和 ${urls.length} 条网络来源。请给出回答并引用来源的真实标题。` }], details: {} };
    },
  };
}
