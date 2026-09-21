import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { configForProvider, defaultModelConfig, modelProviderPresets } from '../src/model-config';
import { ModelSettingsStore, modelConfigInputSchema, type SecretEncryption } from '../electron/core/models/model-settings';

const config = { ...defaultModelConfig, modelId: 'test-model' };
function encryption(): SecretEncryption {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

test('model settings are encrypted, private, restart-persistent and never return keys to the renderer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-models-'));
  const crypto = encryption();
  try {
    const store = new ModelSettingsStore(root, crypto);
    assert.equal((await store.get()).config, null);
    const result = await store.save({ config, apiKey: 'sk-private-key' });
    assert.equal(result.hasApiKey, true);
    assert.ok(!JSON.stringify(result).includes('sk-private-key'));
    const file = path.join(root, 'model-settings.enc');
    assert.ok(!(await readFile(file)).includes(Buffer.from('sk-private-key')));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const restarted = new ModelSettingsStore(root, crypto);
    assert.deepEqual((await restarted.get()).config, config);
    assert.equal((await restarted.saved())?.apiKey, 'sk-private-key');
    assert.deepEqual(await readdir(root), ['model-settings.enc']);
    assert.equal((await restarted.clear()).config, null);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('keys are retained only within the same provider, API and endpoint, and explicit removal works', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-model-key-'));
  try {
    const store = new ModelSettingsStore(root, encryption());
    await store.save({ config, apiKey: 'secret' });
    assert.equal((await store.resolve({ config: { ...config, modelId: 'other-model' } })).apiKey, 'secret');
    for (const changes of [{ baseUrl: 'https://other.example/v1' }, { api: 'openai-responses' as const }, { provider: 'custom' as const }]) {
      assert.equal((await store.resolve({ config: { ...config, ...changes } })).apiKey, '');
    }
    assert.equal((await store.resolve({ config: { ...config, baseUrl: `${config.baseUrl}/` } })).apiKey, 'secret');
    await store.save({ config, apiKey: '' });
    assert.equal((await store.get()).hasApiKey, false);
    assert.equal((await store.saved())?.apiKey, '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unsafe endpoints, invalid model names and inconsistent generation parameters are rejected', () => {
  for (const changes of [
    { baseUrl: 'http://remote.example/v1' }, { baseUrl: 'https://user:secret@example.com' },
    { baseUrl: 'https://example.com?key=secret' }, { baseUrl: 'file:///tmp/model' },
    { modelId: '' }, { modelId: 'bad model' }, { maxTokens: 200000, contextWindow: 1024 },
    { temperature: -1 }, { temperature: 3 }, { contextWindow: NaN },
    { reasoning: false, reasoningLevel: 'high' },
  ]) assert.equal(modelConfigInputSchema.safeParse({ config: { ...config, ...changes } }).success, false);
  for (const baseUrl of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080/v1']) {
    assert.equal(modelConfigInputSchema.safeParse({ config: { ...config, baseUrl } }).success, true);
  }
  assert.equal(modelConfigInputSchema.safeParse({ config, apiKey: 'key\nheader' }).success, false);
});

test('failed encryption and corrupt settings preserve the previous file and report a recoverable error', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-model-failure-'));
  const crypto = encryption();
  try {
    const store = new ModelSettingsStore(root, crypto);
    await store.save({ config, apiKey: 'retained' });
    const file = path.join(root, 'model-settings.enc');
    const before = await readFile(file);
    const unavailable = new ModelSettingsStore(root, { ...crypto, isEncryptionAvailable: () => false });
    await assert.rejects(unavailable.save({ config, apiKey: 'new-key' }), /系统密钥服务不可用/);
    assert.deepEqual(await readFile(file), before);
    await writeFile(file, 'broken');
    await assert.rejects(store.get(), /原文件已保留/);
    assert.equal(await readFile(file, 'utf8'), 'broken');
    await store.clear();
    assert.equal((await store.get()).config, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent saves are serialized and leave no temporary files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-model-race-'));
  try {
    const store = new ModelSettingsStore(root, encryption());
    await Promise.all([
      store.save({ config, apiKey: 'first' }),
      store.save({ config: { ...config, modelId: 'second' } }),
    ]);
    assert.equal((await store.saved())?.config.modelId, 'second');
    assert.equal((await store.saved())?.apiKey, 'first');
    assert.deepEqual(await readdir(root), ['model-settings.enc']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('domestic presets have valid provider-specific defaults and custom starts empty', () => {
  assert.equal(defaultModelConfig.modelId, 'deepseek-flash');
  assert.equal(defaultModelConfig.provider, 'deepseek');
  assert.equal(defaultModelConfig.imageInput, true);
  assert.equal(defaultModelConfig.contextWindow, 1000000);
  assert.deepEqual(modelProviderPresets.map(provider => provider.id), ['deepseek', 'qwen', 'moonshotai-cn', 'zhipu', 'minimax-cn', 'custom']);
  for (const provider of modelProviderPresets.filter(provider => provider.id !== 'custom')) {
    assert.ok(provider.models.length > 0);
    for (const model of provider.models) {
      const value = configForProvider(provider, model);
      assert.equal(modelConfigInputSchema.safeParse({ config: value }).success, true);
      assert.equal(value.modelId, model.id);
      assert.equal(value.baseUrl, provider.baseUrl);
      assert.ok(!value.baseUrl.includes('coding') && !value.baseUrl.includes('token-plan'));
      assert.ok(model.reasoningLevels?.includes(value.reasoningLevel));
    }
  }
  const custom = configForProvider(modelProviderPresets.find(provider => provider.id === 'custom')!);
  assert.equal(custom.modelId, '');
  assert.equal(custom.baseUrl, '');
  assert.equal(custom.reasoning, false);
  assert.equal(custom.imageInput, false);
});

test('legacy saved providers remain readable without applying new defaults or replacing credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-legacy-model-'));
  const crypto = encryption();
  const previous = { ...config, provider: 'openai' as const, api: 'openai-responses' as const, baseUrl: 'https://api.openai.com/v1', modelId: 'previous-model', reasoning: false, imageInput: false };
  try {
    const store = new ModelSettingsStore(root, crypto);
    await store.save({ config: previous, apiKey: 'existing-key' });
    const restarted = new ModelSettingsStore(root, crypto);
    assert.deepEqual((await restarted.get()).config, previous);
    assert.equal((await restarted.saved())?.apiKey, 'existing-key');
  } finally { await rm(root, { recursive: true, force: true }); }
});
