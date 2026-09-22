import type { Message } from '../../../src/shared';
import type { ActivitySource } from '../../../src/schedule';
import { sourceLink } from './material-links';

export function readableTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const title = value.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (title.length < 2 || /^(微信公众平台|微信公众号|环境异常|安全验证|访问验证|请先登录|登录|验证码|loading|captcha|untitled)$/i.test(title)) return;
  return title;
}
export const genericInformationTitle = (title: string) =>
  /^(公众号与网页推送|公众号推送|招聘资讯|招聘信息|招聘链接(?:（内容待补全）)?|待补全消息|招聘图片与消息)$/.test(title) || /^https?:\/\//.test(title);
export const linkOnlyMessage = (message: Message) =>
  !message.text.replace(/https?:\/\/\S+/g, '').replace(/\[(?:引用|卡片|链接|分享)\]/g, '').replace(/[\s\p{P}\p{S}]/gu, '');

// Title and destination must be siblings in the same card object, not unrelated strings.
export function shareCardMaterials(message: Message): ActivitySource['materials'] {
  const result: ActivitySource['materials'] = [];
  const walk = (value: unknown, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 6 || result.length >= 20) return;
    const card = value as Record<string, unknown>;
    const title = readableTitle(card.title);
    if (title) for (const key of ['jumpUrl', 'url', 'qqdocurl', 'newsUrl']) {
      if (typeof card[key] !== 'string') continue;
      const url = sourceLink(card[key]);
      if (url && !result.some(item => item.url === url)) result.push({ url, kind: 'page', title });
    }
    Object.values(card).slice(0, 40).forEach(child => walk(child, depth + 1));
  };
  for (const segment of message.segments) if (segment.type === 'json') {
    try { walk(JSON.parse(String(segment.data.data))); } catch {}
  }
  return result;
}
