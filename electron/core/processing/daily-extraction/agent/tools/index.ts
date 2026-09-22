import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { StoredModelSettings } from '../../../../models/model-settings';
import type { DailyActivityOutput, DailyExtractionOptions, PreparedDailySource } from '../../types';
import { createReadSourceLinksTool } from './read-source-links';
import { createSubmitDailyActivitiesTool } from './submit-daily-activities';

export const DAILY_AGENT_TOOL_NAMES = ['read_source_links', 'submit_daily_activities'] as const;

export function createDailyAgentTools(input: {
  sources: PreparedDailySource[];
  settings: StoredModelSettings;
  options: DailyExtractionOptions;
  submit: (value: DailyActivityOutput) => void;
}): AgentTool<any>[] {
  const refs = new Set(input.sources.map(source => source.ref));
  const links = new Set(input.sources.flatMap(source => source.links.map(link => link.url)));
  return [
    createReadSourceLinksTool(input.sources, input.settings, input.options, links),
    createSubmitDailyActivitiesTool(refs, links, input.submit),
  ];
}
