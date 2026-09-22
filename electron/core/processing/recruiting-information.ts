import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Message } from '../../../src/shared';
import type { ActivitySource, InformationCategory, InformationDetail, InformationPage, InformationQuery, RecruitingInformation, RecruitingInformationInput, RelatedMessageSource } from '../../../src/schedule';
import { linksInSourceText, sourceLink } from '../materials/material-links';
import { genericInformationTitle, linkOnlyMessage, readableTitle, shareCardMaterials } from '../materials/material-title';

// This index preserves message provenance; it neither downloads sources nor calls a model.
export function informationCandidate(message: Message): boolean {
  return (message.text.length >= 30 && /校园招聘|校招|招聘公告|招聘简章|招聘岗位|岗位投递|内推|网申/.test(message.text))
    || linksInSourceText(message.text).some(url => new URL(url).hostname === 'mp.weixin.qq.com')
    || message.segments.some(segment => segment.type === 'json' && /mp\.weixin\.qq\.com/.test(String(segment.data.data)));
}

export function informationMaterials(message: Message, supplied: ActivitySource['materials'] = []): ActivitySource['materials'] {
  const materials: ActivitySource['materials'] = [];
  const add = (source: ActivitySource['materials'][number]) => {
    const url = source.url ? sourceLink(source.url) : '';
    const title = source.title?.slice(0, 200) || (!url && source.kind === 'image' ? 'QQ 图片附件' : undefined);
    if (url === undefined) return;
    const existing = materials.find(item => item.kind === source.kind && item.url === url && (url || item.title === title));
    if (existing) {
      if (!readableTitle(existing.title) && readableTitle(title)) existing.title = title;
      if (!existing.snapshotId && source.snapshotId) existing.snapshotId = source.snapshotId;
      if (!existing.pdfCoverage && source.pdfCoverage) existing.pdfCoverage = source.pdfCoverage;
      if (!existing.notices && source.notices) existing.notices = source.notices;
      return;
    }
    if (materials.length < 120) materials.push({ ...source, url, title });
  };
  supplied.forEach(add);
  shareCardMaterials(message).forEach(add);
  for (const url of linksInSourceText(message.text)) add({ url, kind: 'page' });
  for (const segment of message.segments) {
    if (segment.type === 'file' || segment.type === 'image') {
      const name = String(segment.data.name ?? segment.data.file ?? '').split(/[\\/]/).pop();
      add({ url: typeof segment.data.url === 'string' ? segment.data.url : '', kind: segment.type,
        title: segment.type === 'file' ? name || 'QQ 文件附件' : 'QQ 图片附件' });
    }
    if (segment.type === 'json') {
      try {
        const walk = (value: unknown, depth = 0) => {
          if (depth > 6) return;
          if (typeof value === 'string') for (const url of linksInSourceText(value)) add({ url, kind: 'page' });
          else if (value && typeof value === 'object') Object.values(value).slice(0, 40).forEach(child => walk(child, depth + 1));
        };
        walk(JSON.parse(String(segment.data.data)));
      } catch {}
    }
  }
  return materials;
}

function fallbackInformation(message: Message, materials: ActivitySource['materials']): RecruitingInformationInput {
  const plain = message.text.replace(/https?:\/\/\S+/g, '').replace(/\[(?:图片|文件|分享|链接)\]/g, '').trim();
  const firstLine = plain.split(/\n/).find(line => line.trim().length >= 5)?.trim();
  const file = materials.find(item => item.kind === 'file');
  const page = materials.find(item => item.kind === 'page' && readableTitle(item.title)) ?? materials.find(item => item.kind === 'page');
  const genericTitle = materials.some(item => item.kind === 'image') ? '招聘图片与消息' : '待补全消息';
  return {
    title: (page?.title || firstLine?.split(/[。！？!?]/)[0] || (file ? `招聘附件 · ${file.title || '群文件'}` : page ? '公众号与网页推送' : genericTitle)).slice(0, 100),
    summary: plain.replace(/\s+/g, ' ').slice(0, 500),
  };
}

const join = `FROM recruiting_information i JOIN messages m ON m.key=i.message_key AND m.content_hash=i.input_hash
  JOIN schedule_jobs j ON j.message_key=m.key AND j.input_hash=m.content_hash
  JOIN groups g ON g.account_id=m.account_id AND g.id=m.group_id`;
const fields = 'i.*,m.group_id,m.time,g.name,j.status';
const itemFrom = (row: Record<string, unknown>): RecruitingInformation => ({
  messageKey: String(row.message_key), title: String(row.title), summary: String(row.summary),
  groupId: String(row.group_id), groupName: String(row.name), messageTime: Number(row.time),
  category: row.category as InformationCategory, processingState: row.status as RecruitingInformation['processingState'],
});

export class RecruitingInformationStore {
  constructor(private db: DatabaseSync) {
    const existed = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recruiting_information'").get();
    this.db.exec(`CREATE TABLE IF NOT EXISTS recruiting_information (
      message_key TEXT PRIMARY KEY REFERENCES messages(key) ON DELETE CASCADE, input_hash TEXT NOT NULL,
      category TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, materials TEXT NOT NULL
    )`);
    if (!this.db.prepare('PRAGMA table_info(recruiting_information)').all().some(row => row.name === 'related_messages')) {
      this.db.exec("ALTER TABLE recruiting_information ADD COLUMN related_messages TEXT NOT NULL DEFAULT '[]'");
    }
    if (!existed) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of this.db.prepare(`SELECT j.*,m.payload FROM schedule_jobs j JOIN messages m ON m.key=j.message_key
          WHERE j.input_hash=m.content_hash AND j.status IN ('completed','partial','failed')`).iterate()) {
          const message: Message = JSON.parse(String(row.payload));
          const sources = this.db.prepare('SELECT payload FROM activity_sources WHERE message_key=?').all(message.key)
            .map(source => JSON.parse(String(source.payload)));
          if (row.status === 'completed' && (sources.length || !informationCandidate(message))) continue;
          this.save(message, String(row.input_hash), row.status === 'completed' ? 'information' : 'incomplete',
            undefined, sources.flatMap(source => source.materials ?? []));
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        // A failed initial backfill must remain retryable on the next startup.
        this.db.exec('DROP TABLE recruiting_information');
        throw error;
      }
    }
  }

  save(message: Message, hash: string, category: InformationCategory, input?: RecruitingInformationInput | null, supplied: ActivitySource['materials'] = [], relatedMessages: RelatedMessageSource[] = []) {
    const previous = this.db.prepare('SELECT * FROM recruiting_information WHERE message_key=? AND input_hash=?').get(message.key, hash);
    const materials = informationMaterials(message, [...supplied, ...(previous ? JSON.parse(String(previous.materials)) : [])]);
    const metadata = input ?? (category === 'incomplete' && previous ? { title: String(previous.title), summary: String(previous.summary) } : fallbackInformation(message, materials));
    const articleTitle = materials.filter(item => item.kind === 'page').map(item => readableTitle(item.title)).find(Boolean);
    const title = articleTitle && (linkOnlyMessage(message) || genericInformationTitle(metadata.title)) ? articleTitle : metadata.title;
    this.db.prepare(`INSERT INTO recruiting_information(message_key,input_hash,category,title,summary,materials,related_messages) VALUES(?,?,?,?,?,?,?) ON CONFLICT(message_key) DO UPDATE SET
      input_hash=excluded.input_hash,category=excluded.category,title=excluded.title,summary=excluded.summary,materials=excluded.materials,related_messages=excluded.related_messages`)
      .run(message.key, hash, category, title, metadata.summary, JSON.stringify(materials),
        JSON.stringify(relatedMessages.length ? relatedMessages : previous ? JSON.parse(String(previous.related_messages)) : []));
  }
  titleRequests(accountId: string, keys: string[]): { messageKey: string; hash: string; url: string; title?: string }[] {
    return keys.flatMap(key => {
      const row = this.db.prepare(`SELECT i.*,m.payload ${join} WHERE m.account_id=? AND g.followed=1 AND i.message_key=?`).get(accountId, key);
      if (!row) return [];
      const message: Message = JSON.parse(String(row.payload));
      if (!genericInformationTitle(String(row.title))) return [];
      const material = informationMaterials(message, JSON.parse(String(row.materials)))
        .find(item => item.kind === 'page' && item.url && new URL(item.url).hostname === 'mp.weixin.qq.com');
      return material ? [{ messageKey: key, hash: String(row.input_hash), url: material.url, title: readableTitle(material.title) }] : [];
    });
  }
  applyTitle(accountId: string, target: { messageKey: string; hash: string; url: string }, title: string): boolean {
    if (!readableTitle(title)) return false;
    const row = this.db.prepare(`SELECT i.*,m.payload ${join} WHERE m.account_id=? AND g.followed=1 AND i.message_key=? AND i.input_hash=?`)
      .get(accountId, target.messageKey, target.hash);
    if (!row || !genericInformationTitle(String(row.title))) return false;
    const message: Message = JSON.parse(String(row.payload));
    const materials = informationMaterials(message, JSON.parse(String(row.materials)));
    const material = materials.find(item => item.url === target.url && item.kind === 'page');
    if (!material) return false;
    material.title = title;
    this.db.prepare('UPDATE recruiting_information SET title=?,materials=? WHERE message_key=? AND input_hash=?')
      .run(title, JSON.stringify(materials), target.messageKey, target.hash);
    return true;
  }
  remove(messageKey: string) { this.db.prepare('DELETE FROM recruiting_information WHERE message_key=?').run(messageKey); }
  incompleteCount(accountId: string): number {
    return Number(this.db.prepare(`SELECT count(*) n ${join} WHERE m.account_id=? AND g.followed=1 AND i.category='incomplete'`).get(accountId)!.n);
  }

  page(accountId: string, query: InformationQuery): InformationPage {
    const filters = ['m.account_id=?', 'g.followed=1'];
    const args: SQLInputValue[] = [accountId];
    if (query.groupId) { filters.push('m.group_id=?'); args.push(query.groupId); }
    if (query.search?.trim()) {
      filters.push("instr(lower(i.title || ' ' || i.summary || ' ' || m.text || ' ' || i.materials),lower(?))>0");
      args.push(query.search.trim());
    }
    const where = `WHERE ${filters.join(' AND ')}`;
    const counts = { information: 0, incomplete: 0 };
    for (const row of this.db.prepare(`SELECT i.category,count(*) n ${join} ${where} GROUP BY i.category`).all(...args)) {
      counts[row.category as InformationCategory] = Number(row.n);
    }
    const rows = this.db.prepare(`SELECT ${fields} ${join} ${where} AND i.category=? ORDER BY m.time DESC,m.key DESC LIMIT 20 OFFSET ?`)
      .all(...args, query.category, query.offset ?? 0);
    const total = counts[query.category];
    return { items: rows.map(itemFrom), total, counts, hasMore: (query.offset ?? 0) + rows.length < total };
  }

  detail(accountId: string, messageKey: string): InformationDetail | null {
    const row = this.db.prepare(`SELECT ${fields},m.payload,j.error,j.diagnostics ${join}
      WHERE m.account_id=? AND g.followed=1 AND i.message_key=?`).get(accountId, messageKey);
    if (!row) return null;
    const message: Message = JSON.parse(String(row.payload));
    return { item: itemFrom(row), text: message.text, senderName: message.senderName, materials: JSON.parse(String(row.materials)),
      reason: String(row.error), diagnostics: JSON.parse(String(row.diagnostics)),
      relatedMessages: JSON.parse(String(row.related_messages)),
      activityIds: this.db.prepare('SELECT activity_id FROM activity_sources WHERE message_key=?').all(messageKey).map(source => String(source.activity_id)) };
  }
}
