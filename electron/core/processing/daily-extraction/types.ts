import type { ActivityInput, ActivitySource, RelatedMessageSource } from '../../../../src/schedule';
import type { Message } from '../../../../src/shared';

export type SourceLinkKind = 'wechat-article' | 'registration' | 'direct-image' | 'webpage';

export interface ClassifiedSourceLink {
  url: string;
  kind: SourceLinkKind;
}

export interface DailyMessageSource {
  ref: number;
  message: Message;
  contentHash: string;
  groupName: string;
  referenceGraph?: import('../../archive/message-references').ReferenceGraph;
}

export interface DailyProcessingJob {
  key: string;
  accountId: string;
  sourceDay: string;
  hash: string;
  attempts: number;
  messages: DailyMessageSource[];
}

export interface PreparedDailySource extends DailyMessageSource {
  displayTime: string;
  text: string;
  links: ClassifiedSourceLink[];
  extractedContent: string;
  materials: ActivitySource['materials'];
  warnings: string[];
  relatedMessages?: RelatedMessageSource[];
}

export interface DailyExtractedActivity extends ActivityInput {
  sourceRefs: number[];
}

export interface DailyRecruitingInformation {
  sourceRef: number;
  title: string;
  summary: string;
}

export interface DailyExtractionResult {
  activities: DailyExtractedActivity[];
  information: DailyRecruitingInformation[];
  sources: PreparedDailySource[];
  warnings: string[];
  reviewReasons?: string[];
}

export interface DailyExtractionOptions {
  signal: AbortSignal;
  fetch?: typeof fetch;
  download?: import('../../materials/message-materials').MaterialDownload;
  resolveAttachment?: (messageKey: string, segmentIndex: number, signal: AbortSignal) => Promise<import('../../materials/material-document').ResolvedAttachment>;
  readWebpagePdf?: (messageKey: string, input: import('../../materials/webpage-pdf').WebpagePdfRequest, signal: AbortSignal,
    consumePages?: (pages: import('../../materials/material-pdf').PdfPageImage[], totalPages: number) => Promise<void>) => Promise<import('../../materials/webpage-pdf').WebpagePdfResult>;
}
