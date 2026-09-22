import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { StoredModelSettings } from '../../../models/model-settings';
import { createConfiguredPiAgent } from '../../../models/pi-model';
import type { DailyActivityOutput, DailyExtractionOptions, PreparedDailySource } from '../types';
import { dailyActivityOutputJsonSchema, parseDailySubmission } from './activity-output';
import { buildDailyPromptPayload, DAILY_EXTRACTION_SYSTEM_PROMPT } from './prompt';
import { createSubmitDailyActivitiesTool } from './tools/submit-daily-activities';

const UNSUPPORTED_STRUCTURED_OUTPUT = /(?:response.?format|json.?schema|text\.format).*(?:unsupported|unknown|unrecognized|invalid)|(?:unsupported|unknown|unrecognized).*(?:response.?format|json.?schema|text\.format)/i;

export class StructuredOutputTruncatedError extends Error {
  override name = 'StructuredOutputTruncatedError';
}

export function isUnsupportedStructuredOutputError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return UNSUPPORTED_STRUCTURED_OUTPUT.test(message);
}

function validatedSubmission(input: unknown, sources: PreparedDailySource[], allowedLinks?: Set<string>): DailyActivityOutput {
  const links = allowedLinks ?? new Set(sources.flatMap(source => source.links.map(link => link.url)));
  const output = parseDailySubmission(Array.isArray(input) ? { activities: input } : input, new Set(sources.map(source => source.ref)));
  for (const activity of output) if (activity.registrationUrl && !links.has(activity.registrationUrl)) activity.registrationUrl = null;
  return output;
}

function submissionCandidates(text: string): string[] {
  return [text.trim(), ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1].trim())]
    .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index);
}

function parseDailyTextSubmissionResult(
  text: string, sources: PreparedDailySource[], allowedLinks?: Set<string>,
): { value?: DailyActivityOutput; error: string } {
  let lastError = '模型未返回日程 JSON。';
  for (const candidate of submissionCandidates(text)) {
    try {
      return { value: validatedSubmission(JSON.parse(candidate), sources, allowedLinks), error: '' };
    } catch (error) {
      lastError = error instanceof Error ? error.message : '返回值不是有效的日程 JSON。';
    }
  }
  return { error: lastError.slice(0, 1200) };
}

export function parseDailyTextSubmission(
  text: string, sources: PreparedDailySource[], allowedLinks?: Set<string>,
): DailyActivityOutput | undefined {
  return parseDailyTextSubmissionResult(text, sources, allowedLinks).value;
}

function assistantText(messages: AgentMessage[]): string[] {
  return messages.flatMap(message => message.role === 'assistant'
    ? [message.content.filter(block => block.type === 'text').map(block => block.text).join('').trim()].filter(Boolean)
    : []);
}

function toolEvidence(messages: AgentMessage[]): string[] {
  return messages.flatMap(message => message.role === 'toolResult'
    ? message.content.filter(block => block.type === 'text').map(block => block.text).filter(Boolean)
    : []);
}

function boundedToolEvidence(messages: AgentMessage[]): string[] {
  const retained: string[] = [];
  let remaining = 30_000;
  for (const value of toolEvidence(messages).reverse()) {
    if (remaining <= 0) break;
    retained.unshift(value.slice(0, remaining));
    remaining -= value.length;
  }
  return retained;
}

export function dailyStructuredSamplingParams(api: StoredModelSettings['config']['api']): Record<string, unknown> | undefined {
  if (api === 'openai-completions') return { response_format: { type: 'json_object' } };
  if (api === 'openai-responses') {
    return {
      text: {
        format: {
          type: 'json_schema', name: 'chancekit_daily_activities', strict: true, schema: dailyActivityOutputJsonSchema,
        },
      },
    };
  }
}

function lastAssistant(messages: AgentMessage[]) {
  return messages.findLast(message => message.role === 'assistant');
}

async function runStructuredSubmission(
  sourceDay: string, sources: PreparedDailySource[], settings: StoredModelSettings, options: DailyExtractionOptions,
  priorMessages: AgentMessage[], allowedLinks: Set<string>,
): Promise<DailyActivityOutput> {
  const agent = createConfiguredPiAgent(settings, {
    fetch: options.fetch,
    signal: options.signal,
    systemPrompt: `${DAILY_EXTRACTION_SYSTEM_PROMPT}\nThis is the final submission stage. Call submit_daily_activities now. No other response is accepted.`,
    timeoutMs: 120_000,
    requireToolCall: true,
  });
  let captured: DailyActivityOutput | undefined;
  let turns = 0;
  agent.state.tools = [createSubmitDailyActivitiesTool(
    new Set(sources.map(source => source.ref)), allowedLinks, value => { captured = value; },
  )];
  agent.shouldStopAfterTurn = () => captured !== undefined || ++turns >= 2;
  const abort = () => agent.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    await agent.prompt(JSON.stringify({
      ...buildDailyPromptPayload(sourceDay, sources),
      supplementalEvidence: boundedToolEvidence(priorMessages),
      priorDraft: (assistantText(priorMessages).at(-1) ?? '').slice(0, 30_000),
      requiredOutput: 'Call submit_daily_activities with {"activities": [...]} now.',
    }));
    options.signal.throwIfAborted();
    if (captured) return captured;
    const last = lastAssistant(agent.state.messages);
    if (!last || (last.role === 'assistant' && ['error', 'aborted'].includes(last.stopReason))) {
      throw new Error(last?.role === 'assistant' ? last.errorMessage || '模型结构化输出请求失败。' : '模型未返回结构化输出。');
    }
    if (last.stopReason === 'length') throw new StructuredOutputTruncatedError('模型结构化输出达到最大长度。');
    throw new Error('模型未能提交符合格式的日程结果。');
  } finally {
    options.signal.removeEventListener('abort', abort);
    agent.abort();
  }
}

export async function repairStructuredSubmission(
  sourceDay: string, sources: PreparedDailySource[], settings: StoredModelSettings, options: DailyExtractionOptions,
  priorMessages: AgentMessage[], allowedLinks: Set<string>,
): Promise<DailyActivityOutput> {
  return runStructuredSubmission(sourceDay, sources, settings, options, priorMessages, allowedLinks);
}
