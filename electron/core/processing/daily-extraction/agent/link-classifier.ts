import { linksInSourceText, sourceLink } from '../../../materials/material-links';
import type { ClassifiedSourceLink, SourceLinkKind } from '../types';

const imageExtension = /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i;
const registrationHint = /(?:apply|application|career|campus|event|form|job|join|register|registration|recruit|signup|talent|投递|报名|招聘|校招|宣讲)/i;

export function classifySourceLink(value: string): SourceLinkKind {
  const parsed = new URL(value);
  if (parsed.hostname.toLowerCase() === 'mp.weixin.qq.com') return 'wechat-article';
  if (imageExtension.test(`${parsed.pathname}${parsed.search}${parsed.hash}`)) return 'direct-image';
  if (registrationHint.test(`${parsed.hostname}${parsed.pathname}${parsed.search}${parsed.hash}`)) return 'registration';
  return 'webpage';
}

export function classifiedLinks(text: string): ClassifiedSourceLink[] {
  return linksInSourceText(text).flatMap(value => {
    const url = sourceLink(value);
    return url ? [{ url, kind: classifySourceLink(url) }] : [];
  });
}

export const sourceLinkLabel: Record<SourceLinkKind, string> = {
  'wechat-article': '微信公众号文章',
  registration: '报名或投递入口',
  'direct-image': '图片链接',
  webpage: '相关网页',
};
