import type { StoredModelSettings } from '../../../models/model-settings';
import { createConfiguredPiAgent } from '../../../models/pi-model';
import { ExtractionFailure } from '../../extraction-failure';
import { buildDailyPromptPayload, DAILY_EXTRACTION_SYSTEM_PROMPT } from './prompt';
import { buildDailySources } from './source-builder';
import { createDailyAgentTools } from './tools/index';
import type { DailyActivityOutput, DailyExtractedActivity, DailyExtractionOptions, DailyExtractionResult, DailyProcessingJob, PreparedDailySource } from '../types';

const MAX_PROMPT_CHARS = 220_000;

function sourceSize(source: PreparedDailySource) {
  return source.text.length + source.extractedContent.length + source.links.reduce((sum, link) => sum + link.url.length, 0) + 300;
}

export function splitDailySources(sources: PreparedDailySource[], maxChars = MAX_PROMPT_CHARS): PreparedDailySource[][] {
  const chunks: PreparedDailySource[][] = [];
  let current: PreparedDailySource[] = [];
  let size = 0;
  for (const source of sources) {
    const next = sourceSize(source);
    if (current.length && (size + next > maxChars || current.length >= 180)) { chunks.push(current); current = []; size = 0; }
    current.push(source); size += next;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function extractChunk(
  sourceDay: string, sources: PreparedDailySource[], settings: StoredModelSettings, options: DailyExtractionOptions,
): Promise<DailyActivityOutput> {
  const agent = createConfiguredPiAgent(settings, {
    fetch: options.fetch, signal: options.signal, systemPrompt: DAILY_EXTRACTION_SYSTEM_PROMPT, timeoutMs: 120_000,
  });
  let captured: DailyActivityOutput | undefined;
  let turns = 0;
  agent.shouldStopAfterTurn = () => captured !== undefined || ++turns >= 4;
  agent.state.tools = createDailyAgentTools({
    sources, settings, options,
    submit(value) { options.signal.throwIfAborted(); if (captured) throw new Error('本批次已经提交。'); captured = value; },
  });
  const abort = () => agent.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    await agent.prompt(JSON.stringify(buildDailyPromptPayload(sourceDay, sources)));
    options.signal.throwIfAborted();
    const last = agent.state.messages.findLast(message => message.role === 'assistant');
    if (last?.role === 'assistant' && ['error', 'aborted'].includes(last.stopReason)) throw new Error(last.errorMessage || '模型处理失败。');
    if (!captured) throw new Error('模型没有返回有效的结构化结果。');
    return captured;
  } finally {
    options.signal.removeEventListener('abort', abort);
    agent.abort();
  }
}

function redactError(error: unknown, apiKey: string) {
  const value = error instanceof Error ? error.message : '当日消息整理失败。';
  return (apiKey ? value.replaceAll(apiKey, '[已隐藏密钥]').replaceAll(encodeURIComponent(apiKey), '[已隐藏密钥]') : value)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏密钥]').slice(0, 800);
}

export async function extractDailyActivities(
  job: DailyProcessingJob, settings: StoredModelSettings, options: DailyExtractionOptions,
): Promise<DailyExtractionResult> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(20 * 60_000)]);
  const runOptions = { ...options, signal };
  let sources: PreparedDailySource[] = [];
  try {
    sources = await buildDailySources(job.messages, settings, runOptions);
    const activities: DailyExtractedActivity[] = [];
    const promptBudget = Math.min(MAX_PROMPT_CHARS, Math.max(40_000, Math.floor(settings.config.contextWindow * 1.2)));
    for (const chunk of splitDailySources(sources, promptBudget)) {
      const extracted = await extractChunk(job.sourceDay, chunk, settings, runOptions);
      activities.push(...extracted);
    }
    const warnings = [...new Set(sources.flatMap(source => source.warnings))];
    const reviewReasons = warnings.filter(warning => /未读取|未展开|不支持|缺少可读取|无法辨认|读取失败|内容可能不完整|需核对原图/.test(warning));
    return { activities, sources, warnings, reviewReasons };
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason;
    if (signal.aborted) throw new ExtractionFailure('当日消息处理超时，将按队列策略重试。', sources.flatMap(source => source.materials));
    throw new ExtractionFailure(redactError(error, settings.apiKey), sources.flatMap(source => source.materials));
  }
}
