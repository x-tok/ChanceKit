import { test, expect, _electron as electron, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockNapCat, sample } from '../fixtures';
import { preview } from 'vite';

test('desktop connects to NapCat, archives history and live messages, and renders window sizes', async () => {
  const fixture = await mockNapCat();
  fixture.completeHistoryAtBoundary();
  const folder = await mkdtemp(path.join(os.tmpdir(), 'chancekit-e2e-'));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env: { ...env, CHANCEKIT_TEST_DATA: folder } });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const sidebar = page.locator('aside');
  try {
    await page.route('https://q1.qlogo.cn/**', route => route.fulfill({ contentType: 'image/png', path: 'build/icon.png' }));
    await expect(page).toHaveTitle('见机');
    expect(await app.evaluate(({ app }) => app.getName())).toBe('见机');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await expect(page.getByText('不让机会淹没在消息里', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/connection-desktop.png' });
    await page.getByRole('button', { name: '已有 NapCat' }).click();
    await page.getByLabel('消息服务地址').fill(fixture.config.wsUrl);
    await page.getByLabel('访问令牌', { exact: true }).fill(fixture.config.accessToken);
    await page.getByLabel('启用扫码登录管理').check();
    await page.getByLabel('登录管理地址').fill(fixture.config.webuiUrl);
    await page.getByLabel('登录管理令牌').fill(fixture.config.webuiToken);
    fixture.setLoggedIn(false);
    await page.getByRole('button', { name: '连接 QQ', exact: true }).click();
    await expect(page.getByAltText('QQ 登录二维码')).toBeVisible();
    await page.screenshot({ path: 'test-results/qr-desktop.png' });
    fixture.setLoggedIn(true);
    await expect(page.getByRole('heading', { name: '账号已连接' })).toBeVisible({ timeout: 15_000 });
    await expect(sidebar.locator('img')).toHaveAttribute('src', /nk=100010001&/);
    await expect.poll(() => sidebar.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.getByRole('button', { name: '查看群聊' }).click();
    await page.getByRole('button', { name: /2027 届校园招聘/ }).click();
    await page.getByRole('button', { name: '关注', exact: true }).click();
    await page.getByRole('button', { name: '获取消息记录', exact: true }).click();
    await expect(page.getByText('收到，感谢分享。', { exact: true })).toBeVisible();
    fixture.push(sample(6, '实时消息已通过 WebSocket 到达（测试）。'));
    await expect(page.getByText('实时消息已通过 WebSocket 到达（测试）。', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/messages-desktop.png' });
    await expect(page.getByText('较早的双选会通知。', { exact: true })).toBeVisible();
    await page.getByLabel('搜索本地消息').fill('校园宣讲会');
    await expect(page.locator('article')).toHaveCount(1);
    await page.getByRole('button', { name: '清除搜索' }).click();
    for (const [width, height] of [[900, 820], [1240, 640], [900, 640]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height]);
      await page.waitForTimeout(150);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/messages-${width}x${height}.png` });
    }
    const resuming = fixture.holdNext('get_login_info');
    fixture.drop();
    await expect(page.getByText('重连中', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('未登录账号')).toBeVisible();
    await expect(sidebar.locator('img')).toHaveCount(0);
    await resuming.requested;
    resuming.release();
    await expect(page.getByText('已连接', { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: /实习机会/ }).click();
    await page.getByRole('button', { name: '获取消息记录', exact: true }).click();
    await expect(page.getByText('QQ 当前没有可获取的记录', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '停止连接', exact: true }).click();
    await expect(sidebar.getByText('未登录账号')).toBeVisible();
    await expect(sidebar.getByText('100010001', { exact: true })).toHaveCount(0);
    await expect(sidebar.locator('img')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/account-disconnected.png' });
    await page.getByRole('button', { name: /^群消息/ }).click();
    await page.getByRole('button', { name: /2027 届校园招聘/ }).click();
    await expect(page.getByText('实时消息已通过 WebSocket 到达（测试）。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    fixture.setLoggedIn(false);
    await page.getByRole('button', { name: '连接 QQ', exact: true }).click();
    await expect(page.getByAltText('QQ 登录二维码')).toBeVisible();
    await expect(sidebar.getByText('未登录账号')).toBeVisible();
    await page.getByRole('button', { name: '停止连接', exact: true }).click();
    await expect(page.getByAltText('QQ 登录二维码')).toHaveCount(0);
    await expect(sidebar.locator('img')).toHaveCount(0);

    // A failed avatar and a whitespace-only nickname must not poison the next login.
    await page.unroute('https://q1.qlogo.cn/**');
    await page.route('https://q1.qlogo.cn/**', route => route.abort());
    fixture.setAccount({ user_id: 100010002, nickname: '\u3000\u3000' });
    fixture.setLoggedIn(true);
    await page.getByRole('button', { name: '连接 QQ', exact: true }).click();
    await expect(page.getByRole('heading', { name: '账号已连接' })).toBeVisible();
    await expect(sidebar.getByText('QQ 用户')).toBeVisible();
    await expect(sidebar.locator('img')).toHaveCount(0);
    await expect(sidebar.getByText('Q', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/account-avatar-fallback.png' });
    await page.getByRole('button', { name: '停止连接', exact: true }).click();
    await expect(sidebar.getByText('未登录账号')).toBeVisible();
    await page.unroute('https://q1.qlogo.cn/**');
    await page.route('https://q1.qlogo.cn/**', route => route.fulfill({ contentType: 'image/png', path: 'build/icon.png' }));
    fixture.setAccount({ user_id: 100010003, nickname: '另一个账号' });
    await page.getByRole('button', { name: '连接 QQ', exact: true }).click();
    await expect(sidebar.getByText('另一个账号')).toBeVisible();
    await expect(sidebar.locator('img')).toHaveAttribute('src', /nk=100010003&/);
    await expect.poll(() => sidebar.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.screenshot({ path: 'test-results/account-switched.png' });
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await app.close(); await fixture.close(); await rm(folder, { recursive: true, force: true }); }
});

test('browser preview stays usable at narrow widths without a desktop bridge', async () => {
  const server = await preview({ preview: { host: '127.0.0.1', port: 5192, strictPort: false } });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  try {
    await page.goto(server.resolvedUrls!.local[0]);
    await expect(page.getByRole('heading', { name: '日程', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    for (const width of [1280, 760, 375, 320]) {
      await page.setViewportSize({ width, height: 820 });
      await expect(page.getByText('不让机会淹没在消息里', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/connection-${width}.png` });
      await page.getByRole('button', { name: '已有 NapCat' }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/settings-${width}.png` });
      await page.getByRole('button', { name: '本机 QQ' }).click();
    }
  } finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())); }
});
