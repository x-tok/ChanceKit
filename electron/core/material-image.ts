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
    // Overlap adjacent tiles so a line of text crossing the boundary stays readable.
    for (let top = 0; top < info.height; top += 2120) {
      signal?.throwIfAborted();
      if (images.length >= limit) { truncated = true; break; }
      images.push(await jpeg(sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
        .extract({ left: 0, top, width: info.width, height: Math.min(2200, info.height - top) })));
      if (top + 2200 >= info.height) break;
    }
  };
  if (!animated) await split(sharp(bytes, options));
  else {
    const width = metadata.width!;
    const height = metadata.pageHeight ?? metadata.height!;
    const frames = Math.min(metadata.pages!, 240, Math.max(1, Math.floor(80_000_000 / (width * height))));
    truncated = frames < metadata.pages!;
    const { data, info } = await sharp(bytes, { ...options, limitInputPixels: 80_000_000, pages: frames }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const frameBytes = width * height * info.channels;
    const seen = new Set<string>();
    const tileWidth = Math.min(width, width > 1000 ? 1592 : 792);
    const tileHeight = Math.max(1, Math.round(height * tileWidth / width));
    const columns = Math.max(1, Math.min(4, Math.floor(1600 / (tileWidth + 8))));
    const rows = Math.max(1, Math.floor(2200 / (tileHeight + 8)));
    let cells: OverlayOptions[] = [];
    const flush = async () => {
      if (!cells.length) return;
      if (images.length >= limit) { truncated = true; cells = []; return; }
      const sheet = sharp({ create: { width: columns * (tileWidth + 8), height: Math.ceil(cells.length / columns) * (tileHeight + 8), channels: 3, background: '#ffffff' } }).composite(cells);
      images.push(await jpeg(sheet));
      cells = [];
    };
    // Read every frame within the decode budget; only byte-identical frames are removed.
    for (let frame = 0; frame < frames; frame++) {
      signal?.throwIfAborted();
      const raw = data.subarray(frame * frameBytes, (frame + 1) * frameBytes);
      const hash = createHash('sha256').update(raw).digest('hex');
      if (seen.has(hash)) continue;
      seen.add(hash);
      if (tileHeight > 2200) await split(sharp(raw, { raw: { width, height, channels: info.channels } }));
      else {
        const input = await sharp(raw, { raw: { width, height, channels: info.channels } }).flatten({ background: '#ffffff' }).resize({ width: tileWidth }).png().toBuffer();
        cells.push({ input, left: (cells.length % columns) * (tileWidth + 8), top: Math.floor(cells.length / columns) * (tileHeight + 8) });
        if (cells.length === columns * rows) await flush();
      }
      if (images.length >= limit && frame < frames - 1) { truncated = true; break; }
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
