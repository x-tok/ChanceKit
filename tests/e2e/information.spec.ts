import { test, expect, _electron as electron, chromium, type ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { preview } from 'vite';
import { mockNapCat, sample } from '../fixtures';
import { emptyProcessingStatus, type ActivityInput, type InformationDetail, type InformationQuery, type RecruitingInformation } from '../../src/schedule';
import type { AppState, DesktopBridge } from '../../src/shared';

const ad = '星河银行2027届校园招聘正式启动，多个职位开放投递，面向理学、管理学和经济学等专业，提供导师培养及轮岗机会，欢迎同学投递简历。';
const groupTitle = '群聊：9月23日星河科技宣讲会-示例大学场';
const groupSummary = '微信群聊二维码。图片注明：该二维码7天内（9月27日前）有效，重新进入将更新。';
const activity: ActivityInput = {
  title: '星河技术宣讲会', type: '宣讲会', organizer: '星河科技', startDate: '2026-09-24', endDate: null,
  startTime: '14:00', endTime: null, location: '实验楼201', audience: '', description: '', registrationUrl: null, deadline: null,
  evidence: '2026年9月24日14:00，实验楼201',
};

test('recruiting information keeps pushes and incomplete attachments, moves recovered events and persists paused retries', async () => {
  const fixture = await mockNapCat();
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-info-e2e-'));
  let requests = 0, recovered = false, quotedRequests = 0, readingGroupCard = false;
  const endpoint = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const visual = body.tools[0].function.name === 'submit_visual_text';
    const user = body.messages.find((message: any) => message.role === 'user');
    const input = visual ? {} : JSON.parse(typeof user.content === 'string' ? user.content : user.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join(''));
    const quoted = input.currentMessage?.includes('引用地点补充');
    if (quoted) {
      expect(input.referencedMessages).toHaveLength(1);
      expect(input.referencedMessages[0].text).toContain('明天14:00');
      expect(input.referencedMessages[0].messageTime).toBe('2026-09-23 09:00:00');
      expect(input.linkedContent).toContain('研发岗位说明');
      quotedRequests++;
    }
    const output = visual ? readingGroupCard ? { text: `${groupTitle}\n${groupSummary}`, unreadable: false }
      : { text: recovered ? `${activity.title} ${activity.evidence}` : '', unreadable: !recovered }
      : quoted ? { activities: [{ ...activity, title: '星海研究院宣讲会', evidence: '原消息：明天14:00；引用地点补充：实验楼201' }] }
      : input.linkedContent?.includes(groupTitle) ? { activities: [], information: { title: groupTitle, summary: groupSummary } }
      : input.linkedContent?.includes(activity.title) ? { activities: [activity] }
      : { activities: [], information: input.currentMessage?.includes('学院推送') ? { title: '企业招聘岗位资讯', summary: '岗位职责与毕业生培养安排。' } : null };
    requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'test', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: visual ? 'submit_visual_text' : 'submit_activities', arguments: JSON.stringify(output) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  });
  endpoint.listen(0, '127.0.0.1'); await once(endpoint, 'listening');
  const baseUrl = `http://127.0.0.1:${(endpoint.address() as { port: number }).port}/v1`;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), CHANCEKIT_TEST_DATA: root };
  delete (env as Record<string, string>).ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: ['.'], env });
    let page = await app.firstWindow();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByLabel('服务商', { exact: true }).selectOption('custom');
    await page.getByLabel('API 地址', { exact: true }).fill(baseUrl);
    await page.getByLabel('模型 ID', { exact: true }).fill('information-test');
    await page.getByLabel('图像输入', { exact: true }).check();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByText('配置已保存', { exact: true })).toBeVisible();
    await page.evaluate(async config => {
      await window.desktop!.request({ type: 'connect', config });
      await window.desktop!.request({ type: 'follow', groupId: '731234567', followed: true });
    }, fixture.config);
    const png = await sharp({ create: { width: 120, height: 100, channels: 3, background: '#558166' } }).png().toBuffer();
    fixture.respond('get_image', () => ({ base64: png.toString('base64') }));
    fixture.push(sample(201, ad));
    fixture.push(sample(202, '学院推送：企业招聘岗位介绍与毕业生培养安排，欢迎了解投递方式。'));
    fixture.push({ ...sample(203, ''), message: [{ type: 'file', data: { name: '招聘附件.doc', file_id: 'synthetic-doc' } }] });
    fixture.push({ ...sample(204, ''), message: [{ type: 'image', data: { file: 'synthetic-poster.png' } }] });
    await page.getByRole('button', { name: '日程', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop!.processingStatus())).pending).toBe(4);
    await page.getByRole('switch', { name: '自动处理' }).click();
    await page.getByRole('button', { name: '开启处理', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop!.processingStatus())).partial).toBe(2);
    await expect.poll(async () => (await page.evaluate(() => window.desktop!.processingStatus())).completed).toBe(2);
    const panel = () => page.getByRole('region', { name: '招聘资讯', exact: true });
    await expect(panel().getByRole('button', { name: /^查看资讯：/ })).toHaveCount(2);
    await page.getByLabel('跳转日期').fill('2030-01-07');
    await expect(panel().getByRole('button', { name: /^查看资讯：/ })).toHaveCount(2);
    await panel().getByRole('button', { name: '查看资讯：企业招聘岗位资讯', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('消息发布时间');
    await expect(page.getByRole('dialog')).toContainText('学院推送');
    await page.getByRole('button', { name: '关闭资讯详情' }).click();
    await page.getByRole('region', { name: '消息处理' }).getByRole('button', { name: /待补全/ }).click();
    await expect(panel().getByRole('button', { name: /^待补全/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel().getByRole('button', { name: /^查看资讯：/ })).toHaveCount(2);
    await panel().screenshot({ path: 'test-results/information-incomplete-desktop.png' });
    await panel().getByRole('button', { name: /查看资讯：.*招聘附件/ }).click();
    await expect(page.getByRole('dialog')).toContainText('招聘附件.doc');
    await expect(page.getByRole('dialog').locator('details')).not.toHaveAttribute('open');
    await page.getByRole('button', { name: '关闭资讯详情' }).click();
    await panel().getByRole('button', { name: /查看资讯：.*招聘图片/ }).click();
    recovered = true;
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop!.processingStatus())).partial).toBe(1);
    await expect(page.getByRole('dialog')).toContainText('提取为日程');
    await page.getByRole('button', { name: '关闭资讯详情' }).click();
    await page.getByLabel('跳转日期').fill('2026-09-24');
    await expect(page.getByRole('button', { name: `查看活动：${activity.title}`, exact: true })).toBeVisible();
    const original = { ...sample(190, ''), time: Date.parse('2026-09-23T09:00:00+08:00') / 1000, message: [
      { type: 'text', data: { text: '星海研究院宣讲会，明天14:00，地点稍后补充。' } },
      { type: 'file', data: { name: '招聘说明.txt', file_id: 'quoted-original-file' } },
    ] };
    fixture.respond('get_msg', () => original);
    fixture.respond('get_group_file_url', () => ({ base64: Buffer.from('研发岗位说明：面向毕业生开放投递。').toString('base64') }));
    fixture.push({ ...sample(210, ''), time: Date.parse('2026-09-24T10:00:00+08:00') / 1000, message: [
      { type: 'reply', data: { id: '190' } }, { type: 'text', data: { text: '引用地点补充：实验楼201，请带简历。' } },
    ] });
    await expect(page.getByRole('button', { name: '查看活动：星海研究院宣讲会', exact: true })).toBeVisible();
    expect(quotedRequests).toBe(1);
    expect(fixture.calls.some(call => call.action === 'get_msg' && call.params.message_id === '190')).toBe(true);
    expect(fixture.calls.some(call => call.action === 'get_group_file_url' && call.params.file_id === 'quoted-original-file')).toBe(true);
    await page.getByRole('button', { name: '查看活动：星海研究院宣讲会', exact: true }).click();
    const quote = page.getByRole('dialog').locator('details').filter({ has: page.locator('summary', { hasText: '引用原消息' }) }).last();
    await quote.locator('summary').click();
    await expect(quote).toContainText('明天14:00');
    await expect(quote).toContainText('2026/9/23');
    await page.getByRole('button', { name: '关闭活动详情' }).click();
    readingGroupCard = true;
    const groupPng = await sharp({ create: { width: 120, height: 180, channels: 3, background: '#eeeeee' } }).png().toBuffer();
    fixture.respond('get_image', () => ({ base64: groupPng.toString('base64') }));
    fixture.push({ ...sample(211, ''), message: [{ type: 'image', data: { file: 'synthetic-group-card.png' } }] });
    await panel().getByRole('button', { name: /^资讯推送/ }).click();
    await panel().getByRole('button', { name: `查看资讯：${groupTitle}`, exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(groupSummary);
    await expect(page.getByRole('dialog')).not.toContainText('材料尚未读全');
    await expect(page.getByRole('dialog')).toContainText('打开来源群聊');
    const week = await page.evaluate(() => window.desktop!.schedule({ week: '2026-09-21' }));
    expect(week.activities).toHaveLength(2);
    expect(week.undated).toHaveLength(0);
    expect(week.activities.every(item => !item.title.startsWith('群聊：') && item.startDate === '2026-09-24')).toBe(true);
    await page.getByRole('button', { name: '关闭资讯详情' }).click();
    await page.getByRole('switch', { name: '自动处理' }).click();
    await panel().getByRole('button', { name: /^待补全/ }).click();
    await panel().getByRole('button', { name: /查看资讯：.*招聘附件/ }).click();
    const beforeRetry = requests;
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('等待补读');
    await expect(page.getByRole('dialog')).toContainText('自动处理已暂停');
    expect(requests).toBe(beforeRetry);
    await page.getByRole('button', { name: '关闭资讯详情' }).click();
    await app.close();
    app = await electron.launch({ args: ['.'], env });
    page = await app.firstWindow();
    await page.getByRole('button', { name: '日程', exact: true }).click();
    await expect(panel().getByRole('button', { name: /^查看资讯：/ })).toHaveCount(3);
    await expect(panel().getByRole('button', { name: `查看资讯：${groupTitle}`, exact: true })).toBeVisible();
    await panel().getByRole('button', { name: /^待补全/ }).click();
    await expect(panel().getByRole('button', { name: /^查看资讯：/ })).toHaveCount(1);
    await expect(panel()).toContainText('等待补读');
    expect(requests).toBe(beforeRetry);
    await page.evaluate(() => window.desktop!.request({ type: 'follow', groupId: '731234567', followed: false }));
    await expect(panel().getByRole('button', { name: /^查看资讯：/ })).toHaveCount(0);
  } finally {
    await app?.close(); endpoint.closeAllConnections();
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
    await fixture.close(); await rm(root, { recursive: true, force: true });
  }
});

test('information lists, original long links and file details fit narrow windows', async () => {
  const server = await preview({ preview: { host: '127.0.0.1', port: 5197, strictPort: false } });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  const items: RecruitingInformation[] = [
    { messageKey: 'a', title: groupTitle, summary: groupSummary, category: 'information', processingState: 'completed' },
    { messageKey: 'b', title: '招聘附件 · 星河研究院2027届高校毕业生招聘及岗位说明.doc', summary: '', category: 'incomplete', processingState: 'partial' },
  ].map(item => ({ ...item, groupId: 'g', groupName: '毕业生就业与招聘推送信息交流群', messageTime: 1789873200 })) as RecruitingInformation[];
  const details: InformationDetail[] = items.map(item => ({
    item, text: `${ad}\nhttps://example.com/article?${'source=synthetic&'.repeat(30)}`, senderName: '合成消息来源',
    materials: item.category === 'information' ? [{ kind: 'image', url: '', title: 'QQ 图片附件' }]
      : [{ kind: 'file', url: '', title: '星河研究院2027届高校毕业生招聘及岗位说明.doc' },
        { kind: 'page', url: 'https://example.com/article', title: '合成多图网页', snapshotId: 'c'.repeat(64), pdfCoverage: { processedPages: 42, totalPages: 42 },
          notices: ['网页 PDF 动图按末帧静态呈现，非逐帧读取；可打开原网页查看动画。'] },
        ...Array.from({ length: 55 }, (_, index) => ({ kind: 'image' as const, url: `https://example.com/image-${index}.png` }))], reason: item.category === 'incomplete' ? '附件内容未读全' : '',
    diagnostics: ['保留的原始读取记录'], activityIds: [],
  }));
  const state: AppState = { phase: 'idle', detail: '未连接', runtime: null, groups: [], archived: 2, historyBusy: false, logs: [] };
  try {
    await page.addInitScript(({ state, items, details, status }) => {
      window.desktop = {
        request: async () => state, subscribe: () => () => {}, savedConnection: async () => ({}),
        schedule: async () => ({ activities: [], undated: [] }), processingStatus: async () => status,
        recruitingInformation: async (query: InformationQuery) => {
          const rows = items.filter(item => item.category === query.category && (!query.search || item.title.includes(query.search)));
          return { items: rows, total: rows.length, counts: { information: 1, incomplete: 1 }, hasMore: false };
        },
        informationDetail: async (key: string) => details.find(detail => detail.item.messageKey === key) ?? null,
        openWebpagePdf: async (key: string, snapshotId: string) => { (window as any).openedPdf = { key, snapshotId }; },
      } as unknown as DesktopBridge;
    }, { state, items, details, status: emptyProcessingStatus });
    await page.goto(server.resolvedUrls!.local[0]);
    await page.getByRole('button', { name: '日程', exact: true }).click();
    const panel = page.getByRole('region', { name: '招聘资讯', exact: true });
    for (const width of [1440, 900, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of ['资讯推送', '待补全']) {
        await panel.getByRole('button', { name: new RegExp(`^${name}`) }).click();
        await expect(panel.getByRole('button', { name: /^查看资讯：/ })).toHaveCount(1);
        await panel.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await page.screenshot({ path: `test-results/information-${name}-${width}.png` });
        await panel.getByRole('button', { name: /^查看资讯：/ }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('原消息与来源');
        if (name === '资讯推送') {
          await expect(dialog).toContainText(groupTitle);
          await expect(dialog).toContainText(groupSummary);
        } else {
          await expect(dialog).toContainText('已处理 42 / 42 页');
          const images = dialog.locator('details').filter({ has: page.locator('summary', { hasText: '来源图片 · 55 张' }) });
          await expect(images).not.toHaveAttribute('open');
          await expect(dialog.getByRole('button', { name: /^来源图片 \d+$/ })).toHaveCount(0);
          await images.locator('summary').click();
          await expect(dialog.getByRole('button', { name: /^来源图片 \d+$/ })).toHaveCount(55);
          await images.locator('summary').click();
          await dialog.getByRole('button', { name: '网页 PDF · 合成多图网页', exact: true }).click();
          expect(await page.evaluate(() => (window as any).openedPdf)).toEqual({ key: 'b', snapshotId: 'c'.repeat(64) });
        }
        expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await page.screenshot({ path: `test-results/information-detail-${name}-${width}.png` });
        await page.getByRole('button', { name: '关闭资讯详情' }).click();
      }
    }
    await panel.getByLabel('搜索招聘资讯').fill('没有匹配的内容');
    await expect(panel.getByText('没有符合筛选条件的资讯')).toBeVisible();
  } finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())); }
});
