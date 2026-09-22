import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { jobResultKey, type ChatWebSource, type JobChatDataset, type JobChatDetail, type JobChatMessage, type JobChatSession, type JobOpportunity, type JobResultDetail, type JobResultRef } from '../../../src/chat';
import type { ActivityInput, ActivitySource } from '../../../src/schedule';

export interface OpportunityFilters {
  keywords?: string[];
  cities?: string[];
  regions?: string[];
  companies?: string[];
  companyTypes?: string[];
  workContents?: string[];
  groupIds?: string[];
  postedAfter?: string;
  postedBefore?: string;
  includeIncomplete?: boolean;
  offset?: number;
  limit?: number;
}

interface OpportunityRow extends Record<string, unknown> {
  result_id: string; message_key: string; activity_id: string | null;
  title: string; summary: string; category: JobOpportunity['category'];
  materials: string; group_id: string; group_name: string; time: number;
  text: string; sender_name: string; activity: string | null;
  diagnostics: string; related_messages: string; review_reasons: string;
}

// Each candidate retains a current, followed source. No calendar window or extraction-version cutoff.
const candidates = `WITH eligible AS (
  SELECT m.*,g.name group_name,j.status,j.diagnostics,j.error
  FROM messages m JOIN groups g ON g.account_id=m.account_id AND g.id=m.group_id
  JOIN schedule_jobs j ON j.message_key=m.key AND j.input_hash=m.content_hash
  WHERE m.account_id=? AND g.followed=1
), current_activities AS (
  SELECT s.activity_id,s.message_key,s.payload FROM activity_sources s
  JOIN activities a ON a.id=s.activity_id
  JOIN eligible m ON m.key=s.message_key AND a.account_id=m.account_id
    AND json_extract(s.payload,'$.inputHash')=m.content_hash
), candidates AS (
  SELECT 'activity:' || s.activity_id result_id,s.activity_id,m.key message_key,
    json_extract(s.payload,'$.activity.title') title,
    coalesce(json_extract(s.payload,'$.activity.description'),'') summary,'activity' category,
    coalesce(json_extract(s.payload,'$.materials'),'[]') materials,
    m.group_id,m.group_name,m.time,m.text,json_extract(m.payload,'$.senderName') sender_name,
    json_extract(s.payload,'$.activity') activity,
    coalesce(json_extract(s.payload,'$.warnings'),'[]') diagnostics,
    coalesce(json_extract(s.payload,'$.relatedMessages'),'[]') related_messages,
    coalesce(json_extract(s.payload,'$.reviewReasons'),'[]') review_reasons
  FROM current_activities s JOIN eligible m ON m.key=s.message_key
  UNION ALL
  SELECT 'message:' || m.key,NULL,m.key,i.title,i.summary,i.category,i.materials,
    m.group_id,m.group_name,m.time,m.text,json_extract(m.payload,'$.senderName'),NULL,
    m.diagnostics,i.related_messages,json_array(m.error)
  FROM recruiting_information i JOIN eligible m ON m.key=i.message_key AND m.content_hash=i.input_hash
  UNION ALL
  SELECT 'message:' || m.key,NULL,m.key,
    CASE WHEN trim(m.text)='' THEN '已处理消息' ELSE substr(trim(m.text),1,100) END,
    substr(m.text,1,500),'processed','[]',m.group_id,m.group_name,m.time,m.text,
    json_extract(m.payload,'$.senderName'),NULL,m.diagnostics,'[]',json_array(m.error)
  FROM eligible m WHERE m.status IN ('completed','partial')
    AND NOT EXISTS(SELECT 1 FROM recruiting_information i WHERE i.message_key=m.key AND i.input_hash=m.content_hash)
    AND NOT EXISTS(SELECT 1 FROM current_activities s WHERE s.message_key=m.key)
)`;
const searchable = "lower(title || ' ' || summary || ' ' || text || ' ' || materials || ' ' || group_name || ' ' || coalesce(activity,'') || ' ' || related_messages)";

function sessionFrom(row: Record<string, unknown>): JobChatSession {
  return {
    id: String(row.id), title: String(row.title), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    preview: String(row.preview ?? ''),
  };
}

function messageFrom(row: Record<string, unknown>): JobChatMessage {
  let opportunities: JobOpportunity[] = [];
  let webSources: ChatWebSource[] = [];
  try { opportunities = JSON.parse(String(row.opportunities)); } catch {}
  try { webSources = JSON.parse(String(row.web_sources ?? '[]')); } catch {}
  return {
    id: String(row.id), role: row.role as JobChatMessage['role'], content: String(row.content),
    createdAt: Number(row.created_at), opportunities, webSources,
  };
}

function terms(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))].slice(0, 12);
}

function materialUrl(raw: string): string | undefined {
  try {
    const materials = JSON.parse(raw) as { url?: string; kind?: string }[];
    return materials.find(item => item.kind === 'page' && /^https?:\/\//.test(item.url ?? ''))?.url;
  } catch { return undefined; }
}

function matchedTerms(row: OpportunityRow, filters: OpportunityFilters): string[] {
  const source = `${row.title} ${row.summary} ${row.text} ${row.materials} ${row.group_name} ${row.activity ?? ''} ${row.related_messages}`.toLowerCase();
  return [...new Set([
    ...terms(filters.cities), ...terms(filters.regions), ...terms(filters.companies), ...terms(filters.companyTypes),
    ...terms(filters.workContents), ...terms(filters.keywords),
  ].filter(value => source.includes(value.toLowerCase())))];
}

function opportunityFrom(row: OpportunityRow, filters: OpportunityFilters): JobOpportunity {
  const activity: ActivityInput | undefined = row.activity ? JSON.parse(row.activity) : undefined;
  return {
    activityId: row.activity_id ?? undefined, activityType: activity?.type, startDate: activity?.startDate, location: activity?.location,
    messageKey: row.message_key, title: row.title, summary: row.summary, groupId: row.group_id,
    groupName: row.group_name, messageTime: Number(row.time), category: row.category,
    matchedBy: matchedTerms(row, filters), sourceUrl: materialUrl(row.materials),
  };
}

export class JobChatStore {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS job_chat_sessions (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, title TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS job_chat_sessions_account_updated ON job_chat_sessions(account_id,updated_at DESC);
      CREATE TABLE IF NOT EXISTS job_chat_messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES job_chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
        opportunities TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS job_chat_messages_session_created ON job_chat_messages(session_id,created_at,id);
    `);
    if (!this.db.prepare('PRAGMA table_info(job_chat_messages)').all().some(column => column.name === 'web_sources')) {
      this.db.exec("ALTER TABLE job_chat_messages ADD COLUMN web_sources TEXT NOT NULL DEFAULT '[]'");
    }
  }

  overview(accountId: string): { sessions: JobChatSession[]; dataset: JobChatDataset } {
    const sessions = this.db.prepare(`SELECT s.*,
      COALESCE((SELECT content FROM job_chat_messages WHERE session_id=s.id ORDER BY created_at DESC,rowid DESC LIMIT 1),'') preview
      FROM job_chat_sessions s WHERE account_id=? ORDER BY updated_at DESC LIMIT 60`).all(accountId).map(sessionFrom);
    return { sessions, dataset: this.dataset(accountId) };
  }

  dataset(accountId: string): JobChatDataset {
    const counts = { information: 0, incomplete: 0, activities: 0, processed: 0 };
    let newestMessageAt: number | undefined;
    for (const row of this.db.prepare(`${candidates} SELECT category,count(DISTINCT result_id) n,max(time) newest
      FROM candidates GROUP BY category`).all(accountId)) {
      const key = row.category === 'activity' ? 'activities' : String(row.category) as keyof typeof counts;
      counts[key] = Number(row.n);
      newestMessageAt = Math.max(newestMessageAt ?? 0, Number(row.newest));
    }
    const groups = this.db.prepare('SELECT count(*) n FROM groups WHERE account_id=? AND followed=1').get(accountId);
    return { ...counts, followedGroups: Number(groups?.n ?? 0), newestMessageAt };
  }

  followedGroups(accountId: string): { id: string; name: string }[] {
    return this.db.prepare('SELECT id,name FROM groups WHERE account_id=? AND followed=1 ORDER BY name').all(accountId)
      .map(row => ({ id: String(row.id), name: String(row.name) }));
  }

  createSession(accountId: string, title = '新的求职咨询'): JobChatSession {
    const now = Date.now();
    const session = { id: randomUUID(), title, createdAt: now, updatedAt: now, preview: '' };
    this.db.prepare('INSERT INTO job_chat_sessions(id,account_id,title,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(session.id, accountId, title, now, now);
    return session;
  }

  detail(accountId: string, sessionId: string): JobChatDetail | null {
    const row = this.db.prepare(`SELECT s.*,
      COALESCE((SELECT content FROM job_chat_messages WHERE session_id=s.id ORDER BY created_at DESC,rowid DESC LIMIT 1),'') preview
      FROM job_chat_sessions s WHERE account_id=? AND id=?`).get(accountId, sessionId);
    if (!row) return null;
    const messages = this.db.prepare('SELECT * FROM job_chat_messages WHERE session_id=? ORDER BY created_at,rowid').all(sessionId).map(messageFrom);
    return { session: sessionFrom(row), messages };
  }

  addMessage(accountId: string, sessionId: string, role: JobChatMessage['role'], content: string, opportunities: JobOpportunity[] = [], webSources: ChatWebSource[] = []): JobChatMessage {
    const session = this.db.prepare('SELECT id,title FROM job_chat_sessions WHERE account_id=? AND id=?').get(accountId, sessionId);
    if (!session) throw new Error('对话不存在或不属于当前账号。');
    const message: JobChatMessage = { id: randomUUID(), role, content, createdAt: Date.now(), opportunities, webSources };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO job_chat_messages(id,session_id,role,content,opportunities,created_at,web_sources) VALUES(?,?,?,?,?,?,?)')
        .run(message.id, sessionId, role, content, JSON.stringify(opportunities), message.createdAt, JSON.stringify(webSources));
      const title = role === 'user' && String(session.title) === '新的求职咨询'
        ? content.replace(/\s+/g, ' ').trim().slice(0, 28) || '新的求职咨询' : String(session.title);
      this.db.prepare('UPDATE job_chat_sessions SET title=?,updated_at=? WHERE id=?').run(title, message.createdAt, sessionId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return message;
  }

  deleteSession(accountId: string, sessionId: string): boolean {
    return this.db.prepare('DELETE FROM job_chat_sessions WHERE account_id=? AND id=?').run(accountId, sessionId).changes > 0;
  }

  search(accountId: string, filters: OpportunityFilters): JobOpportunity[] {
    const where = ['1=1'];
    const args: SQLInputValue[] = [accountId];
    // Include every processed category by default; the caller may explicitly exclude incomplete records.
    if (filters.includeIncomplete === false) where.push("category<>'incomplete'");
    const categories = ['keywords', 'cities', 'regions', 'companies', 'companyTypes', 'workContents'] as const;
    for (const category of categories) {
      const values = terms(filters[category]);
      if (!values.length) continue;
      where.push(`(${values.map(() => `instr(${searchable},lower(?))>0`).join(' OR ')})`);
      args.push(...values);
    }
    const groupIds = terms(filters.groupIds);
    if (groupIds.length) {
      where.push(`group_id IN (${groupIds.map(() => '?').join(',')})`);
      args.push(...groupIds);
    }
    if (filters.postedAfter) { where.push('time>=unixepoch(?)'); args.push(`${filters.postedAfter}T00:00:00+08:00`); }
    if (filters.postedBefore) { where.push("time<unixepoch(?,'+1 day')"); args.push(`${filters.postedBefore}T00:00:00+08:00`); }
    const limit = Math.min(20, Math.max(1, filters.limit ?? 10));
    const offset = Math.min(1_000_000, Math.max(0, filters.offset ?? 0));
    const rows = this.db.prepare(`${candidates}, ranked AS (
      SELECT *,row_number() OVER(PARTITION BY result_id ORDER BY time DESC,message_key DESC) rank
      FROM candidates WHERE ${where.join(' AND ')}
    ) SELECT * FROM ranked WHERE rank=1 ORDER BY time DESC,result_id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as OpportunityRow[];
    return rows.map(row => opportunityFrom(row, filters));
  }

  resultDetail(accountId: string, ref: JobResultRef): JobResultDetail | null {
    const rows = this.db.prepare(`${candidates} SELECT * FROM candidates WHERE result_id=?
      ORDER BY time DESC,message_key DESC`).all(accountId, jobResultKey(ref)) as OpportunityRow[];
    if (!rows.length) return null;
    const row = rows[0];
    const sources: ActivitySource[] = rows.map(source => {
      const activity: ActivityInput | undefined = source.activity ? JSON.parse(source.activity) : undefined;
      return {
        messageKey: source.message_key, groupId: source.group_id, groupName: source.group_name,
        senderName: source.sender_name, messageTime: Number(source.time), text: source.text,
        evidence: activity?.evidence ?? '', materials: JSON.parse(source.materials),
        warnings: JSON.parse(source.diagnostics), reviewReasons: JSON.parse(source.review_reasons).filter(Boolean),
        relatedMessages: JSON.parse(source.related_messages),
      };
    });
    return { item: opportunityFrom(row, {}), activity: row.activity ? JSON.parse(row.activity) : undefined, sources };
  }

  details(accountId: string, references: JobResultRef[]): JobResultDetail[] {
    return references.slice(0, 6).flatMap(ref => {
      const detail = this.resultDetail(accountId, ref);
      return detail ? [detail] : [];
    });
  }

  close() { this.db.close(); }
}
