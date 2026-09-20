import yauzl from 'yauzl';
import mammoth from 'mammoth';
import type { Readable } from 'node:stream';
import { readMaterialPage } from './material-page';
import { readPdfMaterial } from './material-pdf';

export type ResolvedAttachment = string | { url?: string; bytes?: Uint8Array };
export type AttachmentResolver = (segmentIndex: number, signal: AbortSignal) => Promise<ResolvedAttachment>;
export interface AttachmentRequest { type: 'resolveAttachment'; accountId: string; messageKey: string; segmentIndex: number }

async function validateDocumentArchive(bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(new Error('DOCX 文件格式不正确。')); return; }
      let size = 0;
      let entries = 0;
      let settled = false;
      let current: Readable | undefined;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true; current?.destroy(); zip.close(); reject(error);
      };
      const abort = () => fail(new Error('文件读取已取消。'));
      signal.addEventListener('abort', abort, { once: true });
      zip.once('close', () => signal.removeEventListener('abort', abort));
      zip.once('error', fail);
      zip.once('end', () => { if (!settled) { settled = true; resolve(); } });
      zip.on('entry', (entry: yauzl.Entry) => {
        if (settled) return;
        if (++entries > 1000 || entry.uncompressedSize > 20 * 1024 * 1024) { fail(new Error('DOCX 解压内容超过上限。')); return; }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) { fail(new Error('DOCX 文件损坏。')); return; }
          if (settled) { stream.destroy(); return; }
          current = stream;
          stream.on('error', fail);
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 20 * 1024 * 1024) { stream.destroy(); fail(new Error('DOCX 解压内容超过上限。')); }
          });
          stream.once('end', () => { current = undefined; if (!settled) zip.readEntry(); });
        });
      });
      if (signal.aborted) abort(); else zip.readEntry();
    });
  });
}

export async function readDocumentMaterial(bytes: Uint8Array, name: string, signal: AbortSignal) {
  if (signal.aborted) throw new Error('文件读取已取消。');
  if (bytes.byteLength > 5 * 1024 * 1024) throw new Error('文件超过 5 MB 读取上限。');
  if (/\.pdf$/i.test(name)) return readPdfMaterial(bytes, signal);
  if (/\.(txt|md|csv)$/i.test(name)) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('文件不是可读取的文字。');
    return { text, images: [] as Uint8Array[], links: [] as string[], warnings: [] as string[] };
  }
  if (!/\.docx$/i.test(name)) throw new Error('暂不支持此文件格式，可读取 PDF、DOCX、TXT、MD 和 CSV。');
  await validateDocumentArchive(bytes, signal);
  signal.throwIfAborted();
  const images: Uint8Array[] = [];
  const warnings: string[] = [];
  const converted = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) }, {
    externalFileAccess: false, includeEmbeddedStyleMap: false,
    convertImage: mammoth.images.imgElement(async image => {
      if (images.length >= 48) warnings.push('文件图片超过 48 张，部分图片未读取。');
      else {
        try {
          const data = await image.readAsBuffer();
          if (data.length <= 5 * 1024 * 1024) images.push(data);
          else warnings.push('文件中部分图片超过 5 MB，未读取。');
        } catch { warnings.push('文件中部分图片无法读取。'); }
      }
      return { src: '' };
    }),
  });
  signal.throwIfAborted();
  if (converted.messages.some(message => message.type === 'error' || /external|image|drawing|chart|textbox/i.test(message.message))) {
    warnings.push('文件中部分图片或特殊内容无法读取，需核对原文件。');
  }
  const page = readMaterialPage(`<html><body><article>${converted.value}</article></body></html>`, 'https://document.invalid/');
  return { text: page.text, images, links: page.links, warnings };
}
