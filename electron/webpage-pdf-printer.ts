import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { downloadPublicMaterial, publicMaterialUrl, type MaterialDownload } from './core/materials/message-materials';
import { readMaterialPage } from './core/materials/material-page';
import type { PrintedWebpagePdf } from './core/materials/webpage-pdf';

// Chromium lays out the original document, not an article rebuilt from extracted images.
export async function printWebpagePdf(url: string, signal: AbortSignal,
  download: MaterialDownload = (url, signal) => downloadPublicMaterial(url, signal, undefined, 30)): Promise<PrintedWebpagePdf> {
  signal.throwIfAborted();
  const initial = publicMaterialUrl(url).href;
  const win = new BrowserWindow({
    show: false, width: 1000, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
      partition: `webpage-pdf-${randomUUID()}`, backgroundThrottling: false },
  });
  const session = win.webContents.session;
  const destroy = () => { if (!win.isDestroyed()) win.destroy(); };
  signal.addEventListener('abort', destroy, { once: true });
  const warnings = new Set<string>();
  const navigations = new Set([initial.split('#')[0]]);
  let resourceCount = 0, resourceBytes = 0;
  const inFlight = new Set<Promise<void>>();
  const resources = new Map<string, ReturnType<MaterialDownload>>();
  const controller = new AbortController();
  const resourceSignal = AbortSignal.any([signal, controller.signal]);
  const relevant = new Set(['image', 'stylesheet', 'font']);
  const fetchResource = (url: string) => {
    const key = url.split('#')[0];
    let result = resources.get(key);
    if (!result) {
      result = (async () => {
        resourceSignal.throwIfAborted();
        while (inFlight.size >= 8) {
          await Promise.race(inFlight);
          resourceSignal.throwIfAborted();
        }
        const pending = download(key, resourceSignal);
        const settled = pending.then(() => {}, () => {}).finally(() => inFlight.delete(settled));
        inFlight.add(settled);
        const data = await pending;
        resourceBytes += data.bytes.length;
        if (resourceBytes > 128 * 1024 * 1024) throw new Error('resource bytes');
        return data;
      })();
      resources.set(key, result);
    }
    return result;
  };
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on('will-download', event => event.preventDefault());
  session.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      if (/^https?:/.test(details.url)) {
        publicMaterialUrl(details.url);
        allowed = details.method === 'GET' && details.resourceType !== 'subFrame'
          && (details.resourceType !== 'mainFrame' || navigations.has(details.url.split('#')[0]));
      } else allowed = /^(data|blob):/.test(details.url) && details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame';
    } catch { /* DNS is also checked and pinned by the public downloader. */ }
    if (!allowed && relevant.has(details.resourceType)) warnings.add('网页部分图片、样式或字体未能加载。');
    callback({ cancel: !allowed });
  });
  session.webRequest.onErrorOccurred(details => {
    if (relevant.has(details.resourceType) && !resourceSignal.aborted) warnings.add('网页部分图片、样式或字体未能加载。');
  });
  // Keep the original DOM, CSS and scripts. Route GETs through the DNS-pinned public
  // downloader without forwarding browser cookies, authorization or application credentials.
  for (const scheme of ['http', 'https']) session.protocol.handle(scheme, async request => {
    try {
      resourceSignal.throwIfAborted();
      if (request.method !== 'GET') return new Response('', { status: 405 });
      publicMaterialUrl(request.url);
      if (++resourceCount > 768 || resourceBytes > 128 * 1024 * 1024) throw new Error('resource budget');
      const data = await fetchResource(request.url);
      if (data.url.split('#')[0] !== request.url.split('#')[0]) {
        publicMaterialUrl(data.url);
        if (navigations.has(request.url.split('#')[0])) navigations.add(data.url.split('#')[0]);
        return Response.redirect(data.url, 302);
      }
      if (navigations.has(request.url.split('#')[0])) {
        const charset = data.contentType.match(/charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8';
        if (!/text\/html|application\/xhtml\+xml/i.test(data.contentType)
          || readMaterialPage(new TextDecoder(charset).decode(data.bytes), data.url).restricted) {
          throw new Error('restricted page');
        }
      }
      const headers = new Headers(data.headers);
      headers.set('content-type', data.contentType);
      // Page scripts may render content, but cannot submit forms or open frames/workers/sockets.
      headers.append('content-security-policy', "default-src http: https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src http: https:; form-action 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'");
      return new Response(new Uint8Array(data.bytes), { headers });
    } catch {
      if (!resourceSignal.aborted) warnings.add('网页部分资源未能加载，或已达到读取上限。');
      return new Response('', { status: 502 });
    }
  });
  try {
    await win.loadURL(initial);
    signal.throwIfAborted();
    // Fixed script: rendering readiness and lazy-image attributes only; no new article layout.
    const state = await win.webContents.executeJavaScript(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const until = (promise, ms) => Promise.race([promise, wait(ms)]);
      const start = Date.now();
      const activate = () => {
        for (const image of document.images) {
          image.loading = 'eager';
          const lazy = image.getAttribute('data-src') || image.getAttribute('data-original');
          if (lazy && !image.dataset.chancekitLoaded) {
            image.dataset.chancekitLoaded = 'true';
            image.src = lazy;
          }
        }
      };
      let end = false, stable = 0, previousHeight = 0;
      for (let step = 0; step < 400 && Date.now() - start < 45000; step++) {
        activate();
        const height = Math.max(document.body?.scrollHeight || 0, document.documentElement.scrollHeight);
        if (height > 300000) break;
        window.scrollBy(0, Math.max(300, innerHeight * 0.8));
        await wait(80);
        const bottom = scrollY + innerHeight >= height - 4;
        stable = bottom && height === previousHeight ? stable + 1 : 0;
        previousHeight = height;
        if (stable >= 4) { end = true; break; }
      }
      activate();
      await until(Promise.all(Array.from(document.images, image => image.decode().catch(() => {}))), 15000);
      await until(document.fonts.ready, 5000);
      await wait(1000);
      window.scrollTo(0, 0);
      const content = document.querySelector('#js_content,article,main,[role="main"]') || document.body;
      const contentImages = Array.from(content.querySelectorAll('img'));
      // Detect source layouts that native printing cannot reliably expand. Do not
      // flatten grids/carousels or rewrite their styles to make the warning disappear.
      const clippedContent = Array.from(content.querySelectorAll('*')).slice(0, 20000).some(element => {
        if (['IMG','SVG','CANVAS','VIDEO'].includes(element.tagName)) return false;
        const style = getComputedStyle(element), rect = element.getBoundingClientRect();
        const clips = value => ['hidden','auto','scroll','clip'].includes(value);
        return rect.width > 0 && (
          (element.scrollWidth > element.clientWidth + 4 && clips(style.overflowX))
          || (element.scrollHeight > element.clientHeight + 4 && clips(style.overflowY))
          || (rect.height > 1000 && clips(style.overflowY)
            && ['inline-block','inline-flex','grid','inline-grid','flex'].includes(style.display)));
      });
      return {
        html: document.documentElement.outerHTML,
        text: (document.body?.innerText || '').slice(0, 2000),
        images: document.images.length,
        missingImages: contentImages.filter(image => (image.currentSrc || image.getAttribute('src') || image.dataset.src)
          && (!image.complete || !image.naturalWidth)).length,
        incompleteScroll: !end,
        dynamic: Boolean(content.querySelector('video,audio,canvas,iframe')),
        clippedContent,
      };
    })()`) as { html: string; text: string; images: number; missingImages: number; incompleteScroll: boolean; dynamic: boolean; clippedContent: boolean };
    signal.throwIfAborted();
    if (readMaterialPage(state.html, win.webContents.getURL()).restricted || (!state.text.trim() && !state.images)) {
      throw new Error('网页返回验证、登录或空白页面，未保存为正文 PDF。');
    }
    if (state.missingImages) warnings.add(`网页有 ${state.missingImages} 张图片未能完整加载。`);
    if (state.incompleteScroll) warnings.add('网页过长或持续加载，未能确认全部内容加载完成。');
    if (state.dynamic) warnings.add('网页含音视频、画布或嵌入内容，PDF 可能未完整保留。');
    if (state.clippedContent) warnings.add('原网页含滚动或裁切容器，浏览器打印可能遗漏隐藏内容；请以原网页为准。');
    const bytes = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, generateTaggedPDF: true });
    signal.throwIfAborted();
    return { bytes, warnings: [...warnings], notices: ['由浏览器直接打印原网页，保留网页打印样式；动画仅保留静态画面。'] };
  } finally {
    controller.abort();
    signal.removeEventListener('abort', destroy);
    destroy();
    for (const scheme of ['http', 'https']) session.protocol.unhandle(scheme);
    session.webRequest.onBeforeRequest(null);
    session.webRequest.onErrorOccurred(null);
    session.setPermissionRequestHandler(null);
    session.setPermissionCheckHandler(null);
    session.removeAllListeners('will-download');
    resources.clear();
    void session.clearCache().catch(() => {});
    void session.clearStorageData().catch(() => {});
  }
}
