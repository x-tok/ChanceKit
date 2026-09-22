import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { Agent } from '@earendil-works/pi-agent-core';
import { createConfiguredPiAgent, getModelCatalog, MODEL_TEST_PROMPT, testPiModel } from '../electron/core/models/pi-model';
import type { StoredModelSettings } from '../electron/core/models/model-settings';
import { configForProvider, defaultModelConfig, modelProviderPresets, type ModelApi } from '../src/model-config';

const stored: StoredModelSettings = {
  config: { ...defaultModelConfig, provider: 'custom', api: 'openai-completions', modelId: 'test-model', reasoning: false, imageInput: false },
  apiKey: 'sk-test-key', updatedAt: new Date().toISOString(),
};

async function server(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const http = createServer(handler);
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  return `http://127.0.0.1:${(http.address() as { port: number }).port}/v1`;
}

test('pi catalog contains supported providers and the configured runtime is a real pi Agent', () => {
  const catalog = getModelCatalog();
  assert.deepEqual(catalog, modelProviderPresets);
  for (const id of ['deepseek', 'qwen', 'moonshotai-cn', 'zhipu', 'minimax-cn']) {
    assert.ok(catalog.find(provider => provider.id === id)!.models.length > 0);
  }
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] as ModelApi[]) {
    const agent = createConfiguredPiAgent({ ...stored, config: { ...stored.config, api, reasoning: true, reasoningLevel: 'high' } });
    assert.ok(agent instanceof Agent);
    assert.equal(agent.state.model.api, api);
    assert.equal(agent.state.model.id, 'test-model');
    assert.equal(agent.state.thinkingLevel, 'high');
    assert.deepEqual(agent.state.tools, []);
  }
});

test('domestic models retain pi compatibility settings with regular API endpoints', () => {
  for (const provider of modelProviderPresets.filter(provider => provider.id !== 'custom')) {
    for (const entry of provider.models) {
      const config = configForProvider(provider, entry);
      const agent = createConfiguredPiAgent({ ...stored, config });
      assert.equal(agent.state.model.name, entry.name);
      assert.equal(agent.state.model.id, entry.id);
      assert.equal(agent.state.model.baseUrl, provider.baseUrl);
      assert.equal(agent.state.model.api, entry.api);
      assert.equal(agent.state.thinkingLevel, config.reasoningLevel);
      if (entry.api === 'openai-completions') assert.ok(agent.state.model.compat);
    }
  }
});

test('DeepSeek V4.1 Flash and domestic completions providers send their own thinking formats', async t => {
  let body: Record<string, any> = {};
  const baseUrl = await server(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString());
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  for (const id of ['deepseek', 'qwen', 'moonshotai-cn', 'zhipu']) {
    const provider = modelProviderPresets.find(provider => provider.id === id)!;
    for (const reasoningLevel of ['off', 'high'] as const) {
      const config = { ...configForProvider(provider), baseUrl, reasoningLevel };
      assert.equal((await testPiModel({ ...stored, config })).reply, 'OK');
      assert.equal(body.model, config.modelId);
      assert.equal(body.max_tokens ?? body.max_completion_tokens, config.maxTokens);
      if (id === 'qwen') {
        assert.equal(body.enable_thinking, reasoningLevel !== 'off');
        assert.equal(body.reasoning_effort, undefined);
      } else {
        assert.equal(body.thinking.type, reasoningLevel === 'off' ? 'disabled' : 'enabled');
        if (id === 'deepseek') {
          assert.equal(body.model, 'deepseek-flash');
          assert.equal(body.reasoning_effort, reasoningLevel === 'off' ? undefined : 'high');
        }
        if (id === 'moonshotai-cn') assert.equal(body.reasoning_effort, undefined);
      }
    }
  }
});

test('connection test sends the configured model and generation options through pi, without conversation data', async t => {
  let body: Record<string, any> = {};
  let auth: string | undefined;
  const baseUrl = await server(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString());
    auth = request.headers.authorization;
    assert.equal(request.url, '/v1/chat/completions');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  const result = await testPiModel({ ...stored, config: { ...stored.config, baseUrl, temperature: 0.4, maxTokens: 100 } });
  assert.equal(result.reply, 'OK');
  assert.equal(result.outputTokens, 1);
  assert.equal(auth, 'Bearer sk-test-key');
  assert.equal(body.model, 'test-model');
  assert.equal(body.temperature, 0.4);
  assert.equal(body.max_tokens ?? body.max_completion_tokens, 100);
  assert.equal(body.stream, true);
  assert.equal(body.messages.filter((message: any) => message.role === 'user').length, 1);
  assert.deepEqual(body.messages.find((message: any) => message.role === 'user').content, [{ type: 'text', text: MODEL_TEST_PROMPT }]);
  assert.equal(body.tools, undefined);
});

test('provider errors are not treated as successful tests and secret values are redacted', async t => {
  const baseUrl = await server(t, (_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Invalid sk-test-key', type: 'authentication_error' } }));
  });
  await assert.rejects(testPiModel({ ...stored, config: { ...stored.config, baseUrl } }), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes('sk-test-key'));
    assert.match(error.message, /401|Invalid/);
    return true;
  });
});

test('remote models require explicit credentials and local model servers may omit them', () => {
  assert.throws(() => createConfiguredPiAgent({ ...stored, apiKey: '' }), /API Key/);
  assert.ok(createConfiguredPiAgent({ ...stored, config: { ...stored.config, baseUrl: 'http://localhost:11434/v1' }, apiKey: '' }) instanceof Agent);
});

test('canceling and timing out a model test stops the pending provider request', async t => {
  const baseUrl = await server(t, () => {});
  const settings = { ...stored, config: { ...stored.config, baseUrl } };
  const controller = new AbortController();
  const pending = testPiModel(settings, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 50);
  try { await assert.rejects(pending, /已取消/); }
  finally { clearTimeout(timer); }
  await assert.rejects(testPiModel(settings, { timeout: 50 }), /超时/);
});

test('redirect responses cannot forward API credentials to another server', async t => {
  let leakedRequests = 0;
  const target = await server(t, (_request, response) => { leakedRequests++; response.end(); });
  const baseUrl = await server(t, (_request, response) => { response.writeHead(307, { location: target }); response.end(); });
  await assert.rejects(testPiModel({ ...stored, config: { ...stored.config, baseUrl } }));
  assert.equal(leakedRequests, 0);
});
