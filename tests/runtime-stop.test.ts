import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { RuntimeManager } from '../electron/core/runtime/runtime';

async function fixture(mode = '') {
  const child = spawn(process.execPath, ['tests/helpers/qq-exit-fixture.mjs', mode], {
    detached: process.platform !== 'win32', stdio: [process.platform === 'darwin' ? 'pipe' : 'ignore', 'ignore', 'pipe', 'ipc'],
  });
  const events: string[] = [];
  child.on('message', (message: any) => { if (message.event) events.push(message.event); });
  const [{ port }] = await once(child, 'message') as [{ port: number }];
  const runtime = new RuntimeManager(path.join(os.tmpdir(), 'unused-qq-exit-fixture'), () => {}, () => {}, '');
  Object.assign(runtime, { child, connection: { wsUrl: `ws://127.0.0.1:${port}`, accessToken: 'fixture-exit-token' } });
  return { child, runtime, events, cleanup: async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  } };
}

test('managed QQ receives bot_exit and exits without a termination signal or action response', async () => {
  for (const mode of ['', 'delayed']) {
    const { child, runtime, events, cleanup } = await fixture(mode);
    try {
      await Promise.all([runtime.stop(), runtime.stop()]);
      assert.deepEqual(events, ['bot_exit']);
      assert.equal(child.exitCode, 0);
      assert.equal(child.signalCode, null);
    } finally { await cleanup(); }
  }
});

test('macOS can quit before login through the private pipe when OneBot is unavailable', { skip: process.platform !== 'darwin' }, async () => {
  const { child, runtime, events, cleanup } = await fixture('prelogin');
  try {
    await runtime.stop();
    assert.deepEqual(events, ['control_exit']);
    assert.equal(child.exitCode, 0);
  } finally { await cleanup(); }
});

test('an unresponsive owned runtime is terminated only after attempting bot_exit', async () => {
  const { child, runtime, events, cleanup } = await fixture('unresponsive');
  try {
    await runtime.stop();
    assert.equal(events[0], 'bot_exit');
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    if (process.platform !== 'win32') assert.deepEqual(events, ['bot_exit', 'sigterm']);
  } finally { await cleanup(); }
});

test('a runtime that already exited is not signalled again', async t => {
  const { child, runtime, events, cleanup } = await fixture();
  try {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    let signals = 0;
    if (process.platform !== 'win32') t.mock.method(process, 'kill', () => { signals++; return true; });
    await runtime.stop();
    assert.equal(signals, 0);
    assert.deepEqual(events, []);
  } finally { await cleanup(); }
});
