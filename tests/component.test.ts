import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, writeFile, copyFile, open, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installBundledNapCat, RELEASE } from '../electron/core/runtime/component';

const archive = path.resolve('resources/napcat', RELEASE.archive);

test('fresh component installation is offline, reusable, and does not modify bundled resources', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'chancekit offline '));
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network disabled'); });
  const reports: string[] = [];
  const before = await stat(archive);
  const signal = new AbortController().signal;
  try {
    const dest = await installBundledNapCat(folder, archive, text => reports.push(text), signal);
    assert.equal(await readFile(path.join(dest, '.verified'), 'utf8'), RELEASE.sha256);
    assert.ok((await stat(path.join(dest, 'napcat.mjs'))).size > 0);
    assert.ok((await stat(path.join(dest, 'NapCatWinBootMain.exe'))).size > 0);
    assert.ok(reports.some(text => text.includes('内置')));
    await assert.rejects(stat(`${dest}.staging`), { code: 'ENOENT' });
    const sentinel = path.join(dest, 'config', 'local-test-setting.json');
    await writeFile(sentinel, '{}');
    // Reusing an installed component must retain its own settings and work without the archive.
    reports.length = 0;
    assert.equal(await installBundledNapCat(folder, path.join(folder, 'unavailable.zip'), text => reports.push(text), signal), dest);
    assert.equal(await readFile(sentinel, 'utf8'), '{}');
    assert.equal(reports.length, 0);
    assert.equal(network.mock.callCount(), 0);
    assert.equal((await stat(archive)).mtimeMs, before.mtimeMs);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('missing and checksum-corrupt bundles fail without network fallback or partial installation', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'chancekit-component-failure-'));
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network disabled'); });
  const signal = new AbortController().signal;
  try {
    await assert.rejects(installBundledNapCat(folder, path.join(folder, 'missing.zip'), () => {}, signal), /重新安装见机/);
    const corrupt = path.join(folder, 'corrupt.zip');
    await copyFile(archive, corrupt);
    const handle = await open(corrupt, 'r+');
    try { await handle.write(Buffer.from('BAD!'), 0, 4, 0); } finally { await handle.close(); }
    assert.equal((await stat(corrupt)).size, RELEASE.size);
    await assert.rejects(installBundledNapCat(folder, corrupt, () => {}, signal), /重新安装见机/);
    await assert.rejects(stat(path.join(folder, `napcat-${RELEASE.version}`)), { code: 'ENOENT' });
    assert.equal(network.mock.callCount(), 0);
    const canceled = new AbortController();
    canceled.abort();
    await assert.rejects(installBundledNapCat(folder, archive, () => {}, canceled.signal), { name: 'AbortError' });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('repairing a partial NapCat installation retains local configuration and recovers interrupted replacement', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'chancekit-component-repair-'));
  const signal = new AbortController().signal;
  try {
    const dest = await installBundledNapCat(folder, archive, () => {}, signal);
    const config = path.join(dest, 'config/local-setting.json');
    await writeFile(config, '{"fixture":"keep"}');
    await rm(path.join(dest, 'napcat.mjs'));
    await mkdir(`${dest}.staging`);
    await writeFile(path.join(`${dest}.staging`, 'partial'), 'interrupted-copy');
    await assert.rejects(installBundledNapCat(folder, path.join(folder, 'missing.zip'), () => {}, signal), /重新安装见机/);
    assert.equal(await readFile(config, 'utf8'), '{"fixture":"keep"}');
    await installBundledNapCat(folder, archive, () => {}, signal);
    assert.ok((await stat(path.join(dest, 'napcat.mjs'))).size > 0);
    assert.equal(await readFile(config, 'utf8'), '{"fixture":"keep"}');
    await assert.rejects(stat(`${dest}.staging`), { code: 'ENOENT' });
    await rename(dest, `${dest}.previous`);
    assert.equal(await installBundledNapCat(folder, path.join(folder, 'missing.zip'), () => {}, signal), dest);
    assert.equal(await readFile(config, 'utf8'), '{"fixture":"keep"}');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
