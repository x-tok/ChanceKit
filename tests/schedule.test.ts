import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { Store, normalizeMessage } from '../electron/core/store';
import { ScheduleStore, type ExtractionResult } from '../electron/core/schedule-store';
import { ScheduleProcessor } from '../electron/core/schedule-processor';
import { activitySchema } from '../electron/core/activity-schema';
import { activityTimeLabel, activityTypes, addDays, calendarWindowStart, chinaToday, isOngoingActivity, scheduleProcessingVersion, weekStart, type ActivityInput } from '../src/schedule';
import { defaultModelConfig } from '../src/model-config';
import { sample } from './fixtures';

export const activityFixture: ActivityInput = {
  title: '星河科技校园宣讲会', type: '宣讲会', organizer: '星河科技',
  startDate: '2026-09-24', endDate: null, startTime: '14:30', endTime: '16:00',
  location: '大学生活动中心 201', audience: '2027 届毕业生', description: '技术岗位宣讲与现场答疑',
  registrationUrl: null, deadline: null, evidence: '9 月 24 日 14:30，大学生活动中心 201',
};
const result = (activities = [activityFixture], warnings: string[] = []): ExtractionResult => ({ activities, warnings, materials: [] });
const settings = { config: defaultModelConfig, apiKey: 'test-private-key', updatedAt: new Date().toISOString() };
const waitUntil = async (predicate: () => boolean, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-schedule-'));
  const file = path.join(root, 'messages.sqlite');
  const messages = new Store(file);
  messages.saveGroups('a', [{ group_id: 731234567, group_name: '关注群' }, { group_id: 731234568, group_name: '未关注群' }]);
  messages.follow('a', '731234567', true);
  const schedule = new ScheduleStore(file);
  const value = { file, messages, schedule, processor: undefined as ScheduleProcessor | undefined };
  t.after(async () => {
    if (value.processor) await value.processor.close();
    else value.schedule.close();
    messages.close();
    await rm(root, { recursive: true, force: true });
  });
  return value;
}

test('diagnostics are retained without partial status; empty incomplete rereads preserve previous activities', async t => {
  const f = await fixture(t);
  f.messages.put([normalizeMessage(sample(1, '活动通知'), 'a')]);
  f.schedule.enqueue('a');
  f.schedule.complete(f.schedule.claim('a')!, { ...result(), warnings: ['补充海报未展开'], reviewReasons: [] });
  assert.equal(f.schedule.status('a').completed, 1);
  const saved = f.schedule.page('a', { week: '2026-09-21' }).activities[0];
  assert.equal(saved.needsReview, false);
  assert.deepEqual(f.schedule.detail('a', saved.id)!.sources[0].warnings, ['补充海报未展开']);
  const db = new DatabaseSync(f.file);
  try {
    assert.match(String(db.prepare('SELECT diagnostics FROM schedule_jobs').get()!.diagnostics), /海报/);
    db.prepare("UPDATE schedule_jobs SET status='partial'").run();
    f.schedule.retry('a');
    f.schedule.complete(f.schedule.claim('a')!, { ...result([]), warnings: ['图片读取失败'], reviewReasons: ['海报信息未确认'] });
    assert.equal(f.schedule.status('a').partial, 1);
    assert.equal(f.schedule.page('a', { week: '2026-09-21' }).activities[0].id, saved.id);
    assert.equal(f.schedule.detail('a', saved.id)!.activity.needsReview, true);
    f.schedule.retry('a');
    f.schedule.complete(f.schedule.claim('a')!, { ...result([]), reviewReasons: [] });
    assert.equal(f.schedule.page('a', { week: '2026-09-21' }).activities.length, 0);
  } finally { db.close(); }
});

test('upgrade retries require enabled processing and are account/group scoped and once per version', async t => {
  const f = await fixture(t);
  f.messages.saveGroups('b', [{ group_id: 731234567, group_name: '其他账号' }]);
  f.messages.follow('b', '731234567', true);
  f.messages.follow('a', '731234568', true);
  f.messages.put([normalizeMessage(sample(1, 'a'), 'a'), normalizeMessage(sample(2, 'hidden', 731234568), 'a'), normalizeMessage(sample(3, 'b'), 'b')]);
  f.schedule.enqueue('a'); f.schedule.enqueue('b');
  f.messages.follow('a', '731234568', false);
  const db = new DatabaseSync(f.file);
  try {
    db.exec("UPDATE schedule_jobs SET status='failed',processing_version=0,attempts=3,error='old read failure'");
    f.schedule.enqueue('a');
    assert.equal(f.schedule.status('a').failed, 1);
    f.schedule.configure('a', { enabled: true, concurrency: 1 });
    f.schedule.enqueue('a');
    assert.equal(f.schedule.status('a').pending, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM schedule_jobs WHERE status='failed'").get()!.n, 2);
    const job = f.schedule.claim('a')!;
    f.schedule.fail({ ...job, attempts: 3 }, 'still unreadable');
    f.schedule.enqueue('a');
    assert.equal(f.schedule.status('a').failed, 1);
    assert.equal(db.prepare('SELECT processing_version FROM schedule_jobs WHERE message_key=?').get(job.message.key)!.processing_version, scheduleProcessingVersion);
  } finally { db.close(); }
});

test('legacy migration resolves locally grounded notices without losing evidence or diagnostic warnings', async t => {
  const f = await fixture(t);
  const text = '星河科技校园宣讲会，2026年9月24日14:30-16:00，大学生活动中心201，欢迎毕业生参加。';
  f.messages.put([normalizeMessage(sample(1, text), 'a'), normalizeMessage(sample(2, 'https://example.com/unknown'), 'a')]);
  f.schedule.enqueue('a');
  f.schedule.complete(f.schedule.claim('a')!, result([{ ...activityFixture, evidence: '2026年9月24日14:30-16:00；来自其他来源的说明' }], ['补充图片无法辨认']));
  f.schedule.complete(f.schedule.claim('a')!, result([], ['图片读取失败']));
  f.schedule.close();
  const db = new DatabaseSync(f.file);
  db.exec('ALTER TABLE schedule_jobs DROP COLUMN processing_version; ALTER TABLE schedule_jobs DROP COLUMN diagnostics');
  db.close();
  f.schedule = new ScheduleStore(f.file);
  assert.equal(f.schedule.status('a').completed, 1);
  assert.equal(f.schedule.status('a').partial, 1);
  const saved = f.schedule.page('a', { week: '2026-09-21' }).activities[0];
  assert.equal(saved.needsReview, false);
  assert.match(f.schedule.detail('a', saved.id)!.sources[0].evidence, /其他来源/);
  assert.deepEqual(f.schedule.detail('a', saved.id)!.sources[0].warnings, ['补充图片无法辨认']);
});

test('dates use China time, Monday weeks, leap days and year boundaries', () => {
  assert.equal(chinaToday(new Date('2026-09-19T18:00:00Z')), '2026-09-20');
  assert.equal(weekStart('2026-09-20'), '2026-09-14');
  assert.equal(weekStart('2026-09-21'), '2026-09-21');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  for (const update of [{ startDate: '2026-02-30' }, { startTime: '25:00' }, { startDate: null }, { endDate: '2026-09-23' }, { endTime: '12:00' }, { registrationUrl: 'javascript:alert(1)' }]) {
    assert.equal(activitySchema.safeParse({ ...activityFixture, ...update }).success, false);
  }
});

test('only multiday other activities are ongoing; named sessions, single dates and unknown dates remain calendar items', () => {
  const window: ActivityInput = { ...activityFixture, type: '其他', startDate: '2026-09-09', endDate: '2026-10-15', startTime: null, endTime: null };
  assert.equal(isOngoingActivity(window), true);
  assert.equal(isOngoingActivity({ ...window, endTime: '18:00' }), true);
  for (const type of activityTypes.filter(type => type !== '其他')) assert.equal(isOngoingActivity({ ...window, type }), false);
  for (const dates of [{ startDate: null, endDate: null }, { startDate: '2026-09-09', endDate: null }, { startDate: '2026-09-09', endDate: '2026-09-09' }]) {
    assert.equal(isOngoingActivity({ ...window, ...dates }), false);
  }
});

test('centered date windows handle month/year bounds and structured times retain missing endpoints', () => {
  assert.equal(calendarWindowStart('2026-09-21'), '2026-09-18');
  assert.equal(calendarWindowStart('2027-01-01'), '2026-12-29');
  assert.equal(calendarWindowStart('1970-01-01'), '1970-01-01');
  assert.equal(calendarWindowStart('2100-12-31'), '2100-12-25');
  for (const [startTime, endTime, label] of [
    ['14:30', '16:00', '14:30–16:00'], ['14:30', null, '14:30'],
    [null, '16:00', '未定–16:00'], [null, null, '未定'],
  ]) {
    const value = activitySchema.parse({ ...activityFixture, startTime, endTime });
    assert.equal(activityTimeLabel(value), label);
  }
  assert.equal(activitySchema.safeParse({ ...activityFixture, startTime: '未定' }).success, false);
});

test('seven-day pages include readable original sources with the same account and group filters as activities', async t => {
  const f = await fixture(t);
  f.messages.follow('a', '731234568', true);
  const messages = [normalizeMessage(sample(1, '原始通知：周四14:30宣讲'), 'a'),
    normalizeMessage(sample(2, 'https://example.com/recruit#/campus', 731234568), 'a')];
  f.messages.put(messages);
  f.schedule.enqueue('a');
  f.schedule.complete(f.schedule.claim('a')!, result());
  f.schedule.complete(f.schedule.claim('a')!, result());
  const page = f.schedule.page('a', { week: '2026-09-18' });
  assert.equal(page.activities.length, 1);
  const id = page.activities[0].id;
  assert.deepEqual(new Set(page.sources![id].map(source => source.text)), new Set(messages.map(message => message.text)));
  assert.ok(page.sources![id].every(source => !('raw' in source)));
  assert.equal(f.schedule.page('a', { week: '2026-09-18', groupId: '731234567' }).sources![id].length, 1);
  assert.deepEqual(f.schedule.page('b', { week: '2026-09-18' }).sources, {});
  assert.deepEqual(f.schedule.page('a', { week: '2026-09-18', search: '不存在' }).sources, {});
  f.messages.follow('a', '731234568', false);
  assert.deepEqual(f.schedule.page('a', { week: '2026-09-18' }).sources![id].map(source => source.text), [messages[0].text]);
});

test('existing ongoing records retain weekly filters and sources without requiring clock times or suppressing real warnings', async t => {
  const { messages, schedule } = await fixture(t);
  messages.put([normalizeMessage(sample(1, '网上报名周期'), 'a'), normalizeMessage(sample(2, '需核对的报名周期'), 'a'), normalizeMessage(sample(3, '跨天双选会'), 'a')]);
  schedule.enqueue('a');
  const window: ActivityInput = { ...activityFixture, type: '其他', title: '海岳能源网上报名', startDate: '2026-09-09', endDate: '2026-10-15', startTime: null, endTime: null };
  schedule.complete(schedule.claim('a')!, result([window]));
  schedule.complete(schedule.claim('a')!, result([{ ...window, title: '研究院网上报名' }], ['来源图片需核对']));
  schedule.complete(schedule.claim('a')!, result([{ ...window, title: '秋季双选会', type: '双选会' }]));
  const page = schedule.page('a', { week: '2026-09-21' });
  const ongoing = page.activities.filter(isOngoingActivity);
  assert.equal(ongoing.length, 2);
  const clean = ongoing.find(activity => activity.title === window.title)!;
  assert.equal(clean.needsReview, false);
  assert.equal(schedule.detail('a', clean.id)!.sources.length, 1);
  assert.equal(ongoing.find(activity => activity.title !== window.title)!.needsReview, true);
  assert.equal(page.activities.find(activity => activity.type === '双选会')!.needsReview, true);
  assert.equal(schedule.page('a', { week: '2026-10-12', search: '海岳', type: '其他', groupId: '731234567' }).activities.length, 1);
  assert.equal(schedule.page('a', { week: '2026-10-19' }).activities.length, 0);
  assert.equal(schedule.page('a', { week: '2026-08-31' }).activities.length, 0);
  assert.equal(schedule.page('a', { week: '2026-09-21', groupId: '731234568' }).activities.length, 0);
});

test('existing SQLite v1 archives migrate without losing messages, groups or follow state', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-schedule-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'messages.sqlite');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE messages(key TEXT PRIMARY KEY,account_id TEXT,group_id TEXT,time INTEGER,text TEXT,payload TEXT); PRAGMA user_version=1');
  const message = normalizeMessage(sample(1, '归档消息'), 'a');
  old.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(message.key, 'a', message.groupId, message.time, message.text, JSON.stringify(message));
  old.close();
  const messages = new Store(file);
  try {
    assert.equal(messages.count('a'), 1);
    const inspect = new DatabaseSync(file);
    assert.equal(String(inspect.prepare('SELECT content_hash FROM messages').get()?.content_hash).length, 64);
    inspect.close();
    assert.equal(messages.put([message]), 0);
  } finally { messages.close(); }
});

test('jobs are scoped to followed groups and accounts, deduplicate replay and requeue edited messages', async t => {
  const { messages, schedule } = await fixture(t);
  const message = normalizeMessage(sample(1, '活动通知'), 'a');
  messages.put([message, normalizeMessage(sample(2, '非关注通知', 731234568), 'a'), normalizeMessage(sample(3, '其他账号'), 'b')]);
  schedule.enqueue('a');
  assert.equal(schedule.status('a').pending, 1);
  const job = schedule.claim('a')!;
  assert.equal(job.context.length, 0);
  schedule.complete(job, result());
  messages.put([normalizeMessage(sample(1, '活动通知'), 'a')]);
  schedule.enqueue('a');
  assert.equal(schedule.status('a').completed, 1);
  assert.equal(schedule.claim('a'), undefined);
  messages.put([normalizeMessage(sample(1, '活动通知已更新'), 'a')]);
  schedule.enqueue('a');
  assert.equal(schedule.status('a').pending, 1);
  const edited = schedule.claim('a')!;
  assert.notEqual(edited.hash, job.hash);
  assert.equal(schedule.complete(job, result()), false);
  schedule.complete(edited, result([]));
  assert.equal(schedule.page('a', { week: '2026-09-21' }).activities.length, 0);
});

test('activities merge cross-posts with provenance, support multiday/undated filters and hide unfollowed sources', async t => {
  const { messages, schedule } = await fixture(t);
  messages.follow('a', '731234568', true);
  messages.put([normalizeMessage(sample(1, '宣讲会'), 'a'), normalizeMessage(sample(2, '转发宣讲会', 731234568), 'a')]);
  schedule.enqueue('a');
  schedule.complete(schedule.claim('a')!, result());
  schedule.complete(schedule.claim('a')!, result());
  const page = schedule.page('a', { week: '2026-09-21' });
  assert.equal(page.activities.length, 1);
  assert.equal(page.activities[0].sourceCount, 2);
  assert.equal(schedule.detail('b', page.activities[0].id), null);
  assert.equal(schedule.page('a', { week: '2026-09-21', type: '笔试' }).activities.length, 0);
  assert.equal(schedule.page('a', { week: '2026-09-21', search: '星河' }).activities.length, 1);
  messages.follow('a', '731234568', false);
  assert.equal(schedule.detail('a', page.activities[0].id)!.sources.length, 1);
  messages.put([normalizeMessage(sample(3, '跨周招聘会'), 'a'), normalizeMessage(sample(4, '时间待定'), 'a')]);
  schedule.enqueue('a');
  schedule.complete(schedule.claim('a')!, result([{ ...activityFixture, title: '跨周招聘会', startDate: '2026-09-20', endDate: '2026-09-22' }]));
  schedule.complete(schedule.claim('a')!, result([{ ...activityFixture, title: '待定活动', startDate: null, startTime: null, endTime: null }]));
  assert.equal(schedule.page('a', { week: '2026-09-21' }).activities.length, 2);
  assert.equal(schedule.page('a', { week: '2026-09-28' }).undated.length, 1);
  messages.follow('a', '731234567', false);
  assert.equal(schedule.page('a', { week: '2026-09-21' }).activities.length, 0);
});

test('failed attempts back off, stop after three and can be retried; interrupted leases recover on restart', async t => {
  const { messages, schedule, file } = await fixture(t);
  messages.put([normalizeMessage(sample(1, '通知'), 'a')]);
  schedule.enqueue('a');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const job = schedule.claim('a', Number.MAX_SAFE_INTEGER)!;
    assert.equal(job.attempts, attempt);
    schedule.fail(job, '模拟网络错误');
    assert.equal(schedule.claim('a', 0), undefined);
  }
  assert.equal(schedule.status('a').failed, 1);
  schedule.retry('a');
  const job = schedule.claim('a')!;
  assert.equal(job.attempts, 1);
  const restarted = new ScheduleStore(file);
  try {
    assert.equal(restarted.status('a').pending, 1);
    assert.equal(restarted.claim('a')!.attempts, 1);
  } finally { restarted.close(); }
  schedule.release(job);
});

test('zero activities with unread sources remain partial and retryable instead of completed', async t => {
  const { messages, schedule } = await fixture(t);
  const message = normalizeMessage(sample(1, '[图片]'), 'a');
  messages.put([message]);
  schedule.enqueue('a');
  schedule.complete(schedule.claim('a')!, result([], ['来源图片补读后仍未返回有效文字，需核对原图。']));
  assert.equal(schedule.status('a').partial, 1);
  assert.equal(schedule.status('a').completed, 0);
  assert.equal(schedule.page('a', { week: '2026-09-21' }).activities.length, 0);
  schedule.retry('a', message.key);
  const retry = schedule.claim('a')!;
  assert.equal(retry.attempts, 1);
  schedule.complete(retry, result([]));
  assert.equal(schedule.status('a').partial, 0);
  assert.equal(schedule.status('a').completed, 1);
});

test('unfollow and content changes prevent a stale running job from committing', async t => {
  const { messages, schedule } = await fixture(t);
  messages.put([normalizeMessage(sample(1, '通知'), 'a')]);
  schedule.enqueue('a');
  const job = schedule.claim('a')!;
  messages.follow('a', '731234567', false);
  assert.equal(schedule.complete(job, result()), false);
  schedule.release(job);
  messages.follow('a', '731234567', true);
  const second = schedule.claim('a')!;
  messages.put([normalizeMessage(sample(1, '新通知'), 'a')]);
  assert.equal(schedule.complete(second, result()), false);
});

test('processor actually runs messages concurrently within limit and pause prevents late commits', async t => {
  const f = await fixture(t);
  f.messages.put(Array.from({ length: 7 }, (_, i) => normalizeMessage(sample(i + 1, '通知'), 'a')));
  let active = 0;
  let peak = 0;
  let started = 0;
  f.processor = new ScheduleProcessor(f.schedule, async () => settings, async (_job, _settings, signal) => {
    active++; started++; peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 90));
      // Deliberately return even after cancellation; the lease must still reject this result.
      return result([], signal.aborted ? ['aborted'] : []);
    } finally { active--; }
  }, () => {});
  f.processor.setAccount('a');
  await f.processor.configure({ enabled: true, concurrency: 3 });
  await waitUntil(() => started === 3);
  assert.equal(peak, 3);
  await f.processor.configure({ enabled: false, concurrency: 3 });
  await waitUntil(() => active === 0 && f.schedule.status('a').running === 0);
  assert.equal(f.schedule.status('a').completed, 0);
  assert.equal(f.schedule.status('a').pending, 7);
  await f.processor.configure({ enabled: true, concurrency: 2 });
  await waitUntil(() => f.schedule.status('a').completed === 7);
  assert.equal(f.schedule.status('a').pending, 0);
  assert.equal(peak, 3);
});

test('model configuration is required, account changes cancel jobs and partial results remain retryable', async t => {
  const f = await fixture(t);
  f.messages.put([normalizeMessage(sample(1, '通知'), 'a')]);
  let credentialReady = false;
  f.processor = new ScheduleProcessor(f.schedule, async () => credentialReady ? settings : null, async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    return result([activityFixture], ['网页图片无法读取']);
  }, () => {});
  f.processor.setAccount('a');
  await assert.rejects(f.processor.configure({ enabled: true, concurrency: 1 }), /API Key/);
  credentialReady = true;
  await f.processor.configure({ enabled: true, concurrency: 1 });
  await waitUntil(() => f.schedule.status('a').running === 1);
  f.processor.setAccount('b');
  await waitUntil(() => f.schedule.status('a').running === 0);
  assert.equal(f.schedule.page('a', { week: '2026-09-21' }).activities.length, 0);
  f.processor.setAccount('a');
  await waitUntil(() => f.schedule.status('a').partial === 1);
  assert.equal(f.schedule.status('a').issues[0].error, '网页图片无法读取');
  assert.equal(f.schedule.page('a', { week: '2026-09-21' }).activities[0].needsReview, true);
});

test('an edited message cancels its old lease without overlapping the replacement or losing queue capacity', async t => {
  const f = await fixture(t);
  f.messages.put([normalizeMessage(sample(1, '旧通知'), 'a')]);
  let active = 0, peak = 0, started = 0;
  f.processor = new ScheduleProcessor(f.schedule, async () => settings, async current => {
    active++; started++; peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 70));
      return result([{ ...activityFixture, title: current.message.text }]);
    } finally { active--; }
  }, () => {});
  f.processor.setAccount('a');
  await f.processor.configure({ enabled: true, concurrency: 3 });
  await waitUntil(() => started === 1);
  f.messages.put([normalizeMessage(sample(1, '新通知'), 'a')]);
  f.processor.refresh();
  await waitUntil(() => f.schedule.status('a').completed === 1);
  assert.equal(started, 2);
  assert.equal(peak, 1);
  assert.deepEqual(f.schedule.page('a', { week: '2026-09-21' }).activities.map(event => event.title), ['新通知']);
});
