import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { RuntimeManager, detectQQ } from '../../electron/core/runtime';
import { macLaunchArgs, macQuitCommand } from '../../electron/core/mac-loader';
import type { QQInstallation } from '../../src/shared';

const exec = promisify(execFile);
const source = process.env.CHANCEKIT_TEST_QQ_APP;

test('the managed macOS QQ runtime exits cleanly before and after OneBot becomes available', {
  skip: process.platform !== 'darwin' || !source,
  timeout: 240_000,
}, async () => {
  // Copy the actual QQ runtime, but never import NapCat or initialize a QQ session.
  const qq = await detectQQ(source);
  assert.ok(qq, 'Select an unmodified official QQ app');
  const folder = await mkdtemp(path.join(os.tmpdir(), 'chancekit-native-qq-'));
  const runtime = new RuntimeManager(folder, () => {}, () => {}, '');
  const prepare = runtime as unknown as { prepareMac: (qq: QQInstallation, signal: AbortSignal) => Promise<string> };
  try {
    const executable = await prepare.prepareMac(qq, new AbortController().signal);
    // Exercise reuse of an already signed copy as well as the first installation.
    const marker = path.join(folder, 'QQRuntime.app/Contents/Resources/chancekit-runtime.json');
    const identity = await readFile(marker, 'utf8');
    assert.equal(await prepare.prepareMac(qq, new AbortController().signal), executable);
    assert.equal(await readFile(marker, 'utf8'), identity);
    const legacyIdentity = JSON.parse(identity);
    delete legacyIdentity.signing;
    delete legacyIdentity.launchArgs;
    await writeFile(marker, JSON.stringify(legacyIdentity));
    const preserved = path.join(folder, 'qq-profile', 'fixture.txt');
    await mkdir(path.dirname(preserved));
    await writeFile(preserved, 'existing-profile');
    await prepare.prepareMac(qq, new AbortController().signal);
    assert.equal(await readFile(marker, 'utf8'), identity, 'Old runtime policy must trigger a rebuild');
    assert.equal(await readFile(preserved, 'utf8'), 'existing-profile');

    for (const mode of ['prelogin', 'onebot']) {
      const profile = path.join(folder, mode);
      const entry = path.join(folder, `${mode}.mjs`);
      const marker = path.join(folder, `${mode}-exit.json`);
      const wsModule = new URL('../../node_modules/ws/wrapper.mjs', import.meta.url).href;
      await writeFile(entry, `import fs from 'node:fs';
import { app } from 'electron';
import { WebSocketServer } from ${JSON.stringify(wsModule)};
process.on('exit', code => fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ code })));
await app.whenReady();
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
server.on('connection', socket => socket.on('message', bytes => {
  if (JSON.parse(bytes.toString()).action === 'bot_exit') process.exit(0);
}));
server.on('listening', () => console.log('CHANCEKIT_FIXTURE_READY:' + server.address().port));
`);
      const env: NodeJS.ProcessEnv = { ...process.env, CHANCEKIT_QQ_DATA: profile, CHANCEKIT_NAPCAT_ENTRY: entry };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(executable, [...macLaunchArgs], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      child.stdin.on('error', () => {});
      child.stderr.resume();
      const exited = once(child, 'exit');
      let watchdog: NodeJS.Timeout | undefined;
      try {
        const port = await new Promise<number>((resolve, reject) => {
          let output = '';
          watchdog = setTimeout(() => reject(new Error('Isolated QQ runtime did not become ready')), 15_000);
          child.once('error', reject);
          void exited.then(() => reject(new Error('Isolated QQ runtime exited before ready')));
          child.stdout.on('data', bytes => {
            output += bytes;
            const match = output.match(/CHANCEKIT_FIXTURE_READY:(\d+)/);
            if (match) { clearTimeout(watchdog); resolve(Number(match[1])); }
          });
        });
        if (mode === 'prelogin') {
          child.stdin.write(`${macQuitCommand}\n`);
        } else {
          Object.assign(runtime, { child, connection: { wsUrl: `ws://127.0.0.1:${port}` } });
          await runtime.stop();
        }
        watchdog = setTimeout(() => child.kill('SIGKILL'), 8000);
        const [code, signal] = await exited;
        assert.deepEqual({ code, signal }, { code: 0, signal: null }, `${mode}: QQ must finish native teardown`);
        assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { code: 0 });
        // A clean parent exit must also reap its QQ Helper children.
        const { stdout } = await exec('/bin/ps', ['-axo', 'args=']);
        assert.equal(stdout.split('\n').some(line => line.startsWith(path.join(folder, 'QQRuntime.app'))), false);
      } finally {
        clearTimeout(watchdog);
        await cleanup(child);
      }
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});

async function cleanup(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  // Only the isolated process group created by this test can be affected.
  if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already reaped. */ } }
}
