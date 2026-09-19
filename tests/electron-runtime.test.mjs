import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareElectron } from '../scripts/electron-runtime.mjs';

const installer = fileURLToPath(new URL('./helpers/electron-installer.cjs', import.meta.url));

async function runInstaller(t, env, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chancekit-electron-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = path.join(directory, 'result.json');
  const original = { ...env };
  await prepareElectron({
    installer, platform: 'linux', ...options,
    env: { ...env, CHANCEKIT_INSTALLER_RESULT: result },
  });
  assert.deepEqual(env, original);
  return JSON.parse(await readFile(result, 'utf8'));
}

test('Electron installer receives proxy settings before it runs, without changing the parent environment', async t => {
  const result = await runInstaller(t, {
    https_proxy: 'http://lower:7890', HTTPS_PROXY: 'http://upper:7891',
    HTTP_PROXY: 'http://http:7892', NO_PROXY: 'localhost',
    electron_config_cache: '/custom/cache',
  });
  assert.deepEqual(result, {
    useProxy: '1',
    httpProxy: 'http://http:7892', lowerHttpProxy: 'http://http:7892',
    httpsProxy: 'http://lower:7890', lowerHttpsProxy: 'http://lower:7890',
    noProxy: 'localhost', lowerNoProxy: 'localhost',
    cache: '/custom/cache',
  });
});

test('Electron installation inherits the macOS system proxy when explicit proxies are absent', async t => {
  const result = await runInstaller(t, {}, {
    platform: 'darwin',
    readSystemProxy: async () => ({ httpProxy: 'http://127.0.0.1:7890', httpsProxy: 'http://127.0.0.1:7890' }),
  });
  assert.equal(result.useProxy, '1');
  assert.equal(result.httpsProxy, 'http://127.0.0.1:7890');
  assert.equal(result.httpProxy, result.httpsProxy);
});

test('Electron installation uses npm proxy settings and preserves bypass rules', async t => {
  const result = await runInstaller(t, { npm_config_https_proxy: 'http://npm:7890', npm_config_noproxy: '*' });
  assert.equal(result.httpsProxy, 'http://npm:7890');
  assert.equal(result.noProxy, '*');
});

test('Electron installation can run directly without consulting another platform system settings', async t => {
  const result = await runInstaller(t, {}, {
    readSystemProxy: () => { throw new Error('unexpected system lookup'); },
  });
  assert.equal(result.httpProxy, '');
  assert.equal(result.httpsProxy, '');
});

test('failed Electron installation gives an actionable error instead of continuing startup', async () => {
  await assert.rejects(prepareElectron({
    installer, platform: 'linux', env: { CHANCEKIT_INSTALLER_EXIT: '7' },
  }), /installer exited with code 7[\s\S]*HTTPS_PROXY[\s\S]*npm run prepare:electron/);
});

test('a stalled Electron installer is terminated within its preparation deadline', async () => {
  await assert.rejects(prepareElectron({
    installer, platform: 'linux', env: { CHANCEKIT_INSTALLER_HANG: '1' }, timeout: 100,
  }), /installer stopped by SIGTERM/);
});
