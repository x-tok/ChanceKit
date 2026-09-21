import type { ActivitySource } from './schedule';
import s from './Schedule.module.css';

function MessageText({ text, onOpen }: { text: string; onOpen: (url: string) => void }) {
  return <p className={s.messageText}>{text.split(/(https?:\/\/[^\s<>"，。；！？）]+)/g).map((part, index) => {
    try {
      const url = new URL(part);
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
        return <a key={index} href={part} onClick={event => { event.preventDefault(); onOpen(part); }}>{part}</a>;
      }
    } catch { /* Non-link parts remain plain text, never markup or JSON. */ }
    return <span key={index}>{part}</span>;
  })}</p>;
}

export function CalendarMessage({ sources, onOpen }: { sources: ActivitySource[]; onOpen: (url: string) => void }) {
  const render = (source: ActivitySource) => <div key={source.messageKey} className={s.originalMessage}>
    <small>{source.groupName}</small>
    <MessageText text={source.text || '原消息未提供文字'} onOpen={onOpen} />
    {[...new Map(source.materials.filter(item => item.kind === 'page' && !source.text.includes(item.url))
      .map(item => [item.url, item])).values()].map(item => <MessageText key={item.url} text={item.url} onOpen={onOpen} />)}
    {source.relatedMessages?.map(message => <div key={message.messageKey} className={s.quotedMessage}>
      <small>{message.relation === 'quoted' ? '引用原消息' : '相关回复'} · {message.senderName}</small>
      <MessageText text={message.text} onOpen={onOpen} />
    </div>)}
  </div>;
  if (!sources.length) return <span className={s.muted}>暂无原始消息</span>;
  return <div className={s.originalMessages}>
    {render(sources[0])}
    {sources.length > 1 && <details><summary>另 {sources.length - 1} 条来源</summary>{sources.slice(1).map(render)}</details>}
  </div>;
}
