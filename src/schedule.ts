export const activityTypes = ['宣讲会', '双选会', '招聘会', '面试', '笔试', '其他'] as const;
export type ActivityType = typeof activityTypes[number];
export interface ActivityInput {
  title: string;
  type: ActivityType;
  organizer: string;
  startDate: string | null;
  endDate: string | null;
  startTime: string | null;
  endTime: string | null;
  location: string;
  audience: string;
  description: string;
  registrationUrl: string | null;
  deadline: string | null;
  evidence: string;
}
export interface Activity extends ActivityInput {
  id: string;
  sourceCount: number;
  groupNames: string[];
  needsReview: boolean;
  updatedAt: number;
}
export interface ActivitySource {
  messageKey: string;
  groupId: string;
  groupName: string;
  senderName: string;
  messageTime: number;
  text: string;
  evidence: string;
  materials: { url: string; kind: 'page' | 'image' | 'file'; title?: string }[];
  warnings: string[];
}
export interface ActivityDetail { activity: Activity; sources: ActivitySource[] }
export interface ScheduleQuery { week: string; type?: ActivityType; groupId?: string; search?: string }
export interface SchedulePage { activities: Activity[]; undated: Activity[] }
export interface ProcessingStatus {
  enabled: boolean;
  concurrency: number;
  pending: number;
  running: number;
  completed: number;
  partial: number;
  failed: number;
  blockedReason?: string;
  issues: { messageKey: string; groupName: string; text: string; error: string; status: 'failed' | 'partial' }[];
}
export const emptyProcessingStatus: ProcessingStatus = {
  enabled: false, concurrency: 3, pending: 0, running: 0, completed: 0, partial: 0, failed: 0, issues: [],
};

export function chinaToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function weekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -(day === 0 ? 6 : day - 1));
}
export function activityOnDate(activity: Activity, date: string): boolean {
  return Boolean(activity.startDate && activity.startDate <= date && (activity.endDate ?? activity.startDate) >= date);
}
