import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { qqDownloadTarget } from '../electron/onboarding/ipc';
import { OnboardingStore } from '../electron/onboarding/store';

test('onboarding completion is validated and persists across store instances', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-onboarding-'));
  try {
    const store = new OnboardingStore(root);
    assert.deepEqual(await store.status(), { completed: false });
    await assert.rejects(store.complete('../invalid'));
    assert.deepEqual(await store.status(), { completed: false });

    await store.complete('100010001');
    assert.deepEqual(await new OnboardingStore(root).status(), { completed: true });
    const saved = JSON.parse(await readFile(path.join(root, 'onboarding.json'), 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(saved.accountId, '100010001');
    assert.ok(Number.isFinite(Date.parse(saved.completedAt)));

    await writeFile(path.join(root, 'onboarding.json'), '{"version":1}');
    assert.deepEqual(await store.status(), { completed: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('test profiles can bypass onboarding without creating state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-onboarding-test-'));
  try {
    assert.deepEqual(await new OnboardingStore(root, true).status(), { completed: true });
    await assert.rejects(readFile(path.join(root, 'onboarding.json')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('QQ download targets are platform specific', () => {
  assert.equal(qqDownloadTarget('darwin'), 'macappstore://itunes.apple.com/app/id451108668');
  assert.equal(qqDownloadTarget('win32'), 'https://im.qq.com/pcqq/index.shtml');
});
