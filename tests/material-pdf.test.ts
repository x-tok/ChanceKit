import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { pdfFixture } from './pdf-fixtures';
import { readDocumentMaterial } from '../electron/core/material-document';
import { collectMessageMaterials } from '../electron/core/message-materials';
import { normalizeMessage } from '../electron/core/store';
import { sample } from './fixtures';
import { readPdfMaterial } from '../electron/core/material-pdf';

const signal = () => new AbortController().signal;
test('PDF text and exact annotations are read without OCR or fetching annotation targets', async () => {
  const url = 'https://example.com/#/position/campus/';
  const result = await readDocumentMaterial(pdfFixture({ link: url }), 'notice.pdf', signal());
  assert.match(result.text, /2026-09-24 14:30 Hall 201/);
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.links, [url]);
  assert.deepEqual(result.warnings, []);
});

test('scanned PDF pages become valid bounded images and QQ PDF attachments reach the collector', async () => {
  const jpeg = await sharp(Buffer.from('<svg width="600" height="300"><rect width="600" height="300" fill="white"/><text x="20" y="80" font-size="28">Recruitment fair</text><text x="20" y="130" font-size="24">2026-09-24 14:30 Hall 201</text></svg>')).jpeg().toBuffer();
  const bytes = pdfFixture({ jpeg });
  const document = await readDocumentMaterial(bytes, 'scan.pdf', signal());
  assert.equal(document.images.length, 1);
  const meta = await sharp(document.images[0]).metadata();
  assert.ok(meta.width! <= 1600 && meta.height! <= 2200);
  assert.ok((await sharp(document.images[0]).stats()).channels.some(channel => channel.stdev > 10));
  assert.deepEqual(document.warnings, []);
  const message = normalizeMessage({ ...sample(1, ''), message: [{ type: 'file', data: { file: 'notice.pdf', file_id: 'test-pdf' } }] }, 'test');
  const material = await collectMessageMaterials(message, signal(), true, undefined, async () => ({ bytes }));
  assert.equal(material.imageGroups.length, 1);
  assert.equal(material.materials[0].kind, 'file');
  assert.deepEqual(material.warnings, []);
});

test('PDF page limits, invalid contents and cancellation remain explicit', async () => {
  const result = await readDocumentMaterial(pdfFixture({ pages: 22 }), 'long.pdf', signal());
  assert.match(result.warnings.join(' '), /前 20 页/);
  assert.match(result.text, /第 20 页/);
  assert.ok(!result.text.includes('第 21 页'));
  await assert.rejects(readDocumentMaterial(Buffer.from('%PDF-broken'), 'broken.pdf', signal()), /PDF/);
  await assert.rejects(readDocumentMaterial(Buffer.alloc(6 * 1024 * 1024), 'large.pdf', signal()), /5 MB/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readDocumentMaterial(pdfFixture(), 'cancel.pdf', controller.signal), /取消/);
});

test('42-page image PDFs stream every page including the tail, in bounded awaited batches', async () => {
  const jpeg = await sharp({ create: { width: 600, height: 300, channels: 3, background: '#abcdef' } }).jpeg().toBuffer();
  const seen: number[] = [], sizes: number[] = [];
  let running = false;
  const result = await readPdfMaterial(pdfFixture({ pages: 42, jpeg }), signal(), 'webpage', async (batch, total) => {
    assert.equal(total, 42);
    assert.equal(running, false);
    running = true;
    sizes.push(batch.length);
    seen.push(...batch.map(page => page.pageNumber));
    assert.ok(batch.every(page => page.bytes.length > 0));
    await new Promise(resolve => setTimeout(resolve, 1));
    running = false;
  });
  assert.deepEqual(seen, Array.from({ length: 42 }, (_, index) => index + 1));
  assert.ok(Math.max(...sizes) <= 4);
  assert.equal(sizes.length, 11);
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.coverage, { totalPages: 42, processedPages: 42 });
});

test('PDF streaming cancellation and consumer failures stop later batches without false completion', async () => {
  const jpeg = await sharp({ create: { width: 600, height: 300, channels: 3, background: '#ddd' } }).jpeg().toBuffer();
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    let batches = 0;
    await assert.rejects(readPdfMaterial(pdfFixture({ pages: 42, jpeg }), controller.signal, 'webpage', async () => {
      batches++;
      if (cancelled) controller.abort(new Error('cancelled'));
      else throw new Error('model unavailable');
    }));
    assert.equal(batches, 1);
  }
});
