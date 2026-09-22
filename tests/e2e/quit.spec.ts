import { test, expect, _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, rm, cp, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';

const exec = promisify(execFile);

test('macOS system quit waits for the managed runtime and worker to exit, including repeated requests', async () => {
  test.skip(process.platform !== 'darwin', 'macOS application termination event');
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-system-quit-'));
  const profile = path.join(root, 'profile');
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await mkdir(profile);
    await cp('dist', path.join(root, 'dist'), { recursive: true });
    await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
    await build({ entryPoints: ['electron/main.ts', 'electron/preload.ts'], outdir: path.join(root, 'dist-electron'),
      outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
      external: ['electron', 'sharp', 'pdfjs-dist', '@napi-rs/canvas'] });
    await build({ entryPoints: ['tests/helpers/quit-worker.ts'], outfile: path.join(root, 'dist-electron/worker.cjs'),
      bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] });
    const app = await electron.launch({ args: [path.join(root, 'dist-electron/main.cjs')], env: {
      ...env, CHANCEKIT_TEST_DATA: profile, CHANCEKIT_FIXTURE_ELECTRON: createRequire(import.meta.url)('electron') as string,
    } });
    try {
      const events = async () => (await readFile(path.join(profile, 'quit-events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      await expect.poll(events).toContain('ready');
      const page = await app.firstWindow();
      await expect(page.getByRole('heading', { name: '请先登录 QQ', exact: true })).toBeVisible();
      await page.screenshot({ path: 'test-results/system-quit-before.png' });
      const appProcess = app.process();
      const pid = appProcess.pid!;
      await app.evaluate(({ app }) => {
        app.once('before-quit', () => { setTimeout(() => app.quit(), 10); });
      });
      // NSRunningApplication.terminate delivers the same OS quit event as the Dock.
      await exec('/usr/bin/swift', ['-e', 'import AppKit; let pid = pid_t(CommandLine.arguments[1])!; guard let app = NSRunningApplication(processIdentifier: pid), app.terminate() else { exit(1) }', String(pid)], { timeout: 30_000 });
      await expect.poll(events).toContain('shutdown-start');
      await expect.poll(() => appProcess.exitCode).toBe(0);
      expect(appProcess.signalCode).toBeNull();
      expect(await events()).toEqual(['ready', 'shutdown-start', 'qq-exit:0', 'child-exit:0:null', 'runtime-stopped', 'worker-exit']);
    } finally { await app.close().catch(() => {}); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
