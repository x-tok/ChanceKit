import { test, expect, _electron as electron, chromium, type ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { preview } from 'vite';
import sharp from 'sharp';
import { mockNapCat, sample } from '../fixtures';
import { pdfFixture } from '../pdf-fixtures';
import type { Activity, ActivityInput } from '../../src/schedule';
import type { AppState, DesktopBridge } from '../../src/shared';
import { emptyProcessingDetails, emptyProcessingStatus, chinaToday } from '../../src/schedule';

const events: ActivityInput[] = [
  { title: '星河科技校园宣讲会', type: '宣讲会', organizer: '星河科技', startDate: '2026-09-24', endDate: null, startTime: '14:30', endTime: '16:00', location: '大学生活动中心 201', audience: '2027 届毕业生', description: '研发岗位介绍与现场简历交流。', registrationUrl: null, deadline: null, evidence: '9月24日14:30，大学生活动中心201' },
  { title: '秋季校园双选会', type: '双选会', organizer: '学校就业中心', startDate: '2026-09-25', endDate: '2026-09-26', startTime: '09:00', endTime: '17:00', location: '体育馆一层', audience: '应届毕业生', description: '多家用人单位到场，携带纸质简历。', registrationUrl: null, deadline: '9月24日18:00', evidence: '9月25日至26日9:00至17:00 体育馆一层' },
  { title: '秋招线上笔试', type: '笔试', organizer: '启明软件', startDate: '2026-09-23', endDate: null, startTime: '19:00', endTime: '21:00', location: '线上', audience: '已通过简历筛选的同学', description: '以邮件中的考试通知为准。', registrationUrl: null, deadline: null, evidence: '9月23日19:00线上笔试' },
  { title: '研究院实习交流会', type: '其他', organizer: '研究院', startDate: null, endDate: null, startTime: null, endTime: null, location: '待通知', audience: '硕士及博士研究生', description: '具体日期尚未公布。', registrationUrl: null, deadline: null, evidence: '实习交流会，时间另行通知' },
];
const ongoingEvent: ActivityInput = {
  title: '海岳能源2026年秋季高校毕业生招聘（网上报名）', type: '其他', organizer: '海岳能源人才发展中心',
  startDate: '2026-09-09', endDate: '2026-10-15', startTime: null, endTime: null,
  location: '', audience: '2027届毕业生', description: '网上报名及资格审核。', registrationUrl: null,
  deadline: '2026年10月15日', evidence: '网上报名：2026年9月9日至10月15日',
};

test('schedule extracts followed messages with concurrent pi agents, persists activities and supports weekly filters and sources', async () => {
  const fixture = await mockNapCat();
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-schedule-e2e-'));
  let requests = 0, active = 0, peak = 0, visionCalls = 0;
  const endpoint = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const user = body.messages.find((message: any) => message.role === 'user');
    const text = typeof user.content === 'string' ? user.content : user.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
    const visual = body.tools[0].function.name === 'submit_visual_text';
    if (visual) {
      visionCalls++;
      expect(user.content.some((part: any) => part.type === 'image_url')).toBe(true);
    }
    const input = visual ? {} : JSON.parse(text);
    const sources = visual ? [] : input.sources ?? [];
    const extracted = [...events, ongoingEvent].flatMap(event => {
      const sourceRefs = sources.filter((source: any) => `${source.message}\n${source.extractedContent}`.includes(event.title)
        || event === events[0] && source.extractedContent?.includes('Recruitment fair:')).map((source: any) => source.source);
      return sourceRefs.length ? [{ ...event, sourceRefs }] : [];
    });
    const output = visual ? { text: `${events[0].title}\n${events[0].evidence}`, unreadable: false } : { activities: extracted };
    requests++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 180));
    active--;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'test', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: visual ? 'submit_visual_text' : 'submit_daily_activities', arguments: JSON.stringify(output) } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  const baseUrl = `http://127.0.0.1:${(endpoint.address() as { port: number }).port}/v1`;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), CHANCEKIT_TEST_DATA: root };
  delete (env as Record<string, string>).ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: ['.'], env });
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const startOneTimeSync = async () => {
      const button = page.getByRole('button', { name: /^(开始同步|再次同步)$/ });
      await expect(button).toBeEnabled();
      await button.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('同步会产生 API 费用');
      await dialog.getByRole('button', { name: '开始同步', exact: true }).click();
    };
    const closeSyncDetails = async () => {
      const close = page.getByRole('button', { name: '关闭同步详情', exact: true });
      if (await close.isVisible()) await close.click();
    };
    const waitForSyncToStop = async (keepOpen = false) => {
      await expect.poll(async () => (await page.evaluate(() => window.desktop!.processingStatus())).enabled, { timeout: 20000 }).toBe(false);
      if (!keepOpen) await closeSyncDetails();
    };
    const waitForDayToSettle = async () => {
      await expect.poll(async () => {
        const status = await page.evaluate(() => window.desktop!.processingStatus());
        return status.completed + status.partial + status.failed;
      }, { timeout: 20000 }).toBe(1);
    };
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByLabel('服务商', { exact: true }).selectOption('custom');
    await page.getByLabel('API 地址', { exact: true }).fill(baseUrl);
    await page.getByLabel('模型 ID', { exact: true }).fill('schedule-test-model');
    await page.getByLabel('图像输入', { exact: true }).check();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByText('配置已保存', { exact: true })).toBeVisible();
    await page.evaluate(async config => {
      await window.desktop!.request({ type: 'connect', config });
      await window.desktop!.request({ type: 'follow', groupId: '731234567', followed: true });
    }, fixture.config);
    for (let i = 0; i < events.length; i++) fixture.push(sample(100 + i, `${events[i].title}\n${events[i].evidence}`));
    fixture.push(sample(105, '谢谢，收到。'));
    fixture.push(sample(106, `${events[0].title}\n${events[0].evidence}`));
    fixture.push(sample(107, '未关注的消息不能发给模型', 731234568));
    await page.getByRole('button', { name: '日程', exact: true }).click();
    await expect(page.getByRole('heading', { name: '日程', exact: true })).toBeVisible();
    await expect.poll(async () => (await page.evaluate(() => window.desktop!.processingStatus())).pending).toBe(1);
    expect(requests).toBe(0);
    await startOneTimeSync();
    const stages = page.getByRole('list', { name: '同步阶段' });
    await expect(stages).toContainText('读取消息');
    await expect(stages).toContainText('AI 整理');
    await expect(stages).toContainText('完成');
    await waitForDayToSettle();
    await waitForSyncToStop(true);
    await expect(page.getByText(/本次同步已完成|部分消息需要处理/)).toBeVisible();
    const syncDialog = page.getByRole('dialog');
    await expect(syncDialog.getByRole('navigation', { name: '消息整理状态' })).toContainText('待整理');
    await syncDialog.getByRole('button', { name: /已完成/ }).click();
    await expect(syncDialog.getByRole('region', { name: '已完成消息列表' })).toContainText('星河科技校园宣讲会');
    await page.screenshot({ path: 'test-results/schedule-sync-details.png' });
    await closeSyncDetails();
    expect(requests).toBe(1);
    expect(peak).toBe(1);
    await page.getByLabel('跳转日期').fill('2026-09-24');
    await expect(page.getByRole('button', { name: '查看活动：星河科技校园宣讲会', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: '查看活动：秋季校园双选会', exact: true })).toHaveCount(0);
    await expect(page.getByRole('table', { name: '当日活动列表' })).toContainText('9月24日14:30');
    await expect(page.getByRole('region', { name: '日期待确认' })).toContainText('研究院实习交流会');
    await page.screenshot({ path: 'test-results/schedule-desktop.png' });
    await page.getByRole('button', { name: '查看活动：星河科技校园宣讲会', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('完整原始信息 · 2 条');
    await page.getByRole('dialog').locator('summary').first().click();
    await expect(page.getByRole('dialog')).toContainText('9月24日14:30');
    await page.screenshot({ path: 'test-results/schedule-detail.png' });
    await page.getByRole('button', { name: '关闭活动详情' }).click();
    await page.getByLabel('活动类型').selectOption('笔试');
    await page.getByRole('button', { name: /^2026-09-23 / }).click();
    await expect(page.getByRole('button', { name: '查看活动：星河科技校园宣讲会', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '查看活动：秋招线上笔试', exact: true })).toBeVisible();
    await page.getByLabel('活动类型').selectOption('');
    await page.getByLabel('搜索活动').fill('没有这个活动');
    await expect(page.getByText('没有符合筛选条件的活动')).toBeVisible();
    await page.getByLabel('搜索活动').fill('');
    await page.getByRole('button', { name: '后7天', exact: true }).click();
    await expect(page.getByText('这一天暂无活动', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '前7天', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 640));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/schedule-900.png' });
    const beforeNewMessage = requests;
    fixture.push(sample(108, '新到达的无活动消息'));
    await expect.poll(async () => (await page.evaluate(() => window.desktop!.processingStatus())).pending).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(requests).toBe(beforeNewMessage);
    await startOneTimeSync();
    await expect.poll(() => requests).toBeGreaterThanOrEqual(2);
    expect(requests).toBeGreaterThanOrEqual(2);
    await waitForSyncToStop();
    const poster = await sharp({ create: { width: 120, height: 100, channels: 3, background: '#567843' } }).png().toBuffer();
    fixture.respond('get_image', () => ({ base64: poster.toString('base64') }));
    fixture.push({ ...sample(110, ''), message: [{ type: 'image', data: { file: 'fixture-poster.png', file_size: poster.length } }] });
    await expect.poll(async () => (await page.evaluate(() => window.desktop!.processingStatus())).pending).toBe(1);
    await startOneTimeSync();
    await expect.poll(() => visionCalls, { timeout: 20000 }).toBe(1);
    await expect.poll(() => requests).toBeGreaterThanOrEqual(4);
    expect(requests).toBeGreaterThanOrEqual(4);
    expect(fixture.calls.some(call => call.action === 'get_image')).toBe(true);
    await waitForSyncToStop();
    fixture.push(sample(111, `${ongoingEvent.title}\n${ongoingEvent.evidence}`));
    await expect.poll(async () => (await page.evaluate(() => window.desktop!.processingStatus())).pending).toBe(1);
    await startOneTimeSync();
    await waitForDayToSettle();
    await waitForSyncToStop();
    const ongoing = page.getByRole('region', { name: '跨期事项', exact: true });
    await expect(ongoing.getByRole('button', { name: `查看活动：${ongoingEvent.title}` })).toHaveCount(1);
    await expect(page.getByRole('table').getByRole('button', { name: `查看活动：${ongoingEvent.title}` })).toHaveCount(0);
    await expect(ongoing).toContainText('2026-09-09 至 2026-10-15');
    await expect(ongoing).not.toContainText('时间待确认');
    await ongoing.getByRole('button').click();
    await expect(page.getByRole('dialog')).toContainText('起止日期');
    await expect(page.getByRole('dialog')).not.toContainText('时间待确认');
    await expect(page.getByRole('dialog')).not.toContainText('部分信息待确认');
    await page.getByRole('button', { name: '关闭活动详情' }).click();
    await page.getByLabel('活动类型').selectOption('宣讲会');
    await expect(ongoing).toHaveCount(0);
    await page.getByLabel('活动类型').selectOption('');
    await page.getByRole('button', { name: '后7天', exact: true }).click();
    await expect(ongoing).toBeVisible();
    await expect(page.getByText('这一天暂无活动', { exact: true })).toBeVisible();
    await page.getByLabel('跳转日期').fill('2026-10-19');
    await expect(ongoing).toHaveCount(0);
    await page.getByLabel('跳转日期').fill('2026-09-24');
    await expect(ongoing).toBeVisible();
    await ongoing.screenshot({ path: 'test-results/schedule-ongoing-desktop.png' });
    const pdf = pdfFixture();
    fixture.respond('get_group_file_url', () => ({ base64: pdf.toString('base64') }));
    const beforePdf = requests;
    fixture.push({ ...sample(112, ''), message: [{ type: 'file', data: { name: 'recruitment.pdf', file_id: 'fixture-pdf', file_size: pdf.length } }] });
    await expect.poll(async () => (await page.evaluate(() => window.desktop!.processingStatus())).pending).toBe(1);
    await startOneTimeSync();
    await expect.poll(() => requests, { timeout: 20000 }).toBeGreaterThan(beforePdf);
    expect(visionCalls).toBe(1);
    await waitForSyncToStop();
    const jpeg = await sharp({ create: { width: 600, height: 300, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    const scan = pdfFixture({ jpeg });
    fixture.respond('get_group_file_url', () => ({ base64: scan.toString('base64') }));
    fixture.push({ ...sample(113, ''), message: [{ type: 'file', data: { name: 'scanned.pdf', file_id: 'fixture-scan', file_size: scan.length } }] });
    await expect.poll(async () => (await page.evaluate(() => window.desktop!.processingStatus())).pending).toBe(1);
    await startOneTimeSync();
    await expect.poll(() => visionCalls, { timeout: 20000 }).toBeGreaterThanOrEqual(2);
    await waitForSyncToStop();
    const beforeLong = requests;
    fixture.push(sample(114, `${events[0].title}\n${events[0].evidence}，结束时间16:00。欢迎应届毕业生携带简历参加，现场将介绍研发岗位、培养安排与工作内容，并提供面对面的交流答疑。`));
    await expect.poll(async () => (await page.evaluate(() => window.desktop!.processingStatus())).pending).toBe(1);
    await startOneTimeSync();
    await expect.poll(() => requests).toBeGreaterThan(beforeLong);
    await waitForSyncToStop();
    await page.getByRole('button', { name: `查看活动：${events[0].title}`, exact: true }).click();
    await page.getByRole('dialog').locator('summary').first().click();
    await page.getByRole('button', { name: '关闭活动详情' }).click();
    fixture.push(sample(109, '已暂停的新消息'));
    await expect.poll(async () => (await page.evaluate(() => window.desktop!.processingStatus())).pending).toBe(1);
    const pausedRequests = requests;
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(requests).toBe(pausedRequests);
    expect(errors).toEqual([]);
    await app.close();
    app = await electron.launch({ args: ['.'], env });
    page = await app.firstWindow();
    await page.getByRole('button', { name: '日程', exact: true }).click();
    await page.getByLabel('跳转日期').fill('2026-09-24');
    await expect(page.getByRole('button', { name: '开始同步', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '查看活动：星河科技校园宣讲会', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '跨期事项' })).toContainText(ongoingEvent.title);
    expect(requests).toBe(pausedRequests);
    const status = await page.evaluate(() => window.desktop!.processingStatus());
    expect(status.pending).toBe(1);
    expect(status.completed).toBe(0);
  } finally {
    await app?.close();
    endpoint.closeAllConnections();
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('populated ongoing section and its detail fit desktop and mobile without repeating across days', async () => {
  const server = await preview({ preview: { host: '127.0.0.1', port: 5196, strictPort: false } });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  const activities: Activity[] = [events[0], events[1], ongoingEvent,
    { ...ongoingEvent, title: '研究院2026至2027年度毕业生网上报名', endDate: '2027-01-10' }].map((activity, index) =>
    ({ ...activity, id: String(index), sourceCount: 1, groupNames: ['测试关注群'], needsReview: false, updatedAt: 0 }));
  const state: AppState = { phase: 'idle', detail: '未连接', runtime: null, groups: [], archived: 4, historyBusy: false, logs: [] };
  try {
    await page.addInitScript(({ state, activities, status, details }) => {
      window.desktop = {
        request: async () => state, subscribe: () => () => {}, savedConnection: async () => ({}),
        schedule: async () => ({ activities, undated: [] }),
        activity: async (id: string) => ({ activity: activities.find(activity => activity.id === id)!, sources: [] }),
        processingStatus: async () => status, processingDetails: async () => details,
      } as unknown as DesktopBridge;
    }, { state, activities, status: emptyProcessingStatus, details: emptyProcessingDetails });
    await page.goto(server.resolvedUrls!.local[0]);
    await page.getByRole('button', { name: '日程', exact: true }).click();
    await page.getByLabel('跳转日期').fill('2026-09-24');
    const ongoing = page.getByRole('region', { name: '跨期事项', exact: true });
    await expect(ongoing.getByRole('button')).toHaveCount(2);
    await page.getByRole('button', { name: /^2026-09-25 / }).click();
    await expect(page.getByRole('button', { name: `查看活动：${events[1].title}` })).toHaveCount(1);
    for (const width of [1440, 900, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await ongoing.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await ongoing.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      for (const button of await ongoing.getByRole('button').all()) {
        expect(await button.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        const title = await button.locator('strong').boundingBox();
        const dates = await button.getByText(/2026-09-09 至/).boundingBox();
        expect(title && dates && (title.x + title.width <= dates.x || title.y + title.height <= dates.y)).toBeTruthy();
      }
      await page.screenshot({ path: `test-results/schedule-ongoing-${width}.png` });
      await ongoing.getByRole('button').first().click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('起止日期');
      await expect(dialog).not.toContainText('时间待确认');
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: `test-results/schedule-ongoing-detail-${width}.png` });
      await page.getByRole('button', { name: '关闭活动详情' }).click();
    }
  } finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())); }
});

test('sync details show message images, open links externally and emphasize stopping', async () => {
  const server = await preview({ preview: { host: '127.0.0.1', port: 5197, strictPort: false } });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  const poster = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#53765f' } }).png().toBuffer();
  const state: AppState = {
    phase: 'online', detail: '已连接', runtime: 'managed', archived: 1, historyBusy: false, logs: [],
    account: { id: '10001', nickname: '测试账号' }, localAccount: { id: '10001', nickname: '测试账号' },
    groups: [{ id: '731234567', name: '就业信息群', memberCount: 100, maxMembers: 500, followed: true, messageCount: 1 }],
  };
  const status = { ...emptyProcessingStatus, processorVersion: 3, enabled: true, since: 1, pending: 1 };
  const details = {
    total: 1, hasMore: false, counts: { pending: 1, running: 0, completed: 0 },
    items: [{ key: 'message-1', bucket: 'pending' as const, state: 'pending' as const, groupName: '就业信息群', senderName: '就业老师',
      messageTime: Date.parse('2026-09-21T04:00:00Z') / 1000,
      text: '宣讲会详情和报名入口：https://jobs.example.com/campus/apply', contentTypes: ['text', 'image'],
      images: [{ segmentIndex: 1, url: 'https://assets.example.com/poster.png' }],
      links: [{ title: '分享的宣讲会通知', url: 'https://jobs.example.com/news' }], activityTitles: [], error: '' }],
  };
  try {
    await page.route('https://assets.example.com/poster.png', route => route.fulfill({ status: 200, contentType: 'image/png', body: poster }));
    await page.addInitScript(({ state, status, details }) => {
      (window as any).__openedLinks = [];
      window.desktop = {
        request: async () => state, subscribe: () => () => {}, savedConnection: async () => ({}),
        schedule: async () => ({ activities: [], undated: [] }), activity: async () => null,
        processingStatus: async () => status, processingDetails: async () => details,
        configureProcessing: async (value: { enabled: boolean }) => ({ ...status, enabled: value.enabled }), retryProcessing: async () => status,
        openExternal: async (url: string) => { (window as any).__openedLinks.push(url); },
      } as unknown as DesktopBridge;
    }, { state, status, details });
    await page.goto(server.resolvedUrls!.local[0]);
    await page.getByRole('button', { name: '日程', exact: true }).click();
    await page.getByRole('button', { name: '查看同步进度', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const image = dialog.getByRole('img', { name: '群消息图片' });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(320);
    await dialog.getByRole('link', { name: 'https://jobs.example.com/campus/apply' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__openedLinks)).toContain('https://jobs.example.com/campus/apply');
    await dialog.getByRole('link', { name: '分享的宣讲会通知' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__openedLinks)).toContain('https://jobs.example.com/news');
    const stop = dialog.getByRole('button', { name: '停止同步', exact: true });
    await expect(stop).toBeVisible();
    expect(await stop.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(166, 71, 61)');
    for (const width of [1000, 375]) {
      await page.setViewportSize({ width, height: 820 });
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: `test-results/schedule-sync-media-${width}.png` });
    }
  } finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())); }
});

test('schedule browser preview has real empty states and responsive navigation down to 320px', async () => {
  const server = await preview({ preview: { host: '127.0.0.1', port: 5195, strictPort: false } });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  try {
    await page.goto(server.resolvedUrls!.local[0]);
    await page.getByRole('button', { name: '日程', exact: true }).click();
    await expect(page.getByRole('button', { name: '开始同步', exact: true })).toBeDisabled();
    await expect(page.getByText('这一天暂无活动', { exact: true })).toBeVisible();
    for (const width of [1280, 900, 760, 375, 320]) {
      await page.setViewportSize({ width, height: 820 });
      await expect(page.getByRole('heading', { name: '日程', exact: true })).toBeVisible();
      for (const name of ['群消息', '日程', '设置']) await expect(page.getByRole('button', { name, exact: true }).first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator('section[aria-label="日程"]').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: `test-results/schedule-preview-${width}.png` });
    }
    await page.getByRole('button', { name: '后7天', exact: true }).click();
    await page.getByRole('button', { name: '回到今天', exact: true }).click();
    await expect(page.getByLabel('跳转日期')).toHaveValue(chinaToday());
  } finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())); }
});
