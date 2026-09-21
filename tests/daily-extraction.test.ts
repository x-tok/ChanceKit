import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, normalizeMessage } from '../electron/core/archive/store';
import { ScheduleStore } from '../electron/core/processing/schedule-store';
import { DailyScheduleStore, beijingSourceDay } from '../electron/core/processing/daily-extraction/queue/store';
import { classifySourceLink } from '../electron/core/processing/daily-extraction/agent/link-classifier';
import { buildDailyPromptPayload } from '../electron/core/processing/daily-extraction/agent/prompt';
import { humanMaterialText, humanMessageText } from '../electron/core/processing/daily-extraction/agent/source-builder';
import { splitDailySources } from '../electron/core/processing/daily-extraction/agent/run';
import { sameRecruitingEvent } from '../electron/core/processing/daily-extraction/dedupe';
import { DailyScheduleProcessor } from '../electron/core/processing/daily-extraction/queue/processor';
import { createReadSourceLinksTool } from '../electron/core/processing/daily-extraction/agent/tools/read-source-links';
import { DAILY_AGENT_TOOL_NAMES } from '../electron/core/processing/daily-extraction/agent/tools/index';
import type { DailyExtractionResult, DailyProcessingJob, PreparedDailySource } from '../electron/core/processing/daily-extraction/types';
import type { ActivityInput } from '../src/schedule';
import { sample } from './fixtures';
import { defaultModelConfig } from '../src/model-config';

const activity: ActivityInput = {
  title: '星河科技 2027 届校园宣讲会', type: '宣讲会', organizer: '星河科技',
  startDate: '2026-09-24', endDate: null, startTime: '14:30', endTime: '16:00',
  location: '大学生活动中心 201', audience: '2027 届毕业生', description: '技术岗位宣讲与交流',
  registrationUrl: 'https://jobs.example.com/campus/apply', deadline: null,
  evidence: '9 月 24 日 14:30，大学生活动中心 201',
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-daily-'));
  const file = path.join(root, 'messages.sqlite');
  const messages = new Store(file);
  messages.saveGroups('a', [
    { group_id: 731234567, group_name: '就业信息一群' },
    { group_id: 731234568, group_name: '就业信息二群' },
  ]);
  messages.follow('a', '731234567', true);
  messages.follow('a', '731234568', true);
  const schedule = new ScheduleStore(file);
  const daily = new DailyScheduleStore(file);
  const value = { messages, schedule, daily, processor: undefined as DailyScheduleProcessor | undefined };
  t.after(async () => {
    if (value.processor) await value.processor.close(); else daily.close();
    schedule.close(); messages.close();
    await rm(root, { recursive: true, force: true });
  });
  return value;
}

async function waitUntil(predicate: () => boolean, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function prepared(job: DailyProcessingJob): PreparedDailySource[] {
  return job.messages.map(source => ({
    ...source, displayTime: '2026-09-21 12:00:00', text: source.message.text,
    links: [], extractedContent: '', materials: [], warnings: [],
  }));
}

function result(job: DailyProcessingJob, activities = [{ ...activity, sourceRefs: job.messages.map(source => source.ref) }]): DailyExtractionResult {
  return { activities, information: [], sources: prepared(job), warnings: [], reviewReasons: [] };
}

test('Beijing calendar boundaries create one deterministic job per day', async t => {
  const { messages, daily } = await fixture(t);
  const first = normalizeMessage({ ...sample(1, '午夜前'), time: Date.parse('2026-09-20T15:59:59Z') / 1000 }, 'a');
  const second = normalizeMessage({ ...sample(2, '午夜后'), time: Date.parse('2026-09-20T16:00:00Z') / 1000 }, 'a');
  const third = normalizeMessage({ ...sample(3, '同一天'), time: Date.parse('2026-09-21T05:00:00Z') / 1000 }, 'a');
  messages.put([first, second, third]);
  assert.equal(beijingSourceDay(first.time), '2026-09-20');
  assert.equal(beijingSourceDay(second.time), '2026-09-21');
  daily.enqueue('a');
  assert.equal(daily.status('a').pending, 2);
  const dayOne = daily.claim('a')!;
  assert.equal(dayOne.sourceDay, '2026-09-20');
  assert.equal(dayOne.messages.length, 1);
  daily.complete(dayOne, result(dayOne, []));
  const dayTwo = daily.claim('a')!;
  assert.equal(dayTwo.sourceDay, '2026-09-21');
  assert.equal(dayTwo.messages.length, 2);
});

test('editing one message requeues only its day and stale daily leases cannot commit', async t => {
  const { messages, daily } = await fixture(t);
  const first = normalizeMessage({ ...sample(1, '第一天'), time: Date.parse('2026-09-20T04:00:00Z') / 1000 }, 'a');
  const second = normalizeMessage({ ...sample(2, '第二天'), time: Date.parse('2026-09-21T04:00:00Z') / 1000 }, 'a');
  messages.put([first, second]); daily.enqueue('a');
  const old = daily.claim('a')!;
  messages.put([normalizeMessage({ ...sample(1, '第一天已更新'), time: first.time }, 'a')]);
  daily.enqueue('a');
  assert.equal(daily.complete(old, result(old)), false);
  const replacement = daily.claim('a')!;
  assert.equal(replacement.sourceDay, old.sourceDay);
  daily.complete(replacement, result(replacement, []));
  const untouched = daily.claim('a')!;
  assert.equal(untouched.sourceDay, '2026-09-21');
});

test('same-event reposts merge into one row and retain every human source', async t => {
  const { messages, schedule, daily } = await fixture(t);
  const time = Date.parse('2026-09-21T04:00:00Z') / 1000;
  messages.put([
    normalizeMessage({ ...sample(1, '星河科技宣讲会通知'), time }, 'a'),
    normalizeMessage({ ...sample(2, '转发：星河科技校园专场'), time: time + 60, group_id: 731234568 }, 'a'),
  ]);
  daily.enqueue('a');
  const job = daily.claim('a')!;
  daily.complete(job, result(job));
  const page = schedule.page('a', { week: '2026-09-21' });
  assert.equal(page.activities.length, 1);
  assert.equal(page.activities[0].sourceCount, 2);
  assert.deepEqual(new Set(schedule.detail('a', page.activities[0].id)!.sources.map(source => source.groupName)),
    new Set(['就业信息一群', '就业信息二群']));
});

test('cross-day wording variants deduplicate by event facts without merging conflicting sessions', async t => {
  const { messages, schedule, daily } = await fixture(t);
  const times = [Date.parse('2026-09-20T04:00:00Z') / 1000, Date.parse('2026-09-21T04:00:00Z') / 1000];
  messages.put(times.map((time, index) => normalizeMessage({ ...sample(index + 1, `第 ${index + 1} 次转发`), time }, 'a')));
  daily.enqueue('a');
  const first = daily.claim('a')!;
  daily.complete(first, result(first, [{ ...activity, title: '星河科技校园宣讲会', sourceRefs: [1] }]));
  const second = daily.claim('a')!;
  daily.complete(second, result(second, [{ ...activity, title: '星河科技 2027 届秋季校园专场宣讲会', sourceRefs: [1] }]));
  const page = schedule.page('a', { week: '2026-09-21' });
  assert.equal(page.activities.length, 1);
  assert.equal(page.activities[0].sourceCount, 2);
  assert.equal(sameRecruitingEvent(activity, { ...activity, startTime: '18:30' }), false);
});

test('daily prompt contains only numbered human evidence and classified links', () => {
  const message = normalizeMessage({ ...sample(1, '请报名 https://jobs.example.com/campus/apply'),
    message: [
      { type: 'text', data: { text: '请报名 https://jobs.example.com/campus/apply' } },
      { type: 'json', data: { data: JSON.stringify({ appid: 'secret-app-id', title: '公众号招聘通知', jumpUrl: 'https://mp.weixin.qq.com/s/demo' }) } },
    ], message_id: 987654, sender: { user_id: 123456789, nickname: '就业老师' },
  }, 'account-secret');
  const source: PreparedDailySource = {
    ref: 1, message, contentHash: 'content-secret', groupName: '就业群', displayTime: '2026-09-21 15:00:00',
    text: humanMessageText({ ref: 1, message, contentHash: 'content-secret', groupName: '就业群' }),
    links: [
      { url: 'https://jobs.example.com/campus/apply', kind: 'registration' },
      { url: 'https://mp.weixin.qq.com/s/demo', kind: 'wechat-article' },
    ],
    extractedContent: humanMaterialText('\n分享卡片：{"message_id":"bad","title":"招聘"}\n网页正文'),
    materials: [], warnings: [],
  };
  const prompt = JSON.stringify(buildDailyPromptPayload('2026-09-21', [source]));
  for (const forbidden of [message.key, message.externalId, message.accountId, message.groupId, message.senderId,
    'content-secret', 'message_id', 'secret-app-id']) assert.equal(prompt.includes(forbidden), false, forbidden);
  assert.match(prompt, /公众号招聘通知/);
  assert.match(prompt, /报名或投递入口/);
  assert.match(prompt, /微信公众号文章/);
});

test('links are classified before reading and oversized days split in stable source order', () => {
  assert.equal(classifySourceLink('https://mp.weixin.qq.com/s/abc'), 'wechat-article');
  assert.equal(classifySourceLink('https://example.com/poster.png?x=1'), 'direct-image');
  assert.equal(classifySourceLink('https://jobs.example.com/campus/apply?id=1'), 'registration');
  assert.equal(classifySourceLink('https://example.com/news/1'), 'webpage');
  const message = normalizeMessage(sample(10, '批次测试'), 'a');
  const sources: PreparedDailySource[] = [1, 2, 3].map(ref => ({
    ref, message, contentHash: `hash-${ref}`, groupName: '测试群', displayTime: '2026-09-21 12:00:00',
    text: 'x'.repeat(80), extractedContent: '', links: [], materials: [], warnings: [],
  }));
  assert.deepEqual(splitDailySources(sources, 500).map(chunk => chunk.map(source => source.ref)), [[1], [2], [3]]);
});

test('daily agent exposes two focused tools and link reader stays within source evidence', async () => {
  assert.deepEqual(DAILY_AGENT_TOOL_NAMES, ['read_source_links', 'submit_daily_activities']);
  const message = normalizeMessage(sample(10, '详情 https://example.com/jobs'), 'a');
  const source: PreparedDailySource = {
    ref: 1, message, contentHash: 'hash', groupName: '测试群', displayTime: '2026-09-21 12:00:00',
    text: message.text, extractedContent: '', materials: [], warnings: [],
    links: [{ url: 'https://example.com/jobs', kind: 'webpage' }],
  };
  const calls: string[] = [];
  const download = async (url: string) => {
    calls.push(url);
    const html = url.endsWith('/jobs')
      ? '<article><h1>秋季宣讲会</h1><p>9月24日 14:30 大学生活动中心</p><a href="/apply">报名</a></article>'
      : '<main><h1>报名表</h1><p>报名截止至9月23日</p></main>';
    return { url, contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(html) };
  };
  const tool = createReadSourceLinksTool([source], { config: { ...defaultModelConfig, imageInput: false }, apiKey: 'test-key', updatedAt: '' }, {
    signal: new AbortController().signal, download,
  });
  const first = await tool.execute('1', { requests: [{ sourceRef: 1, url: 'https://example.com/jobs' }] });
  assert.match((first.content[0] as { text: string }).text, /秋季宣讲会/);
  assert.match((first.content[0] as { text: string }).text, /https:\/\/example\.com\/apply/);
  const child = await tool.execute('2', { requests: [{ sourceRef: 1, url: 'https://example.com/apply' }] });
  assert.match((child.content[0] as { text: string }).text, /报名截止/);
  await assert.rejects(tool.execute('3', { requests: [{ sourceRef: 1, url: 'https://unrelated.example/news' }] }), /只能读取/);
  await assert.rejects(tool.execute('4', { requests: [{ sourceRef: 1, url: 'http:\/\/127.0.0.1/private' }] }), /公开网页地址/);
  assert.deepEqual(calls, ['https://example.com/jobs', 'https://example.com/apply']);
});

test('processor runs different days concurrently while keeping one lease per day', async t => {
  const f = await fixture(t);
  const start = Date.parse('2026-09-19T04:00:00Z') / 1000;
  f.messages.put([0, 1, 2].map(index => normalizeMessage({ ...sample(index + 1, `第 ${index + 1} 天`), time: start + index * 86400 }, 'a')));
  let active = 0, peak = 0;
  const settings = { config: defaultModelConfig, apiKey: 'test-key', updatedAt: new Date().toISOString() };
  f.processor = new DailyScheduleProcessor(f.daily, async () => settings, async job => {
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 50)); return result(job, []); }
    finally { active--; }
  }, () => {});
  f.processor.setAccount('a');
  await f.processor.configure({ enabled: true, concurrency: 2 });
  await waitUntil(() => f.daily.status('a').completed === 3);
  assert.equal(peak, 2);
  assert.equal(f.daily.status('a').running, 0);
});
