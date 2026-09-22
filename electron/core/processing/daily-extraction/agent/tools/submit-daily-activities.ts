import { Type } from 'typebox';
import { z } from 'zod';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { activityTypes } from '../../../../../../src/schedule';
import { activitySchema } from '../../../activity-schema';
import type { DailyActivityOutput } from '../../types';

const nullableString = (description: string) => Type.Union([Type.String({ description }), Type.Null()]);
const activityParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  type: Type.Union(activityTypes.map(value => Type.Literal(value))),
  organizer: Type.String({ maxLength: 200 }),
  startDate: nullableString('YYYY-MM-DD in Asia/Shanghai, or null.'),
  endDate: nullableString('YYYY-MM-DD for a multiday event, or null.'),
  startTime: nullableString('24-hour HH:mm, or null.'),
  endTime: nullableString('24-hour HH:mm, or null.'),
  location: Type.String({ maxLength: 500 }),
  audience: Type.String({ maxLength: 1000 }),
  description: Type.String({ maxLength: 4000 }),
  registrationUrl: nullableString('Exact URL from source evidence, or null.'),
  deadline: nullableString('Explicit registration deadline, or null.'),
  evidence: Type.String({ minLength: 1, maxLength: 2000 }),
  sourceRefs: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 200 }),
}, { additionalProperties: false });

export const dailyExtractionParameters = Type.Object({
  activities: Type.Array(activityParameters, { maxItems: 80 }),
}, { additionalProperties: false });

const submissionSchema = z.object({
  activities: z.array(z.record(z.string(), z.unknown())).max(80),
}).strict();

export function parseDailySubmission(input: unknown, availableRefs: Set<number>): DailyActivityOutput {
  const submitted = submissionSchema.parse(input);
  return submitted.activities.map(value => {
    const { sourceRefs: rawRefs, ...rawActivity } = value;
    const sourceRefs = z.array(z.number().int().positive()).min(1).max(200).parse(rawRefs);
    const refs = [...new Set(sourceRefs)];
    if (refs.some(ref => !availableRefs.has(ref))) throw new Error('活动引用了当前批次之外的来源。');
    return { ...activitySchema.parse(rawActivity), sourceRefs: refs };
  });
}

export function createSubmitDailyActivitiesTool(
  availableRefs: Set<number>, allowedLinks: Set<string>, submit: (value: DailyActivityOutput) => void,
): AgentTool<typeof dailyExtractionParameters> {
  let submitted = false;
  return {
    name: 'submit_daily_activities', label: '整理当日活动',
    description: 'Submit deduplicated recruiting activities and the source reference numbers that support each one.',
    parameters: dailyExtractionParameters, executionMode: 'sequential' as const,
    async execute(_id: string, input: unknown) {
      if (submitted) throw new Error('本批次已经提交。');
      const value = parseDailySubmission(input, availableRefs);
      for (const activity of value) {
        if (activity.registrationUrl && !allowedLinks.has(activity.registrationUrl)) activity.registrationUrl = null;
      }
      submitted = true;
      submit(value);
      return { content: [{ type: 'text' as const, text: 'Daily activities accepted.' }], details: {}, terminate: true };
    },
  };
}
