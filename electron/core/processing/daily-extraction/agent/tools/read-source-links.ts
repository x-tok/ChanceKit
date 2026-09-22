import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { StoredModelSettings } from '../../../../models/model-settings';
import { downloadPublicMaterial, imageMime, parseMaterialPage, publicMaterialUrl } from '../../../../materials/message-materials';
import { normalizeMaterialImage } from '../../../../materials/material-image';
import { readVisualMaterials } from '../../../../materials/visual-materials';
import type { DailyExtractionOptions, PreparedDailySource } from '../../types';
import { classifySourceLink, sourceLinkLabel } from '../link-classifier';

const MAX_REQUESTS_PER_CALL = 4;
const MAX_READS_PER_CHUNK = 12;
const MAX_PAGE_TEXT = 12_000;
const MAX_PAGE_IMAGES = 6;
const LINK_READ_CONCURRENCY = 4;
const PAGE_IMAGE_CONCURRENCY = 3;

const parameters = Type.Object({
  requests: Type.Array(Type.Object({
    sourceRef: Type.Integer({ minimum: 1 }),
    url: Type.String({ minLength: 8, maxLength: 2048 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_REQUESTS_PER_CALL }),
}, { additionalProperties: false });

interface LinkAccess {
  source: PreparedDailySource;
  urls: Map<string, number>;
}

function normalizedUrl(value: string) {
  return publicMaterialUrl(value).href;
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, operation: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await operation(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

async function readPageImages(
  urls: string[], label: string, source: PreparedDailySource, settings: StoredModelSettings,
  options: DailyExtractionOptions, signal: AbortSignal,
) {
  if (!urls.length) return { text: '', warnings: [] as string[] };
  if (!settings.config.imageInput) return { text: '', warnings: ['当前模型未开启图片读取能力，页面图片未读取。'] };
  const download = options.download ?? downloadPublicMaterial;
  const results = await mapConcurrent(urls.slice(0, MAX_PAGE_IMAGES), PAGE_IMAGE_CONCURRENCY, async url => {
    try {
      const data = await download(url, signal);
      if (!imageMime(data.bytes) && !/^image\//i.test(data.contentType)) return { images: [], warnings: [] as string[] };
      const normalized = await normalizeMaterialImage(data.bytes, 2, signal);
      return {
        images: normalized.images,
        warnings: normalized.truncated ? [`图片 ${url} 仅抽取了部分画面。`] : [],
      };
    } catch {
      signal.throwIfAborted();
      return { images: [], warnings: [`图片 ${url} 未能读取。`] };
    }
  });
  const images = results.flatMap(result => result.images);
  const warnings = results.flatMap(result => result.warnings);
  if (!images.length) return { text: '', warnings };
  const visual = await readVisualMaterials([{ label, images }], settings, {
    signal, fetch: options.fetch, accountId: source.message.accountId, repairBudget: { used: 0 },
  });
  return { text: visual.text, warnings: [...warnings, ...visual.warnings] };
}

async function readAllowedLink(
  value: string, depth: number, source: PreparedDailySource, access: LinkAccess,
  acceptedLinks: Set<string>,
  settings: StoredModelSettings, options: DailyExtractionOptions, signal: AbortSignal,
) {
  const download = options.download ?? downloadPublicMaterial;
  const data = await download(value, signal);
  const mime = imageMime(data.bytes);
  if (mime || /^image\//i.test(data.contentType)) {
    if (!settings.config.imageInput) return `来源 ${source.ref} · 图片链接\n${value}\n当前模型未开启图片读取能力。`;
    const normalized = await normalizeMaterialImage(data.bytes, 4, signal);
    const visual = await readVisualMaterials([{ label: `来源 ${source.ref} · ${value}`, images: normalized.images }], settings, {
      signal, fetch: options.fetch, accountId: source.message.accountId, repairBudget: { used: 0 },
    });
    return [`来源 ${source.ref} · 图片链接`, value, visual.text, ...visual.warnings].filter(Boolean).join('\n');
  }
  if (data.contentType && !/text\/(?:html|plain)|application\/xhtml\+xml/i.test(data.contentType)) {
    throw new Error('该链接不是可读取的网页、文字或图片。');
  }
  const charset = data.contentType.match(/charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8';
  let decoded: string;
  try { decoded = new TextDecoder(charset).decode(data.bytes); }
  catch { decoded = new TextDecoder().decode(data.bytes); }
  const page = /text\/plain/i.test(data.contentType)
    ? { title: '', text: decoded, images: [] as string[], links: [] as string[], restricted: false }
    : parseMaterialPage(decoded, data.url);
  if (page.restricted) throw new Error('网站返回了验证或登录页面，无法读取正文。');
  const discovered: string[] = [];
  if (depth < 1) {
    for (const link of page.links.slice(0, 20)) {
      try {
        const url = normalizedUrl(link);
        if (!access.urls.has(url)) access.urls.set(url, depth + 1);
        acceptedLinks.add(url);
        discovered.push(url);
      } catch { /* Ignore non-public links discovered in untrusted page content. */ }
    }
  }
  const visuals = await readPageImages(page.images, `来源 ${source.ref} · 网页图片 · ${page.title || value}`, source, settings, options, signal);
  const links = [...new Set(discovered)].map(url => `${sourceLinkLabel[classifySourceLink(url)]}：${url}`);
  return [
    `来源 ${source.ref} · ${sourceLinkLabel[classifySourceLink(value)]}`,
    `网址：${value}`,
    page.title && `标题：${page.title}`,
    page.text.slice(0, MAX_PAGE_TEXT),
    visuals.text && `页面图片内容：\n${visuals.text}`,
    links.length && `页面中发现的可继续读取链接：\n${links.join('\n')}`,
    visuals.warnings.length && `读取说明：${visuals.warnings.join('；')}`,
  ].filter(Boolean).join('\n');
}

export function createReadSourceLinksTool(
  sources: PreparedDailySource[], settings: StoredModelSettings, options: DailyExtractionOptions,
  acceptedLinks = new Set(sources.flatMap(source => source.links.map(link => link.url))),
): AgentTool<typeof parameters> {
  const access = new Map<number, LinkAccess>(sources.map(source => [source.ref, {
    source,
    urls: new Map(source.links.flatMap(link => {
      try { return [[normalizedUrl(link.url), 0] as const]; } catch { return []; }
    })),
  }]));
  let remaining = MAX_READS_PER_CHUNK;
  return {
    name: 'read_source_links', label: '读取来源链接',
    description: 'Concurrently read supplied public source URLs and relevant child links discovered in those pages. Batch independent URLs in one call.',
    parameters, executionMode: 'sequential' as const,
    async execute(_id: string, input: { requests: { sourceRef: number; url: string }[] }, toolSignal?: AbortSignal) {
      const signal = toolSignal ? AbortSignal.any([options.signal, toolSignal]) : options.signal;
      signal.throwIfAborted();
      if (input.requests.length > remaining) throw new Error(`本批次最多还可读取 ${remaining} 个链接。`);
      remaining -= input.requests.length;
      const requests = input.requests.map(request => {
        const item = access.get(request.sourceRef);
        if (!item) throw new Error('链接引用了当前批次之外的来源。');
        const url = normalizedUrl(request.url);
        const depth = item.urls.get(url);
        if (depth === undefined) throw new Error('只能读取原消息中的链接，或已读取页面正文中发现的下一层链接。');
        acceptedLinks.add(url);
        return { item, url, depth };
      });
      const output = await mapConcurrent(requests, LINK_READ_CONCURRENCY, async ({ item, url, depth }) => {
        signal.throwIfAborted();
        try {
          return await readAllowedLink(url, depth, item.source, item, acceptedLinks, settings, options, signal);
        } catch (error) {
          signal.throwIfAborted();
          const reason = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[链接]').slice(0, 240) : '网页读取失败。';
          return `来源 ${item.source.ref} · 链接读取失败\n网址：${url}\n原因：${reason}`;
        }
      });
      return { content: [{ type: 'text' as const, text: output.join('\n\n---\n\n') }], details: { read: input.requests.length } };
    },
  };
}
