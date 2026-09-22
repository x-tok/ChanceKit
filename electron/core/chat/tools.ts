import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { jobResultKey, type JobOpportunity, type JobResultDetail, type JobResultRef } from '../../../src/chat';
import { jobRecommendationSkills, type JobRecommendationSkill } from './skills';
import { JobChatStore, type OpportunityFilters } from './store';

const textArray = (description: string) => Type.Optional(Type.Array(
  Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 12, description },
));
const date = Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }));
const searchParameters = Type.Object({
  keywords: textArray('General company, industry, audience, graduation-year, or application keywords.'),
  cities: textArray('City names and common textual variants.'),
  regions: textArray('Broader geographic areas such as 华东 or 大湾区.'),
  companies: textArray('Company or organization names.'),
  companyTypes: textArray('Organization types such as 国企、央企、民企、外企、事业单位.'),
  workContents: textArray('Role names, technologies, responsibilities, or work directions.'),
  groupIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 20 })),
  postedAfter: date,
  postedBefore: date,
  includeIncomplete: Type.Optional(Type.Boolean()),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000, description: 'Skip this many matches to retrieve the next page.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
}, { additionalProperties: false });
const detailParameters = Type.Object({
  results: Type.Array(Type.Object({
    messageKey: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    activityId: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 6 }),
}, { additionalProperties: false });
const skillParameters = Type.Object({
  skill: Type.Union([
    Type.Literal('clarify-requirements'),
    Type.Literal('filter-opportunities'),
    Type.Literal('compare-opportunities'),
    Type.Literal('web-research'),
  ]),
}, { additionalProperties: false });

function searchText(opportunities: JobOpportunity[]) {
  if (!opportunities.length) return '当前筛选在本地已处理信息中没有匹配结果。';
  return JSON.stringify(opportunities.map(item => ({
    ...item, publishedAt: new Date(item.messageTime * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
  })));
}

function detailText(details: JobResultDetail[]) {
  return JSON.stringify(details.map(detail => ({
    ...detail, sources: detail.sources.slice(0, 6).map(source => ({
      ...source, text: source.text.slice(0, 6000), materials: source.materials.slice(0, 12),
    })),
  })));
}

export function createJobChatTools(
  store: JobChatStore,
  accountId: string,
  onSearch: (opportunities: JobOpportunity[]) => void,
): AgentTool[] {
  const allowed = new Set<string>();
  return [
    {
      name: 'load_job_recommendation_skill',
      label: '加载求职推荐方法',
      description: 'Load operating instructions for requirement clarification, opportunity filtering, candidate comparison, or public web research.',
      parameters: skillParameters,
      async execute(_id: string, raw: unknown) {
        const input = raw as { skill: JobRecommendationSkill };
        return { content: [{ type: 'text' as const, text: jobRecommendationSkills[input.skill] }], details: { skill: input.skill } };
      },
    },
    {
      name: 'search_job_opportunities',
      label: '查找已处理信息',
      description: 'Search ALL processed information from followed groups: talks, career fairs, interviews, tests, recruitment notices, incomplete records and other processed messages. Activities are deduplicated by activityId. Use offset to page through matches. Fields are text-match filters; terms in one field are alternatives and different fields are combined.',
      parameters: searchParameters,
      executionMode: 'sequential' as const,
      async execute(_id: string, raw: unknown, signal?: AbortSignal) {
        const input = raw as OpportunityFilters;
        signal?.throwIfAborted();
        const opportunities = store.search(accountId, input);
        for (const item of opportunities) allowed.add(jobResultKey(item));
        onSearch(opportunities);
        return { content: [{ type: 'text' as const, text: searchText(opportunities) }], details: { opportunities } };
      },
    },
    {
      name: 'get_job_opportunity_details',
      label: '读取信息详情',
      description: 'Read activity facts, original text and source materials for results returned by search_job_opportunities in this run. Copy messageKey AND activityId (when present) exactly; IDs are internal, not display names.',
      parameters: detailParameters,
      executionMode: 'sequential' as const,
      async execute(_id: string, raw: unknown, signal?: AbortSignal) {
        const input = raw as { results: JobResultRef[] };
        signal?.throwIfAborted();
        if (input.results.some(ref => !allowed.has(jobResultKey(ref)))) throw new Error('只能读取本轮检索已返回的信息。');
        const details = store.details(accountId, input.results);
        return { content: [{ type: 'text' as const, text: detailText(details) }], details: { results: input.results } };
      },
    },
  ];
}
