import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { StoredModelSettings } from '../../../../models/model-settings';
import type { DailyExtractionOptions, PreparedDailySource } from '../../types';
import { createReadSourceLinksTool } from './read-source-links';

export const DAILY_AGENT_TOOL_NAMES = ['read_source_links'] as const;

export function createDailyAgentTools(input: {
  sources: PreparedDailySource[];
  settings: StoredModelSettings;
  options: DailyExtractionOptions;
}): { tools: AgentTool<any>[]; allowedLinks: Set<string> } {
  const allowedLinks = new Set(input.sources.flatMap(source => source.links.map(link => link.url)));
  return {
    tools: [createReadSourceLinksTool(input.sources, input.settings, input.options, allowedLinks)],
    allowedLinks,
  };
}
