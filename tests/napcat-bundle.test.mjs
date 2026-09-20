import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fetch, MockAgent } from 'undici';
import { createDownloadDispatcher, parseMacOSProxy, resolveDownloadProxy } from '../scripts/download-proxy.mjs';
import { prepareNapCatBundle } from '../scripts/napcat-bundle.mjs';

const systemProxy = { httpProxy: 'http://127.0.0.1:7890', httpsProxy: 'http://127.0.0.1:7890' };

test('macOS proxy parsing respects enable flags, ports and IPv6', () => {
  assert.deepEqual(parseMacOSProxy(`<dictionary> {
    HTTPEnable : 1
    HTTPProxy : 127.0.0.1
    HTTPPort : 7890
    HTTPSEnable : 1
    HTTPSProxy : 127.0.0.1
    HTTPSPort : 7890
  }`), systemProxy);
  assert.deepEqual(parseMacOSProxy('HTTPEnable : 0\nHTTPProxy : localhost\nHTTPPort : 7890'), { httpProxy: '', httpsProxy: '' });
  assert.deepEqual(parseMacOSProxy('HTTPEnable : 1\nHTTPProxy : localhost\nHTTPPort : 99999'), { httpProxy: '', httpsProxy: '' });
  assert.deepEqual(parseMacOSProxy('HTTPEnable : 1\nHTTPProxy : ::1\nHTTPPort : 7890'), { httpProxy: 'http://[::1]:7890', httpsProxy: '' });
  assert.deepEqual(parseMacOSProxy('ProxyAutoConfigEnable : 1'), { httpProxy: '', httpsProxy: '' });
});

test('explicit proxies precede npm and macOS settings, preserving NO_PROXY', async () => {
  const readSystemProxy = () => { throw new Error('must not read system settings'); };
  assert.deepEqual(await resolveDownloadProxy({
    env: { https_proxy: 'http://lower:80', HTTPS_PROXY: 'http://upper:80', HTTP_PROXY: 'http://http:80', NO_PROXY: 'localhost', npm_config_proxy: 'http://npm:80' },
    platform: 'darwin', readSystemProxy,
  }), { httpProxy: 'http://http:80', httpsProxy: 'http://lower:80', noProxy: 'localhost', source: 'environment' });
  assert.deepEqual(await resolveDownloadProxy({
    env: { npm_config_https_proxy: 'http://npm:80', npm_config_noproxy: 'localhost' }, platform: 'darwin', readSystemProxy,
  }), { httpProxy: '', httpsProxy: 'http://npm:80', noProxy: 'localhost', source: 'npm configuration' });
  assert.deepEqual(await resolveDownloadProxy({
    env: { NO_PROXY: '*' }, platform: 'darwin', readSystemProxy,
  }), { httpProxy: '', httpsProxy: '', noProxy: '*', source: 'direct connection' });
});

test('macOS settings are used only as fallback and other platforms can connect directly', async () => {
  assert.deepEqual(await resolveDownloadProxy({
    env: {}, platform: 'darwin', readSystemProxy: async () => systemProxy,
  }), { ...systemProxy, noProxy: '', source: 'macOS system settings' });
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.deepEqual(await resolveDownloadProxy({
      env: {}, platform, readSystemProxy: async () => { throw new Error('unavailable'); },
    }), { httpProxy: '', httpsProxy: '', noProxy: '', source: 'direct connection' });
  }
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chancekit-download-'));
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  t.after(async () => {
    try { await dispatcher.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const data = Buffer.from('pinned archive test content');
  const release = {
    version: 'test', url: 'https://download.test/archive.zip', size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
  const file = path.join(directory, 'archive.zip');
  return {
    data, file, dispatcher,
    pool: dispatcher.get('https://download.test'),
    options: { file, release, dispatcher, retryDelay: 0 },
  };
}

test('valid cached bundles do not make network requests', async t => {
  const { data, file, options, dispatcher } = await fixture(t);
  await writeFile(file, data);
  await prepareNapCatBundle(options);
  assert.deepEqual(await readFile(file), data);
  dispatcher.assertNoPendingInterceptors();
});

test('download follows official redirects and promotes only a verified archive', async t => {
  const { data, file, pool, dispatcher, options } = await fixture(t);
  pool.intercept({ path: '/archive.zip' }).reply(302, '', { headers: { location: 'https://assets.test/archive.zip' } });
  dispatcher.get('https://assets.test').intercept({ path: '/archive.zip' }).reply(200, data);
  await prepareNapCatBundle(options);
  assert.deepEqual(await readFile(file), data);
  await assert.rejects(stat(`${file}.part`), { code: 'ENOENT' });
  dispatcher.assertNoPendingInterceptors();
});

test('connection timeouts and temporary HTTP failures retry before succeeding', async t => {
  const { data, file, pool, dispatcher, options } = await fixture(t);
  pool.intercept({ path: '/archive.zip' }).replyWithError(Object.assign(new Error('timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }));
  pool.intercept({ path: '/archive.zip' }).reply(503, 'temporary');
  pool.intercept({ path: '/archive.zip' }).reply(200, data);
  await prepareNapCatBundle(options);
  assert.deepEqual(await readFile(file), data);
  dispatcher.assertNoPendingInterceptors();
});

test('exhausted retries report an actionable error and leave no partial file', async t => {
  const { file, pool, dispatcher, options } = await fixture(t);
  pool.intercept({ path: '/archive.zip' }).reply(503, 'temporary').times(3);
  await assert.rejects(prepareNapCatBundle(options), /HTTP 503[\s\S]*HTTPS_PROXY/);
  await assert.rejects(stat(file), { code: 'ENOENT' });
  await assert.rejects(stat(`${file}.part`), { code: 'ENOENT' });
  dispatcher.assertNoPendingInterceptors();
});

test('permanent HTTP errors do not retry', async t => {
  const { pool, options } = await fixture(t);
  pool.intercept({ path: '/archive.zip' }).reply(404, 'not found');
  await assert.rejects(prepareNapCatBundle(options), /HTTP 404/);
});

test('oversized, truncated and checksum-corrupt downloads preserve the existing file', async t => {
  for (const invalid of ['oversized', 'truncated', 'checksum']) {
    await t.test(invalid, async t => {
      const { data, file, pool, options } = await fixture(t);
      const previous = Buffer.from('previous invalid archive');
      await writeFile(file, previous);
      const body = invalid === 'oversized' ? Buffer.concat([data, data])
        : invalid === 'truncated' ? data.subarray(0, 4) : Buffer.alloc(data.length);
      pool.intercept({ path: '/archive.zip' }).reply(200, body);
      await assert.rejects(prepareNapCatBundle(options), /exceeds pinned size|size mismatch|checksum mismatch/);
      assert.deepEqual(await readFile(file), previous);
      await assert.rejects(stat(`${file}.part`), { code: 'ENOENT' });
    });
  }
});

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('the download dispatcher uses the proxy across redirects and honors NO_PROXY', async t => {
  const origin = await listen(t, createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://assets.invalid/archive.zip' });
      res.end();
    } else { res.end('archive'); }
  }));
  const tunnels = [];
  const proxy = createServer();
  proxy.on('connect', (req, socket, head) => {
    tunnels.push(req.url);
    const upstream = connect(Number(new URL(origin).port), '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  const proxyURL = await listen(t, proxy);
  const { dispatcher } = await createDownloadDispatcher({
    env: { HTTP_PROXY: proxyURL, NO_PROXY: '127.0.0.1' }, platform: 'linux',
  });
  try {
    const response = await fetch('http://download.invalid/redirect', { dispatcher });
    assert.equal(await response.text(), 'archive');
    assert.deepEqual(tunnels, ['download.invalid:80', 'assets.invalid:80']);
    assert.equal(await (await fetch(`${origin}/archive.zip`, { dispatcher })).text(), 'archive');
    assert.equal(tunnels.length, 2);
  } finally { await dispatcher.destroy(); }
});
