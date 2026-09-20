import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readdir, unlink, lstat, rename, utimes } from 'node:fs/promises';
import path from 'node:path';
import { readPdfMaterial, type PdfPageConsumer } from './material-pdf';

export interface WebpagePdfRequest {
  html: string; url: string; baseUrl: string; title: string; imageUrls: string[];
}
export interface WebpagePdfResult {
  text: string; images: Uint8Array[]; links: string[]; warnings: string[]; snapshotId: string;
  notices?: string[];
  coverage?: { totalPages: number; processedPages: number };
}
export interface PrintedWebpagePdf { bytes: Uint8Array; warnings: string[]; notices: string[] }
export type WebpagePdfReader = (input: WebpagePdfRequest, signal: AbortSignal, consumePages?: PdfPageConsumer) => Promise<WebpagePdfResult>;
export type PdfPrinter = (url: string, signal: AbortSignal) => Promise<PrintedWebpagePdf>;
export const shouldUseWebpagePdf = (images: string[]) => images.length >= 8
  || images.some(url => /\.gif(?:[?#]|$)|[?&](?:wx_fmt|format|fmt)=gif(?:&|$)/i.test(url));

export class WebpagePdfStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private root: string, private print: PdfPrinter) {}
  private directory(accountId: string) { return path.join(this.root, createHash('sha256').update(accountId).digest('hex')); }
  async file(accountId: string, id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('PDF 编号无效。');
    const file = path.join(this.directory(accountId), `${id}.pdf`);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('PDF 快照不可读取。');
    return file;
  }
  read(accountId: string, input: WebpagePdfRequest, parentSignal: AbortSignal, consumePages?: PdfPageConsumer): Promise<WebpagePdfResult> {
    const run = this.tail.catch(() => {}).then(async () => {
      parentSignal.throwIfAborted();
      const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(120_000)]);
      // Print the live original URL each time. HTML equality cannot prove CSS, scripts
      // and lazy-loaded content are unchanged, so old reconstructed PDFs are never reused.
      const printed = await this.print(input.url, signal);
      signal.throwIfAborted();
      const { bytes } = printed;
      if (bytes.length > 24 * 1024 * 1024) throw new Error('网页 PDF 超过 24 MB 保存上限。');
      const id = createHash('sha256').update('browser-print-v1').update(input.url).update(bytes).digest('hex');
      const directory = this.directory(accountId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, `${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
        signal.throwIfAborted();
        await rename(temporary, path.join(directory, `${id}.pdf`));
      } finally { await unlink(temporary).catch(() => {}); }
      const result = await readPdfMaterial(bytes, parentSignal, 'webpage', consumePages);
      const now = new Date();
      await utimes(path.join(directory, `${id}.pdf`), now, now);
      await this.prune(directory);
      return { ...result, notices: printed.notices, warnings: [...printed.warnings, ...result.warnings], snapshotId: id };
    });
    this.tail = run.then(() => {}, () => {});
    return run;
  }
  private async prune(directory: string) {
    const files = await Promise.all((await readdir(directory)).filter(name => /^[a-f0-9]{64}\.pdf$/.test(name)).map(async name => {
      const file = path.join(directory, name), info = await lstat(file);
      return { file, size: info.size, time: info.mtimeMs };
    }));
    files.sort((a, b) => b.time - a.time);
    let size = 0;
    for (const [index, file] of files.entries()) {
      size += file.size;
      if (index >= 100 || size > 256 * 1024 * 1024) await unlink(file.file);
    }
  }
}
