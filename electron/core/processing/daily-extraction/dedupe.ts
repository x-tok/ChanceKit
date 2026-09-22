import { createHash } from 'node:crypto';
import type { ActivityInput } from '../../../../src/schedule';

export function normalizedEventText(value: string): string {
  return value.normalize('NFKC').toLowerCase()
    .replace(/20\d{2}(?:届|年)?/g, '')
    .replace(/(?:校园|秋季|春季|线上|线下|专场|招聘|宣讲|双选|见面)(?:会|活动)?/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function grams(value: string): Set<string> {
  const clean = normalizedEventText(value);
  if (clean.length <= 1) return new Set(clean ? [clean] : []);
  return new Set(Array.from({ length: clean.length - 1 }, (_, index) => clean.slice(index, index + 2)));
}

export function textSimilarity(a: string, b: string): number {
  const left = grams(a), right = grams(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const value of left) if (right.has(value)) shared++;
  return 2 * shared / (left.size + right.size);
}

function compatible(a: string | null, b: string | null) {
  return !a || !b || a === b;
}

export function sameRecruitingEvent(a: ActivityInput, b: ActivityInput): boolean {
  if (!compatible(a.startDate, b.startDate) || !compatible(a.startTime, b.startTime)) return false;
  if (a.type !== b.type && a.type !== '其他' && b.type !== '其他') return false;
  const title = textSimilarity(a.title, b.title);
  const organizer = textSimilarity(a.organizer, b.organizer);
  const location = textSimilarity(a.location, b.location);
  const exactTitle = normalizedEventText(a.title) === normalizedEventText(b.title) && Boolean(normalizedEventText(a.title));
  if (!a.startDate || !b.startDate) return exactTitle && (organizer >= 0.6 || location >= 0.7 || a.location === b.location);
  if (exactTitle && (compatible(a.startTime, b.startTime) || location >= 0.6)) return true;
  if (title >= 0.78 && (organizer >= 0.35 || location >= 0.55 || a.startTime === b.startTime)) return true;
  return organizer >= 0.72 && title >= 0.48 && (location >= 0.55 || Boolean(a.startTime && a.startTime === b.startTime));
}

export function mergeActivityFacts(current: ActivityInput, incoming: ActivityInput): ActivityInput {
  const prefer = (a: string, b: string) => a || b;
  const longer = (a: string, b: string) => b.length > a.length ? b : a;
  return {
    title: current.title,
    type: current.type === '其他' && incoming.type !== '其他' ? incoming.type : current.type,
    organizer: prefer(current.organizer, incoming.organizer),
    startDate: current.startDate ?? incoming.startDate,
    endDate: current.endDate ?? incoming.endDate,
    startTime: current.startTime ?? incoming.startTime,
    endTime: current.endTime ?? incoming.endTime,
    location: prefer(current.location, incoming.location),
    audience: longer(current.audience, incoming.audience),
    description: longer(current.description, incoming.description),
    registrationUrl: current.registrationUrl ?? incoming.registrationUrl,
    deadline: current.deadline ?? incoming.deadline,
    evidence: current.evidence,
  };
}

export function activityIdentity(accountId: string, activity: ActivityInput): string {
  const identity = [accountId, normalizedEventText(activity.title), normalizedEventText(activity.organizer),
    activity.startDate, activity.startTime, normalizedEventText(activity.location)];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
