import { test, expect, chromium } from '@playwright/test';
import { preview } from 'vite';
import type { Activity, ActivitySource, ScheduleQuery } from '../../src/schedule';
import { emptyInformationPage, emptyProcessingDetails, emptyProcessingStatus } from '../../src/schedule';
import type { AppState, DesktopBridge } from '../../src/shared';

test('today-centered calendar selects dates and renders structured times and readable sources at desktop and mobile sizes', async () => {
  const server = await preview({ preview: { host: '127.0.0.1', port: 5197, strictPort: false } });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  await page.clock.setFixedTime(new Date('2026-09-21T04:00:00Z'));
  const titles = ['海岳能源校园宣讲会', '星海研究院研发岗位交流', '秋季重点单位招聘会', '材料技术研究所校园招聘'];
  const activities: Activity[] = titles.map((title, index) => ({
    id: `session-${index}`, title, type: index === 2 ? '招聘会' : '宣讲会', organizer: '',
    startDate: '2026-09-21', endDate: null,
    startTime: index === 0 ? '09:30' : index === 1 ? '14:00' : null,
    endTime: index === 1 ? '16:00' : index === 2 ? '18:00' : null,
    location: index === 2 ? '九龙湖校区 焦廷标馆' : '九龙湖校区 教学楼4号楼202',
    audience: '', description: '', registrationUrl: null, deadline: null, evidence: '合成测试通知',
    sourceCount: 1, groupNames: ['校园招聘信息交流群'], needsReview: index >= 2, updatedAt: 0,
  }));
  const sourceLink = 'https://example.com/recruit?year=2027#/campus';
  const originals = [
    '海岳能源校园宣讲会\n9月21日09:30，九龙湖校区教学楼4号楼202。\n欢迎携带简历参加，现场介绍岗位和培养安排。',
    sourceLink,
    '秋季重点单位招聘会将在焦廷标馆举行，18:00结束，开始时间另行通知。',
    '[卡片]',
  ];
  const sources: Record<string, ActivitySource[]> = Object.fromEntries(activities.map((activity, index) => [activity.id, [{
    messageKey: `message-${index}`, groupId: 'test-group', groupName: '校园招聘信息交流群',
    senderName: '就业指导老师', messageTime: 1789950000, text: originals[index],
    evidence: activity.evidence, warnings: [], materials: index === 3 ? [{ kind: 'page', url: 'https://example.com/article', title: '材料技术研究所校招' }] : [],
  }]]));
  sources[activities[2].id][0].relatedMessages = [{
    messageKey: 'quoted', text: '请留意这场招聘会的时间补充。', senderName: '就业指导老师', messageTime: 1789900000, relation: 'quoted',
  }];
  const state: AppState = { phase: 'idle', detail: '', runtime: null, historyBusy: false, archived: 4, logs: [],
    localAccount: { id: 'test', nickname: '测试账号' },
    groups: [{ id: 'test-group', name: '校园招聘信息交流群', followed: true, messageCount: 4, memberCount: 168, maxMembers: 500 }] };
  try {
    await page.addInitScript(({ state, activities, sources, status, details, information }) => {
      const requests: ScheduleQuery[] = [], links: string[] = [];
      Object.assign(window, { calendarRequests: requests, calendarLinks: links });
      window.desktop = {
        request: async () => state, subscribe: () => () => {}, savedConnection: async () => ({}),
        schedule: async (query: ScheduleQuery) => {
          requests.push(query);
          return { activities: activities.filter(item => (!query.type || item.type === query.type)
            && (!query.search || item.title.includes(query.search))), undated: [], sources };
        },
        activity: async (id: string) => ({ activity: activities.find(item => item.id === id)!, sources: sources[id] }),
        processingStatus: async () => status, processingDetails: async () => details, information: async () => information,
        openExternal: async (url: string) => { links.push(url); },
      } as unknown as DesktopBridge;
    }, { state, activities, sources, status: emptyProcessingStatus, details: emptyProcessingDetails, information: emptyInformationPage });
    await page.goto(server.resolvedUrls!.local[0]);
    await page.getByRole('button', { name: '日程', exact: true }).click();
    await expect(page.getByText('时间未定时，请查看原始消息', { exact: true })).toHaveCount(0);
    const dates = page.getByRole('group', { name: '七天日期' }).getByRole('button');
    await expect(dates).toHaveCount(7);
    await expect(dates.nth(3)).toHaveAttribute('aria-current', 'date');
    await expect(dates.nth(3)).toHaveAttribute('aria-pressed', 'true');
    await expect(dates.first()).toHaveAttribute('aria-label', '2026-09-18 周五');
    await expect(dates.last()).toHaveAttribute('aria-label', '2026-09-24 周四');
    const table = page.getByRole('table', { name: '当日活动列表' });
    await expect(table.getByRole('row')).toHaveCount(5);
    await expect(table.getByRole('columnheader')).toHaveText(['宣讲会 / 招聘会名称', '时间', '地点', '原始消息']);
    for (const [index, label] of ['09:30', '14:00–16:00', '未定–18:00', '未定'].entries()) {
      const row = table.getByRole('row').filter({ has: page.getByRole('button', { name: `查看活动：${titles[index]}` }) });
      await expect(row.getByRole('cell').nth(0)).toHaveText(label);
    }
    await expect(table).toContainText(originals[0]);
    await expect(table).toContainText('引用原消息');
    await expect(table.getByRole('link', { name: 'https://example.com/article', exact: true })).toBeVisible();
    await table.getByRole('link', { name: sourceLink, exact: true }).click();
    expect(await page.evaluate(() => (window as any).calendarLinks)).toEqual([sourceLink]);
    await expect(table).not.toContainText('"messageKey"');
    await dates.nth(4).click();
    await expect(page.getByText('这一天暂无活动', { exact: true })).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(1);
    await dates.nth(3).focus();
    await page.keyboard.press('Enter');
    await expect(table.getByRole('row')).toHaveCount(5);
    for (const [width, height] of [[1440, 900], [1280, 820], [900, 640], [760, 820], [375, 820], [320, 640]]) {
      await page.setViewportSize({ width, height });
      await page.getByRole('heading', { name: '日程', exact: true }).scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(dates.nth(3)).toBeVisible();
      await expect(page.getByRole('region', { name: '日程同步', exact: true })).toHaveCount(0);
      const syncButton = await page.getByRole('button', { name: '开始同步', exact: true }).boundingBox();
      const calendarBox = await page.getByRole('group', { name: '七天日期' }).boundingBox();
      expect(syncButton!.y + syncButton!.height).toBeLessThan(calendarBox!.y);
      expect(calendarBox!.height).toBeLessThanOrEqual(width <= 760 ? 108 : 122);
      for (const date of await dates.all()) {
        expect(await date.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      }
      await page.screenshot({ path: `test-results/calendar-table-${width}.png` });
      if (width <= 375) {
        await page.getByRole('button', { name: '开始同步', exact: true }).click();
        const syncDialog = page.getByRole('dialog');
        await expect(syncDialog).toBeVisible();
        expect(await syncDialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await syncDialog.screenshot({ path: `test-results/schedule-sync-${width}.png` });
        await syncDialog.getByRole('button', { name: '关闭同步详情', exact: true }).click();
      }
      const scroll = page.getByRole('region', { name: '当日活动表格，可横向滚动' });
      await scroll.evaluate(element => { element.scrollLeft = element.scrollWidth; });
      await expect(table.getByRole('link', { name: sourceLink, exact: true })).toBeVisible();
      if (width <= 375) {
        await table.getByRole('link', { name: sourceLink, exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `test-results/calendar-sources-${width}.png` });
      }
      await scroll.evaluate(element => { element.scrollLeft = 0; });
    }
    await page.getByLabel('跳转日期').fill('2027-01-01');
    await expect(dates.first()).toHaveAttribute('aria-label', '2026-12-29 周二');
    await expect(dates.nth(3)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => page.evaluate(() => (window as any).calendarRequests.at(-1).week)).toBe('2026-12-29');
    await page.getByRole('button', { name: '回到今天' }).click();
    await expect(dates.nth(3)).toHaveAttribute('aria-current', 'date');
    await page.getByLabel('活动类型').selectOption('招聘会');
    await expect(table.getByRole('row')).toHaveCount(2);
    await page.getByLabel('搜索活动').fill('不存在');
    await expect(page.getByText('没有符合筛选条件的活动')).toBeVisible();
  } finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())); }
});
