import { z } from 'zod';
import { activityTypes } from '../../src/schedule';

export const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= '1970-01-01' && value <= '2100-12-31';
}, '日期无效。');
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable();
export const publicLink = z.string().max(2048).url().refine(value => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
});
export const activitySchema = z.object({
  title: z.string().trim().min(1).max(200),
  type: z.enum(activityTypes),
  organizer: z.string().trim().max(200),
  startDate: calendarDate.nullable(),
  endDate: calendarDate.nullable(),
  startTime: clock,
  endTime: clock,
  location: z.string().trim().max(500),
  audience: z.string().trim().max(1000),
  description: z.string().trim().max(4000),
  registrationUrl: publicLink.nullable(),
  deadline: z.string().max(200).nullable(),
  evidence: z.string().trim().min(1).max(2000),
}).strict().superRefine((event, ctx) => {
  if (!event.startDate && (event.startTime || event.endDate || event.endTime)) {
    ctx.addIssue({ code: 'custom', message: '未知日期不能带有起止时间。' });
  }
  if (event.startDate && event.endDate && event.endDate < event.startDate) {
    ctx.addIssue({ code: 'custom', message: '结束日期不能早于开始日期。' });
  }
  if ((!event.endDate || event.endDate === event.startDate) && event.startTime && event.endTime && event.endTime < event.startTime) {
    ctx.addIssue({ code: 'custom', message: '结束时间不能早于开始时间。' });
  }
});
export const extractionSchema = z.object({ activities: z.array(activitySchema).max(20) }).strict();
export const scheduleQuerySchema = z.object({
  week: calendarDate, type: z.enum(activityTypes).optional(), groupId: z.string().max(160).optional(), search: z.string().max(300).optional(),
}).strict();
export const processingConfigSchema = z.object({ enabled: z.boolean(), concurrency: z.number().int().min(1).max(6) }).strict();
