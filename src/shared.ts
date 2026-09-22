export type Phase = 'idle' | 'preparing' | 'starting' | 'qr' | 'connecting' | 'online' | 'reconnecting' | 'stopping' | 'error';
export interface ConnectionConfig {
  wsUrl: string;
  accessToken: string;
  webuiUrl: string;
  webuiToken: string;
}
export interface Account { id: string; nickname: string }
export interface Group { id: string; name: string; memberCount: number; maxMembers: number; followed: boolean; messageCount: number; lastMessageAt?: number }
export interface Segment { type: string; data: Record<string, unknown> }
export interface Message {
  key: string; accountId: string; groupId: string; externalId: string; realSeq?: string;
  senderId: string; senderName: string; time: number; segments: Segment[]; text: string;
  raw: Record<string, unknown>; receivedAt: number;
}
export interface QQInstallation { path: string; version: string; architecture: string; platform: string }
export interface AppState {
  phase: Phase; detail: string; error?: string; qr?: string; account?: Account;
  // Archive context survives disconnect; account is only the confirmed live session.
  localAccount?: Account;
  groups: Group[]; runtime: 'managed' | 'external' | null; qq?: QQInstallation;
  archived: number; lastEventAt?: number; logs: { time: number; text: string }[];
  historyBusy: boolean;
}
export interface HistoryResult {
  added: number;
  received: number;
  canContinue: boolean;
  boundary: 'more' | 'uncertain' | 'empty';
  oldestTime?: number;
  reachedStart?: boolean;
}
export interface MessagePage { messages: Message[]; total: number; hasMore: boolean }
export type Command =
  | { type: 'state' }
  | { type: 'detect'; path?: string }
  | { type: 'start'; path: string }
  | { type: 'connect'; config: ConnectionConfig }
  | { type: 'disconnect' }
  | { type: 'refreshQR' }
  | { type: 'refreshGroups' }
  | { type: 'follow'; groupId: string; followed: boolean }
  | { type: 'history'; groupId: string; older: boolean; since?: number }
  | { type: 'messages'; groupId: string; search: string; offset: number }
  | { type: 'export'; groupId: string }
  | { type: 'forward'; id: string };
export type AppEvent = { type: 'state'; state: AppState } | { type: 'messages'; groupId: string } | { type: 'schedule' };
export interface DesktopBridge {
  platform?: 'darwin' | 'win32' | 'linux';
  request<T = unknown>(command: Command): Promise<T>;
  subscribe(listener: (event: AppEvent) => void): () => void;
  chooseQQ(): Promise<string | null>;
  exportMessages(groupId: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  openWebpagePdf(messageKey: string, snapshotId: string): Promise<void>;
  savedConnection(): Promise<Partial<ConnectionConfig>>;
  onboardingStatus?(): Promise<{ completed: boolean }>;
  completeOnboarding?(accountId: string): Promise<void>;
  openQQDownload?(): Promise<void>;
  modelCatalog(): Promise<ModelProviderEntry[]>;
  modelSettings(): Promise<ModelSettings>;
  saveModelSettings(input: ModelConfigInput): Promise<ModelSettings>;
  clearModelSettings(): Promise<ModelSettings>;
  testModelSettings(input: ModelConfigInput): Promise<ModelTestResult>;
  cancelModelTest(): Promise<void>;
  schedule(query: ScheduleQuery): Promise<SchedulePage>;
  activity(id: string): Promise<ActivityDetail | null>;
  recruitingInformation(query: InformationQuery): Promise<InformationPage>;
  informationDetail(messageKey: string): Promise<InformationDetail | null>;
  processingStatus(): Promise<ProcessingStatus>;
  processingDetails(query: ProcessingDetailsQuery): Promise<ProcessingDetailsPage>;
  configureProcessing(value: { enabled: boolean; concurrency: number; stopWhenIdle?: boolean; since?: number }): Promise<ProcessingStatus>;
  retryProcessing(messageKey?: string): Promise<ProcessingStatus>;
  jobChatOverview(): Promise<JobChatOverview>;
  jobChatSession(sessionId: string): Promise<JobChatDetail | null>;
  jobChatResult(ref: JobResultRef): Promise<JobResultDetail | null>;
  sendJobChat(input: { sessionId?: string; content: string }): Promise<JobChatSendResult>;
  cancelJobChat(sessionId: string): Promise<void>;
  deleteJobChat(sessionId: string): Promise<boolean>;
}
declare global { interface Window { desktop?: DesktopBridge } }
import type { ModelConfigInput, ModelProviderEntry, ModelSettings, ModelTestResult } from './model-config';
import type { ActivityDetail, InformationDetail, InformationPage, InformationQuery, ProcessingDetailsPage, ProcessingDetailsQuery, ProcessingStatus, SchedulePage, ScheduleQuery } from './schedule';
import type { JobChatDetail, JobChatOverview, JobChatSendResult, JobResultDetail, JobResultRef } from './chat';
