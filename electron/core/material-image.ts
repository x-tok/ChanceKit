import { createHash } from 'node:crypto';
import sharp, { type Sharp, type OverlayOptions } from 'sharp';
import jsQR from 'jsqr';
import type { ImageContent } from '@earendil-works/pi-ai';

interface NormalizedImage {
  images: ImageContent[];
  truncated: boolean;
  animated: boolean;
}
const cache = new Map<string, { value: NormalizedImage; size: number }>();
let cachedBytes = 0;
const options = { limitInputPixels: 268_402_689, failOn: 'error' as const, pages: 1, sequentialRead: true };
const qrCache = new Map<string, string[]>();

function sampledIndices(count: number, limit: number): number[] {
  const size = Math.min(count, Math.max(0, limit));
  return Array.from({ length: size }, (_, index) => size === 1 ? 0 : Math.round(index * (count - 1) / (size - 1)));
}

async function jpeg(input: Sharp): Promise<ImageContent> {
  let data = await input.clone().jpeg({ quality: 82, chromaSubsampling: '4:2:0' }).toBuffer();
  if (data.length > 4 * 1024 * 1024) data = await input.jpeg({ quality: 75 }).toBuffer();
  return { type: 'image', mimeType: 'image/jpeg', data: data.toString('base64') };
}

export async function normalizeMaterialImage(bytes: Uint8Array, limit: number, signal?: AbortSignal): Promise<NormalizedImage> {
  signal?.throwIfAborted();
  const key = createHash('sha256').update(bytes).update(String(limit)).digest('hex');
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return { ...cached.value, images: [...cached.value.images] }; }
  const metadata = await sharp(bytes, options).metadata();
  if (!metadata.format || !['jpeg', 'png', 'webp', 'gif', 'heif', 'tiff', 'avif'].includes(metadata.format)) throw new Error('图片格式不支持。');
  const images: ImageContent[] = [];
  let truncated = false;
  const animated = (metadata.pages ?? 1) > 1;
  const scaledPixels = metadata.width! * (metadata.pageHeight ?? metadata.height!) * Math.min(1, 1600 / metadata.width!) ** 2;
  if (scaledPixels > 32_000_000) throw new Error('图片缩放后仍超过 3200 万像素，无法安全解码。');
  const split = async (input: Sharp) => {
    const { data, info } = await input.rotate().flatten({ background: '#ffffff' })
      .resize({ width: 1600, withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
    // Overlap tiles; if bounded, retain the tail as well as the head instead of dropping every later fact.
    const count = Math.max(1, Math.ceil((info.height - 80) / 2120));
    const selected = sampledIndices(count, limit - images.length);
    if (selected.length < count) truncated = true;
    for (const index of selected) {
      signal?.throwIfAborted();
      const top = index * 2120;
      images.push(await jpeg(sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
        .extract({ left: 0, top, width: info.width, height: Math.min(2200, info.height - top) })));
    }
  };
  if (!animated) await split(sharp(bytes, options));
  else {
    const width = metadata.width!;
    const height = metadata.pageHeight ?? metadata.height!;
    const seen = new Set<string>();
    const tileWidth = Math.min(width, width > 1000 ? 1592 : 792);
    const tileHeight = Math.max(1, Math.round(height * tileWidth / width));
    const columns = Math.max(1, Math.min(4, Math.floor(1600 / (tileWidth + 8))));
    const rows = Math.max(1, Math.floor(2200 / (tileHeight + 8)));
    const capacity = tileHeight > 2200 ? Math.max(1, Math.floor(limit / Math.ceil(height / 2120))) : limit * columns * rows;
    const frames = sampledIndices(metadata.pages!, Math.min(capacity, 240, Math.max(1, Math.floor(80_000_000 / (width * height)))));
    truncated = frames.length < metadata.pages!;
    const complete = !truncated
      ? await sharp(bytes, { ...options, limitInputPixels: 80_000_000, pages: frames.length }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      : undefined;
    let cells: OverlayOptions[] = [];
    const flush = async () => {
      if (!cells.length) return;
      if (images.length >= limit) { truncated = true; cells = []; return; }
      const sheet = sharp({ create: { width: columns * (tileWidth + 8), height: Math.ceil(cells.length / columns) * (tileHeight + 8), channels: 3, background: '#ffffff' } }).composite(cells);
      images.push(await jpeg(sheet));
      cells = [];
    };
    // Sparse reads cover the animation timeline without allocating all decoded frames at once.
    for (const [index, frame] of frames.entries()) {
      signal?.throwIfAborted();
      const frameBytes = width * height * (complete?.info.channels ?? 4);
      const { data: raw, info } = complete
        ? { data: complete.data.subarray(frame * frameBytes, (frame + 1) * frameBytes), info: complete.info }
        : await sharp(bytes, { ...options, page: frame }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const hash = createHash('sha256').update(raw).digest('hex');
      if (seen.has(hash)) continue;
      seen.add(hash);
      if (tileHeight > 2200) await split(sharp(raw, { raw: { width, height, channels: info.channels } }));
      else {
        const input = await sharp(raw, { raw: { width, height, channels: info.channels } }).flatten({ background: '#ffffff' }).resize({ width: tileWidth }).png().toBuffer();
        cells.push({ input, left: (cells.length % columns) * (tileWidth + 8), top: Math.floor(cells.length / columns) * (tileHeight + 8) });
        if (cells.length === columns * rows) await flush();
      }
      if (images.length >= limit && index < frames.length - 1) { truncated = true; break; }
    }
    await flush();
  }
  const value = { images, truncated, animated };
  const size = images.reduce((total, image) => total + image.data.length, 0);
  if (size <= 24 * 1024 * 1024) {
    while (cachedBytes + size > 24 * 1024 * 1024 && cache.size) {
      const oldest = cache.keys().next().value!;
      cachedBytes -= cache.get(oldest)!.size; cache.delete(oldest);
    }
    cache.set(key, { value, size }); cachedBytes += size;
  }
  return { ...value, images: [...images] };
}

export async function imageQrLinks(images: ImageContent[], signal: AbortSignal): Promise<string[]> {
  const links = new Set<string>();
  for (const image of images) {
    signal.throwIfAborted();
    const key = createHash('sha256').update(image.data).digest('hex');
    const cached = qrCache.get(key);
    if (cached) { for (const link of cached) links.add(link); continue; }
    const imageLinks: string[] = [];
    const { data, info } = await sharp(Buffer.from(image.data, 'base64')).resize({ width: 1200, height: 2000, fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels = new Uint8ClampedArray(data);
    for (let code = 0; code < 4; code++) {
      const found = jsQR(pixels, info.width, info.height, { inversionAttempts: 'attemptBoth' });
      if (!found) break;
      if (/^https?:\/\//i.test(found.data)) { links.add(found.data); imageLinks.push(found.data); }
      const corners = [found.location.topLeftCorner, found.location.topRightCorner, found.location.bottomLeftCorner, found.location.bottomRightCorner];
      const left = Math.max(0, Math.floor(Math.min(...corners.map(p => p.x))) - 4);
      const right = Math.min(info.width, Math.ceil(Math.max(...corners.map(p => p.x))) + 4);
      const top = Math.max(0, Math.floor(Math.min(...corners.map(p => p.y))) - 4);
      const bottom = Math.min(info.height, Math.ceil(Math.max(...corners.map(p => p.y))) + 4);
      for (let y = top; y < bottom; y++) pixels.fill(255, (y * info.width + left) * 4, (y * info.width + right) * 4);
    }
    if (qrCache.size >= 256) qrCache.delete(qrCache.keys().next().value!);
    qrCache.set(key, imageLinks);
  }
  return [...links];
}
