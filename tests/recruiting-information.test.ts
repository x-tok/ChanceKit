import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { Store, normalizeMessage } from '../electron/core/archive/store';
import { ScheduleStore, type ExtractionResult } from '../electron/core/processing/schedule-store';
import { informationQuerySchema } from '../electron/core/processing/activity-schema';
import { sample } from './fixtures';

const ad = '星河科技2027届校园招聘正式启动，多个技术岗位开放投递，面向理工科应届毕业生，欢迎从岗位入口投递简历 https://jobs.example.com/#/position/campus/';
const result = (overrides: Partial<ExtractionResult> = {}): ExtractionResult => ({ activities: [], materials: [], warnings: [], reviewReasons: [], ...overrides });
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-information-'));
  const file = path.join(root, 'messages.sqlite');
  const messages = new Store(file);
  messages.saveGroups('a', [{ group_id: 731234567, group_name: '关注招聘群' }, { group_id: 731234568, group_name: '另一关注群' }]);
  messages.follow('a', '731234567', true); messages.follow('a', '731234568', true);
  const value = { file, messages, schedule: new ScheduleStore(file) };
  t.after(async () => { value.schedule.close(); messages.close(); await rm(root, { recursive: true, force: true }); });
  return value;
}

test('read recruiting pushes persist independently of calendar weeks, with original source routes and no irrelevant chat', async t => {
  const f = await fixture(t);
  const messages = [ad, '谢谢，收到。', ad + '感谢同学分享'].map((text, index) => normalizeMessage(sample(index + 1, text), 'a'));
  f.messages.put(messages); f.schedule.enqueue('a');
  f.schedule.complete(f.schedule.claim('a')!, result());
  f.schedule.complete(f.schedule.claim('a')!, result({ information: null }));
  f.schedule.complete(f.schedule.claim('a')!, result({ information: null }));
  const list = f.schedule.information.page('a', { category: 'information' });
  assert.equal(list.total, 1);
  assert.equal(f.schedule.page('a', { week: '2030-01-07' }).activities.length, 0);
  const detail = f.schedule.information.detail('a', messages[0].key)!;
  assert.equal(detail.text, ad);
  assert.equal(detail.item.messageTime, messages[0].time);
  assert.ok(detail.materials.some(source => source.url === 'https://jobs.example.com/#/position/campus/'));
  assert.equal(f.schedule.status('a').completed, 3);
  f.schedule.close(); f.schedule = new ScheduleStore(f.file);
  assert.equal(f.schedule.information.page('a', { category: 'information' }).total, 1);
});

test('incomplete attachments retain filenames, reading records and a visible entry while queued; clean rereads move or remove it', async t => {
  const f = await fixture(t);
  const message = normalizeMessage({ ...sample(1, ''), message: [{ type: 'file', data: { name: '星河招聘公告.doc', file_id: 'opaque' } }] }, 'a');
  f.messages.put([message]); f.schedule.enqueue('a');
  f.schedule.complete(f.schedule.claim('a')!, result({ warnings: ['文件格式暂不支持'], reviewReasons: ['附件尚未读全'] }));
  const entry = f.schedule.information.detail('a', message.key)!;
  assert.match(entry.item.title, /星河招聘公告/);
  assert.equal(entry.item.category, 'incomplete');
  assert.deepEqual(entry.diagnostics, ['文件格式暂不支持']);
  assert.equal(entry.reason, '附件尚未读全');
  assert.equal(entry.materials[0].title, '星河招聘公告.doc');
  assert.equal(f.schedule.information.page('a', { category: 'incomplete', search: '星河招聘公告.doc' }).total, 1);
  f.schedule.retry('a', message.key);
  assert.equal(f.schedule.information.detail('a', message.key)!.item.processingState, 'pending');
  assert.equal(f.schedule.status('a').incompleteInformation, 1);
  f.schedule.complete(f.schedule.claim('a')!, result({ information: { title: '星河招聘公告', summary: '技术岗位开放投递。' } }));
  assert.deepEqual(f.schedule.information.page('a', { category: 'incomplete' }).counts, { information: 1, incomplete: 0 });
  assert.equal(f.schedule.status('a').incompleteInformation, 0);
  assert.equal(f.schedule.information.detail('a', message.key)!.item.summary, '技术岗位开放投递。');
  // A changed source invalidates its old entry immediately, before the new extraction.
  f.messages.put([normalizeMessage({ ...sample(1, '谢谢'), time: message.time }, 'a')]);
  assert.equal(f.schedule.information.detail('a', message.key), null);
  f.schedule.enqueue('a');
  f.schedule.complete(f.schedule.claim('a')!, result({ information: null }));
  assert.equal(f.schedule.information.page('a', { category: 'information' }).total, 0);
});

test('final failures appear without creating false activities, and are scoped to account and followed group', async t => {
  const f = await fixture(t);
  f.messages.saveGroups('b', [{ group_id: 731234567, group_name: '其他账号' }]);
  f.messages.follow('b', '731234567', true);
  const message = normalizeMessage(sample(1, 'https://mp.weixin.qq.com/s/synthetic'), 'a');
  f.messages.put([message]); f.schedule.enqueue('a');
  f.schedule.fail({ ...f.schedule.claim('a')!, attempts: 3 }, '合成服务错误');
  assert.equal(f.schedule.information.page('a', { category: 'incomplete' }).total, 1);
  assert.equal(f.schedule.information.page('b', { category: 'incomplete' }).total, 0);
  assert.equal(f.schedule.information.detail('b', message.key), null);
  assert.equal(f.schedule.page('a', { week: '2026-09-21' }).activities.length, 0);
  f.messages.follow('a', '731234567', false);
  assert.equal(f.schedule.information.page('a', { category: 'incomplete' }).total, 0);
  assert.equal(f.schedule.information.detail('a', message.key), null);
});

test('information queries paginate deterministically and search the original text, title and filenames', async t => {
  const f = await fixture(t);
  for (let id = 1; id <= 25; id++) f.messages.put([normalizeMessage(sample(id, `${ad} 原文编号${id}`, id > 20 ? 731234568 : 731234567), 'a')]);
  f.schedule.enqueue('a');
  for (let id = 1; id <= 25; id++) f.schedule.complete(f.schedule.claim('a')!, result({ information: { title: `单位资讯${id}`, summary: '' } }));
  const first = f.schedule.information.page('a', { category: 'information' });
  const second = f.schedule.information.page('a', { category: 'information', offset: 20 });
  assert.equal(first.items.length, 20); assert.equal(first.total, 25); assert.equal(first.hasMore, true);
  assert.equal(second.items.length, 5); assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.messageKey)).size, 25);
  assert.equal(f.schedule.information.page('a', { category: 'information', groupId: '731234568' }).total, 5);
  assert.equal(f.schedule.information.page('a', { category: 'information', search: '原文编号25' }).total, 1);
  assert.equal(f.schedule.information.page('a', { category: 'information', search: '%' }).total, 0);
  for (const query of [{ category: 'unknown' }, { category: 'information', offset: -1 }, { category: 'information', offset: 0.5 }]) {
    assert.equal(informationQuerySchema.safeParse(query).success, false);
  }
});

test('first upgrade locally backfills completed pushes and unresolved sources, without enabling processing or re-extraction', async t => {
  const f = await fixture(t);
  const messages = [ad, 'https://mp.weixin.qq.com/s/old-read', '[图片]', '谢谢'].map((text, index) => normalizeMessage(sample(index + 1, text), 'a'));
  f.messages.put(messages); f.schedule.enqueue('a');
  f.schedule.complete(f.schedule.claim('a')!, result());
  f.schedule.complete(f.schedule.claim('a')!, result());
  f.schedule.complete(f.schedule.claim('a')!, result({ warnings: ['旧图片未读全'], reviewReasons: ['原图缺失'] }));
  f.schedule.complete(f.schedule.claim('a')!, result());
  f.schedule.close();
  const db = new DatabaseSync(f.file);
  db.exec('DROP TABLE recruiting_information');
  db.close();
  f.schedule = new ScheduleStore(f.file);
  assert.deepEqual(f.schedule.information.page('a', { category: 'information' }).counts, { information: 2, incomplete: 1 });
  assert.equal(f.schedule.status('a').enabled, false);
  assert.equal(f.schedule.status('a').pending, 0);
  assert.equal(f.schedule.information.detail('a', messages[2].key)!.reason, '原图缺失');
});

test('article titles replace generic link names, survive reread failures and fill existing cards without changing status', async t => {
  const f = await fixture(t);
  const url = 'https://mp.weixin.qq.com/s/title-source';
  const message = normalizeMessage(sample(1, url), 'a');
  f.messages.put([message]); f.schedule.enqueue('a');
  f.schedule.complete(f.schedule.claim('a')!, result({
    information: { title: '招聘资讯', summary: '' }, warnings: ['图片未读全'], reviewReasons: ['图片未读全'],
    materials: [{ url, kind: 'page', title: '星河研究院2027届招聘公告' }],
  }));
  assert.equal(f.schedule.information.detail('a', message.key)!.item.title, '星河研究院2027届招聘公告');
  f.schedule.retry('a');
  f.schedule.fail({ ...f.schedule.claim('a')!, attempts: 3 }, '服务失败');
  assert.equal(f.schedule.information.detail('a', message.key)!.item.title, '星河研究院2027届招聘公告');
  const db = new DatabaseSync(f.file);
  db.prepare("UPDATE recruiting_information SET title='公众号与网页推送'").run(); db.close();
  const target = f.schedule.information.titleRequests('a', [message.key])[0];
  assert.equal(target.title, '星河研究院2027届招聘公告');
  assert.equal(f.schedule.information.applyTitle('a', target, target.title!), true);
  assert.equal(f.schedule.information.detail('a', message.key)!.item.processingState, 'failed');
  assert.equal(f.schedule.information.applyTitle('b', target, '跨账号标题'), false);
});
