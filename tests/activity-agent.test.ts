import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectMessageMaterials, downloadPublicMaterial, isPublicAddress, parseMaterialPage, publicMaterialUrl, resolvePublicHost, type MaterialDownload } from '../electron/core/message-materials';
import { extractActivities } from '../electron/core/activity-agent';
import { normalizeMessage } from '../electron/core/store';
import { defaultModelConfig } from '../src/model-config';
import type { ProcessingJob } from '../electron/core/schedule-store';
import { sample } from './fixtures';
import sharp from 'sharp';
import { ExtractionFailure } from '../electron/core/extraction-failure';
import { readPdfMaterial } from '../electron/core/material-pdf';
import { pdfFixture } from './pdf-fixtures';

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
function proseResponse() {
  return new Response(`data: ${JSON.stringify({ id: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: 'No structured submission.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const toolResponse = (activities: unknown[]) => response('submit_activities', { activities });
function job(text = '9 月 24 日 14:30 活动中心 201 校园宣讲会'): ProcessingJob {
  return { message: normalizeMessage(sample(1, text), 'a'), groupName: '测试关注群', hash: 'hash', attempts: 1, context: [] };
}

test('complete original messages use one extraction and skip supplemental downloads', async () => {
  let calls = 0;
  const current = job('星河科技2027届校园招聘宣讲会，9月24日14:30，活动中心201。欢迎毕业生携带简历参加，现场提供岗位交流与答疑，更多企业介绍 https://example.com/info');
  const result = await extractActivities(current, settings, {
    signal: signal(), download: async () => { throw new Error('must not download'); },
    fetch: async () => { calls++; return toolResponse([{ ...activity, evidence: '9月24日14:30，活动中心201' }]); },
  });
  assert.equal(calls, 1);
  assert.equal(result.activities.length, 1);
  assert.deepEqual(result.reviewReasons, []);
  assert.ok(result.materials.some(source => source.url === 'https://example.com/info'));
});

test('strict plain job promotion finishes without any model or page request', async () => {
  const result = await extractActivities(job('星河银行2027届校园招聘正式启动，多个职位开放投递，面向理学、管理学和经济学等专业，提供导师培养及轮岗机会，欢迎通过岗位入口投递简历：https://jobs.example.com/#/position/campus/'), settings, {
    signal: signal(), download: async () => { throw new Error('must not download'); },
    fetch: async () => { throw new Error('must not invoke model'); },
  });
  assert.deepEqual(result.activities, []);
  assert.deepEqual(result.reviewReasons, []);
  assert.ok(result.warnings.length);
});

test('pi preserves a readable undated recruiting push as information without inventing an event', async () => {
  const result = await extractActivities(job('https://example.com/recruiting-news'), settings, {
    signal: signal(), download: async url => ({ url, contentType: 'text/html', bytes: Buffer.from('<article><h1>星河研究院岗位介绍</h1>欢迎了解研发岗位和培养计划。本次推送介绍岗位职责及简历投递方式，尚未安排线下场次。</article>') }),
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      assert.match(JSON.stringify(body.messages), /Preserve recruiting information separately/);
      return response('submit_activities', { activities: [], information: { title: '星河研究院岗位介绍', summary: '研发岗位职责、培养计划与简历投递方式。' } });
    },
  });
  assert.deepEqual(result.activities, []);
  assert.equal(result.information!.title, '星河研究院岗位介绍');
  assert.deepEqual(result.reviewReasons, []);
  assert.equal(result.materials[0].url, 'https://example.com/recruiting-news');
});

test('readable recruiting group QR cards retain the full group name as information without a false calendar event or QR warning', async () => {
  const current = job('');
  current.message.accountId = 'group-invitation';
  current.message.segments = [{ type: 'image', data: { url: 'https://example.com/group-card.png' } }];
  const title = '群聊：9月23日星河科技宣讲会-示例大学场';
  const expiry = '该二维码7天内（9月27日前）有效，重新进入将更新';
  const calls: string[] = [];
  const result = await extractActivities(current, settings, {
    signal: signal(), download: async url => ({ url, contentType: 'image/png', bytes: png }),
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const tool = body.tools[0].function.name;
      const system = body.messages.find((message: any) => message.role === 'system').content;
      calls.push(tool);
      if (tool === 'submit_visual_text') {
        assert.match(system, /full visible group name/);
        assert.match(system, /joining visual line wraps/);
        assert.match(system, /Member avatars and an undecodable QR pattern/);
        assert.match(system, /not the QQ group that forwarded it/);
        return response(tool, { text: `${title}\n微信群聊二维码。\n${expiry}`, unreadable: false });
      }
      assert.match(system, /contact INFORMATION, not a session announcement/);
      assert.match(system, /neither a dated nor an undated activity/);
      assert.match(system, /neither a session date, application deadline nor an ongoing activity window/);
      assert.match(system, /group join URL is not an event registration URL/);
      const content = JSON.stringify(body.messages.find((message: any) => message.role === 'user').content);
      assert.ok(content.includes(title) && content.includes(expiry));
      return response(tool, { activities: [], information: { title, summary: `微信群聊二维码。图片注明：${expiry}。` } });
    },
  });
  assert.deepEqual(calls, ['submit_visual_text', 'submit_activities']);
  assert.deepEqual(result.activities, []);
  assert.equal(result.information!.title, title);
  assert.match(result.information!.summary, /图片注明.*9月27日前/);
  assert.deepEqual(result.reviewReasons, []);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.materials.some(source => source.kind === 'image' && source.url === 'https://example.com/group-card.png'));
});

test('a partially illegible group invitation can keep its legible name without hiding the missing source', async () => {
  const current = job('');
  current.message.accountId = 'group-invitation-incomplete';
  current.message.segments = [{ type: 'image', data: { url: 'https://example.com/group-partial.png' } }];
  let reads = 0;
  const result = await extractActivities(current, settings, {
    signal: signal(), download: async url => ({ url, contentType: 'image/png', bytes: png }),
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.tools[0].function.name === 'submit_visual_text') {
        reads++;
        return response('submit_visual_text', { text: '群聊：星河科技（其余名称无法辨认）', unreadable: true, unreadableImageIndices: [1] });
      }
      return response('submit_activities', { activities: [], information: { title: '群聊：星河科技（名称未读全）', summary: '群聊二维码，群名称仅能辨认“星河科技”。' } });
    },
  });
  assert.equal(reads, 2);
  assert.deepEqual(result.activities, []);
  assert.match(result.information!.title, /群聊：星河科技/);
  assert.ok(result.warnings.length && result.reviewReasons!.length);
});

test('a group QR card with an explicitly quoted session keeps the real event and its group contact separately', async () => {
  const original = normalizeMessage(sample(10, '星河科技宣讲会，9月24日14:30，活动中心201。'), 'group-invitation-with-event');
  const current = job('这是活动交流群');
  current.message.segments.unshift({ type: 'reply', data: { id: original.externalId } });
  current.message.segments.push({ type: 'image', data: { url: 'https://example.com/quoted-group.png' } });
  current.referenceGraph = { references: [{ message: original, hash: 'original', relation: 'quoted' }], missing: [], warnings: [], hash: 'group-reference' };
  current.message.accountId = 'group-invitation-with-event';
  const result = await extractActivities(current, settings, {
    signal: signal(), download: async url => ({ url, contentType: 'image/png', bytes: png }),
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.tools[0].function.name === 'submit_visual_text') return response('submit_visual_text', {
        text: '群聊：星河科技宣讲交流群。该二维码7天内（9月27日前）有效。', unreadable: false,
      });
      assert.match(JSON.stringify(body.messages), /independently announce an actual session/);
      const content = JSON.stringify(body.messages.find((message: any) => message.role === 'user').content);
      assert.match(content, /9月24日14:30/);
      assert.match(content, /星河科技宣讲交流群/);
      return toolResponse([{ ...activity, description: '活动交流群：星河科技宣讲交流群。', evidence: original.text }]);
    },
  });
  assert.equal(result.activities.length, 1);
  assert.equal(result.activities[0].startDate, '2026-09-24');
  assert.equal(result.activities[0].endDate, null);
  assert.equal(result.activities[0].deadline, null);
  assert.equal(result.activities[0].registrationUrl, null);
  assert.match(result.activities[0].description, /活动交流群/);
  assert.equal(result.information, null);
  assert.deepEqual(result.reviewReasons, []);
  assert.equal(result.relatedMessages![0].messageKey, original.key);
});

test('verified quoted messages keep their own dates, read original attachments and preserve source provenance', async () => {
  const original = normalizeMessage({ ...sample(1, ''), time: Date.parse('2026-09-20T09:00:00+08:00') / 1000, message: [
    { type: 'text', data: { text: '星河科技宣讲会，明天14:30，地点稍后补充。' } },
    { type: 'file', data: { name: '岗位说明.txt', file_id: 'quoted-file' } },
  ] }, 'a');
  const current = job('补充地点：活动中心201');
  current.message = normalizeMessage(sample(2, '补充地点：活动中心201'), 'a');
  current.message.segments.unshift({ type: 'reply', data: { id: original.externalId } });
  current.message.time = Date.parse('2026-09-21T10:00:00+08:00') / 1000;
  current.referenceGraph = { references: [{ message: original, hash: 'quoted-hash', relation: 'quoted' }], missing: [], warnings: [], hash: 'graph' };
  let attachmentReads = 0;
  let sent: any;
  const result = await extractActivities(current, settings, {
    signal: signal(),
    resolveReferencedAttachment: async (key, index) => {
      assert.equal(key, original.key); assert.equal(index, 1); attachmentReads++;
      return { bytes: Buffer.from('研发岗位与投递入口 https://jobs.example.com/#/position/campus/') };
    },
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      sent = body;
      return toolResponse([{ ...activity, startDate: '2026-09-21', registrationUrl: 'https://jobs.example.com/#/position/campus/' }]);
    },
  });
  const user = sent.messages.find((message: any) => message.role === 'user').content;
  const input = JSON.parse(typeof user === 'string' ? user : user.filter((part: any) => part.type === 'text').map((part: any) => part.text).join(''));
  assert.equal(input.referencedMessages[0].messageTime, '2026-09-20 09:00:00');
  assert.equal(input.currentMessageTime, '2026-09-21 10:00:00');
  assert.match(input.linkedContent, /研发岗位/);
  assert.match(JSON.stringify(sent.messages), /EACH message against that message's own messageTime/);
  assert.equal(attachmentReads, 1);
  assert.equal(result.relatedMessages![0].messageKey, original.key);
  assert.equal(result.activities[0].startDate, '2026-09-21');
  assert.equal(result.activities[0].registrationUrl, 'https://jobs.example.com/#/position/campus/');
});

test('missing references cannot silently complete, and a model failure preserves a fetched article title', async () => {
  const current = job('补充地点：活动中心201');
  current.message.segments.unshift({ type: 'reply', data: { id: '1' } });
  current.referenceGraph = { references: [], missing: [{ fromKey: current.message.key, id: '1' }], warnings: [], hash: 'missing' };
  const result = await extractActivities(current, settings, { signal: signal(), fetch: async () => toolResponse([]) });
  assert.match(result.reviewReasons!.join(' '), /引用/);
  await assert.rejects(extractActivities(job('https://example.com/titled'), settings, {
    signal: signal(), download: async url => ({ url, contentType: 'text/html', bytes: Buffer.from('<h1 id="activity-name">星河研究院招聘公告</h1><article>本次招聘包含多种岗位及培养方案，欢迎同学了解投递条件和专业要求。</article>') }),
    fetch: async () => new Response(JSON.stringify({ error: { message: 'model unavailable' } }), { status: 401, headers: { 'content-type': 'application/json' } }),
  }), error => {
    assert.ok(error instanceof ExtractionFailure);
    assert.equal(error.materials[0].title, '星河研究院招聘公告');
    return true;
  });
});

test('an incomplete message candidate falls back to sources and keeps unresolved facts actionable', async () => {
  let calls = 0, downloads = 0;
  const current = job('星河科技校园宣讲会9月24日14:30，欢迎毕业生携带简历参加，现场进行岗位介绍与交流，欢迎关注企业发展机会 https://example.com/info');
  const result = await extractActivities(current, settings, {
    signal: signal(), download: async () => { downloads++; throw new Error('unavailable'); },
    fetch: async () => { calls++; return toolResponse([{ ...activity, location: '', evidence: '星河科技校园宣讲会9月24日14:30' }]); },
  });
  assert.equal(calls, 2);
  assert.equal(downloads, 1);
  assert.ok(result.reviewReasons!.length);
});

test('complete webpage text skips poster downloads after one grounded extraction', async () => {
  const downloads: string[] = [];
  let calls = 0;
  const result = await extractActivities(job('https://example.com/complete'), settings, {
    signal: signal(), download: async url => {
      downloads.push(url);
      return { url, contentType: 'text/html', bytes: Buffer.from('<article>星河科技2027届校园招聘宣讲会，9月24日14:30，活动中心201。欢迎毕业生携带简历参加，现场提供岗位交流与答疑，本场活动面向全体应届毕业生。<img src="/poster.png"></article>') };
    },
    fetch: async () => { calls++; return toolResponse([{ ...activity, evidence: '9月24日14:30，活动中心201' }]); },
  });
  assert.deepEqual(downloads, ['https://example.com/complete']);
  assert.equal(calls, 1);
  assert.deepEqual(result.reviewReasons, []);
  assert.match(result.warnings.join(' '), /补充图片未展开/);
});

test('many-image pages pass only PDF page images and combined source text through pi', async () => {
  const current = job('https://example.com/pdf-article');
  current.message.accountId = 'pdf-agent';
  let pdfReads = 0, visualCalls = 0;
  const result = await extractActivities(current, settings, {
    signal: signal(),
    download: async url => {
      assert.equal(url, 'https://example.com/pdf-article');
      return { url, contentType: 'text/html', bytes: Buffer.from(`<article>星河科技招聘详情，见下列海报。${Array.from({ length: 12 }, (_, i) => `<img src="/${i}.gif">`).join('')}</article>`) };
    },
    readWebpagePdf: async input => {
      pdfReads++; assert.equal(input.imageUrls.length, 12);
      return { text: 'PDF 第1页：星河科技招聘', images: [png], links: [], warnings: [], snapshotId: 'a'.repeat(64) };
    },
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.tools[0].function.name === 'submit_visual_text') {
        visualCalls++;
        const images = body.messages.find((message: any) => message.role === 'user').content.filter((part: any) => part.type === 'image_url');
        assert.equal(images.length, 1);
        return response('submit_visual_text', { text: activity.evidence, unreadable: false });
      }
      assert.match(JSON.stringify(body.messages), /网页 PDF/);
      return toolResponse([activity]);
    },
  });
  assert.equal(pdfReads, 1);
  assert.equal(visualCalls, 1);
  assert.equal(result.activities.length, 1);
  assert.equal(result.materials[0].snapshotId, 'a'.repeat(64));
  assert.deepEqual(result.reviewReasons, []);
});

test('42-page recruiting PDFs reach final pi extraction with tail application facts, not just the corporate introduction', async () => {
  const current = job('https://example.com/long-pdf');
  current.message.accountId = 'long-pdf-agent';
  const jpeg = await sharp(png).resize(600, 300).jpeg().toBuffer();
  const pdf = pdfFixture({ jpeg, pages: 42 });
  const seen: number[] = [];
  let visualCalls = 0, finalCalls = 0;
  const result = await extractActivities(current, settings, {
    signal: signal(),
    download: async url => ({ url, contentType: 'text/html', bytes: Buffer.from(`<article>合成校招公告${Array.from({ length: 8 }, (_, i) => `<img src="/${i}.gif">`).join('')}</article>`) }),
    readWebpagePdf: async (_input, parentSignal, consumePages) => {
      assert.ok(consumePages);
      const output = await readPdfMaterial(pdf, parentSignal, 'webpage', async (batch, total) => {
        seen.push(...batch.map(page => page.pageNumber));
        await consumePages(batch, total);
      });
      return { ...output, snapshotId: 'b'.repeat(64), notices: ['网页 PDF 动图按末帧静态呈现，非逐帧读取；可打开原网页查看动画。'] };
    },
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.tools[0].function.name === 'submit_visual_text') {
        visualCalls++;
        const input = JSON.stringify(body.messages.find((message: any) => message.role === 'user').content);
        const pages = [...input.matchAll(/第 (\d+) 页/g)].map(match => Number(match[1]));
        const text = pages.some(page => page >= 40) ? '网申方式：中国建筑招聘平台。招聘流程：简历投递、筛选、测评、面试、发放offer。'
          : pages.some(page => page >= 36) ? '招聘对象：2027届高校毕业生。招聘专业和工作地点见本页。'
          : '企业介绍与人才培养计划。';
        return response('submit_visual_text', { text, unreadable: false });
      }
      finalCalls++;
      assert.equal(seen.length, 42);
      const input = JSON.stringify(body.messages.find((message: any) => message.role === 'user').content);
      assert.match(input, /网申方式：中国建筑招聘平台/);
      assert.match(input, /招聘对象：2027届高校毕业生/);
      return response('submit_activities', { activities: [], information: { title: '合成企业校园招聘', summary: '面向2027届毕业生，通过中国建筑招聘平台网申。' } });
    },
  });
  assert.equal(finalCalls, 1);
  assert.equal(visualCalls, 11);
  assert.deepEqual(seen, Array.from({ length: 42 }, (_, index) => index + 1));
  assert.match(result.information!.summary, /网申/);
  assert.deepEqual(result.reviewReasons, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.materials[0].pdfCoverage, { totalPages: 42, processedPages: 42 });
});

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

test('a partially read image cannot clear its own missing coverage merely by yielding one complete event', async () => {
  const current = job('https://example.com/partial-source.png');
  current.message.accountId = 'independent-evidence';
  const result = await extractActivities(current, settings, {
    signal: signal(), download: async url => ({ url, contentType: 'image/png', bytes: png }),
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      return body.tools[0].function.name === 'submit_visual_text'
        ? response('submit_visual_text', { text: '校园宣讲会9月24日14:30，活动中心201。', unreadable: true, unreadableImageIndices: [1] })
        : toolResponse([{ ...activity, evidence: '校园宣讲会9月24日14:30，活动中心201。' }]);
    },
  });
  assert.equal(result.activities.length, 1);
  assert.match(result.reviewReasons!.join(' '), /海报/);
});

test('exception policy is injected with message-relative dates, booth events, campaign exclusion and unrelated footer safeguards', async () => {
  const current = job('星河科技参加9.20双选会，今天14:00，活动馆，展位68。详情 https://example.com/campus');
  current.message.time = Date.parse('2026-09-20T09:00:00+08:00') / 1000;
  const fair = { ...activity, title: '星河科技双选会', type: '双选会', startDate: '2026-09-20', startTime: '14:00',
    location: '活动馆', description: '展位68', evidence: current.message.text };
  const result = await extractActivities(current, settings, {
    signal: signal(), download: async url => ({ url, contentType: 'text/html', bytes: Buffer.from('<html><body><div id="app"></div></body></html>') }),
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const system = body.messages.find((message: any) => message.role === 'system').content;
      assert.match(system, /coverage warning/);
      assert.match(system, /referral codes/);
      assert.match(system, /Graduation cohort/);
      assert.match(system, /historical article lists/);
      assert.match(system, /explicitly stated application\/recruitment window/);
      assert.match(system, /remain session activities even when they span multiple days/);
      const user = body.messages.find((message: any) => message.role === 'user');
      assert.match(JSON.stringify(user), /2026-09-20 09:00:00/);
      return toolResponse([fair]);
    },
  });
  assert.equal(result.activities[0].startDate, '2026-09-20');
  assert.equal(result.activities[0].startTime, '14:00');
  assert.match(result.warnings.join(' '), /原消息确认日程/);
  assert.deepEqual(result.reviewReasons, []);
});

test('an ordinary job campaign can submit zero activities while an unreadable portal remains a coverage warning', async () => {
  const result = await extractActivities(job('某银行2027届校园招聘，职位专场，内推码123456，岗位投递 https://example.com/#/position/campus/'), settings, {
    signal: signal(), download: async url => ({ url, contentType: 'text/html', bytes: Buffer.from('<html><body></body></html>') }),
    fetch: async () => toolResponse([]),
  });
  assert.deepEqual(result.activities, []);
  assert.equal(result.materials[0].url, 'https://example.com/#/position/campus/');
  assert.ok(result.warnings.length);
});

test('registration validation preserves evidenced hash routes and rejects invented routes on the same site', async () => {
  for (const route of ['campus', 'invented']) {
    const result = await extractActivities(job('宣讲会报名 https://example.com/#/position/campus/'), settings, {
      signal: signal(), download: async url => ({ url, contentType: 'text/html', bytes: Buffer.from('<html><body>校园宣讲会报名入口，欢迎毕业生携带简历前往现场参加交流。</body></html>') }),
      fetch: async () => toolResponse([{ ...activity, registrationUrl: `https://example.com/#/position/${route}/` }]),
    });
    assert.equal(result.activities[0].registrationUrl, route === 'campus' ? 'https://example.com/#/position/campus/' : null);
  }
});

test('missing visual submission gets one controlled reread instead of accepting prose', async () => {
  const current = job('https://example.com/reread.png');
  current.message.accountId = 'visual-protocol-retry';
  let calls = 0;
  const result = await extractActivities(current, settings, {
    signal: signal(), download: async url => ({ url, contentType: 'image/png', bytes: png }),
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.tools[0].function.name === 'submit_visual_text') {
        calls++;
        if (calls === 1) return proseResponse();
        assert.match(JSON.stringify(body.messages), /Controlled reread/);
        return response('submit_visual_text', { text: activity.evidence, unreadable: false });
      }
      assert.match(JSON.stringify(body.messages), /9 月 24 日/);
      return toolResponse([activity]);
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.activities.length, 1);
});

test('persistent visual protocol failures preserve readable message events and cannot silently succeed with zero activities', async () => {
  for (const activities of [[activity], []]) {
    const current = job(`${activities.length ? activity.evidence : '[图片]'} https://example.com/no-tool.png`);
    current.message.accountId = `no-visual-tool-${activities.length}`;
    let calls = 0;
    const result = await extractActivities(current, settings, {
      signal: signal(), download: async url => ({ url, contentType: 'image/png', bytes: png }),
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.tools[0].function.name === 'submit_visual_text') { calls++; return proseResponse(); }
        assert.match(JSON.stringify(body.messages), /补读后仍未返回/);
        assert.ok(!JSON.stringify(body.messages).includes('No structured submission.'));
        return toolResponse(activities);
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.activities.length, activities.length);
    assert.match(result.warnings.join(' '), /需核对原图/);
  }
});

test('unreadable six-image batches are reread in pairs, then later batches still reach extraction', async () => {
  const long = await sharp({ create: { width: 120, height: 16000, channels: 3, background: '#425165' } }).png().toBuffer();
  const current = job('https://example.com/partial-ocr.png');
  current.message.accountId = 'partial-ocr-reread';
  const sizes: number[] = [];
  const result = await extractActivities(current, settings, {
    signal: signal(), download: async url => ({ url, contentType: 'image/png', bytes: long }),
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.tools[0].function.name === 'submit_visual_text') {
        const user = body.messages.find((message: any) => message.role === 'user');
        sizes.push(user.content.filter((part: any) => part.type === 'image_url').length);
        // Keep retries uncached so the test exercises each recovery branch.
        return response('submit_visual_text', { text: sizes.length === 1 ? '首次可辨认：校园宣讲会' : activity.evidence, unreadable: true });
      }
      assert.match(JSON.stringify(body.messages), /首次可辨认/);
      return toolResponse([activity]);
    },
  });
  assert.deepEqual(sizes, [6, 2, 2, 2, 2, 2]);
  assert.equal(result.activities.length, 1);
  assert.ok(result.warnings.some(warning => warning.includes('分片 7')));
});

test('successful visual rereads clear only recovered warnings and cancellation stops a reread before extraction', async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const current = job('https://example.com/recover.png');
    current.message.accountId = `visual-recovered-${cancelled}`;
    let calls = 0;
    const pending = extractActivities(current, settings, {
      signal: controller.signal, download: async url => ({ url, contentType: 'image/png', bytes: png }),
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.tools[0].function.name === 'submit_visual_text') {
          calls++;
          if (calls === 2 && cancelled) controller.abort(new Error('cancel reread'));
          return response('submit_visual_text', { text: activity.evidence, unreadable: calls === 1 });
        }
        assert.equal(cancelled, false);
        return toolResponse([activity]);
      },
    });
    if (cancelled) await assert.rejects(pending, /cancel reread/);
    else assert.deepEqual((await pending).warnings, []);
    assert.equal(calls, 2);
  }
});

test('successful visual text is reused only within the same account and model configuration', async () => {
  let visionCalls = 0;
  for (const [account, temperature] of [['visual-cache-a', 0.4], ['visual-cache-a', 0.4], ['visual-cache-b', 0.4], ['visual-cache-b', 0.5]] as const) {
    const current = job('https://example.com/cached.png');
    current.message.accountId = account;
    await extractActivities(current, { ...settings, config: { ...settings.config, temperature } }, {
      signal: signal(), download: async url => ({ url, contentType: 'image/png', bytes: png }),
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.tools[0].function.name === 'submit_visual_text') {
          visionCalls++;
          return response('submit_visual_text', { text: activity.evidence, unreadable: false });
        }
        return toolResponse([activity]);
      },
    });
  }
  assert.equal(visionCalls, 3);
});
