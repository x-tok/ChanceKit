import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChatWebTools, parseSearchResults, publicChatUrl, rememberWebSource } from '../electron/core/chat/web';
import { createResultSelectionTool } from '../electron/core/chat/results';
import { Store } from '../electron/core/archive/store';
import { ScheduleStore } from '../electron/core/processing/schedule-store';
import { JobChatStore } from '../electron/core/chat/store';
import { JobChatAgent } from '../electron/core/chat/agent';
import { defaultModelConfig } from '../src/model-config';
import type { ChatWebSource, JobOpportunity } from '../src/chat';
import type { MaterialDownload } from '../electron/core/materials/message-materials';

const url = 'https://jobs.example.com/campus';
const rss = `<rss><channel><item><title>示例公司 2027 校招</title><link>${url}</link><description>官网校招入口</description></item>
<item><title>无关公司</title><link>https://unrelated.example.com/</link><description>其他岗位</description></item>
<item><title>私网</title><link>http://127.0.0.1/admin</link></item>
<item><title>重复结果</title><link>${url}</link><description>校园招聘官网</description></item></channel></rss>`;
const html = '<html><head><title>示例公司校园招聘</title></head><body><main><h1>2027 届校园招聘</h1><p>'
  + '软件研发岗位，工作地点上海。面向 2027 届毕业生，请在官网核对职位及截止日期。'.repeat(4)
  + '</p><a href="/campus/jobs">查看岗位</a><script>malicious()</script></main></body></html>';
const fakeDownload: MaterialDownload = async (request, signal) => {
  signal.throwIfAborted();
  return { url: request, contentType: request.includes('bing.com') ? 'text/xml' : 'text/html',
    bytes: new TextEncoder().encode(request.includes('bing.com') ? rss : html) };
};

test('public search parses and deduplicates sources, rejecting private URLs and challenge responses', () => {
  const sources = parseSearchResults(rss, 123);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].url, url);
  assert.equal(sources[0].status, 'snippet');
  assert.equal(sources[0].fetchedAt, 123);
  assert.throws(() => parseSearchResults('<html>captcha</html>'), /未返回/);
  for (const value of ['http://localhost/', 'http://192.168.1.1/', 'http://[::1]/', 'file:///etc/passwd', 'https://user:secret@example.com/', 'http://169.254.169.254/', 'https://public.example:8080/']) {
    assert.throws(() => publicChatUrl(value));
  }
});

test('web tools read evidence and navigation links; failed reads stay visibly unverified', async () => {
  const found: ChatWebSource[] = [];
  const tools = createChatWebTools(source => found.push(source), { download: fakeDownload });
  await tools[0].execute('search', { query: '示例公司 校招 官网' });
  assert.equal(found.length, 2);
  const result = await tools[1].execute('read', { url });
  assert.equal(found.at(-1)?.status, 'read');
  assert.match(found.at(-1)!.text!, /2027 届/);
  assert.doesNotMatch(found.at(-1)!.text!, /malicious/);
  assert.match(JSON.stringify(result.content), /https:\/\/jobs.example.com\/campus\/jobs/);
  const failed = createChatWebTools(source => found.push(source), { download: async () => { throw new Error('HTTP 503'); } });
  const failure = await failed[1].execute('read', { url });
  assert.equal(found.at(-1)?.status, 'unavailable');
  assert.match(JSON.stringify(failure.content), /HTTP 503/);
  const blocked = createChatWebTools(source => found.push(source), { download: async request => ({
    url: request, contentType: 'text/html', bytes: new TextEncoder().encode('<html><body>请先登录</body></html>'),
  }) });
  await blocked[1].execute('read', { url });
  assert.equal(found.at(-1)?.status, 'unavailable');
});

test('web budgets and cancellation bound requests and never pass canceled content to the model', async () => {
  let calls = 0;
  const controller = new AbortController();
  const tools = createChatWebTools(() => {}, { signal: controller.signal,
    download: async (url, signal) => { calls++; return fakeDownload(url, signal); } });
  for (let i = 0; i < 4; i++) await tools[0].execute(String(i), { query: '公开招聘' });
  await assert.rejects(tools[0].execute('extra', { query: '公开招聘' }), /上限/);
  assert.equal(calls, 4);
  controller.abort();
  await assert.rejects(tools[1].execute('read', { url }), /abort/i);
});

test('result selection excludes exploratory cards and refuses invented sources atomically', async () => {
  const sources = parseSearchResults(rss);
  const web = new Map(sources.map(source => [source.url, source]));
  const local = new Map<string, JobOpportunity>();
  let selected: string[] = [];
  const tool = createResultSelectionTool(local, web, (_keys, urls) => { selected = urls; });
  await tool.execute('select', { localResults: [], webUrls: [url, url] });
  assert.deepEqual(selected, [url]);
  await assert.rejects(tool.execute('bad', { localResults: [], webUrls: ['https://invented.example/'] }), /本轮/);
  assert.deepEqual(selected, [url]);
  await tool.execute('clear', { localResults: [], webUrls: [] });
  assert.deepEqual(selected, []);
});

test('repeated searches retain read evidence while a later failed read is not presented as verified', () => {
  const sources = new Map<string, ChatWebSource>();
  const snippet = parseSearchResults(rss)[0];
  rememberWebSource(sources, snippet);
  rememberWebSource(sources, { ...snippet, title: '官网标题', status: 'read', text: '已读取的正文', fetchedAt: 200 });
  rememberWebSource(sources, { ...snippet, fetchedAt: 300 });
  assert.equal(sources.get(url)?.status, 'read');
  assert.equal(sources.get(url)?.text, '已读取的正文');
  rememberWebSource(sources, { ...snippet, title: new URL(url).hostname, summary: '', status: 'unavailable', fetchedAt: 400 });
  assert.equal(sources.get(url)?.status, 'unavailable');
  assert.equal(sources.get(url)?.title, '官网标题');
  assert.equal(sources.get(url)?.text, undefined);
});

test('real pi loop goes from local miss to web search, page reading and selected persisted source cards', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'chancekit-chat-web-'));
  const file = path.join(root, 'messages.sqlite');
  const archive = new Store(file);
  const schedule = new ScheduleStore(file);
  const store = new JobChatStore(file);
  const agent = new JobChatAgent(store);
  t.after(async () => { agent.close(); store.close(); schedule.close(); archive.close(); await rm(root, { recursive: true, force: true }); });
  const steps = [
    ['search_job_opportunities', { companies: ['示例公司'] }],
    ['search_web', { query: '示例公司 2027 校招 官网' }],
    ['read_web_page', { url }],
    ['select_chat_results', { localResults: [], webUrls: [url] }],
  ] as const;
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const step = steps[requests.length - 1];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'web-chat', choices: [{ index: 0,
      delta: step ? { role: 'assistant', tool_calls: [{ index: 0, id: `tool-${requests.length}`, type: 'function',
        function: { name: step[0], arguments: JSON.stringify(step[1]) } }] }
        : { role: 'assistant', content: `## 示例公司校招\n官网列有 2027 届软件研发岗位，详见[校园招聘](${url})。` },
      finish_reason: step ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const settings = {
    config: { ...defaultModelConfig, provider: 'custom' as const, api: 'openai-completions' as const, modelId: 'test',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, reasoning: false },
    apiKey: '', updatedAt: new Date().toISOString(),
  };
  const result = await agent.send('web-only', undefined, '看看示例公司的校招', settings, { download: fakeDownload });
  assert.equal(requests.length, 5);
  assert.deepEqual(result.message.opportunities, []);
  assert.equal(result.message.webSources!.length, 1);
  assert.equal(result.message.webSources![0].url, url);
  assert.equal(result.message.webSources![0].status, 'read');
  assert.match(result.message.content, /校园招聘/);
  const stored = store.detail('web-only', result.session.id)!;
  assert.deepEqual(stored.messages.at(-1)?.webSources, result.message.webSources);
  assert.equal(store.detail('other-account', result.session.id), null);
  // A plain answer needs no tool calls and must not inherit cards from previous turns.
  const next = await agent.send('web-only', result.session.id, '谢谢', settings, { download: fakeDownload });
  assert.deepEqual(next.message.opportunities, []);
  assert.deepEqual(next.message.webSources, []);
});
