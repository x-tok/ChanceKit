import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

export interface PdfPageImage { pageNumber: number; bytes: Uint8Array }
export type PdfPageConsumer = (pages: PdfPageImage[], totalPages: number) => Promise<void>;

export async function readPdfMaterial(bytes: Uint8Array, parentSignal: AbortSignal, mode: 'attachment' | 'webpage' = 'attachment', consumePages?: PdfPageConsumer) {
  parentSignal.throwIfAborted();
  const maxBytes = mode === 'webpage' ? 24 : 5;
  const maxPages = mode === 'webpage' ? 256 : 20, maxImages = mode === 'webpage' ? 24 : 8;
  const maxPixels = mode === 'webpage' ? 72_000_000 : 20_000_000;
  const streaming = mode === 'webpage' && Boolean(consumePages);
  if (bytes.byteLength > maxBytes * 1024 * 1024) throw new Error(`PDF 超过 ${maxBytes} MB 读取上限。`);
  if (!Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) throw new Error('PDF 文件格式不正确。');
  // Streaming consumers may await model calls. The parent task owns the end-to-end deadline.
  const signal = streaming ? parentSignal : AbortSignal.any([parentSignal, AbortSignal.timeout(30_000)]);
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(typeof __filename === 'string' ? __filename : path.join(process.cwd(), 'package.json'));
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  class BundledPdfData {
    async fetch({ kind, filename }: { kind: string; filename: string }) {
      const directories: Record<string, string> = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' };
      if (!directories[kind] || !/^[\w.-]+$/.test(filename) || filename.includes('..')) throw new Error('PDF 字体资源无效。');
      return new Uint8Array(await readFile(path.join(root, directories[kind], filename)));
    }
  }
  const task = getDocument({
    data: new Uint8Array(bytes), verbosity: 0, enableXfa: false, useWasm: false, useWorkerFetch: false,
    useSystemFonts: false, disableFontFace: true, stopAtErrors: true, maxImageSize: 32_000_000,
    canvasMaxAreaInBytes: 16_000_000, BinaryDataFactory: BundledPdfData,
    cMapUrl: 'bundled/', standardFontDataUrl: 'bundled/',
  });
  let render: { cancel(): void } | undefined;
  const abort = () => { render?.cancel(); void task.destroy().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const text: string[] = [], links: string[] = [], warnings: string[] = [];
  const images: Uint8Array[] = [];
  let pixels = 0, textLength = 0, processedPages = 0;
  let batch: PdfPageImage[] = [];
  const flush = async (totalPages: number) => {
    if (!batch.length) return;
    signal.throwIfAborted();
    const pending = batch;
    batch = [];
    await consumePages!(pending, totalPages);
    processedPages += pending.length;
    signal.throwIfAborted();
  };
  try {
    signal.throwIfAborted();
    const document = await task.promise;
    if (document.numPages > maxPages) warnings.push(`PDF 共 ${document.numPages} 页，只读取前 ${maxPages} 页。`);
    for (let index = 1; index <= Math.min(document.numPages, maxPages); index++) {
      signal.throwIfAborted();
      const page = await document.getPage(index);
      try {
        const content = await page.getTextContent();
        const body = content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim();
        const remainingText = Math.max(0, 40000 - textLength);
        if (body.length > remainingText && !warnings.some(warning => warning.startsWith('PDF 正文超过'))) {
          warnings.push('PDF 正文超过 40000 字，部分文字未保留；仍继续处理后续页面。');
        }
        if (body && remainingText) text.push(`PDF 第 ${index} 页：\n${body.slice(0, remainingText)}`);
        textLength += Math.min(body.length, remainingText);
        const annotations = await page.getAnnotations();
        for (const annotation of annotations) if (typeof annotation.url === 'string') links.push(annotation.url);
        const operations = await page.getOperatorList();
        if (operations.fnArray.length > 100000) { warnings.push(`PDF 第 ${index} 页绘图过于复杂，未读取图像。`); continue; }
        const containsImages = operations.fnArray.some(op => [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].includes(op));
        if (!containsImages && body.length >= 30) { processedPages++; continue; }
        const original = page.getViewport({ scale: 1 });
        const scale = Math.min(2, 1600 / original.width, 2200 / original.height);
        const viewport = page.getViewport({ scale });
        const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
        if (!Number.isFinite(width * height) || width < 1 || height < 1
          || (!streaming && (images.length >= maxImages || pixels + width * height > maxPixels))) {
          warnings.push(`PDF 第 ${index} 页超出图像读取预算，已保留可读正文。`); continue;
        }
        const { createCanvas } = await import('@napi-rs/canvas');
        const canvas = createCanvas(width, height);
        pixels += width * height;
        const rendering = page.render({ canvas: null, canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D, viewport });
        render = rendering;
        await rendering.promise;
        signal.throwIfAborted();
        const bytes = canvas.toBuffer('image/png');
        if (streaming) batch.push({ pageNumber: index, bytes });
        else { images.push(bytes); processedPages++; }
        render = undefined;
      } catch {
        signal.throwIfAborted();
        warnings.push(`PDF 第 ${index} 页读取失败，已继续处理后续页面。`);
      } finally { render = undefined; page.cleanup(); }
      if (streaming && batch.length >= 4) await flush(document.numPages);
    }
    if (streaming) await flush(document.numPages);
    return { text: text.join('\n'), images, links: [...new Set(links)], warnings,
      coverage: { totalPages: document.numPages, processedPages } };
  } catch (error) {
    if (parentSignal.aborted) throw parentSignal.reason;
    if (signal.aborted) throw new Error('PDF 读取超过 30 秒，请核对原文件。');
    if (error instanceof Error && error.name === 'PasswordException') throw new Error('PDF 已加密，需要提供可读取的副本。');
    throw new Error('PDF 内容损坏或无法完整读取，请核对原文件。');
  } finally {
    signal.removeEventListener('abort', abort);
    await task.destroy().catch(() => {});
  }
}
