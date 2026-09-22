import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { bridge } from '../bridge';
import s from '../JobChatPage.module.css';

export function chatLink(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {}
}

export function ChatMarkdown({ text, onError }: { text: string; onError: (message: string) => void }) {
  const open = (url: string) => void bridge.openExternal(url).catch(() => onError('链接打开失败，请稍后重试。'));
  return <div className={s.markdown}>
    <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => chatLink(url) ?? ''} components={{
      a: ({ href, children }) => {
        const url = chatLink(href);
        return url ? <a href={url} onClick={event => { event.preventDefault(); open(url); }}>{children}</a> : <span>{children}</span>;
      },
      // Model-authored images must not make unsolicited remote requests.
      img: ({ src, alt }) => {
        const url = typeof src === 'string' ? chatLink(src) : undefined;
        return url ? <a href={url} onClick={event => { event.preventDefault(); open(url); }}>{alt || '查看图片链接'}</a> : <span>{alt}</span>;
      },
      table: ({ children }) => <div className={s.markdownTable} tabIndex={0} role="region" aria-label="回答表格，可横向滚动"><table>{children}</table></div>,
    }}>{text}</Markdown>
  </div>;
}
