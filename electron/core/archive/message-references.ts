import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Message } from '../../../src/shared';

export const MAX_REFERENCED_MESSAGES = 6;
export function replyIds(message: Message): string[] {
  const ids = message.segments.filter(segment => segment.type === 'reply').map(segment => String(segment.data.id ?? ''));
  if (typeof message.raw.message === 'string') {
    for (const match of message.raw.message.matchAll(/\[CQ:reply,id=(-?\d+)(?:,[^\]]*)?\]/g)) ids.push(match[1]);
  }
  return [...new Set(ids.filter(id => /^-?\d{1,20}$/.test(id)))].slice(0, MAX_REFERENCED_MESSAGES);
}
export interface ReferencedMessage { message: Message; hash: string; relation: 'quoted' | 'related-reply' }
export interface ReferenceGraph {
  references: ReferencedMessage[];
  missing: { fromKey: string; id: string }[];
  warnings: string[];
  hash: string;
}

export function readReferenceGraph(db: DatabaseSync, root: Message): ReferenceGraph {
  const graph: ReferenceGraph = { references: [], missing: [], warnings: [], hash: '' };
  if (!replyIds(root).length) {
    if (root.segments.some(segment => segment.type === 'reply')) graph.warnings.push('引用消息编号无效，未展开引用。');
    graph.hash = graph.warnings.length ? 'invalid-reference' : '';
    return graph;
  }
  const visited = new Set([root.key]);
  const queue = [root];
  while (queue.length && graph.references.length < 4) {
    const from = queue.shift()!;
    if (from.segments.filter(segment => segment.type === 'reply').length > MAX_REFERENCED_MESSAGES
      || from.segments.some(segment => segment.type === 'reply' && !/^-?\d{1,20}$/.test(String(segment.data.id ?? '')))) {
      graph.warnings.push('部分引用编号无效或超出数量上限，未全部展开。');
    }
    for (const id of replyIds(from)) {
      const rows = db.prepare(`SELECT payload,content_hash FROM messages WHERE account_id=? AND group_id=?
        AND CAST(json_extract(payload,'$.externalId') AS TEXT)=? AND time<=? ORDER BY time DESC,key LIMIT 2`)
        .all(root.accountId, root.groupId, id, from.time);
      if (!rows.length) { graph.missing.push({ fromKey: from.key, id }); continue; }
      if (rows.length > 1) { graph.warnings.push('同群存在重复的引用编号，未自动配对。'); continue; }
      const message: Message = JSON.parse(String(rows[0].payload));
      if (visited.has(message.key)) {
        if (message.key === root.key || replyIds(message).includes(from.externalId)) graph.warnings.push('引用形成循环，已停止展开。');
        continue;
      }
      if (graph.references.length >= 4) { graph.warnings.push('引用链超过 4 条，后续引用未展开。'); break; }
      visited.add(message.key);
      graph.references.push({ message, hash: String(rows[0].content_hash), relation: 'quoted' });
      queue.push(message);
    }
  }
  if (queue.some(message => replyIds(message).length)) graph.warnings.push('引用链达到 4 条上限，后续引用未展开。');
  // Nearby sibling replies share an explicit target. Mere adjacency never grants relevance.
  const targets = new Set(graph.references.map(reference => reference.message.externalId));
  if (targets.size) {
    const recent = db.prepare(`SELECT payload,content_hash FROM messages WHERE account_id=? AND group_id=?
      AND (time<? OR (time=? AND key<?)) ORDER BY time DESC,key DESC LIMIT 30`)
      .all(root.accountId, root.groupId, root.time, root.time, root.key);
    for (const row of recent) {
      const message: Message = JSON.parse(String(row.payload));
      if (visited.has(message.key) || !replyIds(message).some(id => targets.has(id))) continue;
      visited.add(message.key);
      graph.references.push({ message, hash: String(row.content_hash), relation: 'related-reply' });
      if (graph.references.length >= MAX_REFERENCED_MESSAGES || graph.references.filter(reference => reference.relation === 'related-reply').length >= 2) break;
    }
  }
  graph.warnings = [...new Set(graph.warnings)];
  graph.hash = createHash('sha256').update(JSON.stringify([
    graph.references.map(reference => [reference.message.key, reference.hash, reference.relation]), graph.missing, graph.warnings,
  ])).digest('hex');
  return graph;
}

export interface ReplyRequest { type: 'resolveReply'; accountId: string; messageKey: string; replyId: string }
