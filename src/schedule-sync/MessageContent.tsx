import { useState } from 'react';
import { ExternalLink, ImageOff } from 'lucide-react';
import { bridge } from '../bridge';
import type { ProcessingMessageItem } from '../schedule';
import s from './SyncDialog.module.css';

function safeExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export function LinkifiedText({ text, onError }: { text: string; onError: (message: string) => void }) {
  return <p className={s.messageText}>{text.split(/(https?:\/\/[^\s<>]+)/g).map((part, index) => {
    const visibleUrl = part.replace(/[，。；、！？）】》]+$/u, '');
    const target = safeExternalUrl(visibleUrl);
    if (!target) return <span key={index}>{part}</span>;
    const suffix = part.slice(visibleUrl.length);
    return <span key={index}><a href={target} onClick={event => {
      event.preventDefault();
      void bridge.openExternal(target).catch(error => onError(error instanceof Error ? error.message : '链接打开失败。'));
    }}>{visibleUrl}</a>{suffix}</span>;
  })}</p>;
}

function MessageImage({ image, onError }: { image: ProcessingMessageItem['images'][number]; onError: (message: string) => void }) {
  const [failed, setFailed] = useState(false);
  if (!image.url || failed) return <span className={s.imageFallback}><ImageOff size={17} />图片已过期或无法加载</span>;
  return <a className={s.imageLink} href={image.url} aria-label="在默认浏览器中打开群消息图片" onClick={event => {
    event.preventDefault();
    void bridge.openExternal(image.url!).catch(error => onError(error instanceof Error ? error.message : '图片打开失败。'));
  }}><img src={image.url} loading="lazy" referrerPolicy="no-referrer" alt="群消息图片" onError={() => setFailed(true)} /></a>;
}

export function MessageImages({ images, onError }: { images: ProcessingMessageItem['images']; onError: (message: string) => void }) {
  if (!images.length) return null;
  return <div className={s.messageImages}>{images.map(image => <MessageImage key={image.segmentIndex} image={image} onError={onError} />)}</div>;
}

export function MessageLinks({ links, onError }: { links: ProcessingMessageItem['links']; onError: (message: string) => void }) {
  if (!links.length) return null;
  return <div className={s.messageLinks}>{links.map(link => <a key={link.url} href={link.url} onClick={event => {
    event.preventDefault();
    void bridge.openExternal(link.url).catch(error => onError(error instanceof Error ? error.message : '链接打开失败。'));
  }}><ExternalLink size={13} />{link.title}</a>)}</div>;
}
