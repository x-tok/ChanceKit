import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const accountIdSchema = z.string().regex(/^\d+$/);
const onboardingRecordSchema = z.object({
  version: z.literal(1),
  accountId: accountIdSchema,
  completedAt: z.string().datetime(),
}).strict();

export interface OnboardingStatus {
  completed: boolean;
}

export class OnboardingStore {
  private readonly file: string;

  constructor(root: string, private readonly completedByDefault = false) {
    this.file = path.join(root, 'onboarding.json');
  }

  async status(): Promise<OnboardingStatus> {
    if (this.completedByDefault) return { completed: true };
    try {
      onboardingRecordSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
      return { completed: true };
    } catch {
      return { completed: false };
    }
  }

  async complete(accountId: string): Promise<void> {
    const record = onboardingRecordSchema.parse({ version: 1, accountId, completedAt: new Date().toISOString() });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
