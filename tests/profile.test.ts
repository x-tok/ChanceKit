import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProfileDirectory } from '../electron/core/profile';

test('profile rename preserves login files, the archive and pending WAL data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-profile-'));
  const legacy = path.join(root, '群讯');
  const files = ['messages.sqlite', 'messages.sqlite-wal', 'connection.enc', 'runtime/qq-profile/global/login.db'];
  try {
    for (const file of files) {
      await mkdir(path.dirname(path.join(legacy, file)), { recursive: true });
      await writeFile(path.join(legacy, file), `preserved:${file}`);
    }
    const original = await stat(path.join(legacy, 'messages.sqlite'));
    const current = resolveProfileDirectory(root);
    assert.equal(current, path.join(root, 'ChanceKit'));
    for (const file of files) assert.equal(await readFile(path.join(current, file), 'utf8'), `preserved:${file}`);
    assert.equal((await stat(path.join(current, 'messages.sqlite'))).ino, original.ino);
    await assert.rejects(stat(legacy), { code: 'ENOENT' });
    assert.equal(resolveProfileDirectory(root), current);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fresh profiles use ChanceKit and existing profiles never merge or overwrite', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-profile-'));
  const current = path.join(root, 'ChanceKit');
  const legacy = path.join(root, '群讯');
  try {
    assert.equal(resolveProfileDirectory(root), current);
    await mkdir(current);
    await mkdir(legacy);
    await writeFile(path.join(current, 'messages.sqlite'), 'current');
    await writeFile(path.join(legacy, 'messages.sqlite'), 'legacy');
    assert.equal(resolveProfileDirectory(root), current);
    assert.equal(await readFile(path.join(current, 'messages.sqlite'), 'utf8'), 'current');
    assert.equal(await readFile(path.join(legacy, 'messages.sqlite'), 'utf8'), 'legacy');
  } finally { await rm(root, { recursive: true, force: true }); }
});
