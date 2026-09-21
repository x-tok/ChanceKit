import { test, expect, _electron as electron, chromium, type ElectronApplication } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { preview } from 'vite';

test('model configuration saves encrypted credentials, survives restart and tests through pi agent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-model-e2e-'));
  let requests = 0;
  let auth = '';
  let respond = true;
  const endpoint = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the request before replying. */ }
    requests++;
    auth = request.headers.authorization ?? '';
    if (!respond) return;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish] of [[{ role: 'assistant', content: 'OK' }, null], [{}, 'stop']] as const) {
      response.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'local-test-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  const baseUrl = `http://127.0.0.1:${(endpoint.address() as { port: number }).port}/v1`;
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), CHANCEKIT_TEST_DATA: root };
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: ['.'], env });
    let page = await app.firstWindow();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '消息整理模型', exact: true })).toBeVisible();
    await expect(page.getByLabel('服务商', { exact: true })).toHaveValue('deepseek');
    await expect(page.getByLabel('模型', { exact: true })).toHaveValue('deepseek-flash');
    await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('deepseek-flash');
    await page.screenshot({ path: 'test-results/models-default-desktop.png' });
    await page.getByLabel('服务商', { exact: true }).selectOption('custom');
    await page.getByLabel('API 地址', { exact: true }).fill(baseUrl);
    await page.getByLabel('模型 ID', { exact: true }).fill('local-test-model');
    await page.getByLabel('API Key', { exact: false }).fill('sk-e2e-private-key');
    expect(await page.getByLabel('API Key', { exact: false }).evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-text-security'))).toBe('disc');
    await page.getByRole('button', { name: '显示新密钥' }).click();
    await expect(page.getByLabel('API Key', { exact: false })).toHaveAttribute('type', 'text');
    expect(await page.getByLabel('API Key', { exact: false }).evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-text-security'))).toBe('none');
    await page.getByRole('button', { name: '隐藏新密钥' }).click();
    await page.getByRole('button', { name: '群消息', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('local-test-model');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByText('配置已保存', { exact: true })).toBeVisible();
    await expect(page.getByLabel('API Key', { exact: false })).toHaveValue('');
    expect((await readFile(path.join(root, 'model-settings.enc'))).includes(Buffer.from('sk-e2e-private-key'))).toBe(false);
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    expect(await page.evaluate(async () => JSON.stringify(await window.desktop!.modelSettings()).includes('sk-e2e-private-key'))).toBe(false);
    await app.close();

    app = await electron.launch({ args: ['.'], env });
    page = await app.firstWindow();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('local-test-model');
    await expect(page.getByText('密钥已加密保存', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(page.getByText('连接成功', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('连接成功', { exact: true })).toBeInViewport();
    expect(requests).toBe(1);
    expect(auth).toBe('Bearer sk-e2e-private-key');
    await page.screenshot({ path: 'test-results/models-desktop.png' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 640));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: '保存配置', exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/models-900x640.png' });

    respond = false;
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(page.getByRole('button', { name: '取消测试', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '取消测试', exact: true }).click();
    await expect(page.getByText('连接测试已取消。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '清除模型配置', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '清除配置', exact: true }).click();
    await expect(page.getByText('配置已清除', { exact: true })).toBeVisible();
    await expect(page.getByLabel('服务商', { exact: true })).toHaveValue('deepseek');
    await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('deepseek-flash');
  } finally {
    await app?.close();
    endpoint.closeAllConnections();
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('model settings browser preview is responsive and never pretends to save secrets', async () => {
  const server = await preview({ preview: { host: '127.0.0.1', port: 5194, strictPort: false } });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  try {
    await page.goto(server.resolvedUrls!.local[0]);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByLabel('模型', { exact: true })).toHaveValue('deepseek-flash');
    await expect(page.getByLabel('API 地址', { exact: true })).toHaveValue('https://api.deepseek.com');
    await expect(page.getByRole('button', { name: '保存配置', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled();
    for (const width of [1280, 760, 375, 320]) {
      await page.setViewportSize({ width, height: 820 });
      await expect(page.getByRole('heading', { name: '消息整理模型', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator('section[aria-label="模型配置"]').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: `test-results/models-preview-${width}.png` });
    }
    for (const [provider, model, api, baseUrl] of [
      ['qwen', 'qwen3.7-plus', 'openai-completions', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
      ['moonshotai-cn', 'kimi-k2.6', 'openai-completions', 'https://api.moonshot.cn/v1'],
      ['zhipu', 'glm-5.2', 'openai-completions', 'https://open.bigmodel.cn/api/paas/v4'],
      ['minimax-cn', 'MiniMax-M2.7', 'anthropic-messages', 'https://api.minimaxi.com/anthropic'],
    ]) {
      await page.getByLabel('服务商', { exact: true }).selectOption(provider);
      await expect(page.getByLabel('模型', { exact: true })).toHaveValue(model);
      await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue(model);
      await expect(page.getByLabel('API 协议', { exact: true })).toHaveValue(api);
      await expect(page.getByLabel('API 地址', { exact: true })).toHaveValue(baseUrl);
    }
    await page.getByLabel('模型', { exact: true }).selectOption('MiniMax-M2.7-highspeed');
    await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('MiniMax-M2.7-highspeed');
    await page.getByLabel('服务商', { exact: true }).selectOption('custom');
    await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('API 地址', { exact: true })).toHaveValue('');
    await page.getByLabel('模型 ID', { exact: true }).fill('my-model');
    await page.getByRole('button', { name: '撤销未保存的更改' }).click();
    await expect(page.getByLabel('服务商', { exact: true })).toHaveValue('deepseek');
    await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('deepseek-flash');
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.httpServer.close(() => resolve()));
  }
});
