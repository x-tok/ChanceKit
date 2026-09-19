import { test, expect, _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { createPackage } from '@electron/asar';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('Electron utility process removes leftover QQ bundles containing real ASAR files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-runtime-regression-'));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.ELECTRON_RUN_AS_NODE;
  const worker = path.join(root, 'worker.cjs');
  const stale = path.join(root, 'QQRuntime.staging.app');
  try {
    const content = path.join(root, 'archive-source');
    await mkdir(content);
    await writeFile(path.join(content, 'index.js'), 'module.exports = "fixture";');
    await createPackage(content, path.join(root, 'application.asar'));
    const appDir = path.join(stale, 'Contents/Resources/app');
    await mkdir(appDir, { recursive: true });
    await copyFile(path.join(root, 'application.asar'), path.join(appDir, 'application.asar'));
    for (const [name, identity] of [['QQRuntime.app', 'old'], ['replacement.app', 'new']]) {
      const target = path.join(root, name!, 'Contents/Resources/app');
      await mkdir(target, { recursive: true });
      await copyFile(path.join(root, 'application.asar'), path.join(target, 'application.asar'));
      await writeFile(path.join(root, name!, 'identity'), identity!);
    }
    await build({ entryPoints: ['tests/helpers/runtime-files-worker.ts'], outfile: worker, bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
    const app = await electron.launch({ args: ['.'], env: { ...env, CHANCEKIT_TEST_DATA: path.join(root, 'profile') } });
    try {
      const result = await app.evaluate(({ utilityProcess }, input) => new Promise(resolve => {
        const child = utilityProcess.fork(input.worker, [input.root], { stdio: 'pipe' });
        child.once('message', value => { resolve(value); child.kill(); });
        child.once('exit', code => resolve({ ok: false, code }));
      }), { worker, root });
      expect(result).toEqual({ ok: true });
      await expect(access(stale)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(root, 'QQRuntime.app/identity'), 'utf8')).toBe('new');
      await expect(access(path.join(root, 'QQRuntime.app.previous'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await app.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
