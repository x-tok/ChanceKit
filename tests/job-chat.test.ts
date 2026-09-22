import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Store, normalizeMessage } from '../electron/core/archive/store';
import { ScheduleStore, type ExtractionResult } from '../electron/core/processing/schedule-store';
import { JobChatStore } from '../electron/core/chat/store';
import { dynamicJobContext, transformJobChatContext, JobChatAgent, uniqueOpportunities } from '../electron/core/chat/agent';
import { sample } from './fixtures';
import type { ActivityInput } from '../src/schedule';
import { jobResultKey, type JobOpportunity } from '../src/chat';
import { createJobChatTools } from '../electron/core/chat/tools';
import { DailyScheduleStore } from '../electron/core/processing/daily-extraction/queue/store';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { defaultModelConfig } from '../src/model-config';

const extraction = (title: string, summary: string): ExtractionResult => ({
  activities: [], materials: [], warnings: [], reviewReasons: [], information: { title, summary },
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-job-chat-'));
  const file = path.join(root, 'messages.sqlite');
  const messages = new Store(file);
  messages.saveGroups('a', [
    { group_id: 731234567, group_name: '北京国企校招' },
    { group_id: 731234568, group_name: '上海外企与实习' },
    { group_id: 731234569, group_name: '未关注招聘群' },
  ]);
  messages.follow('a', '731234567', true);
  messages.follow('a', '731234568', true);
  const schedule = new ScheduleStore(file);
  const chat = new JobChatStore(file);
  t.after(async () => {
    chat.close(); schedule.close(); messages.close();
    await rm(root, { recursive: true, force: true });
  });
  return { file, messages, schedule, chat };
}

test('job opportunity tools combine location, company type and work content within the current followed account', async t => {
  const f = await fixture(t);
  const inputs = [
    ['北京某国有企业招聘 Java 后端开发，工作内容包括微服务和数据库设计。', 731234567, '北京国企 Java 后端岗位'],
    ['上海外资企业招聘商业数据分析实习生，主要负责报表和市场分析。', 731234568, '上海外企数据分析实习'],
    ['北京民营公司招聘 Java 工程师。', 731234569, '未关注群岗位'],
  ] as const;
  const messages = inputs.map(([text, group], index) => normalizeMessage(sample(index + 1, text, group), 'a'));
  f.messages.put(messages);
  f.messages.follow('a', '731234569', true);
  f.schedule.enqueue('a');
  for (let index = 0; index < inputs.length; index++) {
    f.schedule.complete(f.schedule.claim('a')!, extraction(inputs[index][2], inputs[index][0]));
  }
  f.messages.follow('a', '731234569', false);

  const beijing = f.chat.search('a', {
    cities: ['北京', '北京市'], companyTypes: ['国企', '国有企业'], workContents: ['Java', '后端'], limit: 10,
  });
  assert.equal(beijing.length, 1);
  assert.equal(beijing[0].title, '北京国企 Java 后端岗位');
  assert.deepEqual(new Set(beijing[0].matchedBy), new Set(['北京', '国企', '国有企业', 'Java', '后端']));
  assert.equal(f.chat.search('a', { cities: ['深圳'] }).length, 0);
  assert.equal(f.chat.search('b', { keywords: ['招聘'] }).length, 0);

  const shanghai = f.chat.search('a', { cities: ['上海'], companyTypes: ['外企', '外资'], workContents: ['数据分析'] });
  assert.equal(shanghai.length, 1);
  assert.equal(shanghai[0].messageKey, messages[1].key);
  assert.match(f.chat.details('a', [{ messageKey: messages[1].key }])[0].sources[0].text, /商业数据分析/);

  f.messages.follow('a', '731234568', false);
  assert.equal(f.chat.search('a', { cities: ['上海'] }).length, 0);
});

test('job chat sessions persist locally and remain isolated by account', async t => {
  const f = await fixture(t);
  const session = f.chat.createSession('a');
  const user = f.chat.addMessage('a', session.id, 'user', '我想找杭州的研发岗位');
  f.chat.addMessage('a', session.id, 'assistant', '当前本地数据暂无匹配。');
  const detail = f.chat.detail('a', session.id)!;
  assert.equal(detail.session.title, '我想找杭州的研发岗位');
  assert.equal(detail.messages[0].id, user.id);
  assert.equal(detail.messages.length, 2);
  assert.equal(f.chat.detail('b', session.id), null);
  assert.equal(f.chat.deleteSession('b', session.id), false);
  assert.equal(f.chat.deleteSession('a', session.id), true);
});

test('dynamic context injects dataset scope and bounds the transcript without mutating stored messages', async t => {
  const f = await fixture(t);
  const session = f.chat.createSession('a');
  for (let index = 0; index < 15; index++) f.chat.addMessage('a', session.id, 'user', `需求 ${index}`);
  const detail = f.chat.detail('a', session.id)!;
  const context = dynamicJobContext(f.chat, 'a', detail);
  assert.match(context, /当前日期：\d{4}-\d{2}-\d{2}/);
  assert.match(context, /2 个已关注群/);
  assert.match(context, /需求 14/);
  assert.doesNotMatch(context, /需求 0\n/);

  const messages: AgentMessage[] = Array.from({ length: 30 }, (_, index) => ({
    role: 'user' as const, content: `turn ${index}`, timestamp: index,
  }));
  const transformed = transformJobChatContext(messages, context);
  assert.equal(messages.length, 30);
  assert.equal(transformed[0].role, 'user');
  assert.equal(transformed.length, 25);
  assert.equal(transformed.at(-1)?.role, 'user');
});

const talk: ActivityInput = {
  title: '港湾研究院校园宣讲会', type: '宣讲会', organizer: '港湾研究院',
  startDate: '2027-03-12', endDate: null, startTime: '14:00', endTime: '16:00',
  location: '深圳校区礼堂', audience: '2027 届毕业生', description: '嵌入式软件研发',
  registrationUrl: null, deadline: null, evidence: '3 月 12 日深圳校区宣讲会',
};

test('search covers daily-processed activities and other messages without an information index or calendar cutoff', async t => {
  const f = await fixture(t);
  const daily = new DailyScheduleStore(f.file);
  t.after(() => daily.close());
  const messages = [
    normalizeMessage(sample(1, '港湾研究院宣讲与联合双选会通知'), 'a'),
    normalizeMessage(sample(2, '星港物流招聘实习生，工作地点成都'), 'a'),
    normalizeMessage(sample(3, '转发港湾研究院通知', 731234568), 'a'),
  ];
  f.messages.put(messages); daily.enqueue('a');
  const job = daily.claim('a')!;
  const ref = (key: string) => job.messages.find(source => source.message.key === key)!.ref;
  const fair = { ...talk, title: '联合双选会', type: '双选会' as const, startDate: '2027-03-15' };
  assert.equal(daily.complete(job, {
    activities: [
      { ...talk, sourceRefs: [ref(messages[0].key), ref(messages[2].key)] },
      { ...fair, sourceRefs: [ref(messages[0].key)] },
    ],
    sources: job.messages.map(source => ({ ...source, displayTime: '2026-09-19', text: source.message.text,
      links: [], extractedContent: '', materials: [], warnings: [] })), warnings: [], reviewReasons: [],
  }), true);
  assert.equal(f.schedule.information.page('a', { category: 'information' }).total, 0);
  const results = f.chat.search('a', { limit: 20 });
  assert.equal(results.length, 3);
  const event = results.find(item => item.title === talk.title)!;
  assert.equal(event.activityType, '宣讲会');
  assert.equal(event.startDate, '2027-03-12');
  assert.equal(f.chat.search('a', { cities: ['深圳'], workContents: ['嵌入式'] }).length, 2);
  assert.equal(f.chat.search('a', { keywords: ['双选会'] }).some(item => item.activityType === '双选会'), true);
  const notice = results.find(item => item.category === 'processed')!;
  assert.match(f.chat.resultDetail('a', notice)!.sources[0].text, /星港物流/);
  const detail = f.chat.resultDetail('a', event)!;
  assert.equal(detail.sources.length, 2);
  assert.equal(detail.activity!.location, talk.location);
  assert.equal(f.chat.resultDetail('b', event), null);
  assert.deepEqual(f.chat.dataset('a'), { information: 0, incomplete: 0, activities: 2, processed: 1,
    followedGroups: 2, newestMessageAt: messages[2].time });
  const paged = [0, 1, 2].flatMap(offset => f.chat.search('a', { limit: 1, offset }));
  assert.equal(new Set(paged.map(jobResultKey)).size, 3);

  // Source edits and unfollows invalidate the corresponding results, even before extraction restarts.
  f.messages.follow('a', '731234568', false);
  assert.equal(f.chat.resultDetail('a', event)!.sources.length, 1);
  f.messages.put([normalizeMessage(sample(1, '消息已更正'), 'a')]);
  assert.equal(f.chat.resultDetail('a', event), null);
  assert.equal(f.chat.search('a', {}).length, 1);
  const pending = normalizeMessage(sample(4, '尚未处理的岗位'), 'a');
  f.messages.put([pending]);
  assert.equal(f.chat.search('a', { keywords: ['尚未处理'] }).length, 0);
});

test('detail tools distinguish multiple activities in one message and reject unsurfaced or revoked results', async t => {
  const f = await fixture(t);
  const message = normalizeMessage(sample(1, '招聘日包含宣讲会、笔试'), 'a');
  f.messages.put([message]); f.schedule.enqueue('a');
  f.schedule.complete(f.schedule.claim('a')!, { ...extraction('', ''), information: null,
    activities: [talk, { ...talk, title: '招聘日笔试', type: '笔试', startTime: '18:00', endTime: '19:00' }] });
  const found: JobOpportunity[] = [];
  const tools = createJobChatTools(f.chat, 'a', items => found.push(...items));
  const search = tools.find(tool => tool.name === 'search_job_opportunities')!;
  const details = tools.find(tool => tool.name === 'get_job_opportunity_details')!;
  const result = await search.execute('search', {});
  assert.equal(found.length, 2);
  assert.equal(new Set(found.map(jobResultKey)).size, 2);
  assert.doesNotMatch(JSON.stringify(result.content), /\[机会/);
  const detail = await details.execute('read', { results: [found[0], found[1]] });
  assert.match(JSON.stringify(detail.content), /招聘日笔试/);
  await assert.rejects(details.execute('read', { results: [{ messageKey: message.key, activityId: 'f'.repeat(64) }] }), /本轮检索/);
  f.messages.follow('a', message.groupId, false);
  assert.equal((await details.execute('read', { results: [found[0]] })).content[0].type, 'text');
  assert.equal(f.chat.resultDetail('a', found[0]), null);
});

test('all found cards survive more than eight matches and the real pi tool loop returns Markdown', async t => {
  const f = await fixture(t);
  for (let index = 1; index <= 12; index++) f.messages.put([normalizeMessage(sample(index, `成都数据岗位招聘 ${index}`), 'a')]);
  f.schedule.enqueue('a');
  let job;
  while ((job = f.schedule.claim('a'))) f.schedule.complete(job, extraction(`成都数据岗位 ${job.message.externalId}`, 'SQL 数据分析'));
  const requests: any[] = [];
  const http = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const first = requests.length === 1;
    const selecting = requests.length === 2;
    const candidates = f.chat.search('a', { cities: ['成都'], limit: 20 });
    response.write(`data: ${JSON.stringify({ id: 'chat-test', choices: [{ index: 0,
      delta: first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'search-one', type: 'function',
        function: { name: 'search_job_opportunities', arguments: JSON.stringify({ cities: ['成都'], limit: 20 }) } }] }
        : selecting ? { role: 'assistant', tool_calls: [{ index: 0, id: 'select-one', type: 'function',
          function: { name: 'select_chat_results', arguments: JSON.stringify({
            localResults: candidates.map(({ messageKey, activityId }) => ({ messageKey, activityId })), webUrls: [],
          }) } }] }
          : { role: 'assistant', content: '## 查询结果\n共找到 **12 条** 成都数据岗位，详见下方卡片。' },
      finish_reason: first || selecting ? 'tool_calls' : 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const agent = new JobChatAgent(f.chat); t.after(() => agent.close());
  const sent = await agent.send('a', undefined, '查找成都数据岗位', {
    config: { ...defaultModelConfig, provider: 'custom', api: 'openai-completions', modelId: 'test',
      baseUrl: `http://127.0.0.1:${(http.address() as { port: number }).port}/v1`, reasoning: false },
    apiKey: '', updatedAt: new Date().toISOString(),
  });
  assert.equal(requests.length, 3);
  assert.match(sent.message.content, /## 查询结果/);
  assert.equal(sent.message.opportunities.length, 12);
  assert.equal(f.chat.detail('a', sent.session.id)!.messages.at(-1)!.opportunities.length, 12);
  assert.equal(uniqueOpportunities([...sent.message.opportunities, ...sent.message.opportunities]).length, 12);
});
