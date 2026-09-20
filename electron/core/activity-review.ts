import type { Message } from '../../src/shared';
import { addDays, chinaToday, isOngoingActivity, type ActivityInput } from '../../src/schedule';
import { linksInSourceText } from './material-links';

const compact = (text: string) => text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
const sessionWords = /宣讲|双选|招聘会|面试|笔试|讲座|直播|交流会/;
const dependencies = /详见|以.{0,12}为准|时间.{0,8}(?:另行|待定|海报|附件)|另有|多场|巡回|场次表|改期|更正|取消/;

export function isPlainJobAdvertisement(message: Message): boolean {
  const text = message.text;
  if (text.length < 50 || text.length > 16000 || message.segments.some(segment => segment.type !== 'text')) return false;
  if (!/校园招聘|校招|招聘岗位/.test(text) || !/投递|内推|职位|岗位/.test(text) || sessionWords.test(text) || dependencies.test(text)) return false;
  // A cohort year is not a date; any possible window/deadline goes through extraction.
  if (/\d{1,2}\s*(?:月|[./-])\s*\d{1,2}|今天|明天|后天|截止|截至|即日起|报名时间|招聘时间|周[一二三四五六日天]/.test(text)) return false;
  return linksInSourceText(text).every(link => {
    const url = new URL(link);
    return /^(?:jobs?|careers?|campus|recruit|zhaopin)\./i.test(url.hostname)
      || /\/(?:campus|positions?|careers?|recruit|jobs?)(?:\/|$)/i.test(`${url.pathname}${url.hash}`);
  });
}

export function canTryMessageFirst(message: Message): boolean {
  return message.text.length >= 60 && message.text.length <= 16000
    && sessionWords.test(message.text) && /\d{1,2}[:：]\d{2}/.test(message.text)
    && !dependencies.test(message.text)
    && message.segments.every(segment => ['text', 'image'].includes(segment.type));
}

function dateSupported(date: string, text: string, messageTime: number): boolean {
  const [year, month, day] = date.split('-').map(Number);
  const normalized = text.normalize('NFKC');
  const full = new RegExp(`(?<!\\d)${year}\\s*(?:年|[-/.])\\s*0?${month}\\s*(?:月|[-/.])\\s*0?${day}(?!\\d)`);
  if (full.test(normalized)) return true;
  const sent = chinaToday(new Date(messageTime * 1000));
  // Month/day can use the message year, but cannot override a different explicit year.
  const withoutFullDates = normalized.replace(/\d{4}\s*(?:年|[-/.])\s*\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}/g, '');
  if (year === Number(sent.slice(0, 4))
    && new RegExp(`(?<!\\d)0?${month}\\s*(?:月|[-/.])\\s*0?${day}(?!\\d)`).test(withoutFullDates)) return true;
  return [['今天', 0], ['明天', 1], ['后天', 2]].some(([word, offset]) =>
    normalized.includes(String(word)) && date === addDays(sent, Number(offset)));
}

function timeSupported(time: string, text: string): boolean {
  const [hour, minute] = time.split(':').map(Number);
  return new RegExp(`(?<!\\d)0?${hour}\\s*(?:[:：]|点|时)\\s*0?${minute}(?!\\d)`).test(text.normalize('NFKC'));
}

export function supportedActivity(activity: ActivityInput, text: string, messageTime: number, groupName = ''): boolean {
  if (!activity.startDate || !dateSupported(activity.startDate, text, messageTime)) return false;
  if (activity.endDate && !dateSupported(activity.endDate, text, messageTime)) return false;
  if (activity.startTime && !timeSupported(activity.startTime, text)) return false;
  if (activity.endTime && !timeSupported(activity.endTime, text)) return false;
  if (!isOngoingActivity(activity) && (!activity.startTime || !activity.location)) return false;
  let location = activity.location;
  const university = location.match(/^(.+?大学)/)?.[1];
  if (university && compact(`${text}\n${groupName}`).includes(compact(university))) location = location.slice(university.length);
  if (location && !compact(text).includes(compact(location))) return false;
  // Models often join several verbatim excerpts with semicolons/ellipses. Core fields are
  // checked separately; an unrelated registration excerpt must not invalidate a good event quote.
  const quotes = activity.evidence.split(/[；;\n…]+/).map(compact);
  return quotes.some(quote => quote.length >= 12 && compact(text).includes(quote))
    && (isOngoingActivity(activity) ? /报名|招聘|投递/.test(text) : text.includes(activity.type));
}

export function reviewActivities(message: Message, activities: ActivityInput[], warnings: string[], sourceText = message.text, groupName = ''): string[] {
  // An explicitly undated notice is not a failed read; the calendar already labels its missing date.
  if (!warnings.length) return [];
  const reasons: string[] = [];
  if (activities.some(activity => !activity.startDate)) reasons.push('活动日期尚未明确。');
  if (activities.some(activity => activity.startDate && !activity.startTime && !isOngoingActivity(activity))) reasons.push('活动开始时间尚未明确。');
  if (activities.length && !dependencies.test(sourceText)
    && activities.every(activity => supportedActivity(activity, sourceText, message.time, groupName))) return reasons;
  if (!activities.length && isPlainJobAdvertisement(message)) return reasons;
  if (warnings.some(warning => /网页 PDF/.test(warning))) reasons.push('网页部分内容尚未读全，已保留可读信息和原网页。');
  else if (warnings.some(warning => /文件|PDF/.test(warning))) reasons.push('附件中的活动信息尚未读全，请核对原文件。');
  else if (warnings.some(warning => /图片|图像|分片|海报/.test(warning))) reasons.push('海报中的活动信息仍无法确认，请补充清晰原图或核对原消息。');
  else reasons.push('来源信息不足，尚不能确认是否包含其他活动，请核对原消息。');
  return [...new Set(reasons)];
}
