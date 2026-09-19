import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runtimeFiles, discardRuntimePath, recoverRuntimeDirectory, replaceRuntimeDirectory } from '../electron/core/runtime-files';

test('runtime replacement preserves account data and rolls back a failed promotion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-replacement-'));
  const bundle = path.join(root, 'QQRuntime.app');
  const staging = path.join(root, 'staging');
  try {
    await mkdir(bundle);
    await mkdir(staging);
    await mkdir(path.join(root, 'qq-profile'));
    await writeFile(path.join(root, 'qq-profile/login.db'), 'account-data');
    await writeFile(path.join(root, 'messages.sqlite'), 'message-data');
    await writeFile(path.join(bundle, 'application.asar'), 'old-runtime');
    await writeFile(path.join(staging, 'application.asar'), 'new-runtime');
    await assert.rejects(replaceRuntimeDirectory(path.join(root, 'missing-stage'), bundle, () => {}), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(bundle, 'application.asar'), 'utf8'), 'old-runtime');
    await replaceRuntimeDirectory(staging, bundle, () => {});
    assert.equal(await readFile(path.join(bundle, 'application.asar'), 'utf8'), 'new-runtime');
    assert.equal(await readFile(path.join(root, 'qq-profile/login.db'), 'utf8'), 'account-data');
    assert.equal(await readFile(path.join(root, 'messages.sqlite'), 'utf8'), 'message-data');
    await assert.rejects(access(`${bundle}.previous`), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an interrupted replacement restores the previous directory without overwriting a current one', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-recovery-'));
  const bundle = path.join(root, 'QQRuntime.app');
  try {
    await mkdir(`${bundle}.previous`);
    await writeFile(path.join(`${bundle}.previous`, 'identity'), 'previous');
    await recoverRuntimeDirectory(bundle);
    assert.equal(await readFile(path.join(bundle, 'identity'), 'utf8'), 'previous');
    await rename(bundle, `${bundle}.previous`);
    await mkdir(bundle);
    await writeFile(path.join(bundle, 'identity'), 'current');
    await recoverRuntimeDirectory(bundle);
    assert.equal(await readFile(path.join(bundle, 'identity'), 'utf8'), 'current');
    assert.equal(await readFile(path.join(`${bundle}.previous`, 'identity'), 'utf8'), 'previous');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cleanup failure cannot undo a published runtime or mask the original preparation error', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-cleanup-'));
  const bundle = path.join(root, 'QQRuntime.app');
  const staging = path.join(root, 'staging');
  const originalRm = runtimeFiles.rm;
  const notices: string[] = [];
  try {
    await mkdir(bundle);
    await mkdir(staging);
    await writeFile(path.join(bundle, 'identity'), 'old');
    await writeFile(path.join(staging, 'identity'), 'new');
    let previousRemovals = 0;
    t.mock.method(runtimeFiles, 'rm', async (...[file, options]: Parameters<typeof originalRm>) => {
      if (file === `${bundle}.previous` && ++previousRemovals === 2) throw Object.assign(new Error('busy'), { code: 'ENOTEMPTY' });
      if (file === staging) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return originalRm(file, options);
    });
    await replaceRuntimeDirectory(staging, bundle, text => notices.push(text));
    assert.equal(await readFile(path.join(bundle, 'identity'), 'utf8'), 'new');
    assert.equal(await readFile(path.join(`${bundle}.previous`, 'identity'), 'utf8'), 'old');
    const failure = new Error('signing failed');
    await assert.rejects(async () => {
      try { throw failure; }
      finally { await discardRuntimePath(staging, text => notices.push(text)); }
    }, error => error === failure);
    assert.equal(notices.length, 2);
  } finally { t.mock.restoreAll(); await rm(root, { recursive: true, force: true }); }
});
