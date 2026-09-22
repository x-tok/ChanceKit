import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { Store, normalizeMessage } from '../electron/core/archive/store';
import { ScheduleStore } from '../electron/core/processing/schedule-store';
import { DailyScheduleStore, beijingSourceDay } from '../electron/core/processing/daily-extraction/queue/store';
import { classifySourceLink } from '../electron/core/processing/daily-extraction/agent/link-classifier';
import { buildDailyPromptPayload } from '../electron/core/processing/daily-extraction/agent/prompt';
import { buildDailySources, humanMaterialText, humanMessageText } from '../electron/core/processing/daily-extraction/agent/source-builder';
import { dailyPromptCharBudget, extractDailyActivities, parseDailyTextSubmission, splitDailySources } from '../electron/core/processing/daily-extraction/agent/run';
import { sameRecruitingEvent } from '../electron/core/processing/daily-extraction/dedupe';
import { DailyScheduleProcessor } from '../electron/core/processing/daily-extraction/queue/processor';
import { createReadSourceLinksTool } from '../electron/core/processing/daily-extraction/agent/tools/read-source-links';
import { DAILY_AGENT_TOOL_NAMES } from '../electron/core/processing/daily-extraction/agent/tools/index';
import { parseDailySubmission } from '../electron/core/processing/daily-extraction/agent/tools/submit-daily-activities';
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
  const value = { root, file, messages, schedule, daily, processor: undefined as DailyScheduleProcessor | undefined };
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
  return { activities, sources: prepared(job), warnings: [], reviewReasons: [] };
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
  daily.release(old);
  daily.enqueue('a');
  const replacement = daily.claim('a')!;
  assert.equal(replacement.sourceDay, old.sourceDay);
  daily.complete(replacement, result(replacement, []));
  const untouched = daily.claim('a')!;
  assert.equal(untouched.sourceDay, '2026-09-21');
});

test('a later same-day sync processes only new messages and deduplicates its activity', async t => {
  const { messages, schedule, daily } = await fixture(t);
  const time = Date.parse('2026-09-21T04:00:00Z') / 1000;
  const original = normalizeMessage({ ...sample(1, '星河科技宣讲会通知'), time }, 'a');
  messages.put([original]);
  daily.enqueue('a');
  const first = daily.claim('a')!;
  assert.deepEqual(first.messages.map(source => source.message.key), [original.key]);
  daily.complete(first, result(first, [{ ...activity, title: '星河科技校园宣讲会', sourceRefs: [1] }]));

  daily.enqueue('a');
  assert.equal(daily.claim('a'), undefined, 'completed messages keep their processed marker');

  const repost = normalizeMessage({ ...sample(2, '再次转发：星河科技 2027 届秋季宣讲'), time: time + 60 }, 'a');
  messages.put([repost]);
  daily.enqueue('a');
  const incremental = daily.claim('a')!;
  assert.deepEqual(incremental.messages.map(source => source.message.key), [repost.key]);
  daily.complete(incremental, result(incremental, [{ ...activity, title: '星河科技 2027 届秋季校园专场宣讲会', sourceRefs: [1] }]));

  const page = schedule.page('a', { week: '2026-09-21' });
  assert.equal(page.activities.length, 1);
  assert.equal(page.activities[0].sourceCount, 2);
  assert.deepEqual(daily.details('a', { bucket: 'completed', since: time - 60 }).counts,
    { pending: 0, running: 0, completed: 2, review: 0 });
});

test('older completed reply jobs with an empty reference marker detect a later original', async t => {
  const f = await fixture(t);
  const time = Date.parse('2026-09-21T04:00:00Z') / 1000;
  const reply = normalizeMessage({ ...sample(20, ''), time, message: [
    { type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '地点补充：报告厅' } },
  ] }, 'a');
  f.messages.put([reply]);
  f.daily.enqueue('a');
  const first = f.daily.claim('a')!;
  f.daily.complete(first, result(first, []));
  const db = new DatabaseSync(f.file);
  db.prepare("UPDATE schedule_jobs SET references_hash='' WHERE message_key=?").run(reply.key);
  db.close();
  f.messages.put([normalizeMessage({ ...sample(1, '星河科技宣讲会'), time: time - 60 }, 'a')]);
  f.daily.enqueue('a');
  const next = f.daily.claim('a')!;
  const retried = next.messages.find(source => source.message.key === reply.key);
  assert.ok(retried);
  assert.equal(retried.referenceGraph!.references[0].message.externalId, '1');
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

test('agent submission becomes a validated JSON array', () => {
  const output = parseDailySubmission({ activities: [{ ...activity, sourceRefs: [1, 1] }] }, new Set([1]));
  assert.equal(Array.isArray(output), true);
  assert.deepEqual(output, [{ ...activity, sourceRefs: [1] }]);
  assert.throws(() => parseDailySubmission({ activities: [{ ...activity, startDate: '9月24日', sourceRefs: [1] }] }, new Set([1])), /日期/);
  assert.throws(() => parseDailySubmission({ activities: [{ ...activity, sourceRefs: [2] }] }, new Set([1])), /批次之外/);
});

test('JSON text responses use the same strict structured-result validation', () => {
  const message = normalizeMessage(sample(10, '结构化结果测试'), 'a');
  const sources: PreparedDailySource[] = [{
    ref: 1, message, contentHash: 'hash', groupName: '测试群', displayTime: '2026-09-21 12:00:00',
    text: message.text, extractedContent: '', materials: [], warnings: [],
    links: [{ url: 'https://jobs.example.com/campus/apply', kind: 'registration' }],
  }];
  assert.deepEqual(parseDailyTextSubmission(`\`\`\`json\n${JSON.stringify([{ ...activity, sourceRefs: [1] }])}\n\`\`\``, sources),
    [{ ...activity, sourceRefs: [1] }]);
  assert.equal(parseDailyTextSubmission(JSON.stringify([{ ...activity, startDate: '9月24日', sourceRefs: [1] }]), sources), undefined);
  assert.equal(parseDailyTextSubmission(JSON.stringify([{ ...activity, sourceRefs: [2] }]), sources), undefined);
});

test('daily extraction forces a validated submit tool call after an unstructured response', async t => {
  const bodies: Record<string, any>[] = [];
  const endpoint = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    bodies.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (bodies.length === 1) {
      response.write(`data: ${JSON.stringify({ id: 'first', choices: [{ index: 0, delta: { role: 'assistant', content: '我已经整理好了。' }, finish_reason: 'stop' }] })}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify({ id: 'final', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'submit_daily_activities', arguments: JSON.stringify({ activities: [{ ...activity, sourceRefs: [1] }] }) } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  t.after(async () => { endpoint.closeAllConnections(); await new Promise<void>(resolve => endpoint.close(() => resolve())); });
  const message = normalizeMessage({ ...sample(10, `${activity.title}\n${activity.evidence}`), time: Date.parse('2026-09-21T04:00:00Z') / 1000 }, 'a');
  const job: DailyProcessingJob = { key: 'a:2026-09-21', accountId: 'a', sourceDay: '2026-09-21', hash: 'hash', attempts: 1,
    messages: [{ ref: 1, message, contentHash: 'hash', groupName: '测试群' }] };
  const result = await extractDailyActivities(job, {
    config: { ...defaultModelConfig, provider: 'custom', modelId: 'test-model', reasoning: false,
      baseUrl: `http://127.0.0.1:${(endpoint.address() as { port: number }).port}/v1` },
    apiKey: 'test-key', updatedAt: new Date().toISOString(),
  }, { signal: new AbortController().signal });
  assert.deepEqual(result.activities, [{ ...activity, registrationUrl: null, sourceRefs: [1] }]);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].tool_choice, 'required');
  assert.deepEqual(bodies[1].tools.map((tool: any) => tool.function.name), ['submit_daily_activities']);
});

test('processing details separate pending, running and completed messages and retain the JSON result', async t => {
  const { messages, daily } = await fixture(t);
  const time = Date.parse('2026-09-21T04:00:00Z') / 1000;
  messages.put([
    normalizeMessage({ ...sample(1, '星河科技宣讲会通知'), time, message: [
      { type: 'text', data: { text: '星河科技宣讲会通知' } },
      { type: 'image', data: { file: 'poster.jpg', url: 'https://multimedia.example.com/poster.jpg' } },
      { type: 'json', data: { data: JSON.stringify({ meta: { news: { title: '宣讲会通知', jumpUrl: 'https://jobs.example.com/news' } } }) } },
    ] }, 'a'),
    normalizeMessage({ ...sample(2, '谢谢，收到'), time: time + 60 }, 'a'),
  ]);
  daily.enqueue('a');
  const since = time - 60;
  const pending = daily.details('a', { bucket: 'pending', since });
  assert.equal(pending.total, 2);
  assert.deepEqual(pending.counts, { pending: 2, running: 0, completed: 0, review: 0 });
  assert.deepEqual(pending.items.find(item => item.text.includes('星河科技'))?.images,
    [{ segmentIndex: 1, url: 'https://multimedia.example.com/poster.jpg' }]);
  assert.deepEqual(pending.items.find(item => item.text.includes('星河科技'))?.links,
    [{ url: 'https://jobs.example.com/news', title: '宣讲会通知' }]);

  const job = daily.claim('a')!;
  const running = daily.details('a', { bucket: 'running', since });
  assert.equal(running.total, 2);
  assert.equal(running.items.every(item => item.state === 'running'), true);

  const output = result(job, [{ ...activity, sourceRefs: [1] }]);
  daily.complete(job, output);
  const completed = daily.details('a', { bucket: 'completed', since });
  assert.deepEqual(completed.counts, { pending: 0, running: 0, completed: 2, review: 0 });
  assert.deepEqual(completed.items.find(item => item.text.includes('星河科技'))?.activityTitles, [activity.title]);
  assert.deepEqual(completed.items.find(item => item.text.includes('谢谢'))?.activityTitles, []);
  assert.deepEqual(daily.structuredResult('a', '2026-09-21'), output.activities);
});

test('partial daily results mark only affected messages for review', async t => {
  const { messages, daily } = await fixture(t);
  const time = Date.parse('2026-09-21T04:00:00Z') / 1000;
  messages.put([
    normalizeMessage({ ...sample(1, '链接中的宣讲会'), time }, 'a'),
    normalizeMessage({ ...sample(2, '普通群聊'), time: time + 60 }, 'a'),
  ]);
  daily.enqueue('a');
  const job = daily.claim('a')!;
  const output = result(job, [{ ...activity, sourceRefs: [1] }]);
  output.sources[0].warnings = ['链接读取失败'];
  output.warnings = ['链接读取失败'];
  output.reviewReasons = ['链接读取失败'];
  daily.complete(job, output);

  const completed = daily.details('a', { bucket: 'completed', since: time - 60 });
  const review = daily.details('a', { bucket: 'review', since: time - 60 });
  const affected = review.items.find(item => item.text.includes('链接'))!;
  const ordinary = completed.items.find(item => item.text.includes('普通'))!;
  assert.equal(completed.items.some(item => item.text.includes('链接')), false);
  assert.equal(review.items.some(item => item.text.includes('普通')), false);
  assert.deepEqual(review.counts, { pending: 0, running: 0, completed: 1, review: 1 });
  assert.equal(affected.state, 'partial');
  assert.equal(affected.error, '链接读取失败');
  assert.equal(ordinary.state, 'completed');
  assert.equal(ordinary.error, '');
});

test('failed daily messages leave pending and expose their error in review', async t => {
  const { messages, daily } = await fixture(t);
  const time = Date.parse('2026-09-21T04:00:00Z') / 1000;
  messages.put([normalizeMessage({ ...sample(1, '无法处理的宣讲会图片'), time }, 'a')]);
  daily.enqueue('a');
  for (let attempt = 0; attempt < 3; attempt++) {
    const job = daily.claim('a')!;
    daily.fail(job, '模型输出格式错误', 0);
  }

  const pending = daily.details('a', { bucket: 'pending', since: time - 60 });
  const review = daily.details('a', { bucket: 'review', since: time - 60 });
  assert.equal(pending.total, 0);
  assert.equal(review.total, 1);
  assert.equal(review.items[0].state, 'failed');
  assert.equal(review.items[0].error, '模型输出格式错误');
  assert.throws(() => daily.retry('a', 'missing-message'), /不存在|当前账号/);
  assert.equal(daily.status('a').failed, 1);
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
  const sourceDay = '2026-09-21';
  const twoSourceSize = JSON.stringify(buildDailyPromptPayload(sourceDay, sources.slice(0, 2))).length;
  assert.deepEqual(splitDailySources(sources, twoSourceSize - 1, sourceDay).map(chunk => chunk.map(source => source.ref)), [[1], [2], [3]]);
  assert.equal(dailyPromptCharBudget(defaultModelConfig), 600_000);
  const oneSourceSize = JSON.stringify(buildDailyPromptPayload(sourceDay, sources.slice(0, 1))).length;
  assert.throws(() => splitDailySources(sources.slice(0, 1), oneSourceSize - 1, sourceDay), /超过模型上下文预算/);
  assert.throws(() => dailyPromptCharBudget({ ...defaultModelConfig, contextWindow: 1024, maxTokens: 1024 }), /上下文配置不足/);
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

test('daily source preparation leaves webpage reads to the agent tool', async () => {
  const message = normalizeMessage(sample(10, '招聘详情 https://example.com/news'), 'a');
  let downloads = 0;
  const sources = await buildDailySources(
    [{ ref: 1, message, contentHash: 'hash', groupName: '测试群' }],
    { config: { ...defaultModelConfig, imageInput: false }, apiKey: 'test-key', updatedAt: '' },
    {
      signal: new AbortController().signal,
      download: async url => {
        downloads++;
        return { url, contentType: 'text/html', bytes: new TextEncoder().encode('<p>不应预读取</p>') };
      },
    },
  );
  assert.equal(downloads, 0);
  assert.deepEqual(sources[0].links, [{ url: 'https://example.com/news', kind: 'webpage' }]);
  assert.equal(sources[0].extractedContent.includes('不应预读取'), false);
});

test('link reader fetches independent requests concurrently and preserves request order', async () => {
  const message = normalizeMessage(sample(10, '批量链接'), 'a');
  const links = [1, 2, 3, 4].map(index => ({ url: `https://example.com/jobs/${index}`, kind: 'webpage' as const }));
  const source: PreparedDailySource = {
    ref: 1, message, contentHash: 'hash', groupName: '测试群', displayTime: '2026-09-21 12:00:00',
    text: message.text, extractedContent: '', materials: [], warnings: [], links,
  };
  let active = 0;
  let peak = 0;
  const tool = createReadSourceLinksTool([source], {
    config: { ...defaultModelConfig, imageInput: false }, apiKey: 'test-key', updatedAt: '',
  }, {
    signal: new AbortController().signal,
    download: async url => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 20));
        return { url, contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(`<p>${url}</p>`) };
      } finally { active--; }
    },
  });
  const result = await tool.execute('parallel', { requests: links.map(link => ({ sourceRef: 1, url: link.url })) });
  const text = (result.content[0] as { text: string }).text;
  assert.equal(peak, 4);
  const positions = links.map(link => text.indexOf(link.url));
  assert.equal(positions.every((position, index) => index === 0 || position > positions[index - 1]), true);
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

test('processing configuration cannot advance another account after a login switch', async t => {
  const f = await fixture(t);
  const settings = { config: defaultModelConfig, apiKey: 'test-key', updatedAt: new Date().toISOString() };
  f.processor = new DailyScheduleProcessor(f.daily, async () => settings, async job => result(job, []), () => {});
  f.processor.setAccount('a');
  await assert.rejects(f.processor.configure({ enabled: true, concurrency: 2, syncedThrough: 456,
    expectedAccountId: 'previous-account' }), /账号已切换/);
  assert.equal(f.daily.status('a').lastSyncedAt, 0);
  assert.equal(f.daily.status('a').enabled, false);
});

test('one-time processing respects its start time and stops when the queue becomes idle', async t => {
  const f = await fixture(t);
  const oldTime = Date.parse('2026-09-17T04:00:00Z') / 1000;
  const includedTime = Date.parse('2026-09-20T04:00:00Z') / 1000;
  f.messages.put([
    normalizeMessage({ ...sample(1, '范围外消息'), time: oldTime }, 'a'),
    normalizeMessage({ ...sample(2, '范围内消息'), time: includedTime }, 'a'),
  ]);
  let requests = 0;
  const settings = { config: defaultModelConfig, apiKey: 'test-key', updatedAt: new Date().toISOString() };
  f.processor = new DailyScheduleProcessor(f.daily, async () => settings, async job => {
    requests++;
    return result(job, []);
  }, () => {});
  f.processor.setAccount('a');
  await f.processor.configure({ enabled: true, concurrency: 2, stopWhenIdle: true, since: includedTime });
  await waitUntil(() => f.daily.status('a').completed === 1 && !f.daily.status('a').enabled);
  assert.equal(requests, 1);
  assert.equal(f.daily.status('a').since, includedTime);

  f.messages.put([normalizeMessage({ ...sample(3, '稍后到达的消息'), time: includedTime + 60 }, 'a')]);
  f.processor.refresh();
  await waitUntil(() => f.daily.status('a').pending === 1);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(requests, 1);
  assert.equal(f.daily.status('a').enabled, false);
});

test('reopening storage pauses an unfinished one-time sync', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-daily-restart-'));
  const file = path.join(root, 'messages.sqlite');
  const messages = new Store(file);
  messages.saveGroups('a', [{ group_id: 731234567, group_name: '就业信息一群' }]);
  messages.follow('a', '731234567', true);
  messages.put([normalizeMessage({ ...sample(1, '尚未完成的整理'), time: 200 }, 'a')]);
  const schedule = new ScheduleStore(file);
  const first = new DailyScheduleStore(file);
  first.configure('a', { enabled: true, concurrency: 3, stopWhenIdle: true, since: 123, syncedThrough: 456,
    syncedGroupIds: ['731234567'] });
  first.enqueue('a');
  assert.ok(first.claim('a'));
  assert.equal(first.status('a').enabled, true);
  first.close();
  schedule.close();
  messages.close();

  const reopened = new DailyScheduleStore(file);
  t.after(() => { reopened.close(); return rm(root, { recursive: true, force: true }); });
  assert.equal(reopened.status('a').enabled, false);
  assert.equal(reopened.status('a').stopWhenIdle, false);
  assert.equal(reopened.status('a').since, 123);
  assert.equal(reopened.status('a').lastSyncedAt, 456);
  assert.deepEqual(reopened.status('a').groupLastSyncedAt, { '731234567': 456 });
  assert.deepEqual(reopened.details('a', { bucket: 'pending', since: 123 }).counts,
    { pending: 1, running: 0, completed: 0, review: 0 });
});
