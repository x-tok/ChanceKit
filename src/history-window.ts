const RECENT_HISTORY_DAYS = 3;
const CHINA_TIME_ZONE = 'Asia/Shanghai';

export interface RecentHistoryWindow {
  date: string;
  since: number;
}

export function recentHistoryWindow(now = new Date()): RecentHistoryWindow {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CHINA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const today = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - RECENT_HISTORY_DAYS);
  const date = start.toISOString().slice(0, 10);
  return { date, since: Math.floor(Date.parse(`${date}T00:00:00+08:00`) / 1000) };
}
