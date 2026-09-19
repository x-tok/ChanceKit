import { test, expect, _electron as electron, chromium, type ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { preview } from 'vite';
import sharp from 'sharp';
import { mockNapCat, sample } from '../fixtures';
import type { ActivityInput } from '../../src/schedule';
import { weekStart, chinaToday } from '../../src/schedule';

const events: ActivityInput[] = [
  { title: '星河科技校园宣讲会', type: '宣讲会', organizer: '星河科技', startDate: '2026-09-24', endDate: null, startTime: '14:30', endTime: '16:00', location: '大学生活动中心 201', audience: '2027 届毕业生', description: '研发岗位介绍与现场简历交流。', registrationUrl: null, deadline: null, evidence: '9月24日14:30，大学生活动中心201' },
  { title: '秋季校园双选会', type: '双选会', organizer: '学校就业中心', startDate: '2026-09-25', endDate: '2026-09-26', startTime: '09:00', endTime: '17:00', location: '体育馆一层', audience: '应届毕业生', description: '多家用人单位到场，携带纸质简历。', registrationUrl: null, deadline: '9月24日18:00', evidence: '9月25日至26日9:00至17:00 体育馆一层' },
  { title: '秋招线上笔试', type: '笔试', organizer: '启明软件', startDate: '2026-09-23', endDate: null, startTime: '19:00', endTime: '21:00', location: '线上', audience: '已通过简历筛选的同学', description: '以邮件中的考试通知为准。', registrationUrl: null, deadline: null, evidence: '9月23日19:00线上笔试' },
  { title: '研究院实习交流会', type: '其他', organizer: '研究院', startDate: null, endDate: null, startTime: null, endTime: null, location: '待通知', audience: '硕士及博士研究生', description: '具体日期尚未公布。', registrationUrl: null, deadline: null, evidence: '实习交流会，时间另行通知' },
];

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
    const activity = events.find(event => `${input.currentMessage ?? ''}\n${input.linkedContent ?? ''}`.includes(event.title));
    const output = visual ? { text: `${events[0].title}\n${events[0].evidence}`, unreadable: false } : { activities: activity ? [activity] : [] };
    requests++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 180));
    active--;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'test', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: visual ? 'submit_visual_text' : 'submit_activities', arguments: JSON.stringify(output) } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
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
    await page.getByRole('button', { name: '模型配置', exact: true }).click();
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
    await expect.poll(async () => (await page.evaluate(() => window.desktop!.processingStatus())).pending).toBe(6);
    expect(requests).toBe(0);
    await page.getByRole('switch', { name: '自动处理' }).click();
    await expect(page.getByRole('dialog').getByText(/可能产生 API 费用/)).toBeVisible();
    await page.getByRole('button', { name: '开启处理', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop!.processingStatus())).completed, { timeout: 20000 }).toBe(6);
    expect(requests).toBe(6);
    expect(peak).toBe(3);
    await page.getByLabel('跳转日期').fill('2026-09-24');
    await expect(page.getByRole('button', { name: '查看活动：星河科技校园宣讲会', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: '查看活动：秋季校园双选会', exact: true })).toHaveCount(2);
    await expect(page.getByRole('region', { name: '日期待确认' })).toContainText('研究院实习交流会');
    await page.screenshot({ path: 'test-results/schedule-desktop.png' });
    await page.getByRole('button', { name: '查看活动：星河科技校园宣讲会', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('消息来源 · 2');
    await page.getByRole('dialog').locator('summary').first().click();
    await expect(page.getByRole('dialog')).toContainText('9月24日14:30');
    await page.screenshot({ path: 'test-results/schedule-detail.png' });
    await page.getByRole('button', { name: '关闭活动详情' }).click();
    await page.getByLabel('活动类型').selectOption('笔试');
    await expect(page.getByRole('button', { name: '查看活动：星河科技校园宣讲会', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '查看活动：秋招线上笔试', exact: true })).toBeVisible();
    await page.getByLabel('活动类型').selectOption('');
    await page.getByLabel('搜索活动').fill('没有这个活动');
    await expect(page.getByText('没有符合筛选条件的活动')).toBeVisible();
    await page.getByLabel('搜索活动').fill('');
    await page.getByRole('button', { name: '下一周', exact: true }).click();
    await expect(page.getByText('本周暂无已提取的活动')).toBeVisible();
    await page.getByRole('button', { name: '上一周', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 640));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/schedule-900.png' });
    fixture.push(sample(108, '新到达的无活动消息'));
    await expect.poll(async () => (await page.evaluate(() => window.desktop!.processingStatus())).completed).toBe(7);
    expect(requests).toBe(7);
    const poster = await sharp({ create: { width: 120, height: 100, channels: 3, background: '#567843' } }).png().toBuffer();
    fixture.respond('get_image', () => ({ base64: poster.toString('base64') }));
    fixture.push({ ...sample(110, ''), message: [{ type: 'image', data: { file: 'fixture-poster.png', file_size: poster.length } }] });
    await expect.poll(async () => (await page.evaluate(() => window.desktop!.processingStatus())).completed, { timeout: 20000 }).toBe(8);
    expect(visionCalls).toBe(1);
    expect(requests).toBe(9);
    expect(fixture.calls.some(call => call.action === 'get_image')).toBe(true);
    await page.getByRole('switch', { name: '自动处理' }).click();
    await expect(page.getByRole('switch', { name: '自动处理' })).not.toBeChecked();
    fixture.push(sample(109, '已暂停的新消息'));
    await expect.poll(async () => (await page.evaluate(() => window.desktop!.processingStatus())).pending).toBe(1);
    expect(requests).toBe(9);
    expect(errors).toEqual([]);
    await app.close();
    app = await electron.launch({ args: ['.'], env });
    page = await app.firstWindow();
    await page.getByRole('button', { name: '日程', exact: true }).click();
    await page.getByLabel('跳转日期').fill('2026-09-24');
    await expect(page.getByRole('switch', { name: '自动处理' })).not.toBeChecked();
    await expect(page.getByRole('button', { name: '查看活动：星河科技校园宣讲会', exact: true })).toBeVisible();
    expect(requests).toBe(9);
    const status = await page.evaluate(() => window.desktop!.processingStatus());
    expect(status.pending).toBe(1);
    expect(status.completed).toBe(8);
  } finally {
    await app?.close();
    endpoint.closeAllConnections();
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('schedule browser preview has real empty states and responsive navigation down to 320px', async () => {
  const server = await preview({ preview: { host: '127.0.0.1', port: 5195, strictPort: false } });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  try {
    await page.goto(server.resolvedUrls!.local[0]);
    await page.getByRole('button', { name: '日程', exact: true }).click();
    await expect(page.getByRole('switch', { name: '自动处理' })).toBeDisabled();
    await expect(page.getByText('本周暂无已提取的活动')).toBeVisible();
    for (const width of [1280, 900, 760, 375, 320]) {
      await page.setViewportSize({ width, height: 820 });
      await expect(page.getByRole('heading', { name: '日程', exact: true })).toBeVisible();
      for (const name of ['群消息', '日程', '连接 QQ', '模型配置']) await expect(page.getByRole('button', { name, exact: true }).first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator('section[aria-label="日程"]').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: `test-results/schedule-preview-${width}.png` });
    }
    await page.getByRole('button', { name: '下一周', exact: true }).click();
    await page.getByRole('button', { name: '本周', exact: true }).click();
    await expect(page.getByLabel('跳转日期')).toHaveValue(weekStart(chinaToday()));
  } finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())); }
});
