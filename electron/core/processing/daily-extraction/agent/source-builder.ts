import type { StoredModelSettings } from '../../../models/model-settings';
import { collectMessageMaterials } from '../../../materials/message-materials';
import { readVisualMaterials } from '../../../materials/visual-materials';
import { classifiedLinks } from './link-classifier';
import type { DailyExtractionOptions, DailyMessageSource, PreparedDailySource } from '../types';

const technicalCardKeys = /^(?:app|appid|app_id|business|data|id|key|msgid|msg_id|seq|token|uin|user_id|ver|version)$/i;

function cardText(value: unknown, key = '', depth = 0): string[] {
  if (depth > 6 || technicalCardKeys.test(key)) return [];
  if (typeof value === 'string') {
    const clean = value.replace(/\s+/g, ' ').trim();
    return clean.length >= 2 && clean.length <= 1000 ? [clean] : [];
  }
  if (Array.isArray(value)) return value.slice(0, 30).flatMap(item => cardText(item, key, depth + 1));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).slice(0, 60).flatMap(([childKey, child]) => cardText(child, childKey, depth + 1));
}

export function humanMessageText(source: DailyMessageSource): string {
  const text = source.message.text
    .replace(/\[CQ:[^\]]+\]/g, '')
    .replace(/@\d{5,12}\b/g, '@群成员')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const cards = source.message.segments.flatMap(segment => {
    if (segment.type !== 'json') return [];
    try { return cardText(JSON.parse(String(segment.data.data ?? ''))); }
    catch { return []; }
  });
  const readableCards = [...new Set(cards)].slice(0, 30).join('\n');
  return [text, readableCards && `分享内容：\n${readableCards}`].filter(Boolean).join('\n');
}

export function humanMaterialText(value: string): string {
  return value
    .replace(/\n?分享卡片：\{[^\n]*\}\n?/g, '\n')
    .replace(/\b(?:message_?id|message_?key|group_?id|account_?id|sender_?id|real_?seq)\s*[:=]\s*[^\s,;]+/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function prepareSource(source: DailyMessageSource, settings: StoredModelSettings, options: DailyExtractionOptions): Promise<PreparedDailySource> {
  const signal = options.signal;
  signal.throwIfAborted();
  const repairBudget = { used: 0 };
  const references = source.referenceGraph?.references ?? [];
  const combined = { ...source.message, segments: [...source.message.segments] };
  const origins = source.message.segments.map((_, index) => ({ messageKey: source.message.key, index }));
  for (const { message, relation } of references) {
    combined.segments.push({ type: 'text', data: { text: `\n${relation === 'quoted' ? '引用原消息' : '相关回复'}（${new Date(message.time * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false })}，${message.senderName}）：\n` } });
    origins.push({ messageKey: message.key, index: -1 });
    for (const [index, segment] of message.segments.entries()) {
      combined.segments.push(segment);
      origins.push({ messageKey: message.key, index });
    }
  }
  const material = await collectMessageMaterials(
    combined,
    signal,
    settings.config.imageInput,
    options.download,
    options.resolveAttachment ? (index, childSignal) => {
      const origin = origins[index];
      if (!origin || origin.index < 0) return Promise.reject(new Error('引用附件无法读取。'));
      return options.resolveAttachment!(origin.messageKey, origin.index, childSignal);
    } : undefined,
    {
      readLinkedPages: false,
      sourceLabel: index => origins[index]?.messageKey === source.message.key ? `来源 ${source.ref}` : `来源 ${source.ref} 的引用原消息`,
    },
  );
  if (material.imageGroups.length) {
    const visual = await readVisualMaterials(material.imageGroups, settings, {
      signal, fetch: options.fetch, accountId: source.message.accountId, repairBudget,
    });
    if (visual.text) material.text += `\n图片文字：\n${visual.text}`;
    material.warnings.push(...visual.warnings);
  }
  const text = humanMessageText(source);
  const referenceText = references.map(({ message, relation }) =>
    `${relation === 'quoted' ? '引用原消息' : '相关回复'}（${new Date(message.time * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false })}，${message.senderName}）：\n${message.text.slice(0, 16000)}`)
    .join('\n\n');
  const extractedContent = [referenceText, humanMaterialText(material.text)].filter(Boolean).join('\n\n');
  material.warnings.push(...(source.referenceGraph?.warnings ?? []));
  if (source.referenceGraph?.missing.length) material.warnings.push('引用的原消息尚未取得，相关信息可能不完整。');
  return {
    ...source,
    displayTime: new Date(source.message.time * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }),
    text: text.slice(0, 16000),
    links: classifiedLinks(`${text}\n${extractedContent}`),
    extractedContent,
    materials: material.materials,
    warnings: [...new Set(material.warnings)],
    relatedMessages: references.map(({ message, relation }) => ({
      messageKey: message.key, text: message.text.slice(0, 16000), messageTime: message.time, senderName: message.senderName, relation,
    })),
  };
}

export async function buildDailySources(
  sources: DailyMessageSource[], settings: StoredModelSettings, options: DailyExtractionOptions, concurrency = 2,
): Promise<PreparedDailySource[]> {
  const output = new Array<PreparedDailySource>(sources.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < sources.length) {
      const index = cursor++;
      output[index] = await prepareSource(sources[index], settings, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
  return output;
}
