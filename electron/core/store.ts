import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { Account, Group, Message, MessagePage, Segment } from '../../src/shared';

const textOf = (segments: Segment[]) => segments.map(segment => {
  if (segment.type === 'text') return String(segment.data.text ?? '');
  if (segment.type === 'at') return `@${segment.data.qq ?? ''}`;
  return `[${({ image: '图片', file: '文件', video: '视频', record: '语音', forward: '合并转发', reply: '引用', json: '卡片', face: '表情' } as Record<string, string>)[segment.type] ?? segment.type}]`;
}).join('');

export function normalizeMessage(raw: Record<string, any>, accountId: string, groupId?: string): Message {
  const segments: Segment[] = Array.isArray(raw.message)
    ? raw.message.filter((item: any) => item && typeof item.type === 'string').map((item: any) => ({ type: item.type, data: item.data && typeof item.data === 'object' ? item.data : {} }))
    : [{ type: 'text', data: { text: String(raw.message ?? raw.raw_message ?? '') } }];
  const externalId = String(raw.message_id ?? raw.message_seq ?? '');
  const realSeq = /^[1-9]\d*$/.test(String(raw.real_seq)) ? String(raw.real_seq) : undefined;
  const senderId = String(raw.sender?.user_id ?? raw.user_id ?? '');
  const time = Number(raw.time) || 0;
  const conversation = String(raw.group_id ?? groupId ?? '');
  const semantic = segments.map(s => [s.type, s.type === 'image' ? String(s.data.file ?? s.data.file_id ?? '') : s.data]);
  const fingerprint = createHash('sha256').update(JSON.stringify([senderId, time, semantic])).digest('hex');
  const identity = realSeq ? `seq:${realSeq}` : `id:${externalId}:${fingerprint}`;
  const key = createHash('sha256').update(JSON.stringify([accountId, conversation, identity])).digest('hex');
  return {
    key, accountId, groupId: conversation, externalId, realSeq, senderId,
    senderName: String(raw.sender?.card || raw.sender?.nickname || senderId || '未知发送者'),
    time, segments, text: textOf(segments), raw, receivedAt: Date.now(),
  };
}

export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, nickname TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS groups (account_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, members INTEGER NOT NULL, max_members INTEGER NOT NULL, followed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account_id, id));
      CREATE TABLE IF NOT EXISTS messages (key TEXT PRIMARY KEY, account_id TEXT NOT NULL, group_id TEXT NOT NULL, time INTEGER NOT NULL, text TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_group_time ON messages(account_id, group_id, time DESC, key DESC);
      PRAGMA user_version=1;`);
  }
  saveAccount(account: Account) {
    this.db.prepare('INSERT INTO accounts VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET nickname=excluded.nickname, updated=excluded.updated').run(account.id, account.nickname, Date.now());
  }
  lastAccount(): Account | undefined {
    return this.db.prepare('SELECT id, nickname FROM accounts ORDER BY updated DESC LIMIT 1').get() as Account | undefined;
  }
  saveGroups(accountId: string, raw: any[]) {
    const insert = this.db.prepare('INSERT INTO groups(account_id,id,name,members,max_members) VALUES (?,?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET name=excluded.name,members=excluded.members,max_members=excluded.max_members');
    this.transaction(() => {
      for (const group of raw) insert.run(accountId, String(group.group_id), String(group.group_name || group.group_id), Number(group.member_count) || 0, Number(group.max_member_count) || 0);
      // Keep archived groups so a departed group remains readable locally.
    });
  }
  groups(accountId: string): Group[] {
    return (this.db.prepare(`SELECT g.*, (SELECT count(*) FROM messages m WHERE m.account_id=g.account_id AND m.group_id=g.id) AS message_count FROM groups g WHERE account_id=? ORDER BY followed DESC, name`).all(accountId) as any[])
      .map(g => ({ id: g.id, name: g.name, memberCount: g.members, maxMembers: g.max_members, followed: Boolean(g.followed), messageCount: g.message_count }));
  }
  follow(accountId: string, groupId: string, followed: boolean) {
    this.db.prepare('UPDATE groups SET followed=? WHERE account_id=? AND id=?').run(Number(followed), accountId, groupId);
  }
  put(messages: Message[]): number {
    const insert = this.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET text=excluded.text, payload=excluded.payload');
    const exists = this.db.prepare('SELECT 1 FROM messages WHERE key=?');
    let added = 0;
    this.transaction(() => {
      for (const message of messages) {
        if (!exists.get(message.key)) added++;
        insert.run(message.key, message.accountId, message.groupId, message.time, message.text, JSON.stringify(message));
      }
    });
    return added;
  }
  messages(accountId: string, groupId: string, search = '', offset = 0): MessagePage {
    const where = 'account_id=? AND group_id=? AND instr(lower(text), lower(?))>0';
    const total = (this.db.prepare(`SELECT count(*) AS n FROM messages WHERE ${where}`).get(accountId, groupId, search) as any).n;
    const rows = this.db.prepare(`SELECT payload FROM messages WHERE ${where} ORDER BY time DESC, key DESC LIMIT 100 OFFSET ?`).all(accountId, groupId, search, offset) as any[];
    return { messages: rows.map(row => JSON.parse(row.payload)).reverse(), total, hasMore: offset + rows.length < total };
  }
  *export(accountId: string, groupId: string): Generator<Message> {
    for (const row of this.db.prepare('SELECT payload FROM messages WHERE account_id=? AND group_id=? ORDER BY time,key').iterate(accountId, groupId)) yield JSON.parse(String(row.payload));
  }
  count(accountId: string): number { return Number(this.db.prepare('SELECT count(*) AS n FROM messages WHERE account_id=?').get(accountId)?.n ?? 0); }
  private transaction(callback: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try { callback(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
