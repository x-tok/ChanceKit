import { test, expect, chromium, type Page } from '@playwright/test';
import { preview } from 'vite';
import type { AppState, Command, DesktopBridge } from '../../src/shared';
import type { JobChatDetail, JobChatOverview, JobResultRef } from '../../src/chat';
import { emptyProcessingStatus } from '../../src/schedule';

async function setup(page: Page, count = 6, web = false, noAccount = false) {
  const initial: AppState = {
    phase: 'idle', detail: '本地记录可离线查看', runtime: null, groups: [
      { id: '731234567', name: '校园招聘信息交流', memberCount: 387, maxMembers: 500, followed: true, messageCount: 42 },
    ], archived: 70, historyBusy: false, logs: [], localAccount: { id: '100010001', nickname: '见机测试账号' },
  };
  const overview: JobChatOverview = {
    dataset: { information: 26, incomplete: 3, activities: 12, processed: 8, followedGroups: 1 },
    sessions: [{ id: '00000000-0000-4000-8000-000000000001', title: '宣讲会与数据岗位',
      createdAt: 1_790_020_800_000, updatedAt: 1_790_020_860_000, preview: '找到相关的已处理信息。' }],
  };
  const markdown = `## 筛选结果

找到 **相关活动与岗位**，可以在下方查看详情。

- 优先核对时间
- 查看报名入口

| 信息 | 地点 |
| --- | --- |
| 宣讲会 | 深圳 |
| 双选会 | 北京 |

> 招聘公告中的截止日期仍需核对。

\`\`\`sql
SELECT '已处理信息';
\`\`\`

[招聘官网](https://jobs.example.com/campus)

[不安全链接](javascript:alert(1))
<img src="https://untrusted.example/pixel" onerror="alert(1)" />
<script>window.markdownExecuted = true;</script>
![说明图片](https://untrusted.example/image.png)
`;
  const titles = ['港湾研究院校园宣讲会', '春季联合双选会', '星港物流数据分析岗', '已处理的投递说明', '没有外链的招聘通知', '待补全的笔试安排'];
  const detail: JobChatDetail = {
    session: overview.sessions[0], messages: [
      { id: 'u1', role: 'user', content: '帮我查找宣讲会、双选会和数据岗位。', createdAt: 1_790_020_800_000, opportunities: [] },
      { id: 'a1', role: 'assistant', content: markdown, createdAt: 1_790_020_860_000,
        opportunities: titles.slice(0, count).map((title, index) => ({
          messageKey: String(index + 1).repeat(64), title, summary: `这是一条已处理信息，包含${index < 2 ? '活动安排和招聘交流' : '岗位介绍与投递说明'}。`,
          groupId: '731234567', groupName: '校园招聘信息交流', messageTime: 1_790_020_800,
          category: index < 2 ? 'activity' : index === 3 ? 'processed' : index === 5 ? 'incomplete' : 'information',
          matchedBy: [], ...(index < 2 ? { activityId: String(index + 7).repeat(64), activityType: index === 0 ? '宣讲会' : '双选会', startDate: '2026-09-24', location: '深圳校区礼堂' } : {}),
        })),
      },
    ],
  };
  if (noAccount) {
    delete initial.localAccount;
    initial.groups = [];
    overview.dataset = { information: 0, incomplete: 0, activities: 0, processed: 0, followedGroups: 0 };
  }
  if (web) {
    detail.messages[1].webSources = [
      { kind: 'web', url: 'https://jobs.example.com/campus?from=chat&year=2027', title: '示例公司 2027 校园招聘',
        summary: '官网招聘入口与岗位介绍。', fetchedAt: 1_790_020_860_000, status: 'read',
        text: '2027 届校园招聘。软件开发岗位，工作地点上海，请查看职位要求。' },
      { kind: 'web', url: 'https://jobs.example.com/dynamic', title: '动态加载的招聘页面',
        summary: '搜索结果提示存在校招入口。', fetchedAt: 1_790_020_860_000, status: 'unavailable', note: '正文需要动态加载，尚未核实。' },
    ];
  }
  await page.addInitScript(({ initial, overview, detail, emptyProcessingStatus }) => {
    Object.assign(window, { openedChatLinks: [], resultRequests: [], missingChatResult: false, failChatResult: false });
    const controls = window as unknown as { openedChatLinks: string[]; resultRequests: JobResultRef[]; missingChatResult: boolean; failChatResult: boolean };
    window.desktop = {
      request: async (command: Command) => command.type === 'state' ? initial : undefined,
      subscribe: () => () => {}, onboardingStatus: async () => ({ completed: true }),
      schedule: async () => ({ activities: [], undated: [] }), processingStatus: async () => emptyProcessingStatus,
      jobChatOverview: async () => overview, jobChatSession: async () => structuredClone(detail),
      openExternal: async (url: string) => { controls.openedChatLinks.push(url); },
      jobChatResult: async (ref: JobResultRef) => {
        controls.resultRequests.push(ref);
        if (controls.failChatResult) throw new Error('synthetic failure');
        if (controls.missingChatResult) return null;
        const item = detail.messages[1].opportunities.find(item => item.messageKey === ref.messageKey && item.activityId === ref.activityId)!;
        return { item, activity: item.activityId ? {
          title: item.title, type: item.activityType, organizer: '港湾研究院', startDate: '2026-09-24', endDate: null,
          startTime: '14:00', endTime: '16:00', location: '深圳校区礼堂', audience: '2027 届毕业生',
          description: '技术方向宣讲与现场交流', registrationUrl: null, deadline: null, evidence: '9 月 24 日 14:00',
        } : undefined, sources: [{
          messageKey: item.messageKey, groupId: item.groupId, groupName: item.groupName, senderName: '就业信息员',
          messageTime: item.messageTime, text: `完整原文：${item.title}。请准备简历，关注后续通知。`, evidence: '', materials: [], warnings: [],
        }] };
      },
      sendJobChat: async () => ({ session: detail.session, message: detail.messages[1] }),
      cancelJobChat: async () => {}, deleteJobChat: async () => false,
    } as unknown as DesktopBridge;
  }, { initial, overview, detail, emptyProcessingStatus });
}

async function withPage(operation: (page: Page, url: string) => Promise<void>) {
  const server = await preview({ preview: { host: '127.0.0.1', port: 5201, strictPort: false } });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  try { await operation(page, server.resolvedUrls!.local[0]); }
  finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())); }
}

async function openChat(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole('button', { name: '助手', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'AI 求职助手', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '筛选结果' })).toBeAttached();
}

test('chat renders safe Markdown, four preview cards and all six clickable details', async () => {
  await withPage(async (page, url) => {
    const requests: string[] = [];
    page.on('request', req => { if (req.url().includes('untrusted.example')) requests.push(req.url()); });
    await setup(page); await openChat(page, url);
    await expect(page.getByText('机会顾问', { exact: true })).toHaveCount(0);
    await expect(page.getByText('[机会 1]', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('描述求职需求')).not.toHaveAttribute('placeholder', /接受实习转正/);
    const log = page.getByLabel('聊天记录');
    await expect(log.locator('strong').filter({ hasText: '相关活动与岗位' })).toHaveCount(1);
    await expect(log.locator('table th')).toHaveCount(2);
    await expect(log.locator('blockquote')).toHaveCount(1);
    await expect(log.locator('pre code')).toContainText("SELECT '已处理信息'");
    await expect(log.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(log.locator('script, img')).toHaveCount(0);
    expect(requests).toEqual([]);
    await log.getByRole('link', { name: '招聘官网' }).click();
    expect(await page.evaluate(() => (window as any).openedChatLinks)).toEqual(['https://jobs.example.com/campus']);
    const cards = log.getByRole('button', { name: /^查看详情：/ });
    await expect(cards).toHaveCount(4);
    await cards.first().click();
    let dialog = page.getByRole('dialog', { name: '信息详情' });
    await expect(dialog.getByText('深圳校区礼堂', { exact: true })).toBeVisible();
    await expect(dialog.getByText(/完整原文：港湾研究院/)).toBeVisible();
    await dialog.getByRole('button', { name: '关闭结果弹窗' }).click();
    await expect(cards.first()).toBeFocused();
    await page.getByRole('button', { name: '查看全部 6 条相关信息' }).click();
    dialog = page.getByRole('dialog', { name: '全部相关信息' });
    await expect(dialog.getByRole('button', { name: /^查看详情：/ })).toHaveCount(6);
    await dialog.getByRole('button', { name: '查看详情：没有外链的招聘通知' }).click();
    dialog = page.getByRole('dialog', { name: '信息详情' });
    await expect(dialog.getByText(/完整原文：没有外链的招聘通知/)).toBeVisible();
    await dialog.getByRole('button', { name: '返回全部相关信息' }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: '查看详情：没有外链的招聘通知' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '查看全部 6 条相关信息' })).toBeFocused();
  });
});

test('chat result dialogs fit desktop minimum and narrow viewports', async () => {
  await withPage(async (page, url) => {
    await setup(page); await openChat(page, url);
    for (const [width, height] of [[1280, 820], [900, 640], [375, 820], [320, 820]]) {
      await page.setViewportSize({ width, height });
      await page.getByLabel('聊天记录').evaluate(el => { el.scrollTop = 0; });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/chat-markdown-${width}.png` });
      await page.getByRole('button', { name: '查看全部 6 条相关信息' }).click();
      const dialog = page.getByRole('dialog');
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: `test-results/chat-results-${width}.png` });
      await dialog.getByRole('button', { name: '查看详情：春季联合双选会' }).click();
      await expect(dialog.getByText(/完整原文：春季联合双选会/)).toBeVisible();
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: `test-results/chat-detail-${width}.png` });
      await dialog.getByRole('button', { name: '关闭结果弹窗' }).click();
    }
  });
});

test('four results need no overflow button; removed or failed details have recoverable states', async () => {
  await withPage(async (page, url) => {
    await setup(page, 4); await openChat(page, url);
    await expect(page.getByRole('button', { name: /查看全部/ })).toHaveCount(0);
    await page.evaluate(() => { (window as any).missingChatResult = true; });
    await page.getByRole('button', { name: '查看详情：已处理的投递说明' }).click();
    await expect(page.getByRole('dialog').getByText(/这条信息已更新/)).toBeVisible();
    await page.keyboard.press('Escape');
    await page.evaluate(() => { (window as any).failChatResult = true; });
    await page.getByRole('button', { name: '查看详情：已处理的投递说明' }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('详情读取失败');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { (window as any).missingChatResult = false; (window as any).failChatResult = false; });
    await page.getByRole('button', { name: '查看详情：已处理的投递说明' }).click();
    await expect(page.getByRole('dialog').getByText(/完整原文：已处理的投递说明/)).toBeVisible();
  });
});

test('local and web cards share overflow, label source evidence and preserve external details after reopening', async () => {
  await withPage(async (page, url) => {
    await setup(page, 3, true); await openChat(page, url);
    await expect(page.getByText('本地 + 网络', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('聊天记录').getByRole('button', { name: /^查看详情：/ })).toHaveCount(4);
    await page.getByRole('button', { name: '查看全部 5 条相关信息' }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: /^查看详情：/ })).toHaveCount(5);
    await dialog.getByRole('button', { name: '查看详情：示例公司 2027 校园招聘' }).click();
    await expect(dialog.getByText('网络来源 · 已读取网页')).toBeVisible();
    await expect(dialog.getByRole('heading', { name: '网页正文摘录' })).toBeVisible();
    await expect(dialog.getByText(/非发布时间/)).toBeVisible();
    await dialog.getByRole('link').click();
    expect(await page.evaluate(() => (window as any).openedChatLinks)).toEqual(['https://jobs.example.com/campus?from=chat&year=2027']);
    expect(await page.evaluate(() => (window as any).resultRequests)).toEqual([]);
    await page.screenshot({ path: 'test-results/chat-web-detail.png' });
    await dialog.getByRole('button', { name: '返回全部相关信息' }).click();
    await expect(dialog.getByRole('button', { name: '查看详情：示例公司 2027 校园招聘' })).toBeFocused();
    await dialog.getByRole('button', { name: '查看详情：动态加载的招聘页面' }).click();
    await expect(dialog.getByText('网络来源 · 正文未能核实')).toBeVisible();
    await expect(dialog.getByText('正文需要动态加载，尚未核实。')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.reload();
    await page.getByRole('button', { name: '助手', exact: true }).click();
    await page.getByRole('button', { name: '查看全部 5 条相关信息' }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: /^查看详情：/ })).toHaveCount(5);
    await page.setViewportSize({ width: 375, height: 820 });
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/chat-mixed-results-mobile.png' });
  });
});

test('chat remains usable without a QQ account and renders network-only results', async () => {
  await withPage(async (page, url) => {
    await setup(page, 0, true, true); await openChat(page, url);
    await expect(page.getByLabel('描述求职需求')).toBeEnabled();
    await page.getByLabel('描述求职需求').fill('帮我看看校园招聘官网');
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: /^查看详情：/ })).toHaveCount(2);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByLabel('描述求职需求')).toBeEnabled();
  });
});
