import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SavedConnectionStore } from '../electron/core/connection/saved-connection';

const encryption = {
  available: () => true,
  encrypt: (value: string) => Buffer.from(value).reverse(),
  decrypt: (value: Buffer) => value.reverse().toString(),
};

test('saved connection mode survives restart without storing credentials as plaintext', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-connection-'));
  const file = path.join(root, 'connection.enc');
  const config = { wsUrl: 'ws://127.0.0.1:3001', accessToken: 'private-access',
    webuiUrl: 'http://127.0.0.1:6099', webuiToken: 'private-webui' };
  try {
    const store = new SavedConnectionStore(file, encryption);
    await store.save({ version: 1, mode: 'external', config });
    assert.equal((await readFile(file)).includes(Buffer.from('private-access')), false);
    assert.deepEqual(await new SavedConnectionStore(file, encryption).load(), { version: 1, mode: 'external', config });
    await store.save({ version: 1, mode: 'managed', path: '/Applications/QQ.app' });
    assert.deepEqual(await store.load(), { version: 1, mode: 'managed', path: '/Applications/QQ.app' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy external settings migrate in memory and invalid records are ignored', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-connection-'));
  const file = path.join(root, 'connection.enc');
  const config = { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', webuiUrl: '', webuiToken: '' };
  try {
    await writeFile(file, encryption.encrypt(JSON.stringify(config)));
    const store = new SavedConnectionStore(file, encryption);
    assert.deepEqual(await store.load(), { version: 1, mode: 'external', config });
    await writeFile(file, encryption.encrypt('{"mode":"managed","path":""}'));
    assert.equal(await store.load(), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
