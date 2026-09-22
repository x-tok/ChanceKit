import { test, expect, chromium } from '@playwright/test';
import { preview } from 'vite';

test('logged-out schedule stays focused on QQ login without a recruiting information panel', async () => {
  const server = await preview({ preview: { host: '127.0.0.1', port: 5194, strictPort: false } });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  try {
    await page.goto(server.resolvedUrls!.local[0]);
    await page.getByRole('button', { name: '日程', exact: true }).click();
    await expect(page.getByRole('heading', { name: '请先登录 QQ', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '当日活动', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '招聘资讯', exact: true })).toHaveCount(0);
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.httpServer.close(() => resolve()));
  }
});
