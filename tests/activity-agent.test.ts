import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectMessageMaterials, downloadPublicMaterial, isPublicAddress, parseMaterialPage, publicMaterialUrl, resolvePublicHost, type MaterialDownload } from '../electron/core/message-materials';
import { extractActivities } from '../electron/core/activity-agent';
import { normalizeMessage } from '../electron/core/store';
import { defaultModelConfig } from '../src/model-config';
import type { ProcessingJob } from '../electron/core/schedule-store';
import { sample } from './fixtures';
import sharp from 'sharp';

const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#ffffff' } }).png().toBuffer();
const activity = {
  title: '校园宣讲会', type: '宣讲会', organizer: '星河科技', startDate: '2026-09-24', endDate: null, startTime: '14:30', endTime: null,
  location: '活动中心 201', audience: '2027 届毕业生', description: '现场答疑', registrationUrl: null, deadline: null,
  evidence: '9 月 24 日 14:30 活动中心 201',
};
const signal = () => new AbortController().signal;
const settings = { config: { ...defaultModelConfig, baseUrl: 'http://127.0.0.1:9999/v1' }, apiKey: 'test-secret-key', updatedAt: new Date().toISOString() };

test('public content reader rejects localhost, private IPs, DNS-to-loopback, credentials and unsafe schemes', async () => {
  for (const url of ['http://localhost/a', 'http://127.1', 'http://2130706433', 'http://10.0.0.1', 'http://169.254.169.254', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'https://example.com:8080', 'https://user:password@example.com', 'file:///etc/passwd', 'javascript:alert(1)']) {
    assert.throws(() => publicMaterialUrl(url));
    await assert.rejects(downloadPublicMaterial(url, signal()));
  }
  for (const address of ['192.168.1.1', '172.16.0.1', '100.64.0.1', '224.0.0.1', 'fc00::1', 'fe80::1']) assert.equal(isPublicAddress(address), false);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  await assert.rejects(resolvePublicHost('localhost'));
  assert.equal(publicMaterialUrl('/jobs', 'https://example.com/page').href, 'https://example.com/jobs');
});

test('HTML is parsed without scripts, preserves poster URLs and finds registration links', () => {
  const page = parseMaterialPage('<html><head><title>招聘通知</title></head><body><nav>菜单</nav><article><h1>宣讲会</h1><p>9月24日 14:30</p><img data-src="/poster.png"><a href="/apply">报名</a><script>sendSecrets()</script><iframe src="http://localhost"></iframe></article></body></html>', 'https://example.com/jobs');
  assert.equal(page.title, '招聘通知');
  assert.ok(page.text.includes('9月24日'));
  assert.ok(!page.text.includes('sendSecrets'));
  assert.ok(!page.text.includes('菜单'));
  assert.deepEqual(page.images, ['https://example.com/poster.png']);
  assert.deepEqual(page.links, ['https://example.com/apply']);
});

test('message links and card links are opened, their images and direct images become vision inputs', async () => {
  const raw = sample(1, '详情 https://example.com/jobs');
  raw.message.push({ type: 'image', data: { url: 'https://example.com/direct.png' } } as any);
  raw.message.push({ type: 'json', data: { data: JSON.stringify({ meta: { news: { jumpUrl: 'https://example.com/card', title: '招聘卡片' } } }) } } as any);
  const urls: string[] = [];
  const download: MaterialDownload = async url => {
    urls.push(url);
    return { url, contentType: url.endsWith('.png') ? 'image/png' : 'text/html;charset=utf-8',
      bytes: url.endsWith('.png') ? png : Buffer.from('<html><body><article><p>9 月 24 日 14:30 在大学生活动中心举办校园宣讲会，欢迎毕业生参加。</p><img data-src="/poster.png"><a href="/apply">报名</a></article></body></html>') };
  };
  const material = await collectMessageMaterials(normalizeMessage(raw, 'a'), signal(), true, download);
  assert.equal(material.images.length, 2);
  assert.equal(material.images[0].mimeType, 'image/jpeg');
  assert.ok(urls.includes('https://example.com/jobs') && urls.includes('https://example.com/card'));
  assert.ok(material.allowedLinks.has('https://example.com/apply'));
  assert.ok(material.text.includes('9 月 24 日'));
  assert.deepEqual(material.warnings, []);
  const noVision = await collectMessageMaterials(normalizeMessage(raw, 'a'), signal(), false, download);
  assert.equal(noVision.images.length, 0);
  assert.ok(noVision.warnings.some(value => value.includes('图像')));
});

test('expired and unsupported content is partial, not silently treated as successfully read', async () => {
  const material = await collectMessageMaterials(normalizeMessage(sample(1, 'https://example.com/missing'), 'a'), signal(), true, async () => { throw new Error('network'); });
  assert.ok(material.warnings.length);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(collectMessageMaterials(normalizeMessage(sample(1, 'https://example.com'), 'a'), controller.signal, true));
});

test('material count limits bound page and image fan-out and report truncated sources', async () => {
  const urls: string[] = [];
  const download: MaterialDownload = async url => {
    urls.push(url);
    return { url, contentType: url.endsWith('.png') ? 'image/png' : 'text/html', bytes: url.endsWith('.png') ? png
      : Buffer.from(`<html><body><article><p>校园宣讲会完整通知，包含地点、时间以及对应的报名信息。</p>${Array.from({ length: 12 }, (_, index) => `<img src="/${index}.png">`).join('')}</article></body></html>`) };
  };
  const raw = sample(1, Array.from({ length: 8 }, (_, index) => `https://example.com/page${index}`).join('\n'));
  const material = await collectMessageMaterials(normalizeMessage(raw, 'a'), signal(), true, download);
  assert.equal(urls.filter(url => !url.endsWith('.png')).length, 4);
  assert.equal(urls.filter(url => url.endsWith('.png')).length, 12);
  assert.equal(material.images.length, 12);
  assert.ok(material.warnings.some(warning => warning.includes('链接超过')));
  assert.ok(!material.warnings.some(warning => warning.includes('图片超过')));
});

function response(name: string, input: unknown) {
  return new Response(`data: ${JSON.stringify({ id: 'test', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const toolResponse = (activities: unknown[]) => response('submit_activities', { activities });
function job(text = '9 月 24 日 14:30 活动中心 201 校园宣讲会'): ProcessingJob {
  return { message: normalizeMessage(sample(1, text), 'a'), groupName: '测试关注群', hash: 'hash', attempts: 1, context: [] };
}

test('real pi Agent executes structured extraction, includes current message time, and never gives SQL/network tools to LLM', async () => {
  let body: any;
  let calls = 0;
  const result = await extractActivities(job(), settings, { signal: signal(), fetch: async (_input, init) => {
    calls++; body = JSON.parse(String(init?.body)); return toolResponse([activity]);
  } });
  assert.equal(calls, 1);
  assert.equal(result.activities[0].title, '校园宣讲会');
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.tools.map((tool: any) => tool.function.name), ['submit_activities']);
  const prompt = JSON.stringify(body.messages);
  assert.ok(prompt.includes('currentMessageTime') && prompt.includes('Asia/Shanghai') && prompt.includes('9 月 24 日'));
  assert.ok(prompt.includes('UNTRUSTED'));
  assert.ok(!prompt.includes('test-secret-key'));
});

test('page images are sent to pi as actual image input, and invented registration URLs are removed', async () => {
  let body: any;
  let visionBody: any;
  const result = await extractActivities(job('校园通知 https://example.com/poster.png'), settings, {
    signal: signal(), download: async url => ({ url, contentType: 'image/png', bytes: png }),
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      if (body.tools[0].function.name === 'submit_visual_text') {
        visionBody = body;
        return response('submit_visual_text', { text: activity.evidence, unreadable: false });
      }
      return toolResponse([{ ...activity, registrationUrl: 'https://invented.example/apply' }]);
    },
  });
  const user = visionBody.messages.find((message: any) => message.role === 'user');
  assert.ok(user.content.some((part: any) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/jpeg;base64,')));
  assert.equal(result.activities[0].registrationUrl, null);
  assert.ok(result.warnings.length > 0);
});

test('malformed model output fails instead of committing empty events; provider errors redact secrets', async () => {
  let calls = 0;
  await assert.rejects(extractActivities(job(), settings, { signal: signal(), fetch: async () => {
    calls++; return toolResponse([{ ...activity, startDate: '2026-02-30' }]);
  } }), /结构化活动/);
  assert.equal(calls, 3);
  await assert.rejects(extractActivities(job(), settings, { signal: signal(), fetch: async () => new Response(JSON.stringify({ error: { message: 'invalid test-secret-key', type: 'authentication_error' } }), { status: 401, headers: { 'content-type': 'application/json' } }) }), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes('test-secret-key'));
    return true;
  });
});

test('long posters are read in bounded batches and final extraction can combine the first and last batch, including printed URLs', async () => {
  const longPoster = await sharp({ create: { width: 120, height: 16000, channels: 3, background: '#246813' } }).png().toBuffer();
  const current = job('长海报通知 https://example.com/long-poster.png');
  current.message.accountId = 'batch-test';
  const sizes: number[] = [];
  let finalCalls = 0;
  const result = await extractActivities(current, settings, {
    signal: signal(), download: async url => ({ url, contentType: 'image/png', bytes: longPoster }),
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const user = body.messages.find((message: any) => message.role === 'user');
      if (body.tools[0].function.name === 'submit_visual_text') {
        sizes.push(user.content.filter((part: any) => part.type === 'image_url').length);
        return response('submit_visual_text', { text: sizes.length === 1 ? '校园宣讲会，9月24日14:30'
          : '地点：活动中心201。报名：https://campus.example.cn/apply', unreadable: false });
      }
      finalCalls++;
      assert.match(JSON.stringify(user), /9月24日14:30/);
      assert.match(JSON.stringify(user), /活动中心201/);
      return toolResponse([{ ...activity, registrationUrl: 'https://campus.example.cn/apply' }]);
    },
  });
  assert.deepEqual(sizes, [6, 2]);
  assert.equal(finalCalls, 1);
  assert.equal(result.activities[0].registrationUrl, 'https://campus.example.cn/apply');
  assert.deepEqual(result.warnings, []);
});

test('cancelling a visual batch prevents later batches and final extraction', async () => {
  const controller = new AbortController();
  const current = job('https://example.com/cancel-poster.png');
  current.message.accountId = 'cancel-visual-test';
  const longPoster = await sharp({ create: { width: 120, height: 16000, channels: 3, background: '#775599' } }).png().toBuffer();
  let calls = 0;
  await assert.rejects(extractActivities(current, settings, {
    signal: controller.signal, download: async url => ({ url, contentType: 'image/png', bytes: longPoster }),
    fetch: async () => { calls++; controller.abort(new Error('cancelled')); return response('submit_visual_text', { text: '', unreadable: false }); },
  }), /cancelled/);
  assert.equal(calls, 1);
});

test('visual failures never become an empty successful extraction and redact provider keys', async () => {
  const current = job('https://example.com/failed-vision.png');
  current.message.accountId = 'failed-vision-test';
  await assert.rejects(extractActivities(current, settings, {
    signal: signal(), download: async url => ({ url, contentType: 'image/png', bytes: png }),
    fetch: async () => new Response(JSON.stringify({ error: { message: 'failure test-secret-key', type: 'authentication_error' } }), { status: 401, headers: { 'content-type': 'application/json' } }),
  }), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes('test-secret-key'));
    return true;
  });
});
