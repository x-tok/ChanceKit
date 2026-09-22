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
        stop_when_idle INTEGER NOT NULL DEFAULT 0, since INTEGER NOT NULL DEFAULT 0,
        last_synced_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS schedule_daily_jobs (
        account_id TEXT NOT NULL, source_day TEXT NOT NULL, input_hash TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '', diagnostics TEXT NOT NULL DEFAULT '[]',
        processing_version INTEGER NOT NULL DEFAULT 0, output_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL,
        PRIMARY KEY(account_id,source_day)
      );
      CREATE INDEX IF NOT EXISTS schedule_daily_jobs_ready ON schedule_daily_jobs(account_id,status,available_at,source_day);
      CREATE TABLE IF NOT EXISTS schedule_group_sync (
        account_id TEXT NOT NULL, group_id TEXT NOT NULL, last_synced_at INTEGER NOT NULL,
        PRIMARY KEY(account_id,group_id)
      );
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
    if (!settingColumns.includes('last_synced_at')) {
      this.db.exec('ALTER TABLE schedule_settings ADD COLUMN last_synced_at INTEGER NOT NULL DEFAULT 0');
    }
    const jobColumns = this.db.prepare('PRAGMA table_info(schedule_daily_jobs)').all().map(row => String(row.name));
    if (!jobColumns.includes('output_json')) {
      this.db.exec("ALTER TABLE schedule_daily_jobs ADD COLUMN output_json TEXT NOT NULL DEFAULT '[]'");
    }
    // A one-time sync must never resume API requests after an application restart.
    this.db.prepare('UPDATE schedule_settings SET enabled=0,stop_when_idle=0 WHERE enabled<>0 OR stop_when_idle<>0').run();
    this.db.prepare("UPDATE schedule_daily_jobs SET status='pending',attempts=max(0,attempts-1) WHERE status='running'").run();
    this.db.prepare("UPDATE schedule_jobs SET status='pending',attempts=max(0,attempts-1),available_at=0 WHERE status='running'").run();
  }

  settings(accountId: string): { enabled: boolean; concurrency: number; stopWhenIdle: boolean; since: number;
    lastSyncedAt: number; groupLastSyncedAt: Record<string, number> } {
    const row = this.db.prepare('SELECT enabled,concurrency,stop_when_idle,since,last_synced_at FROM schedule_settings WHERE account_id=?').get(accountId);
    const groupLastSyncedAt = Object.fromEntries(this.db.prepare('SELECT group_id,last_synced_at FROM schedule_group_sync WHERE account_id=?')
      .all(accountId).map(group => [String(group.group_id), Number(group.last_synced_at)]));
    return {
      enabled: Boolean(row?.enabled), concurrency: Number(row?.concurrency ?? 3),
      stopWhenIdle: Boolean(row?.stop_when_idle), since: Number(row?.since ?? 0),
      lastSyncedAt: Number(row?.last_synced_at ?? 0), groupLastSyncedAt,
    };
  }

  configure(accountId: string, value: { enabled: boolean; concurrency: number; stopWhenIdle?: boolean; since?: number;
    syncedThrough?: number; syncedGroupIds?: string[] }) {
    const current = this.settings(accountId);
    const since = value.since ?? current.since;
    const lastSyncedAt = Math.max(current.lastSyncedAt, value.syncedThrough ?? 0);
    this.transaction(() => {
      this.db.prepare(`INSERT INTO schedule_settings(account_id,enabled,concurrency,stop_when_idle,since,last_synced_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(account_id) DO UPDATE SET enabled=excluded.enabled,concurrency=excluded.concurrency,
        stop_when_idle=excluded.stop_when_idle,since=excluded.since,last_synced_at=max(schedule_settings.last_synced_at,excluded.last_synced_at)`)
        .run(accountId, Number(value.enabled), value.concurrency, Number(Boolean(value.enabled && value.stopWhenIdle)), since, lastSyncedAt);
      if (value.syncedThrough) for (const groupId of new Set(value.syncedGroupIds ?? [])) {
        this.db.prepare(`INSERT INTO schedule_group_sync(account_id,group_id,last_synced_at) VALUES(?,?,?)
          ON CONFLICT(account_id,group_id) DO UPDATE SET last_synced_at=max(schedule_group_sync.last_synced_at,excluded.last_synced_at)`)
          .run(accountId, groupId, value.syncedThrough);
      }
    });
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

  private rowsWithStatus(accountId: string, day: string, status: ProcessingMessageState): MessageRow[] {
    const [start, end] = dayRange(day);
    return this.db.prepare(`SELECT m.key,m.content_hash,m.payload,m.time,g.name FROM messages m
      JOIN groups g ON g.account_id=m.account_id AND g.id=m.group_id
      JOIN schedule_jobs j ON j.message_key=m.key AND j.input_hash=m.content_hash
      WHERE m.account_id=? AND g.followed=1 AND m.time>=? AND m.time<? AND m.time>=? AND j.status=?
      ORDER BY m.time,m.key`).all(accountId, start, end, this.settings(accountId).since, status) as unknown as MessageRow[];
  }

  private currentRows(job: DailyProcessingJob): MessageRow[] {
    const keys = new Set(job.messages.map(source => source.message.key));
    return this.rows(job.accountId, job.sourceDay).filter(row => keys.has(String(row.key)));
  }

  private enqueueCandidates(accountId: string): MessageRow[] {
    return this.db.prepare(`SELECT m.key,m.content_hash,m.payload,m.time,g.name FROM messages m
      JOIN groups g ON g.account_id=m.account_id AND g.id=m.group_id
      LEFT JOIN schedule_jobs j ON j.message_key=m.key
      WHERE m.account_id=? AND g.followed=1 AND m.time>=?
        AND (j.message_key IS NULL OR j.input_hash<>m.content_hash OR j.status IN ('pending','running')
          OR instr(m.text,'[引用]')>0 OR instr(m.text,'[CQ:reply,')>0)
      ORDER BY m.time,m.key`).all(accountId, this.settings(accountId).since) as unknown as MessageRow[];
  }

  enqueue(accountId: string) {
    const rows = this.enqueueCandidates(accountId);
    const now = Date.now();
    this.transaction(() => {
      for (const row of rows) {
        const message = JSON.parse(String(row.payload)) as Message;
        const referencesHash = readReferenceGraph(this.db, message).hash;
        this.db.prepare(`INSERT INTO schedule_jobs(message_key,input_hash,status,updated_at,processing_version,references_hash)
          VALUES(?,?,'pending',?,?,?) ON CONFLICT(message_key) DO UPDATE SET input_hash=excluded.input_hash,status='pending',attempts=0,
          available_at=0,error='',updated_at=excluded.updated_at,processing_version=excluded.processing_version,references_hash=excluded.references_hash
          WHERE schedule_jobs.status<>'running' AND (schedule_jobs.input_hash<>excluded.input_hash OR schedule_jobs.references_hash<>excluded.references_hash)`)
          .run(row.key, row.content_hash, now, scheduleProcessingVersion, referencesHash);
      }
      const pendingByDay = new Map<string, MessageRow[]>();
      for (const row of rows) {
        const state = this.db.prepare('SELECT status,input_hash FROM schedule_jobs WHERE message_key=?').get(row.key);
        if (state?.status !== 'pending' || state.input_hash !== row.content_hash) continue;
        const day = beijingSourceDay(Number(row.time));
        const values = pendingByDay.get(day) ?? [];
        values.push(row);
        pendingByDay.set(day, values);
      }
      for (const [day, pendingRows] of pendingByDay) {
        const current = this.db.prepare('SELECT status,input_hash FROM schedule_daily_jobs WHERE account_id=? AND source_day=?').get(accountId, day);
        if (current?.status === 'running') continue;
        const hash = this.hashRows(pendingRows);
        this.db.prepare(`INSERT INTO schedule_daily_jobs(account_id,source_day,input_hash,status,updated_at,processing_version)
          VALUES(?,?,?,'pending',?,?) ON CONFLICT(account_id,source_day) DO UPDATE SET
          input_hash=excluded.input_hash,status='pending',
          attempts=CASE WHEN schedule_daily_jobs.status='pending' AND schedule_daily_jobs.input_hash=excluded.input_hash
            THEN schedule_daily_jobs.attempts ELSE 0 END,
          available_at=CASE WHEN schedule_daily_jobs.status='pending' AND schedule_daily_jobs.input_hash=excluded.input_hash
            THEN schedule_daily_jobs.available_at ELSE 0 END,
          error='',diagnostics='[]',updated_at=excluded.updated_at,processing_version=excluded.processing_version
          WHERE schedule_daily_jobs.status<>'running'`)
          .run(accountId, day, hash, now, scheduleProcessingVersion);
      }
      const activeDays = [...pendingByDay.keys()];
      const suffix = activeDays.length ? `AND source_day NOT IN (${activeDays.map(() => '?').join(',')})` : '';
      this.db.prepare(`DELETE FROM schedule_daily_jobs WHERE account_id=? AND status='pending' ${suffix}`).run(accountId, ...activeDays);
    });
  }

  claim(accountId: string, now = Date.now()): DailyProcessingJob | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM schedule_daily_jobs WHERE account_id=? AND status='pending' AND available_at<=?
        ORDER BY source_day LIMIT 1`).get(accountId, now);
      if (!row) return;
      const sourceDay = String(row.source_day);
      const rows = this.rowsWithStatus(accountId, sourceDay, 'pending');
      if (!rows.length || this.hashRows(rows) !== String(row.input_hash)) return;
      const updated = this.db.prepare(`UPDATE schedule_daily_jobs SET status='running',attempts=attempts+1,updated_at=?,processing_version=?
        WHERE account_id=? AND source_day=? AND status='pending'`).run(now, scheduleProcessingVersion, accountId, sourceDay);
      if (!updated.changes) return;
      for (const item of rows) {
        const leased = this.db.prepare(`UPDATE schedule_jobs SET status='running',attempts=attempts+1,updated_at=?
          WHERE message_key=? AND input_hash=? AND status='pending'`).run(now, item.key, item.content_hash);
        if (!leased.changes) throw new Error('消息整理状态已变化，请重新领取。');
      }
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
    if (!row || row.status !== 'running' || row.input_hash !== job.hash) return false;
    const rows = this.currentRows(job);
    if (rows.length !== job.messages.length || this.hashRows(rows) !== job.hash) return false;
    return job.messages.every(source => {
      const state = this.db.prepare('SELECT status,input_hash FROM schedule_jobs WHERE message_key=?').get(source.message.key);
      return state?.status === 'running' && state.input_hash === source.contentHash;
    });
  }

  refreshReferences(job: DailyProcessingJob): boolean {
    const row = this.db.prepare(`SELECT input_hash,status FROM schedule_daily_jobs WHERE account_id=? AND source_day=?`)
      .get(job.accountId, job.sourceDay);
    if (!row || row.status !== 'running' || row.input_hash !== job.hash) return false;
    const rows = this.currentRows(job);
    if (rows.length !== job.messages.length) return false;
    const hash = this.hashRows(rows);
    const byKey = new Map(job.messages.map(source => [source.message.key, source]));
    for (const item of rows) {
      const source = byKey.get(String(item.key));
      if (source) source.referenceGraph = readReferenceGraph(this.db, source.message);
    }
    this.db.prepare(`UPDATE schedule_daily_jobs SET input_hash=? WHERE account_id=? AND source_day=? AND input_hash=? AND status='running'`)
      .run(hash, job.accountId, job.sourceDay, job.hash);
    for (const item of rows) {
      const message = JSON.parse(String(item.payload)) as Message;
      this.db.prepare(`UPDATE schedule_jobs SET references_hash=? WHERE message_key=? AND status='running'`)
        .run(readReferenceGraph(this.db, message).hash, item.key);
    }
    job.hash = hash;
    return true;
  }

  release(job: DailyProcessingJob) {
    this.transaction(() => {
      this.db.prepare(`UPDATE schedule_daily_jobs SET status='pending',attempts=max(0,attempts-1),available_at=0
        WHERE account_id=? AND source_day=? AND input_hash=? AND status='running'`).run(job.accountId, job.sourceDay, job.hash);
      for (const source of job.messages) this.db.prepare(`UPDATE schedule_jobs SET status='pending',attempts=max(0,attempts-1),available_at=0
        WHERE message_key=? AND input_hash=? AND status='running'`).run(source.message.key, source.contentHash);
    });
  }

  fail(job: DailyProcessingJob, error: string, now = Date.now()) {
    const status = job.attempts >= 3 ? 'failed' : 'pending';
    this.transaction(() => {
      const updated = this.db.prepare(`UPDATE schedule_daily_jobs SET status=?,error=?,available_at=?,updated_at=?
        WHERE account_id=? AND source_day=? AND input_hash=? AND status='running'`)
        .run(status, error.slice(0, 800), now + 5000 * 2 ** (job.attempts - 1), now, job.accountId, job.sourceDay, job.hash);
      if (updated.changes) for (const source of job.messages) this.db.prepare(`UPDATE schedule_jobs SET status=?,error=?,available_at=?,updated_at=?
        WHERE message_key=? AND input_hash=? AND status='running'`)
        .run(status, error.slice(0, 800), now + 5000 * 2 ** (job.attempts - 1), now, source.message.key, source.contentHash);
    });
  }

  retry(accountId: string, messageKey?: string) {
    let day: string | undefined;
    if (messageKey) {
      const row = this.db.prepare('SELECT time FROM messages WHERE account_id=? AND key=?').get(accountId, messageKey);
      if (!row) throw new Error('需要重新处理的消息已不存在或不属于当前账号。');
      day = beijingSourceDay(Number(row.time));
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
      : this.db.prepare('SELECT id FROM activities WHERE account_id=?').all(accountId);
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
      for (const source of job.messages) this.db.prepare('DELETE FROM activity_sources WHERE message_key=?').run(source.message.key);
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
        this.db.prepare(`UPDATE schedule_jobs SET status=?,error=?,diagnostics=?,references_hash=?,processing_version=?,updated_at=?
          WHERE message_key=? AND input_hash=?`).run(sourceStatus, sourceReviewReasons.join('；').slice(0, 800),
          JSON.stringify(sourceWarnings), source.referenceGraph?.hash ?? '', scheduleProcessingVersion, Date.now(), source.message.key, source.contentHash);
        this.db.prepare('DELETE FROM recruiting_information WHERE message_key=?').run(source.message.key);
      }
      return true;
    });
  }

  status(accountId: string): ProcessingStatus {
    const status: ProcessingStatus = { ...emptyProcessingStatus, ...this.settings(accountId), issues: [] };
    const hasArchive = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get());
    if (!hasArchive) return status;
    const dayStatuses = this.db.prepare(`SELECT date(m.time,'unixepoch','+8 hours') AS source_day,
      CASE WHEN sum(j.status='running')>0 THEN 'running' WHEN sum(j.status='pending')>0 THEN 'pending'
        WHEN sum(j.status='failed')>0 THEN 'failed' WHEN sum(j.status='partial')>0 THEN 'partial' ELSE 'completed' END AS status
      FROM schedule_jobs j JOIN messages m ON m.key=j.message_key
      JOIN groups g ON g.account_id=m.account_id AND g.id=m.group_id
      WHERE m.account_id=? AND g.followed=1 AND m.time>=? AND j.input_hash=m.content_hash GROUP BY source_day`)
      .all(accountId, this.settings(accountId).since);
    for (const row of dayStatuses) {
      if (['pending', 'running', 'completed', 'partial', 'failed'].includes(String(row.status))) status[row.status as 'pending']++;
    }
    const issues = this.db.prepare(`SELECT j.message_key,j.status,j.error,g.name,m.text FROM schedule_jobs j
      JOIN messages m ON m.key=j.message_key JOIN groups g ON g.account_id=m.account_id AND g.id=m.group_id
      WHERE m.account_id=? AND g.followed=1 AND m.time>=? AND j.input_hash=m.content_hash
        AND j.status IN ('partial','failed') ORDER BY j.updated_at DESC LIMIT 30`).all(accountId, this.settings(accountId).since);
    status.issues = issues.map(issue => ({ messageKey: String(issue.message_key), status: issue.status as 'failed' | 'partial',
      groupName: String(issue.name), text: String(issue.text).slice(0, 200), error: String(issue.error) }));
    return status;
  }

  details(accountId: string, query: ProcessingDetailsQuery): ProcessingDetailsPage {
    const effectiveStatus = "CASE WHEN j.message_key IS NULL OR j.input_hash<>m.content_hash THEN 'pending' ELSE j.status END";
    const bucketSql: Record<ProcessingMessageBucket, string> = {
      pending: `${effectiveStatus}='pending'`,
      running: `${effectiveStatus}='running'`,
      completed: `${effectiveStatus}='completed'`,
      review: `${effectiveStatus} IN ('partial','failed')`,
    };
    const base = `FROM messages m JOIN groups g ON g.account_id=m.account_id AND g.id=m.group_id
      LEFT JOIN schedule_jobs j ON j.message_key=m.key
      WHERE m.account_id=? AND g.followed=1 AND m.time>=?`;
    const count = (bucket: ProcessingMessageBucket) => Number(this.db.prepare(`SELECT count(*) AS n ${base} AND ${bucketSql[bucket]}`)
      .get(accountId, query.since)?.n ?? 0);
    const counts = { pending: count('pending'), running: count('running'), completed: count('completed'), review: count('review') };
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;
    const rows = this.db.prepare(`SELECT m.key,m.time,m.text,m.payload,g.name,
      ${effectiveStatus} AS status,CASE WHEN ${effectiveStatus} IN ('failed','partial')
        THEN coalesce(nullif(j.error,''),'') ELSE '' END AS error,
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
