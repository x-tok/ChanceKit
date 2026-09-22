import { test, expect } from '@playwright/test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { macLoader } from '../../electron/core/runtime/mac-loader';

test('the macOS runtime loader handles a pre-login stop with a clean Electron exit', async () => {
  test.skip(process.platform !== 'darwin', 'macOS loader only');
  const folder = await mkdtemp(path.join(os.tmpdir(), 'chancekit-qq-exit-'));
  const entry = path.join(folder, 'main.cjs');
  const stub = path.join(folder, 'napcat-fixture.mjs');
  const marker = path.join(folder, 'exit.json');
  const ready = path.join(folder, 'ready');
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await writeFile(entry, macLoader);
    await writeFile(stub, `import fs from 'node:fs';
      const exit = process.exit;
      let requested = false;
      process.exit = code => {
        requested = true;
        fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ code, requested }));
        exit(code);
      };
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      setInterval(() => {}, 1000);
    `);
    const executable = createRequire(import.meta.url)('electron') as string;
    const child = spawn(executable, [entry], {
      env: { ...env, CHANCEKIT_QQ_DATA: path.join(folder, 'profile'), CHANCEKIT_NAPCAT_ENTRY: stub },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    child.stderr.resume();
    const exited = once(child, 'exit');
    try {
      await expect.poll(() => readFile(ready, 'utf8').catch(() => '')).toBe('ready');
      child.stdin.write('chancekit:quit\n');
      let timer: NodeJS.Timeout | undefined;
      const [code, signal] = await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The runtime did not handle the quit command')), 3000); }),
      ]).finally(() => clearTimeout(timer));
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({ code: 0, requested: true });
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});
