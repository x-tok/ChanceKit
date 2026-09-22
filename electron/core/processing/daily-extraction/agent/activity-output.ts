import { Type } from 'typebox';
import { z } from 'zod';
import { activityTypes } from '../../../../../src/schedule';
import { activitySchema } from '../../activity-schema';
import type { DailyActivityOutput } from '../types';

const nullableString = (description: string) => Type.Union([Type.String({ description }), Type.Null()]);
const activityOutputSchema = Type.Object({
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

const typeboxOutputSchema = Type.Object({
  activities: Type.Array(activityOutputSchema, { maxItems: 80 }),
}, { additionalProperties: false });

export const dailyActivityOutputJsonSchema = JSON.parse(JSON.stringify(typeboxOutputSchema)) as Record<string, unknown>;

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
