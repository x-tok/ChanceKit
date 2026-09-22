import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { Message } from '../../../src/shared';
import { addDays, emptyProcessingStatus, isOngoingActivity, scheduleProcessingVersion, type Activity, type ActivityDetail, type ActivityInput, type ActivitySource, type ProcessingStatus, type RecruitingInformationInput, type RelatedMessageSource, type SchedulePage, type ScheduleQuery } from '../../../src/schedule';
import { extractionSchema } from './activity-schema';
import { isPlainJobAdvertisement, reviewActivities } from './activity-review';
import { informationCandidate, RecruitingInformationStore } from './recruiting-information';
import { readReferenceGraph, type ReferenceGraph } from '../archive/message-references';

export interface ExtractionResult {
  activities: ActivityInput[];
  materials: ActivitySource['materials'];
  warnings: string[];
  reviewReasons?: string[];
  information?: RecruitingInformationInput | null;
  relatedMessages?: RelatedMessageSource[];
}
export interface ProcessingJob {
  message: Message;
  groupName: string;
  hash: string;
  attempts: number;
  context: { text: string; time: number }[];
  referenceGraph?: ReferenceGraph;
}
const followedJoin = 'JOIN messages m ON m.key=j.message_key JOIN groups g ON g.account_id=m.account_id AND g.id=m.group_id';
const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');

export class ScheduleStore {
  private db: DatabaseSync;
  readonly information: RecruitingInformationStore;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS schedule_settings (
        account_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, concurrency INTEGER NOT NULL DEFAULT 3
      );
      CREATE TABLE IF NOT EXISTS schedule_jobs (
        message_key TEXT PRIMARY KEY REFERENCES messages(key), input_hash TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
        diagnostics TEXT NOT NULL DEFAULT '[]', processing_version INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS schedule_jobs_ready ON schedule_jobs(status,available_at);
      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, start_date TEXT, end_date TEXT, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activities_week ON activities(account_id,start_date,end_date);
      CREATE TABLE IF NOT EXISTS activity_sources (
        activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        message_key TEXT NOT NULL REFERENCES messages(key), payload TEXT NOT NULL,
        PRIMARY KEY(activity_id,message_key)
      );
      CREATE INDEX IF NOT EXISTS activity_sources_message ON activity_sources(message_key);
      CREATE TABLE IF NOT EXISTS activity_canonical (
        activity_id TEXT PRIMARY KEY REFERENCES activities(id) ON DELETE CASCADE, payload TEXT NOT NULL
      );
    `);
    const columns = this.db.prepare('PRAGMA table_info(schedule_jobs)').all().map(row => String(row.name));
    if (!columns.includes('diagnostics')) this.db.exec("ALTER TABLE schedule_jobs ADD COLUMN diagnostics TEXT NOT NULL DEFAULT '[]'");
    if (!columns.includes('references_hash')) this.db.exec("ALTER TABLE schedule_jobs ADD COLUMN references_hash TEXT NOT NULL DEFAULT ''");
    if (!columns.includes('processing_version')) {
      this.db.exec('ALTER TABLE schedule_jobs ADD COLUMN processing_version INTEGER NOT NULL DEFAULT 0');
      this.reassessLegacyResults();
    }
    // A running lease belongs to the previous desktop process and cannot be resumed.
    this.db.prepare("UPDATE schedule_jobs SET status='pending',attempts=max(0,attempts-1) WHERE status='running'").run();
    this.information = new RecruitingInformationStore(this.db);
  }
  private reassessLegacyResults() {
    // Local evidence only: migrating an advisory warning must never invoke a model.
    this.transaction(() => {
      const rows = this.db.prepare(`SELECT j.message_key,j.error,m.payload,g.name FROM schedule_jobs j
        JOIN messages m ON m.key=j.message_key JOIN groups g ON g.account_id=m.account_id AND g.id=m.group_id
        WHERE j.status='partial'`).all();
      for (const row of rows) {
        const message: Message = JSON.parse(String(row.payload));
        const sources = this.db.prepare('SELECT activity_id,payload FROM activity_sources WHERE message_key=?').all(row.message_key);
        const payloads = sources.map(source => JSON.parse(String(source.payload)));
        const activities = payloads.map(payload => payload.activity as ActivityInput);
        const warnings = [...new Set([String(row.error), ...payloads.flatMap(payload => payload.warnings as string[])].filter(Boolean))];
        if ((!activities.length && !isPlainJobAdvertisement(message)) || reviewActivities(message, activities, warnings, message.text, String(row.name)).length) continue;
        for (const [index, source] of sources.entries()) {
          this.db.prepare('UPDATE activity_sources SET payload=? WHERE activity_id=? AND message_key=?')
            .run(JSON.stringify({ ...payloads[index], reviewReasons: [] }), source.activity_id, row.message_key);
        }
        this.db.prepare("UPDATE schedule_jobs SET status='completed',error='',diagnostics=?,processing_version=? WHERE message_key=?")
          .run(JSON.stringify(warnings), scheduleProcessingVersion, row.message_key);
      }
    });
  }
  settings(accountId: string): { enabled: boolean; concurrency: number } {
    const row = this.db.prepare('SELECT enabled,concurrency FROM schedule_settings WHERE account_id=?').get(accountId);
    return { enabled: Boolean(row?.enabled), concurrency: Number(row?.concurrency ?? 3) };
  }
  configure(accountId: string, value: { enabled: boolean; concurrency: number }) {
    this.db.prepare(`INSERT INTO schedule_settings(account_id,enabled,concurrency) VALUES(?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET enabled=excluded.enabled,concurrency=excluded.concurrency`)
      .run(accountId, Number(value.enabled), value.concurrency);
  }
  enqueue(accountId: string) {
    this.db.prepare(`INSERT INTO schedule_jobs(message_key,input_hash,status,updated_at)
      SELECT m.key,m.content_hash,'pending',? FROM messages m
      JOIN groups g ON g.account_id=m.account_id AND g.id=m.group_id
      WHERE m.account_id=? AND g.followed=1
      ON CONFLICT(message_key) DO UPDATE SET input_hash=excluded.input_hash,status='pending',attempts=0,
        available_at=0,error='',updated_at=excluded.updated_at
      WHERE schedule_jobs.input_hash<>excluded.input_hash`).run(Date.now(), accountId);
    // A quoted source arriving late or changing invalidates dependent results, not unrelated chat.
    for (const row of this.db.prepare(`SELECT j.message_key,j.references_hash,m.payload FROM schedule_jobs j ${followedJoin}
      WHERE m.account_id=? AND g.followed=1 AND j.status<>'running'
      AND (instr(m.text,'[引用]')>0 OR instr(m.text,'[CQ:reply,')>0)`).all(accountId)) {
      const graph = readReferenceGraph(this.db, JSON.parse(String(row.payload)));
      if (graph.hash !== String(row.references_hash)) this.db.prepare(`UPDATE schedule_jobs SET status='pending',attempts=0,available_at=0,error='',references_hash=?
        WHERE message_key=?`).run(graph.hash, row.message_key);
    }
    if (this.settings(accountId).enabled) {
      // One upgrade retry through the normal bounded queue; disabled processing never sends data.
      this.db.prepare(`UPDATE schedule_jobs SET status='pending',attempts=0,available_at=0,
        diagnostics=CASE WHEN diagnostics='[]' THEN json_array(error) ELSE diagnostics END,
        error='',processing_version=? WHERE status IN ('partial','failed') AND processing_version<?
        AND message_key IN (SELECT m.key FROM messages m JOIN groups g ON g.account_id=m.account_id AND g.id=m.group_id
          WHERE m.account_id=? AND g.followed=1)`).run(scheduleProcessingVersion, scheduleProcessingVersion, accountId);
    }
  }
  claim(accountId: string, now = Date.now()): ProcessingJob | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT j.*,m.payload,g.name FROM schedule_jobs j ${followedJoin}
        WHERE m.account_id=? AND g.followed=1 AND j.status='pending' AND j.available_at<=?
        AND j.input_hash=m.content_hash ORDER BY m.time,m.key LIMIT 1`).get(accountId, now);
      if (!row) return;
      this.db.prepare("UPDATE schedule_jobs SET status='running',attempts=attempts+1,updated_at=?,processing_version=? WHERE message_key=?")
        .run(now, scheduleProcessingVersion, row.message_key);
      const message = JSON.parse(String(row.payload)) as Message;
      const context = this.db.prepare(`SELECT text,time FROM messages WHERE account_id=? AND group_id=?
        AND (time<? OR (time=? AND key<?)) ORDER BY time DESC,key DESC LIMIT 3`)
        .all(accountId, message.groupId, message.time, message.time, message.key)
        .map(row => ({ text: String(row.text).slice(0, 3000), time: Number(row.time) })).reverse();
      const referenceGraph = readReferenceGraph(this.db, message);
      this.db.prepare('UPDATE schedule_jobs SET references_hash=? WHERE message_key=?').run(referenceGraph.hash, message.key);
      return { message, groupName: String(row.name), hash: String(row.input_hash), attempts: Number(row.attempts) + 1, context, referenceGraph };
    });
  }
  isCurrent(job: ProcessingJob): boolean {
    return this.currentRoot(job) && (!job.referenceGraph || readReferenceGraph(this.db, job.message).hash === job.referenceGraph.hash);
  }
  hasSnapshot(accountId: string, messageKey: string, snapshotId: string): boolean {
    const current = this.db.prepare(`SELECT m.content_hash,j.input_hash FROM messages m
      JOIN schedule_jobs j ON j.message_key=m.key JOIN groups g ON g.account_id=m.account_id AND g.id=m.group_id
      WHERE m.account_id=? AND m.key=? AND g.followed=1 AND m.content_hash=j.input_hash`).get(accountId, messageKey);
    if (!current) return false;
    const materials = this.db.prepare('SELECT materials FROM recruiting_information WHERE message_key=? AND input_hash=?')
      .get(messageKey, current.content_hash);
    const sources = this.db.prepare('SELECT payload FROM activity_sources WHERE message_key=?').all(messageKey);
    return [materials ? JSON.parse(String(materials.materials)) : [], ...sources.map(source => {
      const payload = JSON.parse(String(source.payload));
      return payload.inputHash === current.content_hash ? payload.materials ?? [] : [];
    })]
      .some(items => items.some((item: { snapshotId?: string }) => item.snapshotId === snapshotId));
  }
  private currentRoot(job: ProcessingJob): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM schedule_jobs j ${followedJoin}
      WHERE j.message_key=? AND j.input_hash=? AND m.content_hash=? AND j.status='running' AND g.followed=1`)
      .get(job.message.key, job.hash, job.hash));
  }
  refreshReferences(job: ProcessingJob): boolean {
    if (!this.currentRoot(job)) return false;
    job.referenceGraph = readReferenceGraph(this.db, job.message);
    this.db.prepare('UPDATE schedule_jobs SET references_hash=? WHERE message_key=? AND status=?').run(job.referenceGraph.hash, job.message.key, 'running');
    return true;
  }
  release(job: ProcessingJob) {
    this.db.prepare("UPDATE schedule_jobs SET status='pending',attempts=max(0,attempts-1),available_at=0 WHERE message_key=? AND input_hash=? AND status='running'")
      .run(job.message.key, job.hash);
  }
  fail(job: ProcessingJob, error: string, now = Date.now(), materials: ActivitySource['materials'] = []) {
    this.transaction(() => {
      const updated = this.db.prepare(`UPDATE schedule_jobs SET status=?,error=?,available_at=?,updated_at=?
      WHERE message_key=? AND input_hash=? AND status='running'`)
      .run(job.attempts >= 3 ? 'failed' : 'pending', error.slice(0, 800), now + 5000 * 2 ** (job.attempts - 1), now, job.message.key, job.hash);
      if (updated.changes && job.attempts >= 3) this.information.save(job.message, job.hash, 'incomplete', undefined, materials,
        job.referenceGraph?.references.map(({ message, relation }) => ({ messageKey: message.key, text: message.text, messageTime: message.time, senderName: message.senderName, relation })) ?? []);
    });
  }
  retry(accountId: string, messageKey?: string) {
    this.db.prepare(`UPDATE schedule_jobs SET status='pending',attempts=0,error='',available_at=0
      WHERE status IN ('failed','partial') AND message_key IN (
        SELECT m.key FROM messages m JOIN groups g ON g.account_id=m.account_id AND g.id=m.group_id
        WHERE m.account_id=? AND g.followed=1 ${messageKey ? 'AND m.key=?' : ''}
      )`).run(accountId, ...(messageKey ? [messageKey] : []));
  }
  complete(job: ProcessingJob, result: ExtractionResult): boolean {
    const { activities, information } = extractionSchema.parse({ activities: result.activities, information: result.information });
    const reviewReasons = result.reviewReasons ?? result.warnings;
    return this.transaction(() => {
      if (!this.isCurrent(job)) return false;
      if (reviewReasons.length) this.information.save(job.message, job.hash, 'incomplete', information, result.materials, result.relatedMessages);
      else if (!activities.length && (information || (result.information === undefined && informationCandidate(job.message)))) {
        this.information.save(job.message, job.hash, 'information', information, result.materials, result.relatedMessages);
      } else this.information.remove(job.message.key);
      if (!activities.length && reviewReasons.length) {
        // A failed reread is not evidence that a previously extracted event disappeared.
        for (const row of this.db.prepare('SELECT activity_id,payload FROM activity_sources WHERE message_key=?').all(job.message.key)) {
          const previous = JSON.parse(String(row.payload));
          this.db.prepare('UPDATE activity_sources SET payload=? WHERE activity_id=? AND message_key=?')
            .run(JSON.stringify({ ...previous,
              warnings: [...new Set([...previous.warnings, ...result.warnings])],
              reviewReasons: [...reviewReasons, '本次来源未读全，暂保留上次提取的活动，请核对原通知。'],
            }), row.activity_id, job.message.key);
        }
      } else this.db.prepare('DELETE FROM activity_sources WHERE message_key=?').run(job.message.key);
      for (const activity of activities) {
        // Conservative cross-post deduplication; undated notices stay source-specific.
        const identity = [job.message.accountId, normalized(activity.title), normalized(activity.organizer),
          activity.startDate ?? job.message.key, activity.startTime, normalized(activity.location)];
        const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
        this.db.prepare(`INSERT INTO activities VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`)
          .run(id, job.message.accountId, activity.startDate, activity.endDate, Date.now());
        this.db.prepare(`INSERT INTO activity_canonical(activity_id,payload) VALUES(?,?)
          ON CONFLICT(activity_id) DO UPDATE SET payload=excluded.payload`).run(id, JSON.stringify(activity));
        this.db.prepare('INSERT OR REPLACE INTO activity_sources VALUES(?,?,?)')
          .run(id, job.message.key, JSON.stringify({ activity, inputHash: job.hash, materials: result.materials, warnings: result.warnings, reviewReasons, relatedMessages: result.relatedMessages }));
      }
      this.db.prepare(`UPDATE activities SET end_date=(
        SELECT max(coalesce(json_extract(s.payload,'$.activity.endDate'),json_extract(s.payload,'$.activity.startDate')))
        FROM activity_sources s WHERE s.activity_id=activities.id
      ) WHERE id IN (SELECT activity_id FROM activity_sources WHERE message_key=?)`).run(job.message.key);
      this.db.prepare('DELETE FROM activities WHERE NOT EXISTS(SELECT 1 FROM activity_sources s WHERE s.activity_id=activities.id)').run();
      this.db.prepare('DELETE FROM activity_canonical WHERE NOT EXISTS(SELECT 1 FROM activities a WHERE a.id=activity_canonical.activity_id)').run();
      this.db.prepare("UPDATE schedule_jobs SET status=?,error=?,diagnostics=?,processing_version=?,updated_at=? WHERE message_key=?")
        .run(reviewReasons.length ? 'partial' : 'completed', reviewReasons.join('；').slice(0, 800),
          JSON.stringify(result.warnings), scheduleProcessingVersion, Date.now(), job.message.key);
      return true;
    });
  }
  status(accountId: string): ProcessingStatus {
    const status: ProcessingStatus = { ...emptyProcessingStatus, ...this.settings(accountId), issues: [],
      incompleteInformation: this.information.incompleteCount(accountId) };
    for (const row of this.db.prepare(`SELECT j.status,count(*) AS n FROM schedule_jobs j ${followedJoin}
      WHERE m.account_id=? AND g.followed=1 GROUP BY j.status`).all(accountId)) {
      if (['pending', 'running', 'completed', 'partial', 'failed'].includes(String(row.status))) {
        status[row.status as 'pending'] = Number(row.n);
      }
    }
    status.issues = this.db.prepare(`SELECT j.message_key,j.status,j.error,g.name,m.text FROM schedule_jobs j ${followedJoin}
      WHERE m.account_id=? AND g.followed=1 AND j.status IN ('failed','partial')
      ORDER BY j.updated_at DESC LIMIT 30`).all(accountId).map(row => ({
      messageKey: String(row.message_key), status: row.status as 'failed' | 'partial', groupName: String(row.name),
      text: String(row.text).slice(0, 200), error: String(row.error),
    }));
    return status;
  }
  page(accountId: string, query: ScheduleQuery): SchedulePage {
    const ids = this.db.prepare(`SELECT a.id FROM activities a WHERE a.account_id=? AND
      (a.start_date IS NULL OR (a.start_date<? AND coalesce(a.end_date,a.start_date)>=?)) ORDER BY a.start_date`)
      .all(accountId, addDays(query.week, 7), query.week);
    const details = ids.map(row => this.detail(accountId, String(row.id), query.groupId)).filter((row): row is ActivityDetail => Boolean(row));
    const rows = details.map(detail => detail.activity);
    const filtered = rows.filter(row => (!row.startDate || (row.startDate < addDays(query.week, 7) && (row.endDate ?? row.startDate) >= query.week))
      && (!query.type || row.type === query.type)
      && (!query.search || `${row.title} ${row.organizer} ${row.location} ${row.description}`.toLowerCase().includes(query.search.toLowerCase())));
    filtered.sort((a, b) => `${a.startDate ?? ''} ${a.startTime ?? '99:99'} ${a.title}`.localeCompare(`${b.startDate ?? ''} ${b.startTime ?? '99:99'} ${b.title}`));
    const visible = new Set(filtered.map(row => row.id));
    return {
      activities: filtered.filter(row => row.startDate), undated: filtered.filter(row => !row.startDate),
      sources: Object.fromEntries(details.filter(detail => visible.has(detail.activity.id)).map(detail => [detail.activity.id, detail.sources])),
    };
  }
  detail(accountId: string, id: string, groupId?: string): ActivityDetail | null {
    const rows = this.db.prepare(`SELECT s.payload,s.message_key,m.group_id,m.time,m.payload AS message,g.name,a.updated_at
      FROM activity_sources s JOIN activities a ON a.id=s.activity_id JOIN messages m ON m.key=s.message_key
      JOIN groups g ON g.account_id=m.account_id AND g.id=m.group_id
      WHERE a.id=? AND a.account_id=? AND g.followed=1 ${groupId ? 'AND m.group_id=?' : ''} ORDER BY m.time DESC,m.key DESC`)
      .all(id, accountId, ...(groupId ? [groupId] : []));
    if (!rows.length) return null;
    const sources: ActivitySource[] = rows.map(row => {
      const payload = JSON.parse(String(row.payload));
      const message: Message = JSON.parse(String(row.message));
      return {
        messageKey: String(row.message_key), groupId: String(row.group_id), groupName: String(row.name), senderName: message.senderName,
        messageTime: Number(row.time), text: message.text, evidence: payload.activity.evidence, materials: payload.materials, warnings: payload.warnings,
        reviewReasons: payload.reviewReasons,
        relatedMessages: payload.relatedMessages,
      };
    });
    const payload = JSON.parse(String(rows[0].payload));
    const canonicalRow = this.db.prepare('SELECT payload FROM activity_canonical WHERE activity_id=?').get(id);
    const activity = canonicalRow ? JSON.parse(String(canonicalRow.payload)) as ActivityInput : payload.activity as ActivityInput;
    return {
      activity: { ...activity, id, updatedAt: Number(rows[0].updated_at), sourceCount: sources.length,
        groupNames: [...new Set(sources.map(source => source.groupName))],
        needsReview: !activity.startDate || (!activity.startTime && !isOngoingActivity(activity))
          || sources.some(source => (source.reviewReasons ?? source.warnings).length > 0) },
      sources,
    };
  }
  private transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
