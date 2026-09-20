import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import JSZip from 'jszip';
import QRCode from 'qrcode';
import { Response as HttpResponse, type fetch as httpFetch } from 'undici';
import { collectMessageMaterials, downloadPublicMaterial, parseMaterialPage, type MaterialDownload } from '../electron/core/message-materials';
import { normalizeMaterialImage } from '../electron/core/material-image';
import { readDocumentMaterial } from '../electron/core/material-document';
import { linksInSourceText } from '../electron/core/material-links';
import { normalizeMessage } from '../electron/core/store';
import { sample } from './fixtures';

const signal = () => new AbortController().signal;
const png = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#ffffff' } }).png().toBuffer();
const message = (segments: { type: string; data: Record<string, unknown> }[]) => normalizeMessage({ ...sample(1, ''), message: segments }, 'a');
const textMessage = (text: string) => message([{ type: 'text', data: { text } }]);

test('public downloads use browser-compatible headers, follow longer share redirects without cookies and still block private redirects', async () => {
  let calls = 0;
  const request: typeof httpFetch = async (_input, init) => {
    calls++;
    const headers = init!.headers as Record<string, string>;
    assert.match(headers['user-agent'], /Mozilla\/5/);
    assert.equal(headers.cookie, undefined);
    assert.equal(headers.authorization, undefined);
    assert.equal(init!.redirect, 'manual');
    return calls <= 5 ? new HttpResponse(null, { status: 302, headers: { location: `https://example.com/redirect${calls}` } })
      : new HttpResponse('public form body', { headers: { 'content-type': 'text/html' } });
  };
  assert.equal((await downloadPublicMaterial('https://example.com/share', signal(), request)).bytes.length, 16);
  assert.equal(calls, 6);
  await assert.rejects(downloadPublicMaterial('https://example.com/share', signal(), async () =>
    new HttpResponse(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })), /公开网页/);
  calls = 0;
  await assert.rejects(downloadPublicMaterial('https://example.com/share', signal(), async () => {
    calls++;
    return new HttpResponse(null, { status: 302, headers: { location: '/loop' } });
  }), /跳转次数/);
  assert.equal(calls, 9);
  await assert.rejects(downloadPublicMaterial('https://example.com/large', signal(), async () =>
    new HttpResponse('a', { headers: { 'content-length': String(6 * 1024 * 1024) } })), /5 MB/);
  assert.ok((await downloadPublicMaterial('https://example.com/poster', signal(), async () =>
    new HttpResponse(Buffer.alloc(6 * 1024 * 1024), { headers: { 'content-type': 'image/jpeg' } }))).bytes.length > 5 * 1024 * 1024);
  await assert.rejects(downloadPublicMaterial('https://example.com/oversize-poster', signal(), async () =>
    new HttpResponse('a', { headers: { 'content-type': 'image/jpeg', 'content-length': String(21 * 1024 * 1024) } })), /20 MB/);
});

test('WeChat extracts its visible title and body without treating article mentions of verification as a login wall', async () => {
  const html = '<html><head><title></title></head><body><h1 id="activity-name">双选会通知</h1><div id="js_content"><p>9月20日14:00-17:00，九龙湖校区焦廷标馆二楼。报名页面可能要求安全验证。</p><img data-src="https://example.com/poster.png"></div></body></html>';
  const page = parseMaterialPage(html, 'https://mp.weixin.qq.com/s/article');
  assert.equal(page.title, '双选会通知');
  assert.equal(page.restricted, false);
  const result = await collectMessageMaterials(textMessage('https://mp.weixin.qq.com/s/article'), signal(), true,
    async url => ({ url, contentType: url.endsWith('.png') ? 'image/png' : 'text/html', bytes: url.endsWith('.png') ? png : Buffer.from(html) }));
  assert.deepEqual(result.warnings, []);
  assert.equal(result.images.length, 1);
});

test('real challenge pages are not passed to LLM as if they were article content', async () => {
  const result = await collectMessageMaterials(textMessage('https://mp.weixin.qq.com/s/article'), signal(), true, async () => ({
    url: 'https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?action=appmsg', contentType: 'text/html',
    bytes: Buffer.from('<html><body>当前环境异常，完成验证后即可继续访问。</body></html>'),
  }));
  assert.equal(result.text, '');
  assert.equal(result.materials.length, 0);
  assert.match(result.warnings[0], /验证或登录页面/);
});

test('Feishu public form literal data exposes visible field options, not internal state or redirect auth tokens', async () => {
  const snapshot = {
    name: '校园宣讲会报名', description: { content: [{ text: '欢迎参加校园宣讲会' }] },
    fieldMap: {
      session: { name: '宣讲场次', property: { options: [{ name: '东南大学-9月14日18:00-五四楼103' }] } },
      hidden: { name: '内部状态' },
    },
    viewProperty: { fields: ['hidden', 'session'], fieldInfos: { hidden: { visible: false } } },
    recordEntity: { privateAnswer: 'NEVER_INCLUDE' },
  };
  const html = `<html><body><div id="app"></div><script>window.formMetaContent = Object(${JSON.stringify({ Snapshot: JSON.stringify(snapshot), token: 'NEVER_INCLUDE' })}); throw new Error('DO_NOT_EXECUTE');</script></body></html>`;
  const publicUrl = 'https://example.feishu.cn/share/base/form/public';
  const result = await collectMessageMaterials(textMessage(publicUrl), signal(), true, async () => ({
    url: `${publicUrl}?auth_token=NEVER_INCLUDE`, contentType: 'text/html', bytes: Buffer.from(html),
  }));
  assert.match(result.text, /东南大学-9月14日18:00-五四楼103/);
  assert.ok(!result.text.includes('内部状态') && !result.text.includes('NEVER_INCLUDE'));
  assert.equal(result.materials[0].url, publicUrl);
  assert.deepEqual([...result.allowedLinks], [publicUrl]);
  assert.deepEqual(result.warnings, []);
  const malicious = parseMaterialPage('<html><body><script>window.formMetaContent=Object({Snapshot:(()=>{throw new Error("NO")})()});</script></body></html>', publicUrl);
  assert.equal(malicious.text, '');
});

test('images are fully decoded, normalized and long posters split without sending invalid original bytes', async () => {
  const gif = await sharp(png).gif().toBuffer();
  for (const bytes of [gif, png]) {
    const normalized = await normalizeMaterialImage(bytes, 6);
    assert.equal(normalized.images[0].mimeType, 'image/jpeg');
    assert.equal((await sharp(Buffer.from(normalized.images[0].data, 'base64')).metadata()).format, 'jpeg');
  }
  const long = await sharp({ create: { width: 200, height: 5000, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const normalized = await normalizeMaterialImage(long, 6);
  assert.equal(normalized.images.length, 3);
  assert.equal(normalized.truncated, false);
  assert.equal((await normalizeMaterialImage(long, 2)).truncated, true);
  await assert.rejects(normalizeMaterialImage(png.subarray(0, 32), 6));
  const result = await collectMessageMaterials(message([{ type: 'image', data: { url: 'https://example.com/invalid.png' } }]), signal(), true,
    async url => ({ url, contentType: 'image/png', bytes: png.subarray(0, 32) }));
  assert.equal(result.images.length, 0);
  assert.ok(result.warnings.length);
});

test('expired QQ images can refresh through the scoped attachment resolver; refreshed private URLs remain blocked', async () => {
  const raw = message([{ type: 'image', data: { url: 'https://example.com/expired.png', file: 'opaque-id' } }]);
  const calls: string[] = [];
  const download: MaterialDownload = async url => {
    calls.push(url);
    if (url.endsWith('expired.png')) throw new Error('expired');
    return { url, contentType: 'image/png', bytes: png };
  };
  const result = await collectMessageMaterials(raw, signal(), true, download, async index => {
    assert.equal(index, 0); return 'https://example.com/refreshed.png';
  });
  assert.equal(result.images.length, 1);
  assert.deepEqual(result.warnings, []);
  assert.equal(calls.length, 2);
  calls.length = 0;
  const blocked = await collectMessageMaterials(raw, signal(), true, download, async () => 'http://127.0.0.1/image');
  assert.equal(blocked.images.length, 0);
  assert.equal(calls.length, 1);
});

async function docx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>2027校园招聘简章：9月24日14:30 活动中心201</w:t></w:r></w:p><w:p><w:hyperlink r:id="link1"><w:r><w:t>报名</w:t></w:r></w:hyperlink></w:p><w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="poster"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="image1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>');
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/poster.png"/><Relationship Id="link1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/apply" TargetMode="External"/></Relationships>');
  zip.file('word/media/poster.png', png);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('DOCX content, embedded images and registration links reach the agent material collector through an attachment ID', async () => {
  const bytes = await docx();
  const raw = message([{ type: 'file', data: { file: '2027校园招聘简章(1).docx', file_id: 'opaque-id' } }]);
  const result = await collectMessageMaterials(raw, signal(), true, async url => ({ url, contentType: 'application/octet-stream', bytes }),
    async index => { assert.equal(index, 0); return 'https://example.com/file-download'; });
  assert.match(result.text, /9月24日14:30 活动中心201/);
  assert.equal(result.materials[0].kind, 'file');
  assert.equal(result.images.length, 1);
  assert.ok(result.allowedLinks.has('https://example.com/apply'));
  assert.match(result.text, /https:\/\/example.com\/apply/);
  assert.deepEqual(result.warnings, []);
});

test('documents enforce size, format, cancellation and decompression limits without opening local paths', async () => {
  const parsed = await readDocumentMaterial(Buffer.from('宣讲会：9月24日'), 'notice.txt', signal());
  assert.match(parsed.text, /宣讲会/);
  await assert.rejects(readDocumentMaterial(Buffer.from('x'), '/etc/passwd', signal()), /文件格式/);
  await assert.rejects(readDocumentMaterial(Buffer.from('broken'), 'notice.docx', signal()), /DOCX/);
  const zip = new JSZip();
  zip.file('word/document.xml', Buffer.alloc(21 * 1024 * 1024));
  await assert.rejects(readDocumentMaterial(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), 'oversize.docx', signal()), /上限/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readDocumentMaterial(await docx(), 'notice.docx', controller.signal), /取消/);
  let resolved = false;
  const result = await collectMessageMaterials(message([{ type: 'file', data: { file: '/etc/passwd', file_id: 'opaque-id' } }]), signal(), true, undefined,
    async () => { resolved = true; return 'https://example.com/private'; });
  assert.equal(resolved, false);
  assert.ok(result.warnings.some(warning => warning.includes('格式暂不支持')));
});

test('animation contact sheets contain later frames without a blanket first-frame warning', async () => {
  const frames = [Buffer.alloc(60 * 40 * 3), Buffer.alloc(60 * 40 * 3), Buffer.alloc(60 * 40 * 3)];
  for (let i = 0; i < 60 * 40; i++) {
    frames[0][i * 3] = 255;
    frames[1][i * 3 + 1] = 255;
    frames[2][i * 3 + 2] = 255;
  }
  const gif = await sharp(Buffer.concat(frames), { raw: { width: 60, height: 120, pageHeight: 40, channels: 3 } }).gif({ delay: [100, 100, 100] }).toBuffer();
  const normalized = await normalizeMaterialImage(gif, 128);
  assert.equal(normalized.animated, true);
  assert.equal(normalized.truncated, false);
  const { data, info } = await sharp(Buffer.from(normalized.images[0].data, 'base64')).raw().toBuffer({ resolveWithObject: true });
  for (let frame = 0; frame < 3; frame++) {
    const offset = (10 * info.width + frame * 68 + 10) * info.channels;
    assert.ok(data[offset + frame] > 200, `frame ${frame} is visible in the contact sheet`);
  }
  const result = await collectMessageMaterials(textMessage('https://example.com/animation.gif'), signal(), true,
    async url => ({ url, contentType: 'image/gif', bytes: gif }));
  assert.deepEqual(result.warnings, []);
});

test('QR registration URLs and plain text URLs become evidence without permitting invented links', async () => {
  const url = 'https://campus.example.cn/apply?session=2027';
  const qr = await QRCode.toBuffer(url, { width: 480, margin: 4 });
  const result = await collectMessageMaterials(textMessage('https://example.com/qr.png'), signal(), true,
    async address => ({ url: address, contentType: 'image/png', bytes: qr }));
  assert.ok(result.allowedLinks.has(url));
  assert.match(result.text, /campus\.example\.cn/);
  const page = await collectMessageMaterials(textMessage('https://example.com/article'), signal(), false, async address => ({
    url: address, contentType: 'text/html', bytes: Buffer.from('<html><body><article>9月24日宣讲会报名地址：https://campus.example.cn/apply 。欢迎各位毕业生参加。</article></body></html>'),
  }));
  assert.ok(page.allowedLinks.has('https://campus.example.cn/apply'));
  assert.deepEqual(linksInSourceText('请访问 www.example.cn/jobs 或 campus.example.cn/apply。'), ['https://www.example.cn/jobs', 'https://campus.example.cn/apply']);
});

test('documents can be read from scoped QQ attachment bytes without a public download URL', async () => {
  const bytes = await docx();
  let downloads = 0;
  const result = await collectMessageMaterials(message([{ type: 'file', data: { file: 'notice.docx', file_id: '/12345678-abcd-1234-abcd-123456789012' } }]),
    signal(), true, async () => { downloads++; throw new Error('must not download'); }, async () => ({ bytes }));
  assert.equal(downloads, 0);
  assert.match(result.text, /2027校园招聘简章/);
  assert.equal(result.materials[0].url, '');
  assert.deepEqual(result.warnings, []);
});

test('a transient challenge gets one controlled retry, while persistent challenges remain incomplete', async () => {
  let calls = 0;
  const result = await collectMessageMaterials(textMessage('https://mp.weixin.qq.com/s/retry'), signal(), false, async url => {
    calls++;
    return calls === 1 ? { url: 'https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha', contentType: 'text/html', bytes: Buffer.from('<html><body>完成验证后继续</body></html>') }
      : { url, contentType: 'text/html', bytes: Buffer.from('<html><body><article>9月24日14:30在活动中心201举办校园宣讲会，欢迎毕业生参加。</article></body></html>') };
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.warnings, []);
  assert.match(result.text, /活动中心201/);
});

test('hash-based source routes survive extraction but are stripped only for HTTP downloads', async () => {
  const url = 'https://example.com/#/position/campus/';
  assert.deepEqual(linksInSourceText(`投递 ${url}`), [url]);
  const page = parseMaterialPage('<html><body><article><a href="#/position/campus/">投递</a></article></body></html>', 'https://example.com/');
  assert.deepEqual(page.links, [url]);
  await downloadPublicMaterial(url, signal(), async input => {
    assert.equal(String(input), 'https://example.com/');
    return new HttpResponse('ok', { headers: { 'content-type': 'text/plain' } });
  });
});

test('source budgets cover more than 48 images and prevent early long posters from starving later sources', async () => {
  const long = await sharp({ create: { width: 120, height: 16000, channels: 3, background: '#778844' } }).png().toBuffer();
  const seen: string[] = [];
  const result = await collectMessageMaterials(textMessage('https://example.com/many'), signal(), true, async url => {
    seen.push(url);
    if (url.endsWith('/many')) return { url, contentType: 'text/html', bytes: Buffer.from(`<html><body><article>${Array.from({ length: 55 }, (_, index) => `<img src="/${index}.png">`).join('')}</article></body></html>`) };
    return { url, contentType: 'image/png', bytes: url.endsWith('/0.png') ? long : png };
  });
  assert.equal(result.imageGroups.length, 55);
  assert.ok(seen.includes('https://example.com/54.png'));
  assert.equal(result.imageGroups[0].images.length, 2);
  assert.ok(result.images.length <= 128);
  assert.match(result.warnings.join(' '), /来源图片 1.*抽读/);
});

test('bounded static posters and animations retain their last content and disclose sampling', async () => {
  const red = await sharp({ create: { width: 120, height: 5000, channels: 3, background: '#ff0000' } })
    .composite([{ input: await sharp({ create: { width: 120, height: 500, channels: 3, background: '#0000ff' } }).png().toBuffer(), top: 4500, left: 0 }]).png().toBuffer();
  const poster = await normalizeMaterialImage(red, 2);
  assert.equal(poster.truncated, true);
  const tail = await sharp(Buffer.from(poster.images[1].data, 'base64')).raw().toBuffer({ resolveWithObject: true });
  const lastPixel = tail.data.subarray(tail.data.length - tail.info.channels);
  assert.ok(lastPixel[2] > 200 && lastPixel[0] < 20);

  const frames = [0, 1, 2].map(channel => {
    const raw = Buffer.alloc(1080 * 1200 * 3);
    for (let index = channel; index < raw.length; index += 3) raw[index] = 255;
    return raw;
  });
  const gif = await sharp(Buffer.concat(frames), { raw: { width: 1080, height: 3600, pageHeight: 1200, channels: 3 } }).gif({ delay: [100, 100, 100] }).toBuffer();
  const animation = await normalizeMaterialImage(gif, 2);
  assert.equal(animation.truncated, true);
  assert.equal(animation.images.length, 2);
  const last = await sharp(Buffer.from(animation.images[1].data, 'base64')).raw().toBuffer({ resolveWithObject: true });
  const pixel = (10 * last.info.width + 10) * last.info.channels;
  assert.ok(last.data[pixel + 2] > 200 && last.data[pixel] < 20);
});
