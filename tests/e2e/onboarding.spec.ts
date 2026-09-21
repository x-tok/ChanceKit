import { test, expect, chromium } from '@playwright/test';
import { preview } from 'vite';
import type { AppEvent, AppState, Command, DesktopBridge } from '../../src/shared';
import { defaultModelConfig } from '../../src/model-config';
import { emptyInformationPage, emptyProcessingStatus } from '../../src/schedule';

const groups = [
  { id: '731234567', name: '2027 届校园招聘信息交流', memberCount: 387, maxMembers: 500, followed: false, messageCount: 12, lastMessageAt: 1_789_980_000 },
  { id: '731234568', name: '宣讲会与双选会通知', memberCount: 216, maxMembers: 500, followed: false, messageCount: 18, lastMessageAt: 1_789_990_000 },
  { id: '731234569', name: '互联网校招资讯', memberCount: 402, maxMembers: 500, followed: false, messageCount: 7, lastMessageAt: 1_789_970_000 },
  { id: '731234570', name: '本地双选会互助', memberCount: 188, maxMembers: 500, followed: false, messageCount: 0 },
  { id: '731234571', name: '实习内推信息', memberCount: 329, maxMembers: 500, followed: false, messageCount: 0 },
  { id: '731234572', name: '高校就业通知', memberCount: 264, maxMembers: 500, followed: false, messageCount: 0 },
];

test('first-run onboarding completes QQ, DeepSeek and bounded group sync', async () => {
  const server = await preview({ preview: { host: '127.0.0.1', port: 5198, strictPort: false } });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const initial: AppState = { phase: 'idle', detail: '尚未连接 QQ', runtime: null, groups: [], archived: 0, historyBusy: false, logs: [],
    qq: { path: '/Applications/QQ.app', version: '9.9.21', architecture: 'arm64', platform: 'darwin' } };
  try {
    await page.addInitScript(({ initial, groups, defaultModelConfig, emptyProcessingStatus, emptyInformationPage }) => {
      let state = structuredClone(initial);
      let listener: ((event: AppEvent) => void) | undefined;
      const commands: Command[] = [];
      const emit = () => listener?.({ type: 'state', state: structuredClone(state) });
      Object.assign(window, {
        onboardingCommands: commands,
        finishQQLogin: () => {
          state = { ...state, phase: 'online', detail: 'QQ 已连接', qr: undefined, runtime: 'managed',
            account: { id: '100010001', nickname: '见机测试账号' }, localAccount: { id: '100010001', nickname: '见机测试账号' }, groups };
          emit();
        },
      });
      window.desktop = {
        platform: 'darwin', onboardingStatus: async () => ({ completed: false }), completeOnboarding: async () => {}, openQQDownload: async () => {},
        request: async (command: Command) => {
          commands.push(command);
          if (command.type === 'state' || command.type === 'detect') return structuredClone(state);
          if (command.type === 'start') { state = { ...state, phase: 'qr', detail: '等待 QQ 扫码确认', runtime: 'managed', qr: 'https://example.com/qq-login' }; emit(); return; }
          if (command.type === 'history') return { added: 3, received: 3, canContinue: false, boundary: 'uncertain', reachedStart: true };
          if (command.type === 'follow') { state = { ...state, groups: state.groups.map(group => group.id === command.groupId ? { ...group, followed: command.followed } : group) }; emit(); return; }
          if (command.type === 'disconnect') { state = { ...state, phase: 'idle', detail: '已停止连接', account: undefined, runtime: null }; emit(); return; }
          return;
        },
        subscribe: callback => { listener = callback; return () => { listener = undefined; }; },
        chooseQQ: async () => null, exportMessages: async () => false, openExternal: async () => {}, openWebpagePdf: async () => {}, savedConnection: async () => ({}),
        modelCatalog: async () => [], modelSettings: async () => ({ config: null, hasApiKey: false, updatedAt: null, encryptionAvailable: true }),
        saveModelSettings: async () => ({ config: defaultModelConfig, hasApiKey: true, updatedAt: new Date().toISOString(), encryptionAvailable: true }),
        clearModelSettings: async () => ({ config: null, hasApiKey: false, updatedAt: null, encryptionAvailable: true }),
        testModelSettings: async () => ({ modelId: 'deepseek-flash', latencyMs: 80, reply: 'OK', inputTokens: 2, outputTokens: 1 }), cancelModelTest: async () => {},
        schedule: async () => ({ activities: [], undated: [] }), activity: async () => null,
        recruitingInformation: async () => emptyInformationPage, informationDetail: async () => null,
        processingStatus: async () => emptyProcessingStatus, configureProcessing: async () => emptyProcessingStatus, retryProcessing: async () => emptyProcessingStatus,
      } as DesktopBridge;
    }, { initial, groups, defaultModelConfig, emptyProcessingStatus, emptyInformationPage });
    await page.goto(server.resolvedUrls!.local[0]);
    await expect(page.getByRole('heading', { name: '先准备好官方 QQ' })).toBeVisible();
    await page.screenshot({ path: 'test-results/onboarding-qq-1280.png' });
    await expect(page.getByLabel('我已正常退出官方 QQ')).toBeDisabled();
    await page.getByLabel('我已完成登录与消息同步').check();
    await expect(page.getByLabel('我已正常退出官方 QQ')).toBeEnabled();
    await page.getByLabel('我已正常退出官方 QQ').check();
    await page.getByRole('button', { name: /继续设置 AI 服务/ }).click();
    await expect(page.getByLabel('AI 服务')).toHaveValue('deepseek');
    await expect(page.getByLabel('AI 服务').locator('option')).toHaveCount(1);
    const apiKey = page.getByLabel('DeepSeek API Key');
    await expect(apiKey).toHaveAttribute('type', 'text');
    await apiKey.fill('sk-onboarding-test');
    expect(await apiKey.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-text-security'))).toBe('disc');
    await page.screenshot({ path: 'test-results/onboarding-model-1280.png' });
    await page.getByRole('button', { name: '显示 API Key' }).click();
    expect(await apiKey.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-text-security'))).toBe('none');
    await page.getByRole('button', { name: '隐藏 API Key' }).click();
    await page.getByRole('button', { name: /测试并继续/ }).click();
    await page.getByRole('button', { name: '开始 QQ 登录' }).click();
    await expect(page.getByAltText('QQ 登录二维码')).toBeVisible();
    await page.evaluate(() => (window as unknown as { finishQQLogin(): void }).finishQQLogin());
    await expect(page.getByRole('heading', { name: '选择需要整理的群聊' })).toBeVisible();
    await expect(page.getByText('宣讲会与双选会通知', { exact: true })).toBeVisible();
    await expect(page.getByText('第 1 / 2 页', { exact: false })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    await page.getByText('2027 届校园招聘信息交流', { exact: true }).click();
    await page.getByRole('button', { name: '下一页' }).click();
    await expect(page.getByText('实习内推信息', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '上一页' }).click();
    await page.screenshot({ path: 'test-results/onboarding-groups-1280.png' });
    await page.setViewportSize({ width: 900, height: 640 });
    await page.screenshot({ path: 'test-results/onboarding-groups-900x640.png' });
    const compactSize = await page.evaluate(() => ({ scrollHeight: document.documentElement.scrollHeight, innerHeight }));
    expect(compactSize.scrollHeight).toBeLessThanOrEqual(compactSize.innerHeight);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 375, height: 820 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/onboarding-groups-375.png' });
    await page.getByRole('button', { name: /同步 1 个群聊并开始整理/ }).click();
    await expect(page.getByRole('heading', { name: '日程', exact: true })).toBeVisible();
    const history = await page.evaluate(() => (window as unknown as { onboardingCommands: Command[] }).onboardingCommands.find(command => command.type === 'history'));
    expect(history).toMatchObject({ type: 'history', groupId: '731234567', older: false });
    expect((history as Extract<Command, { type: 'history' }>).since).toBeGreaterThan(0);
  } finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())); }
});

test('Windows onboarding offers the official download without the macOS copy confirmation', async () => {
  const server = await preview({ preview: { host: '127.0.0.1', port: 5199, strictPort: false } });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
  try {
    await page.addInitScript(() => {
      const state: AppState = { phase: 'idle', detail: '', runtime: null, groups: [], archived: 0, historyBusy: false, logs: [] };
      window.desktop = {
        platform: 'win32', onboardingStatus: async () => ({ completed: false }), request: async () => state, subscribe: () => () => {},
        chooseQQ: async () => null, openQQDownload: async () => {}, modelSettings: async () => ({ config: null, hasApiKey: false, updatedAt: null, encryptionAvailable: true }),
      } as unknown as DesktopBridge;
    });
    await page.goto(server.resolvedUrls!.local[0]);
    await expect(page.getByRole('button', { name: '前往 QQ 官网' })).toBeVisible();
    await expect(page.getByText('我已正常退出官方 QQ', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/onboarding-windows-320.png' });
  } finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())); }
});
