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
  materials: { url: string; kind: 'page' | 'image' | 'file'; title?: string; snapshotId?: string;
    pdfCoverage?: { totalPages: number; processedPages: number }; notices?: string[] }[];
  warnings: string[];
  reviewReasons?: string[];
  relatedMessages?: RelatedMessageSource[];
}
export interface RelatedMessageSource {
  messageKey: string; text: string; messageTime: number; senderName: string; relation: 'quoted' | 'related-reply';
}
export interface ActivityDetail { activity: Activity; sources: ActivitySource[] }
export interface RecruitingInformationInput { title: string; summary: string }
export type InformationCategory = 'information' | 'incomplete';
export interface RecruitingInformation extends RecruitingInformationInput {
  messageKey: string;
  groupId: string;
  groupName: string;
  messageTime: number;
  category: InformationCategory;
  processingState: 'pending' | 'running' | 'completed' | 'partial' | 'failed';
}
export interface InformationDetail {
  item: RecruitingInformation;
  text: string;
  senderName: string;
  materials: ActivitySource['materials'];
  diagnostics: string[];
  reason: string;
  activityIds: string[];
  relatedMessages?: RelatedMessageSource[];
}
export interface InformationQuery { category: InformationCategory; groupId?: string; search?: string; offset?: number }
export interface InformationPage {
  items: RecruitingInformation[];
  total: number;
  counts: Record<InformationCategory, number>;
  hasMore: boolean;
}
export const emptyInformationPage: InformationPage = { items: [], total: 0, counts: { information: 0, incomplete: 0 }, hasMore: false };
export interface ScheduleQuery { week: string; type?: ActivityType; groupId?: string; search?: string }
export interface SchedulePage {
  activities: Activity[]; undated: Activity[];
  sources?: Record<string, ActivitySource[]>;
}
export interface ProcessingStatus {
  processorVersion?: number;
  incompleteInformation?: number;
  enabled: boolean;
  stopWhenIdle?: boolean;
  since?: number;
  concurrency: number;
  pending: number;
  running: number;
  completed: number;
  partial: number;
  failed: number;
  blockedReason?: string;
  issues: { messageKey: string; groupName: string; text: string; error: string; status: 'failed' | 'partial' }[];
}
export type ProcessingMessageBucket = 'pending' | 'running' | 'completed';
export type ProcessingMessageState = 'pending' | 'running' | 'completed' | 'partial' | 'failed';
export interface ProcessingMessageItem {
  key: string;
  bucket: ProcessingMessageBucket;
  state: ProcessingMessageState;
  groupName: string;
  senderName: string;
  messageTime: number;
  text: string;
  contentTypes: string[];
  activityTitles: string[];
  error: string;
}
export interface ProcessingDetailsQuery {
  bucket: ProcessingMessageBucket;
  since: number;
  offset?: number;
  limit?: number;
}
export interface ProcessingDetailsPage {
  items: ProcessingMessageItem[];
  total: number;
  hasMore: boolean;
  counts: Record<ProcessingMessageBucket, number>;
}
export const emptyProcessingDetails: ProcessingDetailsPage = {
  items: [], total: 0, hasMore: false, counts: { pending: 0, running: 0, completed: 0 },
};
export const scheduleProcessingVersion = 3;
export const emptyProcessingStatus: ProcessingStatus = {
  processorVersion: scheduleProcessingVersion,
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
// The API's legacy "week" field is the first day of any seven-day window.
export function calendarWindowStart(date: string): string {
  const start = addDays(date, -3);
  return start < '1970-01-01' ? '1970-01-01' : start > '2100-12-25' ? '2100-12-25' : start;
}
export function activityTimeLabel(activity: Pick<ActivityInput, 'startTime' | 'endTime'>): string {
  if (activity.startTime && activity.endTime) return `${activity.startTime}–${activity.endTime}`;
  if (activity.startTime) return activity.startTime;
  if (activity.endTime) return `未定–${activity.endTime}`;
  return '未定';
}
export function activityOnDate(activity: Activity, date: string): boolean {
  return Boolean(activity.startDate && activity.startDate <= date && (activity.endDate ?? activity.startDate) >= date);
}

export function isOngoingActivity(activity: ActivityInput): boolean {
  return activity.type === '其他' && Boolean(activity.startDate && activity.endDate && activity.endDate > activity.startDate);
}
