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
import { addDays, chinaToday, weekStart, type ActivityInput } from '../src/schedule';
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
    else schedule.close();
    messages.close();
    await rm(root, { recursive: true, force: true });
  });
  return value;
}

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
