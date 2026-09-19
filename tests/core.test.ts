import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { Store, normalizeMessage } from '../electron/core/store';
import { OneBot } from '../electron/core/onebot';
import { NapCatManagement } from '../electron/core/management';
import { validateEndpoint } from '../electron/core/validation';
import { AppService } from '../electron/core/service';
import { mockNapCat, sample } from './fixtures';

test('OneBot correlates out-of-order replies and keeps group events separate', async () => {
  const fixture = await mockNapCat();
  const bot = new OneBot(200);
  try {
    await bot.connect(fixture.config.wsUrl, fixture.config.accessToken);
    const event = once(bot, 'event');
    const slow = bot.call('delayed', { delay: 50, name: 'slow' });
    const fast = bot.call('delayed', { delay: 1, name: 'fast' });
    fixture.push(sample(8, '实时消息'));
    assert.equal((await fast).name, 'fast');
    assert.equal((await slow).name, 'slow');
    assert.equal((await event)[0].message_id, 8);
    await assert.rejects(bot.call('never'), /超时/);
    const pending = bot.call('never');
    bot.close();
    await assert.rejects(pending, /停止/);
  } finally { bot.close(); await fixture.close(); }
});

test('NapCat management uses the salted token hash, QR refresh and actual login state', async () => {
  const fixture = await mockNapCat();
  try {
    fixture.setLoggedIn(false);
    const management = new NapCatManagement(fixture.config.webuiUrl, fixture.config.webuiToken);
    const first = await management.status();
    assert.equal(first.isLogin, false);
    await management.refreshQR();
    assert.notEqual((await management.status()).qrcodeurl, first.qrcodeurl);
    fixture.setLoggedIn(true);
    assert.equal((await management.status()).isLogin, true);
    await assert.rejects(new NapCatManagement(fixture.config.webuiUrl, 'wrong').status(), /token is invalid/);
  } finally { await fixture.close(); }
});

test('Storage deduplicates replay but preserves distinct messages and account boundaries', () => {
  const store = new Store(':memory:');
  try {
    const raw = sample(1, '同一条招聘信息');
    assert.equal(store.put([normalizeMessage(raw, 'a')]), 1);
    assert.equal(store.put([normalizeMessage({ ...raw, message_id: 777 }, 'a')]), 0);
    assert.equal(store.put([normalizeMessage(sample(2, '同一条招聘信息'), 'a')]), 1);
    assert.equal(store.put([normalizeMessage(raw, 'b')]), 1);
    assert.equal(store.messages('a', '731234567').total, 2);
    assert.equal(store.messages('b', '731234567').total, 1);
    assert.equal(store.messages('a', '731234567', "' OR 1=1").total, 0);
    store.saveGroups('a', [{ group_id: 1, group_name: 'A' }]);
    store.follow('a', '1', true);
    store.saveGroups('a', [{ group_id: 1, group_name: 'A renamed' }]);
    assert.equal(store.groups('a')[0].followed, true);
    assert.equal(store.groups('b').length, 0);
  } finally { store.close(); }
});

test('Plain remote endpoints and credentials in URLs are rejected', () => {
  assert.equal(validateEndpoint('ws://127.0.0.1:3001', 'ws'), 'ws://127.0.0.1:3001');
  assert.equal(validateEndpoint('wss://example.com/onebot', 'ws'), 'wss://example.com/onebot');
  assert.throws(() => validateEndpoint('ws://example.com', 'ws'), /WSS/);
  assert.throws(() => validateEndpoint('http://user:pass@localhost', 'http'));
  assert.throws(() => validateEndpoint('ws://localhost?token=secret', 'ws'));
});

test('An invalid access token stays failed until the user retries', async () => {
  const fixture = await mockNapCat();
  const service = new AppService(os.tmpdir(), new Store(':memory:'), () => {});
  try {
    await assert.rejects(service.request({ type: 'connect', config: { ...fixture.config, accessToken: 'wrong', webuiUrl: '', webuiToken: '' } }));
    assert.equal(service.state.phase, 'error');
    await new Promise(resolve => setTimeout(resolve, 3200));
    assert.equal(service.state.phase, 'error');
  } finally { await service.close(); await fixture.close(); }
});

test('End-to-end service: groups, paged history, live dedup, export, offline reads and fresh cursors', async () => {
  const fixture = await mockNapCat();
  const folder = await mkdtemp(path.join(os.tmpdir(), 'qunxun-service-'));
  const events: any[] = [];
  const service = new AppService(folder, new Store(path.join(folder, 'test.sqlite')), event => events.push(event));
  try {
    await service.request({ type: 'connect', config: fixture.config });
    assert.equal(service.state.phase, 'online');
    assert.equal(service.state.groups.length, 3);
    await service.request({ type: 'follow', groupId: '731234567', followed: true });
    const recent: any = await service.request({ type: 'history', groupId: '731234567', older: false });
    assert.equal(recent.added, 3);
    assert.equal((await service.request({ type: 'history', groupId: '731234567', older: true }) as any).added, 2);
    assert.equal(fixture.calls.filter(c => c.action === 'get_group_msg_history')[1].params.message_seq, '3');
    assert.equal(fixture.calls.filter(c => c.action === 'get_group_msg_history')[1].params.reverse_order, true);
    assert.equal((await service.request({ type: 'history', groupId: '731234567', older: true }) as any).boundary, 'uncertain');
    assert.equal((await service.request({ type: 'history', groupId: '731234569', older: false }) as any).boundary, 'empty');
    fixture.push(sample(5, '收到，感谢分享。'));
    fixture.push(sample(6, '新的实习通知。'));
    fixture.push(sample(7, '不关注的群不归档', 731234568));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(service.state.archived, 6);
    const file = await service.request({ type: 'export', groupId: '731234567' }) as string;
    assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 6);
    await service.request({ type: 'disconnect' });
    assert.equal((await service.request({ type: 'messages', groupId: '731234567', search: '', offset: 0 }) as any).total, 6);
    await service.request({ type: 'connect', config: fixture.config });
    // Reconnect refreshes followed groups from a new, recent anchor.
    const historyCalls = fixture.calls.filter(c => c.action === 'get_group_msg_history');
    assert.equal(historyCalls.at(-1)?.params.message_seq, undefined);
    await service.request({ type: 'follow', groupId: '731234567', followed: false });
    fixture.push(sample(9, '取消关注后不归档'));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(service.state.archived, 6);
  } finally { await service.close(); await fixture.close(); await rm(folder, { recursive: true, force: true }); }
});
