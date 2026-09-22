import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Message } from '../../../../../src/shared';
import { emptyProcessingStatus, scheduleProcessingVersion, type ActivityInput, type ActivitySource, type ProcessingDetailsPage, type ProcessingDetailsQuery, type ProcessingMessageBucket, type ProcessingMessageItem, type ProcessingMessageState, type ProcessingStatus } from '../../../../../src/schedule';
import { activitySchema } from '../../activity-schema';
import { activityIdentity, mergeActivityFacts, sameRecruitingEvent } from '../dedupe';
import type { DailyExtractionResult, DailyMessageSource, DailyProcessingJob } from '../types';
import { readReferenceGraph } from '../../../archive/message-references';

interface MessageRow {
  key: string;
  content_hash: string;
  payload: string;
  name: string;
  time: number;
}

export function beijingSourceDay(unixSeconds: number): string {
  return new Date((unixSeconds + 8 * 60 * 60) * 1000).toISOString().slice(0, 10);
}

function dayRange(day: string): [number, number] {
  const start = Date.parse(`${day}T00:00:00+08:00`) / 1000;
  return [start, start + 24 * 60 * 60];
}

const severeWarnings = (warnings: string[]) => warnings.filter(warning => /未读取|未展开|不支持|缺少可读取|无法辨认|读取失败|内容可能不完整|需核对原图/.test(warning));

export class DailyScheduleStore {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS schedule_settings (
        account_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, concurrency INTEGER NOT NULL DEFAULT 3,
        stop_when_idle INTEGER NOT NULL DEFAULT 0, since INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS schedule_daily_jobs (
        account_id TEXT NOT NULL, source_day TEXT NOT NULL, input_hash TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '', diagnostics TEXT NOT NULL DEFAULT '[]',
        processing_version INTEGER NOT NULL DEFAULT 0, output_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL,
        PRIMARY KEY(account_id,source_day)
      );
      CREATE INDEX IF NOT EXISTS schedule_daily_jobs_ready ON schedule_daily_jobs(account_id,status,available_at,source_day);
      CREATE TABLE IF NOT EXISTS schedule_jobs (
        message_key TEXT PRIMARY KEY REFERENCES messages(key), input_hash TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
        diagnostics TEXT NOT NULL DEFAULT '[]', references_hash TEXT NOT NULL DEFAULT '', processing_version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, start_date TEXT, end_date TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity_sources (
        activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        message_key TEXT NOT NULL REFERENCES messages(key), payload TEXT NOT NULL,
        PRIMARY KEY(activity_id,message_key)
      );
      CREATE TABLE IF NOT EXISTS activity_canonical (
        activity_id TEXT PRIMARY KEY REFERENCES activities(id) ON DELETE CASCADE, payload TEXT NOT NULL
      );
    `);
    const settingColumns = this.db.prepare('PRAGMA table_info(schedule_settings)').all().map(row => String(row.name));
    if (!settingColumns.includes('stop_when_idle')) {
      this.db.exec('ALTER TABLE schedule_settings ADD COLUMN stop_when_idle INTEGER NOT NULL DEFAULT 0');
    }
    if (!settingColumns.includes('since')) {
      this.db.exec('ALTER TABLE schedule_settings ADD COLUMN since INTEGER NOT NULL DEFAULT 0');
    }
    const jobColumns = this.db.prepare('PRAGMA table_info(schedule_daily_jobs)').all().map(row => String(row.name));
    if (!jobColumns.includes('output_json')) {
      this.db.exec("ALTER TABLE schedule_daily_jobs ADD COLUMN output_json TEXT NOT NULL DEFAULT '[]'");
    }
    // A one-time sync must never resume API requests after an application restart.
    this.db.prepare('UPDATE schedule_settings SET enabled=0,stop_when_idle=0 WHERE enabled<>0 OR stop_when_idle<>0').run();
    this.db.prepare("UPDATE schedule_daily_jobs SET status='pending',attempts=max(0,attempts-1) WHERE status='running'").run();
  }

  settings(accountId: string): { enabled: boolean; concurrency: number; stopWhenIdle: boolean; since: number } {
    const row = this.db.prepare('SELECT enabled,concurrency,stop_when_idle,since FROM schedule_settings WHERE account_id=?').get(accountId);
    return {
      enabled: Boolean(row?.enabled), concurrency: Number(row?.concurrency ?? 3),
      stopWhenIdle: Boolean(row?.stop_when_idle), since: Number(row?.since ?? 0),
    };
  }

  configure(accountId: string, value: { enabled: boolean; concurrency: number; stopWhenIdle?: boolean; since?: number }) {
    const since = value.since ?? this.settings(accountId).since;
    this.db.prepare(`INSERT INTO schedule_settings(account_id,enabled,concurrency,stop_when_idle,since) VALUES(?,?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET enabled=excluded.enabled,concurrency=excluded.concurrency,
      stop_when_idle=excluded.stop_when_idle,since=excluded.since`)
      .run(accountId, Number(value.enabled), value.concurrency, Number(Boolean(value.enabled && value.stopWhenIdle)), since);
  }

  stopWhenIdle(accountId: string): boolean {
    const active = Number(this.db.prepare(`SELECT count(*) AS n FROM schedule_daily_jobs
      WHERE account_id=? AND status IN ('pending','running')`).get(accountId)?.n ?? 0);
    if (active || !this.settings(accountId).stopWhenIdle) return false;
    return Boolean(this.db.prepare(`UPDATE schedule_settings SET enabled=0,stop_when_idle=0
      WHERE account_id=? AND enabled=1 AND stop_when_idle=1`).run(accountId).changes);
  }

  private rows(accountId: string, day?: string): MessageRow[] {
    const args: (string | number)[] = [accountId, this.settings(accountId).since];
    let time = '';
    if (day) {
      const [start, end] = dayRange(day);
      time = 'AND m.time>=? AND m.time<?';
      args.push(start, end);
    }
    return this.db.prepare(`SELECT m.key,m.content_hash,m.payload,m.time,g.name FROM messages m
      JOIN groups g ON g.account_id=m.account_id AND g.id=m.group_id
      WHERE m.account_id=? AND g.followed=1 AND m.time>=? ${time} ORDER BY m.time,m.key`).all(...args) as unknown as MessageRow[];
  }

  private hashRows(rows: MessageRow[]): string {
    return createHash('sha256').update(JSON.stringify(rows.map(row => {
      const message = JSON.parse(String(row.payload)) as Message;
      return [row.key, row.content_hash, row.name, readReferenceGraph(this.db, message).hash];
    }))).digest('hex');
  }

  enqueue(accountId: string) {
    const byDay = new Map<string, MessageRow[]>();
    for (const row of this.rows(accountId)) {
      const day = beijingSourceDay(Number(row.time));
      const values = byDay.get(day) ?? [];
      values.push(row);
      byDay.set(day, values);
    }
    const now = Date.now();
    this.transaction(() => {
      for (const [day, rows] of byDay) {
        const hash = this.hashRows(rows);
        this.db.prepare(`INSERT INTO schedule_daily_jobs(account_id,source_day,input_hash,status,updated_at,processing_version)
          VALUES(?,?,?,'pending',?,?) ON CONFLICT(account_id,source_day) DO UPDATE SET
          input_hash=excluded.input_hash,status='pending',attempts=0,available_at=0,error='',diagnostics='[]',updated_at=excluded.updated_at,
          processing_version=excluded.processing_version,output_json='[]'
          WHERE schedule_daily_jobs.input_hash<>excluded.input_hash
            OR (schedule_daily_jobs.processing_version<excluded.processing_version AND schedule_daily_jobs.status IN ('partial','failed'))`)
          .run(accountId, day, hash, now, scheduleProcessingVersion);
        for (const row of rows) this.db.prepare(`INSERT INTO schedule_jobs(message_key,input_hash,status,updated_at,processing_version)
          VALUES(?,?,'pending',?,?) ON CONFLICT(message_key) DO UPDATE SET input_hash=excluded.input_hash,status='pending',attempts=0,
          available_at=0,error='',updated_at=excluded.updated_at,processing_version=excluded.processing_version
          WHERE schedule_jobs.input_hash<>excluded.input_hash`).run(row.key, row.content_hash, now, scheduleProcessingVersion);
      }
      const activeDays = [...byDay.keys()];
      if (activeDays.length) {
        this.db.prepare(`DELETE FROM schedule_daily_jobs WHERE account_id=? AND source_day NOT IN (${activeDays.map(() => '?').join(',')})`)
          .run(accountId, ...activeDays);
      } else this.db.prepare('DELETE FROM schedule_daily_jobs WHERE account_id=?').run(accountId);
    });
  }

  claim(accountId: string, now = Date.now()): DailyProcessingJob | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM schedule_daily_jobs WHERE account_id=? AND status='pending' AND available_at<=?
        ORDER BY source_day LIMIT 1`).get(accountId, now);
      if (!row) return;
      const sourceDay = String(row.source_day);
      const rows = this.rows(accountId, sourceDay);
      if (!rows.length || this.hashRows(rows) !== String(row.input_hash)) return;
      const updated = this.db.prepare(`UPDATE schedule_daily_jobs SET status='running',attempts=attempts+1,updated_at=?,processing_version=?
        WHERE account_id=? AND source_day=? AND status='pending'`).run(now, scheduleProcessingVersion, accountId, sourceDay);
      if (!updated.changes) return;
      const messages: DailyMessageSource[] = rows.map((item, index) => {
        const message = JSON.parse(String(item.payload)) as Message;
        return {
        ref: index + 1, message,
        contentHash: String(item.content_hash),
        groupName: String(item.name),
        referenceGraph: readReferenceGraph(this.db, message),
      }});
      return {
        key: `${accountId}:${sourceDay}`, accountId, sourceDay, messages,
        hash: String(row.input_hash), attempts: Number(row.attempts) + 1,
      };
    });
  }

  isCurrent(job: DailyProcessingJob): boolean {
    const row = this.db.prepare(`SELECT input_hash,status FROM schedule_daily_jobs WHERE account_id=? AND source_day=?`)
      .get(job.accountId, job.sourceDay);
    return Boolean(row && row.status === 'running' && row.input_hash === job.hash && this.hashRows(this.rows(job.accountId, job.sourceDay)) === job.hash);
  }

  refreshReferences(job: DailyProcessingJob): boolean {
    const row = this.db.prepare(`SELECT input_hash,status FROM schedule_daily_jobs WHERE account_id=? AND source_day=?`)
      .get(job.accountId, job.sourceDay);
    if (!row || row.status !== 'running' || row.input_hash !== job.hash) return false;
    const rows = this.rows(job.accountId, job.sourceDay);
    const hash = this.hashRows(rows);
    const byKey = new Map(job.messages.map(source => [source.message.key, source]));
    for (const item of rows) {
      const source = byKey.get(String(item.key));
      if (source) source.referenceGraph = readReferenceGraph(this.db, source.message);
    }
    this.db.prepare(`UPDATE schedule_daily_jobs SET input_hash=? WHERE account_id=? AND source_day=? AND input_hash=? AND status='running'`)
      .run(hash, job.accountId, job.sourceDay, job.hash);
    job.hash = hash;
    return true;
  }

  release(job: DailyProcessingJob) {
    this.db.prepare(`UPDATE schedule_daily_jobs SET status='pending',attempts=max(0,attempts-1),available_at=0
      WHERE account_id=? AND source_day=? AND input_hash=? AND status='running'`).run(job.accountId, job.sourceDay, job.hash);
  }

  fail(job: DailyProcessingJob, error: string, now = Date.now()) {
    const status = job.attempts >= 3 ? 'failed' : 'pending';
    this.transaction(() => {
      const updated = this.db.prepare(`UPDATE schedule_daily_jobs SET status=?,error=?,available_at=?,updated_at=?
        WHERE account_id=? AND source_day=? AND input_hash=? AND status='running'`)
        .run(status, error.slice(0, 800), now + 5000 * 2 ** (job.attempts - 1), now, job.accountId, job.sourceDay, job.hash);
      if (updated.changes) for (const source of job.messages) this.db.prepare(`UPDATE schedule_jobs SET status=?,error=?,updated_at=? WHERE message_key=?`)
        .run(status, error.slice(0, 800), now, source.message.key);
    });
  }

  retry(accountId: string, messageKey?: string) {
    let day: string | undefined;
    if (messageKey) {
      const row = this.db.prepare('SELECT time FROM messages WHERE account_id=? AND key=?').get(accountId, messageKey);
      if (row) day = beijingSourceDay(Number(row.time));
    }
    this.transaction(() => {
      this.db.prepare(`UPDATE schedule_daily_jobs SET status='pending',attempts=0,error='',available_at=0
        WHERE account_id=? AND status IN ('failed','partial') ${day ? 'AND source_day=?' : ''}`).run(accountId, ...(day ? [day] : []));
      if (day) {
        for (const row of this.rows(accountId, day)) this.db.prepare(`UPDATE schedule_jobs SET status='pending',attempts=0,error='',available_at=0
          WHERE message_key=? AND status IN ('failed','partial')`).run(row.key);
      } else {
        this.db.prepare(`UPDATE schedule_jobs SET status='pending',attempts=0,error='',available_at=0 WHERE status IN ('failed','partial')
          AND message_key IN (SELECT m.key FROM messages m JOIN groups g ON g.account_id=m.account_id AND g.id=m.group_id
            WHERE m.account_id=? AND g.followed=1)`).run(accountId);
      }
    });
  }

  private canonical(id: string): ActivityInput | undefined {
    const row = this.db.prepare('SELECT payload FROM activity_canonical WHERE activity_id=?').get(id);
    if (row) return activitySchema.parse(JSON.parse(String(row.payload)));
    const source = this.db.prepare('SELECT payload FROM activity_sources WHERE activity_id=? LIMIT 1').get(id);
    return source ? activitySchema.parse(JSON.parse(String(source.payload)).activity) : undefined;
  }

  private matchingActivity(accountId: string, activity: ActivityInput): { id: string; activity: ActivityInput } | undefined {
    const rows = activity.startDate
      ? this.db.prepare('SELECT id FROM activities WHERE account_id=? AND (start_date=? OR start_date IS NULL)').all(accountId, activity.startDate)
      : this.db.prepare('SELECT id FROM activities WHERE account_id=? AND start_date IS NULL').all(accountId);
    for (const row of rows) {
      const existing = this.canonical(String(row.id));
      if (existing && sameRecruitingEvent(existing, activity)) return { id: String(row.id), activity: existing };
    }
  }

  complete(job: DailyProcessingJob, result: DailyExtractionResult): boolean {
    const sources = new Map(result.sources.map(source => [source.ref, source]));
    const activities = result.activities.map(value => {
      const { sourceRefs, ...input } = value;
      const activity = activitySchema.parse(input);
      const refs = [...new Set(sourceRefs)];
      if (!refs.length || refs.some(ref => !sources.has(ref))) throw new Error('活动来源不属于当前日批次。');
      return { activity, sourceRefs: refs };
    });
    return this.transaction(() => {
      if (!this.isCurrent(job)) return false;
      const [start, end] = dayRange(job.sourceDay);
      const dayKeys = this.db.prepare('SELECT key FROM messages WHERE account_id=? AND time>=? AND time<?').all(job.accountId, start, end);
      for (const row of dayKeys) this.db.prepare('DELETE FROM activity_sources WHERE message_key=?').run(row.key);
      for (const item of activities) {
        const matched = this.matchingActivity(job.accountId, item.activity);
        const id = matched?.id ?? activityIdentity(job.accountId, item.activity);
        const canonical = matched ? mergeActivityFacts(matched.activity, item.activity) : item.activity;
        this.db.prepare(`INSERT INTO activities(id,account_id,start_date,end_date,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET start_date=excluded.start_date,end_date=excluded.end_date,updated_at=excluded.updated_at`)
          .run(id, job.accountId, canonical.startDate, canonical.endDate, Date.now());
        this.db.prepare(`INSERT INTO activity_canonical(activity_id,payload) VALUES(?,?)
          ON CONFLICT(activity_id) DO UPDATE SET payload=excluded.payload`).run(id, JSON.stringify(canonical));
        for (const ref of item.sourceRefs) {
          const source = sources.get(ref)!;
          const reviewReasons = severeWarnings(source.warnings);
          this.db.prepare(`INSERT OR REPLACE INTO activity_sources(activity_id,message_key,payload) VALUES(?,?,?)`).run(
            id,
            source.message.key,
            JSON.stringify({ activity: { ...canonical, evidence: item.activity.evidence }, inputHash: source.contentHash,
              materials: source.materials, warnings: source.warnings, reviewReasons, relatedMessages: source.relatedMessages }),
          );
        }
      }

      this.db.prepare('DELETE FROM activities WHERE NOT EXISTS(SELECT 1 FROM activity_sources s WHERE s.activity_id=activities.id)').run();
      this.db.prepare('DELETE FROM activity_canonical WHERE NOT EXISTS(SELECT 1 FROM activities a WHERE a.id=activity_canonical.activity_id)').run();
      const reviewReasons = result.reviewReasons ?? [];
      const status = reviewReasons.length ? 'partial' : 'completed';
      this.db.prepare(`UPDATE schedule_daily_jobs SET status=?,error=?,diagnostics=?,processing_version=?,output_json=?,updated_at=?
        WHERE account_id=? AND source_day=? AND input_hash=? AND status='running'`)
        .run(status, reviewReasons.join('；').slice(0, 800), JSON.stringify(result.warnings), scheduleProcessingVersion,
          JSON.stringify(result.activities), Date.now(), job.accountId, job.sourceDay, job.hash);
      for (const source of job.messages) {
        const sourceWarnings = sources.get(source.ref)?.warnings ?? [];
        const sourceReviewReasons = severeWarnings(sourceWarnings);
        const sourceStatus = sourceReviewReasons.length ? 'partial' : 'completed';
        this.db.prepare(`UPDATE schedule_jobs SET status=?,error=?,diagnostics=?,processing_version=?,updated_at=?
          WHERE message_key=? AND input_hash=?`).run(sourceStatus, sourceReviewReasons.join('；').slice(0, 800),
          JSON.stringify(sourceWarnings), scheduleProcessingVersion, Date.now(), source.message.key, source.contentHash);
        this.db.prepare('DELETE FROM recruiting_information WHERE message_key=?').run(source.message.key);
      }
      return true;
    });
  }

  status(accountId: string): ProcessingStatus {
    const status: ProcessingStatus = { ...emptyProcessingStatus, ...this.settings(accountId), issues: [] };
    for (const row of this.db.prepare(`SELECT status,count(*) AS n FROM schedule_daily_jobs WHERE account_id=? GROUP BY status`).all(accountId)) {
      if (['pending', 'running', 'completed', 'partial', 'failed'].includes(String(row.status))) status[row.status as 'pending'] = Number(row.n);
    }
    const issues = this.db.prepare(`SELECT source_day,status,error FROM schedule_daily_jobs
      WHERE account_id=? AND status IN ('partial','failed') ORDER BY updated_at DESC LIMIT 30`).all(accountId);
    status.issues = issues.flatMap(issue => {
      const source = this.rows(accountId, String(issue.source_day))[0];
      if (!source) return [];
      const message: Message = JSON.parse(String(source.payload));
      return [{ messageKey: message.key, status: issue.status as 'failed' | 'partial', groupName: String(source.name),
        text: message.text.slice(0, 200), error: String(issue.error) }];
    });
    return status;
  }

  details(accountId: string, query: ProcessingDetailsQuery): ProcessingDetailsPage {
    const effectiveStatus = "CASE WHEN d.status IN ('pending','running','failed') THEN d.status ELSE coalesce(j.status,d.status,'pending') END";
    const bucketSql: Record<ProcessingMessageBucket, string> = {
      pending: `${effectiveStatus} IN ('pending','failed')`,
      running: `${effectiveStatus}='running'`,
      completed: `${effectiveStatus} IN ('completed','partial')`,
    };
    const base = `FROM messages m JOIN groups g ON g.account_id=m.account_id AND g.id=m.group_id
      LEFT JOIN schedule_jobs j ON j.message_key=m.key
      LEFT JOIN schedule_daily_jobs d ON d.account_id=m.account_id AND d.source_day=date(m.time,'unixepoch','+8 hours')
      WHERE m.account_id=? AND g.followed=1 AND m.time>=?`;
    const count = (bucket: ProcessingMessageBucket) => Number(this.db.prepare(`SELECT count(*) AS n ${base} AND ${bucketSql[bucket]}`)
      .get(accountId, query.since)?.n ?? 0);
    const counts = { pending: count('pending'), running: count('running'), completed: count('completed') };
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;
    const rows = this.db.prepare(`SELECT m.key,m.time,m.text,m.payload,g.name,
      ${effectiveStatus} AS status,CASE WHEN ${effectiveStatus}='failed' THEN coalesce(d.error,j.error,'') ELSE coalesce(j.error,'') END AS error,
      coalesce((SELECT json_group_array(json_extract(c.payload,'$.title'))
        FROM activity_sources s JOIN activity_canonical c ON c.activity_id=s.activity_id WHERE s.message_key=m.key),'[]') AS activity_titles
      ${base} AND ${bucketSql[query.bucket]} ORDER BY m.time DESC,m.key DESC LIMIT ? OFFSET ?`)
      .all(accountId, query.since, limit, offset) as Record<string, unknown>[];
    const items = rows.map(row => {
      const message = JSON.parse(String(row.payload)) as Message;
      const state = String(row.status) as ProcessingMessageState;
      const images = message.segments.flatMap((segment, segmentIndex) => {
        if (segment.type !== 'image') return [];
        let url: string | undefined;
        try {
          const parsed = new URL(String(segment.data.url ?? ''));
          if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) url = parsed.href;
        } catch {}
        return [{ segmentIndex, ...(url ? { url } : {}) }];
      });
      const links = message.segments.flatMap(segment => {
        if (segment.type !== 'json') return [];
        try {
          const card = JSON.parse(String(segment.data.data ?? '')) as Record<string, unknown>;
          const meta = Object.values(card.meta ?? {}).find(value => value && typeof value === 'object') as Record<string, unknown> | undefined;
          const target = new URL(String(meta?.jumpUrl ?? meta?.qqdocurl ?? meta?.url ?? card.jumpUrl ?? ''));
          if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) return [];
          const title = String(meta?.title ?? meta?.desc ?? card.prompt ?? '打开分享链接').slice(0, 120);
          return [{ url: target.href, title }];
        } catch { return []; }
      });
      return {
        key: String(row.key), bucket: query.bucket, state, groupName: String(row.name),
        senderName: message.senderName, messageTime: Number(row.time), text: String(row.text),
        contentTypes: [...new Set(message.segments.map(segment => segment.type))],
        images, links,
        activityTitles: JSON.parse(String(row.activity_titles)) as string[], error: String(row.error),
      } satisfies ProcessingMessageItem;
    });
    return { items, total: counts[query.bucket], hasMore: offset + items.length < counts[query.bucket], counts };
  }

  structuredResult(accountId: string, sourceDay: string): DailyExtractionResult['activities'] {
    const row = this.db.prepare('SELECT output_json FROM schedule_daily_jobs WHERE account_id=? AND source_day=?').get(accountId, sourceDay);
    return row ? JSON.parse(String(row.output_json)) : [];
  }

  private transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = callback(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  close() { this.db.close(); }
}
