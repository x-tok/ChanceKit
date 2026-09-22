import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { StoredModelSettings } from '../../../models/model-settings';
import { createConfiguredPiAgent } from '../../../models/pi-model';
import { ExtractionFailure } from '../../extraction-failure';
import { buildDailyPromptPayload, DAILY_EXTRACTION_SYSTEM_PROMPT } from './prompt';
import { buildDailySources } from './source-builder';
import {
  dailyStructuredSamplingParams, isUnsupportedStructuredOutputError, parseDailyTextSubmission, repairStructuredSubmission,
  StructuredOutputTruncatedError,
} from './structured-output';
import { createDailyAgentTools } from './tools/index';
import { mergeActivityFacts, sameRecruitingEvent } from '../dedupe';
import type { DailyActivityOutput, DailyExtractedActivity, DailyExtractionOptions, DailyExtractionResult, DailyProcessingJob, PreparedDailySource } from '../types';

export { parseDailyTextSubmission } from './structured-output';

const MAX_PROMPT_CHARS = 600_000;
const INPUT_CONTEXT_SHARE = 0.65;
const CONTEXT_SAFETY_TOKENS = 2_048;

function sourceSize(source: PreparedDailySource) {
  return source.text.length + source.extractedContent.length + source.links.reduce((sum, link) => sum + link.url.length, 0) + 300;
}

export function dailyPromptCharBudget(config: StoredModelSettings['config']): number {
  const contextShare = Math.floor(config.contextWindow * INPUT_CONTEXT_SHARE);
  const hardLimit = Math.max(1, config.contextWindow - config.maxTokens - CONTEXT_SAFETY_TOKENS);
  // One character per token is deliberately conservative for Chinese-heavy QQ messages.
  return Math.max(1, Math.min(MAX_PROMPT_CHARS, contextShare, hardLimit));
}

function assistantText(messages: AgentMessage[]): string[] {
  return messages.flatMap(message => message.role === 'assistant'
    ? [message.content.filter(block => block.type === 'text').map(block => block.text).join('').trim()].filter(Boolean)
    : []);
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
  const toolset = createDailyAgentTools({ sources, settings, options });
  const nativeSamplingParams = dailyStructuredSamplingParams(settings.config.api);
  const runAgent = async (samplingParams: Record<string, unknown> | undefined): Promise<AgentMessage[]> => {
    const agent = createConfiguredPiAgent(settings, {
      fetch: options.fetch, signal: options.signal, systemPrompt: DAILY_EXTRACTION_SYSTEM_PROMPT, timeoutMs: 120_000,
      samplingParams,
    });
    let turns = 0;
    agent.shouldStopAfterTurn = () => ++turns >= 4;
    agent.state.tools = toolset.tools;
    const abort = () => agent.abort();
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      await agent.prompt(JSON.stringify(buildDailyPromptPayload(sourceDay, sources)));
      options.signal.throwIfAborted();
      const last = agent.state.messages.findLast(message => message.role === 'assistant');
      if (!last || (last.role === 'assistant' && ['error', 'aborted'].includes(last.stopReason))) {
        throw new Error(last?.role === 'assistant' ? last.errorMessage || '模型处理失败。' : '模型未返回处理结果。');
      }
      if (last.stopReason === 'length') throw new StructuredOutputTruncatedError('模型结构化输出达到最大长度。');
      return [...agent.state.messages];
    } finally {
      options.signal.removeEventListener('abort', abort);
      agent.abort();
    }
  };

  let usedNativeOutput = Boolean(nativeSamplingParams);
  let messages: AgentMessage[];
  try {
    messages = await runAgent(nativeSamplingParams);
  } catch (error) {
    if (!nativeSamplingParams || !isUnsupportedStructuredOutputError(error)) throw error;
    usedNativeOutput = false;
    messages = await runAgent(undefined);
  }
  for (const text of assistantText(messages).reverse()) {
    const parsed = parseDailyTextSubmission(text, sources, toolset.allowedLinks);
    if (parsed) return parsed;
  }
  return repairStructuredSubmission(sourceDay, sources, settings, options, messages, toolset.allowedLinks, usedNativeOutput);
}

async function extractChunkWithinOutputLimit(
  sourceDay: string, sources: PreparedDailySource[], settings: StoredModelSettings, options: DailyExtractionOptions,
): Promise<DailyActivityOutput> {
  try {
    return await extractChunk(sourceDay, sources, settings, options);
  } catch (error) {
    if (!(error instanceof StructuredOutputTruncatedError) || sources.length < 2) throw error;
    const middle = Math.ceil(sources.length / 2);
    const left = await extractChunkWithinOutputLimit(sourceDay, sources.slice(0, middle), settings, options);
    const right = await extractChunkWithinOutputLimit(sourceDay, sources.slice(middle), settings, options);
    return [...left, ...right];
  }
}

function mergeExtractedActivities(activities: DailyActivityOutput): DailyActivityOutput {
  const merged: DailyActivityOutput = [];
  for (const incoming of activities) {
    const index = merged.findIndex(current => sameRecruitingEvent(current, incoming));
    if (index < 0) { merged.push(incoming); continue; }
    const current = merged[index];
    const sourceRefs = [...new Set([...current.sourceRefs, ...incoming.sourceRefs])];
    merged[index] = { ...mergeActivityFacts(current, incoming), sourceRefs };
  }
  return merged;
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
    const promptBudget = dailyPromptCharBudget(settings.config);
    for (const chunk of splitDailySources(sources, promptBudget)) {
      const extracted = await extractChunkWithinOutputLimit(job.sourceDay, chunk, settings, runOptions);
      activities.push(...extracted);
    }
    const warnings = [...new Set(sources.flatMap(source => source.warnings))];
    const reviewReasons = warnings.filter(warning => /未读取|未展开|不支持|缺少可读取|无法辨认|读取失败|内容可能不完整|需核对原图/.test(warning));
    return { activities: mergeExtractedActivities(activities), sources, warnings, reviewReasons };
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason;
    if (signal.aborted) throw new ExtractionFailure('当日消息处理超时，将按队列策略重试。', sources.flatMap(source => source.materials));
    throw new ExtractionFailure(redactError(error, settings.apiKey), sources.flatMap(source => source.materials));
  }
}
