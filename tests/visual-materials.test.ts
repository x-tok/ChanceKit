import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readVisualMaterials } from '../electron/core/visual-materials';
import { defaultModelConfig } from '../src/model-config';

const settings = { config: { ...defaultModelConfig, baseUrl: 'http://127.0.0.1:9999/v1' }, apiKey: 'synthetic-key', updatedAt: '' };
const images = (count: number) => [{ label: '合成海报', images: Array.from({ length: count }, (_, i) => ({ type: 'image' as const, mimeType: 'image/png', data: Buffer.from(`synthetic-${i}`).toString('base64') })) }];
function response(input: unknown) {
  return new Response(`data: ${JSON.stringify({ id: 'test', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'submit_visual_text', arguments: JSON.stringify(input) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

test('visual repair targets only identified images and caches the recovered whole batch', async () => {
  const sizes: number[] = [];
  const options = { signal: new AbortController().signal, accountId: 'selective-repair', fetch: (async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    sizes.push(body.messages.find((message: any) => message.role === 'user').content.filter((part: any) => part.type === 'image_url').length);
    return response(sizes.length === 1 ? { text: '已读日期：9月24日', unreadable: true, unreadableImageIndices: [2, 5] }
      : { text: '已补齐地点及报名信息', unreadable: false });
  }) as typeof fetch };
  const first = await readVisualMaterials(images(6), settings, options);
  assert.deepEqual(sizes, [6, 1, 1]);
  assert.match(first.text, /9月24日/);
  assert.deepEqual(first.warnings, []);
  const second = await readVisualMaterials(images(6), settings, options);
  assert.deepEqual(sizes, [6, 1, 1]);
  assert.match(second.text, /9月24日/);
  assert.deepEqual(second.warnings, []);
});

test('repair stops at six operations while later first-pass batches still run', async () => {
  const sizes: number[] = [];
  const result = await readVisualMaterials(images(24), settings, {
    signal: new AbortController().signal, accountId: 'repair-budget',
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      sizes.push(body.messages.find((message: any) => message.role === 'user').content.filter((part: any) => part.type === 'image_url').length);
      return response({ text: '保留可辨认的活动日期与地点', unreadable: true });
    },
  });
  assert.equal(sizes.filter(size => size === 6).length, 4);
  assert.equal(sizes.filter(size => size === 2).length, 6);
  assert.match(result.warnings.join(' '), /6 次补读上限/);
  assert.match(result.text, /保留可辨认/);
});

test('streamed PDF batches share one repair allowance and send true page labels', async () => {
  const repairBudget = { used: 5 };
  let calls = 0;
  for (const page of [39, 40]) {
    const result = await readVisualMaterials([{ ...images(1)[0], label: `网页 PDF 第 ${page} 页` }], settings, {
      signal: new AbortController().signal, accountId: 'streamed-repair', repairBudget,
      fetch: async (_input, init) => {
        calls++;
        assert.match(String(init?.body), new RegExp(`第 ${page} 页`));
        return response({ text: '部分文字', unreadable: true, unreadableImageIndices: [1] });
      },
    });
    assert.ok(result.warnings.length);
  }
  assert.equal(calls, 3);
  assert.equal(repairBudget.used, 6);
});
