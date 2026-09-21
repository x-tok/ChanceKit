import { downloadPublicMaterial, parseMaterialPage, publicMaterialUrl, type MaterialDownload } from '../materials/message-materials';
import { readableTitle } from '../materials/material-title';
import type { RecruitingInformationStore } from './recruiting-information';

export async function readArticleTitle(url: string, signal: AbortSignal, download: MaterialDownload = downloadPublicMaterial): Promise<string | undefined> {
  const source = publicMaterialUrl(url);
  if (source.hostname !== 'mp.weixin.qq.com') return;
  const material = await download(source.href, signal);
  if (!/text\/html|application\/xhtml\+xml/i.test(material.contentType)) return;
  const charset = material.contentType.match(/charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8';
  const page = parseMaterialPage(new TextDecoder(charset).decode(material.bytes), material.url);
  return page.restricted ? undefined : readableTitle(page.title);
}

// Visible generic cards are enriched in the background; no model or image request is made.
export class InformationTitleReader {
  private queue = new Map<string, { accountId: string; target: { messageKey: string; hash: string; url: string } }>();
  private active = new Map<string, AbortController>();
  private cache = new Map<string, { title?: string; until: number }>();
  private closed = false;
  constructor(private store: RecruitingInformationStore, private currentAccount: () => string, private emit: () => void, private download?: MaterialDownload) {}
  request(accountId: string, keys: string[]) {
    if (this.closed || accountId !== this.currentAccount()) return;
    for (const target of this.store.titleRequests(accountId, keys.slice(0, 20))) {
      if (target.title && this.store.applyTitle(accountId, target, target.title)) { this.emit(); continue; }
      const key = `${accountId}:${target.messageKey}:${target.hash}`;
      if (!this.active.has(key) && this.queue.size < 40) this.queue.set(key, { accountId, target });
    }
    this.pump();
  }
  private pump() {
    if (this.closed) return;
    for (const [key, controller] of this.active) if (!key.startsWith(`${this.currentAccount()}:`)) controller.abort();
    while (this.active.size < 2 && this.queue.size) {
      const [key, entry] = this.queue.entries().next().value!;
      this.queue.delete(key);
      if (entry.accountId !== this.currentAccount()) continue;
      const controller = new AbortController();
      this.active.set(key, controller);
      void (async () => {
        const cacheKey = `${entry.accountId}:${entry.target.url}`;
        let cached = this.cache.get(cacheKey);
        if (!cached || cached.until <= Date.now()) {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
          let title: string | undefined;
          try { title = await readArticleTitle(entry.target.url, signal, this.download); } catch {}
          cached = { title, until: Date.now() + (title ? 30 : 5) * 60_000 };
          if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(cacheKey, cached);
        }
        if (!controller.signal.aborted && !this.closed && entry.accountId === this.currentAccount() && cached.title
          && this.store.applyTitle(entry.accountId, entry.target, cached.title)) this.emit();
      })().catch(() => {}).finally(() => { this.active.delete(key); this.pump(); });
    }
  }
  close() { this.closed = true; this.queue.clear(); for (const controller of this.active.values()) controller.abort(); }
}
