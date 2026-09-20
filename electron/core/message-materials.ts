import { lookup } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent as HttpAgent, fetch as httpFetch } from 'undici';
import ipaddr from 'ipaddr.js';
import { readMaterialPage } from './material-page';
import { normalizeMaterialImage, imageQrLinks } from './material-image';
import { readDocumentMaterial, type AttachmentResolver, type ResolvedAttachment } from './material-document';
import { linksInSourceText } from './material-links';
import type { ImageMaterialGroup } from './visual-materials';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { Message } from '../../src/shared';
import type { ActivitySource } from '../../src/schedule';
import { shareCardMaterials } from './material-title';
import { shouldUseWebpagePdf, type WebpagePdfReader, type WebpagePdfRequest } from './webpage-pdf';
import type { PdfPageImage } from './material-pdf';

export interface DownloadedMaterial { url: string; contentType: string; bytes: Uint8Array; headers?: Record<string, string> }
export interface MessageMaterials {
  text: string;
  images: ImageContent[];
  imageGroups: ImageMaterialGroup[];
  materials: ActivitySource['materials'];
  warnings: string[];
  allowedLinks: Set<string>;
  independentText?: string;
}
export interface PdfVisualResult { text: string; warnings: string[] }
export type PdfVisualReader = (pages: PdfPageImage[], label: string) => Promise<PdfVisualResult>;
export type MaterialDownload = (url: string, signal: AbortSignal) => Promise<DownloadedMaterial>;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 4;
const MAX_IMAGES = 128;
const MAX_IMAGE_SOURCES = 96;
const MAX_REDIRECTS = 8;
class MaterialReadError extends Error {}
const downloadedCache = new Map<string, { material: DownloadedMaterial; expires: number }>();
const hostSchedule = new Map<string, number>();
let downloadedBytes = 0;
export const materialRequestHeaders = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,text/plain,image/*,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.5',
};

export function isPublicAddress(value: string): boolean {
  try { return ipaddr.process(value).range() === 'unicast'; }
  catch { return false; }
}
export function publicMaterialUrl(value: string, base?: string): URL {
  const url = new URL(value, base);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || (url.port && !['80', '443'].includes(url.port)) || url.href.length > 2048
    || host === 'localhost' || /\.(localhost|local|internal)$/i.test(host)
    || (ipaddr.isValid(host) && !isPublicAddress(host))) throw new Error('链接不是可读取的公开网页地址。');
  return url;
}
export async function resolvePublicHost(host: string) {
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(value => !isPublicAddress(value.address))) throw new Error('已阻止访问本机或内网地址。');
  return addresses;
}

export async function downloadPublicMaterial(input: string, parentSignal: AbortSignal, request = httpFetch, spacingMs = 350): Promise<DownloadedMaterial> {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(30_000)]);
  signal.throwIfAborted();
  const initial = publicMaterialUrl(input);
  // Fragments belong to source evidence (including SPA routes), not HTTP requests.
  initial.hash = '';
  const cached = request === httpFetch ? downloadedCache.get(initial.href) : undefined;
  if (cached && cached.expires > Date.now()) return cached.material;
  // Validate DNS inside the connection lookup, so validation and connection use the same IP.
  const dispatcher = new HttpAgent({
    connect: {
      timeout: 10_000,
      lookup(hostname, options, callback) {
        void resolvePublicHost(hostname).then(addresses => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        }).catch(error => callback(error, '', 4));
      },
    },
  });
  try {
    let url = initial;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      signal.throwIfAborted();
      if (request === httpFetch) {
        const next = Math.max(Date.now(), hostSchedule.get(url.host) ?? 0);
        if (hostSchedule.size > 256) hostSchedule.delete(hostSchedule.keys().next().value!);
        hostSchedule.set(url.host, next + spacingMs);
        if (next > Date.now()) await delay(next - Date.now(), undefined, { signal });
      }
      const response = await request(url, {
        dispatcher, signal, redirect: 'manual', credentials: 'omit',
        headers: materialRequestHeaders,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || hop === MAX_REDIRECTS) throw new MaterialReadError('网页跳转次数过多。');
        url = publicMaterialUrl(location, url.href);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new MaterialReadError(`资源返回 HTTP ${response.status}。`); }
      const contentType = response.headers.get('content-type') ?? '';
      const maxBytes = /^image\//i.test(contentType) ? MAX_IMAGE_BYTES : MAX_BYTES;
      const limitError = () => new MaterialReadError(`内容超过 ${maxBytes / 1024 / 1024} MB 读取上限。`);
      if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw limitError(); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('网页没有返回内容。');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw limitError();
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const headers: Record<string, string> = {};
      for (const name of ['content-security-policy', 'access-control-allow-origin', 'cross-origin-resource-policy']) {
        const value = response.headers.get(name);
        if (value) headers[name] = value;
      }
      const material = { url: url.href, contentType, bytes: Buffer.concat(chunks), headers };
      // Cache image downloads only: a temporary challenge or edited article must be fetched again.
      if (request === httpFetch && /^image\//i.test(contentType)) {
        const old = downloadedCache.get(initial.href);
        if (old) { downloadedBytes -= old.material.bytes.length; downloadedCache.delete(initial.href); }
        while (downloadedBytes + size > 48 * 1024 * 1024 && downloadedCache.size) {
          const oldest = downloadedCache.keys().next().value!;
          downloadedBytes -= downloadedCache.get(oldest)!.material.bytes.length; downloadedCache.delete(oldest);
        }
        downloadedCache.set(initial.href, { material, expires: Date.now() + 10 * 60_000 });
        downloadedBytes += size;
      }
      return material;
    }
    throw new Error('网页读取失败。');
  } finally { await dispatcher.close(); }
}

export function imageMime(bytes: Uint8Array): string | undefined {
  const data = Buffer.from(bytes);
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(data.subarray(0, 6).toString())) return 'image/gif';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
}
export function parseMaterialPage(html: string, url: string) {
  const page = readMaterialPage(html, url);
  const resolve = (values: string[]) => [...new Set(values.flatMap(value => {
    try { return [publicMaterialUrl(value, url).href]; } catch { return []; }
  }))];
  return { ...page, images: resolve(page.images), links: resolve(page.links) };
}

export async function collectMessageMaterials(
  message: Message, signal: AbortSignal, imageInput: boolean, download: MaterialDownload = downloadPublicMaterial,
  resolveAttachment?: AttachmentResolver,
  options: { onTextReady?: (material: MessageMaterials) => Promise<boolean>; sourceLabel?: (segmentIndex: number) => string;
    readWebpagePdf?: WebpagePdfReader; readPdfVisuals?: PdfVisualReader } = {},
): Promise<MessageMaterials> {
  const result: MessageMaterials = { text: '', images: [], imageGroups: [], materials: [], warnings: [], allowedLinks: new Set() };
  result.materials.push(...shareCardMaterials(message));
  const pages = new Set<string>();
  const images = new Set<string>();
  const imageSegments = new Map<string, number>();
  const pageLabels = new Map<string, string>();
  const imageLabels = new Map<string, string>();
  const files: { index: number; name: string; url?: string }[] = [];
  const pdfPages: WebpagePdfRequest[] = [];
  let imageBytes = 0;
  const resolvedDownload = async (value: ResolvedAttachment): Promise<DownloadedMaterial> => {
    if (typeof value === 'string') return download(publicMaterialUrl(value).href, signal);
    if (value.bytes) {
      if (value.bytes.byteLength > MAX_IMAGE_BYTES) throw new MaterialReadError('附件超过 20 MB 读取上限。');
      return { url: value.url ? publicMaterialUrl(value.url).href : '', contentType: '', bytes: value.bytes };
    }
    if (!value.url) throw new MaterialReadError('附件没有返回可读取的数据。');
    return download(publicMaterialUrl(value.url).href, signal);
  };
  const addImage = async (bytes: Uint8Array, budget = MAX_IMAGES - result.images.length, sourceLabel = '') => {
    if (!imageInput || result.images.length >= MAX_IMAGES) {
      result.warnings.push('图片未发送：当前模型不支持图像或已达到图片数量上限。'); return;
    }
    const normalized = await normalizeMaterialImage(bytes, Math.min(budget, MAX_IMAGES - result.images.length), signal);
    signal.throwIfAborted();
    const size = normalized.images.reduce((sum, image) => sum + image.data.length, 0);
    if (imageBytes + size > 72 * 1024 * 1024) throw new MaterialReadError('本消息图片总量超过 72 MB，未读取剩余图片。');
    imageBytes += size;
    result.images.push(...normalized.images);
    const label = `来源图片 ${result.imageGroups.length + 1}${sourceLabel ? ` · ${sourceLabel}` : ''}`;
    result.imageGroups.push({ label, images: normalized.images });
    if (normalized.truncated) result.warnings.push(`${label}按分片或动图预算抽读，部分内容未读取，需核对原图。`);
    addSourceLinks(await imageQrLinks(normalized.images, signal));
  };
  const addURL = (value: string, target: Set<string>) => {
    try { const url = publicMaterialUrl(value).href; target.add(url); result.allowedLinks.add(url); }
    catch { result.warnings.push('有链接指向本机、内网或不受支持的地址，未读取。'); }
  };
  const linksInText = (text: string) => {
    for (const link of linksInSourceText(text)) addURL(link, pages);
  };
  const addSourceLinks = (links: string[]) => {
    const visible: string[] = [];
    let length = 0;
    for (const link of links) {
      try {
        const url = publicMaterialUrl(link).href;
        result.allowedLinks.add(url);
        if (visible.length < 20 && length + url.length <= 4000) { visible.push(url); length += url.length; }
      } catch {}
    }
    if (visible.length) result.text += `\n来源中的链接：\n${visible.join('\n')}\n`;
  };
  for (const [index, segment] of message.segments.entries()) if (segment.type === 'text') {
    linksInText(String(segment.data.text ?? ''));
    for (const link of linksInSourceText(String(segment.data.text ?? ''))) {
      if (!pageLabels.has(link)) pageLabels.set(link, options.sourceLabel?.(index) ?? '');
    }
  }
  for (const [index, segment] of message.segments.entries()) {
    if (segment.type === 'image') {
      const value = segment.data.url ?? segment.data.file;
      if (typeof value === 'string' && /^https?:\/\//.test(value)) {
        addURL(value, images);
        try { imageSegments.set(publicMaterialUrl(value).href, index); imageLabels.set(publicMaterialUrl(value).href, options.sourceLabel?.(index) ?? ''); } catch {}
      } else if (imageInput && resolveAttachment && result.imageGroups.length < MAX_IMAGE_SOURCES) {
        try {
          const data = await resolvedDownload(await resolveAttachment(index, signal));
          await addImage(data.bytes, undefined, options.sourceLabel?.(index));
          result.materials.push({ url: data.url, kind: 'image' });
        }
        catch { signal.throwIfAborted(); result.warnings.push('图片缺少可读取链接，请连接 QQ 后重试。'); }
      }
      else result.warnings.push('有图片缺少公开链接，未读取。');
    }
    if (segment.type === 'file') files.push({
      index, name: String(segment.data.name ?? segment.data.file ?? '群文件').slice(0, 200),
      url: typeof segment.data.url === 'string' ? segment.data.url : undefined,
    });
    if (segment.type === 'json') {
      try {
        const card = JSON.parse(String(segment.data.data));
        const walk = (value: unknown, depth = 0) => {
          if (depth > 6) return;
          if (typeof value === 'string') {
            linksInText(value);
            for (const link of linksInSourceText(value)) if (!pageLabels.has(link)) pageLabels.set(link, options.sourceLabel?.(index) ?? '');
            return;
          }
          if (value && typeof value === 'object') {
            for (const [key, entry] of Object.entries(value).slice(0, 40)) {
              if (typeof entry === 'string' && /^(preview|image|cover|picurl)$/i.test(key)) addURL(entry, images);
              else walk(entry, depth + 1);
            }
          }
        };
        walk(card);
        result.text += `\n分享卡片：${JSON.stringify(card).slice(0, 5000)}\n`;
      } catch { result.warnings.push('分享卡片内容无法解析。'); }
    }
    if (['forward', 'video', 'record', 'xml'].includes(segment.type)) {
      result.warnings.push('合并转发、XML 卡片或音视频尚未展开，需核对原消息。');
    }
  }
  if (files.length > 2) result.warnings.push('文件超过 2 个，只读取前 2 个。');
  for (const file of files.slice(0, 2)) {
    signal.throwIfAborted();
    if (!/\.(pdf|docx|txt|md|csv)$/i.test(file.name)) { result.warnings.push(`文件“${file.name}”格式暂不支持，可读取 PDF、DOCX、TXT、MD 和 CSV。`); continue; }
    try {
      if (!file.url && !resolveAttachment) throw new Error('文件需连接 QQ 后读取。');
      const data = await resolvedDownload(file.url ?? await resolveAttachment!(file.index, signal));
      const document = await readDocumentMaterial(data.bytes, file.name, signal);
      result.text += `\n${options.sourceLabel?.(file.index) ?? ''} 文件：${file.name}\n${document.text.slice(0, 16000)}\n`;
      result.materials.push({ url: data.url, kind: 'file', title: file.name });
      if (document.text.length > 16000) result.warnings.push('部分文件正文已截断至 16000 字。');
      if (!document.text.trim() && !document.images.length) result.warnings.push('文件没有可提取的正文或图片。');
      result.warnings.push(...document.warnings);
      addSourceLinks([...document.links, ...linksInSourceText(document.text)]);
      for (const image of document.images) {
        try { await addImage(image, undefined, options.sourceLabel?.(file.index)); }
        catch { signal.throwIfAborted(); result.warnings.push('文件中部分图片格式损坏，未发送给模型。'); }
      }
    } catch (error) {
      signal.throwIfAborted();
      const detail = error instanceof Error && /^(请|附件|文件|PDF|DOCX|QQ|NapCat|连接|此消息|当前|内容)/.test(error.message)
        ? error.message.replace(/https?:\/\/\S+/g, '[链接]').slice(0, 240) : '下载或文档解析未完成，请连接 QQ 后重试。';
      result.warnings.push(`文件读取失败：${file.name}；${detail}`);
    }
  }
  if (pages.size > MAX_PAGES) result.warnings.push(`链接超过 ${MAX_PAGES} 个，只读取前 ${MAX_PAGES} 个。`);
  for (const url of [...pages].slice(0, MAX_PAGES)) {
    signal.throwIfAborted();
    try {
      let data = await download(url, signal);
      const mime = imageMime(data.bytes);
      if (mime || /^image\//i.test(data.contentType)) {
        result.materials.push({ url, kind: 'image' });
        await addImage(data.bytes, undefined, pageLabels.get(url));
        continue;
      }
      if (!/text\/(html|plain)|application\/xhtml\+xml/i.test(data.contentType)) throw new Error('不是可读取的网页、文字或图片。');
      const charset = data.contentType.match(/charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8';
      let text = new TextDecoder(charset).decode(data.bytes);
      let page = /text\/plain/i.test(data.contentType) ? { title: '', text, images: [], links: [], restricted: false } : parseMaterialPage(text, data.url);
      if (page.restricted && new URL(url).hostname === 'mp.weixin.qq.com') {
        await delay(1000, undefined, { signal });
        data = await download(url, signal);
        if (/text\/html|application\/xhtml\+xml/i.test(data.contentType)) {
          text = new TextDecoder(charset).decode(data.bytes);
          page = parseMaterialPage(text, data.url);
        }
      }
      if (page.restricted) {
        result.warnings.push(`网站返回了验证或登录页面，未读取正文：${new URL(url).hostname}。`);
        continue;
      }
      if (page.text.length < 30 && !page.images.length) result.warnings.push('网页未返回足够静态正文，可能需浏览器加载；已保留原消息与链接，需核对原页面。');
      if (page.text.length > 16000) result.warnings.push('部分网页正文已截断至 16000 字。');
      // Preserve the public share URL, not temporary auth tokens issued during redirects.
      result.text += `\n${pageLabels.get(url) ?? ''} 网页 ${url}\n标题：${page.title}\n${page.text.slice(0, 16000)}\n`;
      const knownPage = result.materials.find(item => item.url === url && item.kind === 'page');
      if (knownPage) { if (page.title) knownPage.title = page.title.slice(0, 200); }
      else result.materials.push({ url, kind: 'page', title: page.title.slice(0, 200) });
      if (options.readWebpagePdf && imageInput && shouldUseWebpagePdf(page.images)) {
        pdfPages.push({ html: text, url, baseUrl: data.url, title: page.title, imageUrls: page.images });
      } else for (const image of page.images) { images.add(image); if (!imageLabels.has(image)) imageLabels.set(image, pageLabels.get(url) ?? ''); }
      addSourceLinks([...page.links, ...linksInSourceText(page.text)]);
    } catch (error) {
      signal.throwIfAborted();
      result.warnings.push(`链接读取失败：${new URL(url).hostname}；${error instanceof MaterialReadError ? error.message : '可在处理记录中重试。'}`);
    }
  }
  if (result.text.length > 40000) { result.text = result.text.slice(0, 40000); result.warnings.push('链接正文总长度超过上限，已截断。'); }
  if ((images.size || pdfPages.length) && await options.onTextReady?.(result)) {
    for (const url of [...images].slice(0, MAX_IMAGE_SOURCES)) result.materials.push({ url, kind: 'image' });
    result.warnings.push('网页正文已提供日程关键信息，补充图片未展开。');
    return result;
  }
  if (pdfPages.length) result.independentText = result.text;
  for (const page of pdfPages) {
    signal.throwIfAborted();
    const pdfText: string[] = [];
    let pdfTextLength = 0;
    try {
      const pdf = await options.readWebpagePdf!(page, signal, options.readPdfVisuals ? async (pages, totalPages) => {
        signal.throwIfAborted();
        const label = `网页 PDF · ${page.title || page.url} · 共 ${totalPages} 页${pageLabels.get(page.url) ? ` · ${pageLabels.get(page.url)}` : ''}`;
        for (const item of pages) {
          const normalized = await normalizeMaterialImage(item.bytes, 2, signal);
          addSourceLinks(await imageQrLinks(normalized.images, signal));
        }
        const visual = await options.readPdfVisuals!(pages, label);
        result.warnings.push(...visual.warnings);
        // Keep bounded source facts from every batch, including the tail, not a prefix of the whole PDF.
        const share = Math.max(800, Math.floor(100000 / Math.max(1, Math.ceil(totalPages / 4))));
        const remaining = Math.min(share, Math.max(0, 100000 - pdfTextLength));
        if (visual.text.length > remaining) result.warnings.push('网页 PDF 部分批次文字超出汇总额度，已为后续页保留空间。');
        if (remaining) { pdfText.push(visual.text.slice(0, remaining)); pdfTextLength += Math.min(visual.text.length, remaining); }
      } : undefined);
      const source = result.materials.find(item => item.url === page.url && item.kind === 'page');
      if (source) { source.snapshotId = pdf.snapshotId; source.pdfCoverage = pdf.coverage; source.notices = pdf.notices; }
      result.independentText += `\n${pdf.text}`;
      result.text += `\n${pageLabels.get(page.url) ?? ''} 网页 PDF ${page.url}\n${pdf.text}\n${pdfText.join('\n')}\n`;
      if (pdf.notices?.length) result.text += `\n静态转换说明（非读取错误）：${pdf.notices.join('；')}\n`;
      result.warnings.push(...pdf.warnings.map(warning => `网页 PDF：${warning}`));
      addSourceLinks(pdf.links);
      for (const image of pdf.images) await addImage(image, undefined, `网页 PDF · ${page.title || page.url}${pageLabels.get(page.url) ? ` · ${pageLabels.get(page.url)}` : ''}`);
    } catch {
      signal.throwIfAborted();
      if (pdfText.length) result.text += `\n网页 PDF ${page.url} 中已读取的页面：\n${pdfText.join('\n')}\n`;
      result.warnings.push('网页 PDF 生成或读取未完成，已保留原文与链接，可重新读取；未退回逐张展开多图或动图。');
    }
  }
  if (images.size && !imageInput) result.warnings.push('当前模型未开启图像能力，图片内容未提取。');
  const remainingSources = Math.max(0, MAX_IMAGE_SOURCES - result.imageGroups.length);
  if (images.size > remainingSources) result.warnings.push(`图片来源超过本消息 ${MAX_IMAGE_SOURCES} 张上限，还有 ${images.size - remainingSources} 张未读取。`);
  const selectedImages = [...images].slice(0, remainingSources);
  for (const [position, url] of selectedImages.entries()) {
    const source: ActivitySource['materials'][number] = { url, kind: 'image' };
    result.materials.push(source);
    if (!imageInput) continue;
    if (result.images.length >= MAX_IMAGES) { result.warnings.push('图片数量已达到上限，部分图片未读取。'); break; }
    signal.throwIfAborted();
    // Reserve a share for later sources, where application instructions often appear.
    const budget = Math.max(1, Math.floor((MAX_IMAGES - result.images.length) / (selectedImages.length - position)));
    try {
      try {
        const data = await download(url, signal);
        await addImage(data.bytes, budget, imageLabels.get(url));
      } catch (error) {
        signal.throwIfAborted();
        const index = imageSegments.get(url);
        if (index === undefined || !resolveAttachment) throw error;
        const data = await resolvedDownload(await resolveAttachment(index, signal));
        await addImage(data.bytes, budget, imageLabels.get(url));
        source.url = data.url;
      }
    } catch (error) {
      signal.throwIfAborted();
      result.warnings.push(error instanceof MaterialReadError ? `图片未读取：${error.message}` : '部分图片下载或解码失败，图片内容可能不完整。');
    }
  }
  const textLimit = pdfPages.length ? 160000 : 40000;
  if (result.text.length > textLimit) { result.text = result.text.slice(0, textLimit); result.warnings.push('链接正文总长度超过上限，已截断。'); }
  result.warnings = [...new Set(result.warnings)];
  return result;
}
