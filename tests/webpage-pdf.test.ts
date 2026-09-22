import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { shouldUseWebpagePdf, WebpagePdfStore, type WebpagePdfRequest } from '../electron/core/materials/webpage-pdf';
import { collectMessageMaterials } from '../electron/core/materials/message-materials';
import { normalizeMessage, Store } from '../electron/core/archive/store';
import { ScheduleStore } from '../electron/core/processing/schedule-store';
import { sample } from './fixtures';
import { pdfFixture } from './pdf-fixtures';

const signal = () => new AbortController().signal;
const png = await sharp({ create: { width: 100, height: 60, channels: 3, background: '#e94558' } }).png().toBuffer();
const request = (extra: Partial<WebpagePdfRequest> = {}): WebpagePdfRequest => ({
  url: 'https://example.com/article', baseUrl: 'https://example.com/article', title: '合成网页',
  html: '<article><p>First</p><img data-src="/image.png"><p>Last</p></article>',
  imageUrls: ['https://example.com/image.png'], ...extra,
});

test('many-image or known animated pages use browser PDFs', () => {
  assert.equal(shouldUseWebpagePdf(Array(8).fill('https://example.com/image.png')), true);
  assert.equal(shouldUseWebpagePdf(['https://example.com/a?wx_fmt=gif']), true);
  assert.equal(shouldUseWebpagePdf(['https://example.com/a.GIF?x=1']), true);
  assert.equal(shouldUseWebpagePdf(['https://example.com/image.png']), false);
});

test('collector substitutes PDF page images for original image fanout, preserves snapshots, and never falls back on PDF failure', async () => {
  const html = `<article><p>合成招聘消息，职位和宣讲会详细信息位于下方海报中。</p>${Array.from({ length: 10 }, (_, i) => `<img src="/${i}.png">`).join('')}</article>`;
  const message = normalizeMessage(sample(1, 'https://example.com/article'), 'a');
  for (const failed of [false, true]) {
    const downloads: string[] = [];
    const result = await collectMessageMaterials(message, signal(), true, async url => {
      downloads.push(url); return { url, contentType: 'text/html', bytes: Buffer.from(html) };
    }, undefined, {
      readWebpagePdf: async input => {
        assert.equal(input.imageUrls.length, 10);
        if (failed) throw new Error('printer failed');
        return { text: 'PDF 第1页：合成信息', images: [png], links: ['https://example.com/#/apply'], warnings: [], snapshotId: 'a'.repeat(64) };
      },
    });
    assert.deepEqual(downloads, ['https://example.com/article']);
    assert.equal(result.images.length, failed ? 0 : 1);
    if (failed) assert.match(result.warnings.join(' '), /PDF.*未完成/);
    else {
      assert.equal(result.materials[0].snapshotId, 'a'.repeat(64));
      assert.match(result.imageGroups[0].label, /网页 PDF/);
      assert.ok(result.allowedLinks.has('https://example.com/#/apply'));
      assert.deepEqual(result.warnings, []);
    }
  }
  let printed = false;
  await collectMessageMaterials(message, signal(), true, async url => ({ url, contentType: 'text/html', bytes: Buffer.from(html) }), undefined, {
    onTextReady: async () => true,
    readWebpagePdf: async () => { printed = true; throw new Error(); },
  });
  assert.equal(printed, false);
});

test('PDF snapshots print the original URL on every retry and persist per account', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-pdf-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const store = new WebpagePdfStore(root, async url => {
    assert.equal(url, request().url);
    calls++;
    return { bytes: pdfFixture(), warnings: ['图片未加载'], notices: ['浏览器打印'] };
  });
  const first = await store.read('a', request(), signal());
  const second = await store.read('a', request(), signal());
  assert.equal(first.snapshotId, second.snapshotId);
  assert.equal(calls, 2);
  assert.deepEqual(first.warnings, ['图片未加载']);
  assert.deepEqual(first.notices, ['浏览器打印']);
  assert.match(await store.file('a', first.snapshotId), /\.pdf$/);
  await assert.rejects(store.file('b', first.snapshotId));
  await assert.rejects(store.file('a', '../x'));
  const file = await store.file('a', first.snapshotId);
  await rm(file);
  await writeFile(path.join(root, 'other.pdf'), pdfFixture());
  await symlink(path.join(root, 'other.pdf'), file);
  await assert.rejects(store.file('a', first.snapshotId), /不可读取/);
  assert.equal((await readdir(root)).length, 2);
});

test('queued PDF cancellation does not print or poison subsequent jobs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-pdf-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let release!: () => void, started!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const store = new WebpagePdfStore(root, async () => {
    calls++; started(); await gate; return { bytes: pdfFixture(), warnings: [], notices: [] };
  });
  const first = store.read('a', request(), signal());
  await ready;
  const controller = new AbortController();
  const second = store.read('a', request({ title: 'cancelled' }), controller.signal);
  controller.abort();
  const rejected = assert.rejects(second);
  release();
  await first; await rejected;
  assert.equal(calls, 1);
  await store.read('a', request(), signal());
  assert.equal(calls, 2);
});

test('opening saved PDFs requires the current account and a followed source with the exact snapshot', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-pdf-scope-'));
  const file = path.join(root, 'messages.sqlite'), messages = new Store(file);
  messages.saveGroups('a', [{ group_id: 731234567, group_name: '合成招聘群' }]); messages.follow('a', '731234567', true);
  const schedule = new ScheduleStore(file);
  t.after(async () => { schedule.close(); messages.close(); await rm(root, { recursive: true, force: true }); });
  const message = normalizeMessage(sample(1, 'https://example.com/article'), 'a');
  messages.put([message]); schedule.enqueue('a');
  schedule.complete(schedule.claim('a')!, {
    activities: [], information: { title: '合成招聘资讯', summary: '' }, warnings: [], reviewReasons: [],
    materials: [{ url: 'https://example.com/article', kind: 'page', snapshotId: 'a'.repeat(64) }],
  });
  assert.equal(schedule.hasSnapshot('a', message.key, 'a'.repeat(64)), true);
  assert.equal(schedule.hasSnapshot('a', message.key, 'b'.repeat(64)), false);
  assert.equal(schedule.hasSnapshot('b', message.key, 'a'.repeat(64)), false);
  messages.follow('a', '731234567', false);
  assert.equal(schedule.hasSnapshot('a', message.key, 'a'.repeat(64)), false);
});
