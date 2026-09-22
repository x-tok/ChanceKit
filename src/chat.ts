import type { ActivityInput, ActivitySource } from './schedule';

export type JobChatRole = 'user' | 'assistant';
export interface JobResultRef { messageKey: string; activityId?: string }
export const jobResultKey = (item: JobResultRef) => item.activityId ? `activity:${item.activityId}` : `message:${item.messageKey}`;

export interface JobOpportunity extends JobResultRef {
  messageKey: string;
  title: string;
  summary: string;
  groupId: string;
  groupName: string;
  messageTime: number;
  category: 'information' | 'incomplete' | 'activity' | 'processed';
  matchedBy: string[];
  sourceUrl?: string;
  activityType?: string;
  startDate?: string | null;
  location?: string;
}

export interface JobResultDetail {
  item: JobOpportunity;
  activity?: ActivityInput;
  sources: ActivitySource[];
}

export interface ChatWebSource {
  kind: 'web';
  url: string;
  title: string;
  summary: string;
  fetchedAt: number;
  status: 'snippet' | 'read' | 'unavailable';
  text?: string;
  note?: string;
}

export interface JobChatMessage {
  id: string;
  role: JobChatRole;
  content: string;
  createdAt: number;
  opportunities: JobOpportunity[];
  webSources?: ChatWebSource[];
}

export interface JobChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  preview: string;
}

export interface JobChatDataset {
  information: number;
  incomplete: number;
  activities?: number;
  processed?: number;
  followedGroups: number;
  newestMessageAt?: number;
}

export interface JobChatOverview {
  sessions: JobChatSession[];
  dataset: JobChatDataset;
}

export interface JobChatDetail {
  session: JobChatSession;
  messages: JobChatMessage[];
}

export interface JobChatSendResult {
  session: JobChatSession;
  message: JobChatMessage;
}
