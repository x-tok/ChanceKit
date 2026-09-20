import { test, expect, _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

test('browser prints original URL with its CSS, script-rendered content and lazy images', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-web-pdf-e2e-'));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.ELECTRON_RUN_AS_NODE;
  // Bundled helpers resolve native dependencies from the repository, as the desktop build does.
  const bundled = path.resolve('dist-electron/webpage-pdf-test.cjs');
  await build({ entryPoints: ['tests/helpers/webpage-pdf-electron.ts'], outfile: bundled, bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron', 'sharp', 'pdfjs-dist', '@napi-rs/canvas'] });
  const app = await electron.launch({ args: [bundled, `--user-data-dir=${path.join(root, 'profile')}`], env });
  try {
    const png = await sharp(Buffer.from('<svg width="600" height="180"><rect width="600" height="180" fill="white"/><text x="24" y="70" font-size="32" fill="#21332b">Recruitment presentation</text><text x="24" y="120" font-size="26">2026-09-24 14:30 Hall 201</text></svg>')).png().toBuffer();
    const result = await app.evaluate(async (_electron, input) => {
      const { WebpagePdfStore, printWebpagePdf } = (globalThis as any).webpagePdfTest;
      const downloads: string[] = [];
      let prints = 0;
      const urls = Array.from({ length: 10 }, (_, index) => `https://example.com/${index}.png`);
      const html = `<!doctype html><html><head><title>Original webpage</title><link rel="stylesheet" href="original.css"></head>
        <body><article><h2>FIRST FACT: 2026-09-24 14:30 Hall 201</h2>${urls.map(url => `<img data-src="${url}">`).join('')}
        <p>LAST FACT: bring resume</p><a href="https://example.com/#/apply">Registration</a><p id="script"></p></article>
        <script>document.querySelector('#script').textContent = 'SCRIPT RENDERED FACT';
        fetch('http://127.0.0.1/secret').catch(() => {});
        fetch('/must-not-post', {method:'POST', body:'blocked'}).catch(() => {});
        </script></body></html>`;
      const download = async (url: string) => {
        downloads.push(url);
        if (url === 'https://example.com/article' || url === 'https://example.com/sub/article') return { url: 'https://example.com/sub/article', contentType: 'text/html', bytes: Buffer.from(html) };
        if (url.endsWith('/original.css')) return { url, contentType: 'text/css', bytes: Buffer.from(`
          @page { size: A4; margin: 14mm; }
          body { font: 16px sans-serif; background: #eef7ff; }
          h2::before { content: 'ORIGINAL CSS '; }
          img { display: block; width: 450px; height: 135px; break-inside: avoid; }
        `) };
        if (urls.includes(url)) return { url, contentType: 'image/png', bytes: Buffer.from(input.png, 'base64') };
        throw new Error('unexpected resource ' + url);
      };
      const store = new WebpagePdfStore(input.root, async (url: string, signal: AbortSignal) => {
        prints++; return printWebpagePdf(url, signal, download);
      });
      // Deliberately wrong extracted HTML: only the original URL is allowed to reach the printer.
      const request = { html: 'RECONSTRUCTED CONTENT MUST NOT APPEAR', url: 'https://example.com/article', baseUrl: 'https://example.com/article', title: '合成招聘网页', imageUrls: urls };
      const pageImages: string[] = [], batches: number[][] = [];
      const first = await store.read('test', request, new AbortController().signal, async (pages: { pageNumber: number; bytes: Uint8Array }[]) => {
        batches.push(pages.map(page => page.pageNumber));
        pageImages.push(...pages.map(page => Buffer.from(page.bytes).toString('base64')));
      });
      const windows = _electron.BrowserWindow.getAllWindows().length;
      return { text: first.text, links: first.links, warnings: first.warnings, pages: pageImages, batches, coverage: first.coverage,
        snapshot: await store.file('test', first.snapshotId), prints, downloads, windows };
    }, { helper: bundled, root: path.join(root, 'pdfs'), png: png.toString('base64') });
    expect(result.text).toContain('FIRST FACT');
    expect(result.text).toContain('LAST FACT');
    expect(result.text).toContain('SCRIPT RENDERED FACT');
    expect(result.text).toContain('ORIGINAL CSS');
    expect(result.text).not.toContain('RECONSTRUCTED');
    expect(result.links).toContain('https://example.com/#/apply');
    expect(result.warnings).toEqual([]);
    expect(result.prints).toBe(1);
    expect(result.downloads).toContain('https://example.com/article');
    expect(result.downloads).toContain('https://example.com/sub/original.css');
    expect(result.downloads).toContain('https://example.com/9.png');
    expect(result.downloads.some((url: string) => /127\.0\.0\.1|must-not-post/.test(url))).toBe(false);
    expect(result.windows).toBe(1);
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.pages.length).toBeLessThan(10);
    expect(result.batches.every((batch: number[]) => batch.length <= 4)).toBe(true);
    expect(result.coverage.processedPages).toBe(result.coverage.totalPages);
    await mkdir('test-results', { recursive: true });
    for (const [index, page] of result.pages.entries()) {
      const bytes = Buffer.from(page, 'base64');
      expect((await sharp(bytes).stats()).channels.some(channel => channel.stdev > 10)).toBe(true);
      await writeFile(`test-results/webpage-pdf-page-${index + 1}.png`, bytes);
    }
    const failures = await app.evaluate(async (_electron) => {
      const { printWebpagePdf } = (globalThis as any).webpagePdfTest;
      const partial = await printWebpagePdf('https://example.com/broken', new AbortController().signal, async (url: string) => {
        if (url.endsWith('/broken')) return { url, contentType: 'text/html', bytes: Buffer.from('<html><body><article>Readable recruitment facts<img src="/missing.png"><div style="width:100px;overflow:hidden"><div style="width:1000px">CLIPPED SOURCE CONTENT</div></div></article></body></html>') };
        throw new Error('missing image');
      });
      let challengeRejected = false, cancelled = false;
      try {
        await printWebpagePdf('https://example.com/challenge', new AbortController().signal, async (url: string) => ({
          url, contentType: 'text/html', bytes: Buffer.from('<html><head><title>安全验证</title></head><body>完成验证后继续</body></html>'),
        }));
      } catch { challengeRejected = true; }
      const controller = new AbortController();
      const pending = printWebpagePdf('https://example.com/slow', controller.signal, async (_url: string, signal: AbortSignal) => {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        throw new Error('unreachable');
      });
      setTimeout(() => controller.abort(), 50);
      try { await pending; } catch { cancelled = true; }
      return { warnings: partial.warnings, challengeRejected, cancelled, windows: _electron.BrowserWindow.getAllWindows().length };
    });
    expect(failures.warnings.join(' ')).toContain('图片');
    expect(failures.warnings.join(' ')).toContain('裁切');
    expect(failures.challengeRejected).toBe(true);
    expect(failures.cancelled).toBe(true);
    expect(failures.windows).toBe(1);
  } finally { await app.close(); await rm(bundled, { force: true }); await rm(root, { recursive: true, force: true }); }
});
