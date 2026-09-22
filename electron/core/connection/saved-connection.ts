import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const connectionConfigSchema = z.object({
  wsUrl: z.string().min(1).max(2048), accessToken: z.string().max(16384),
  webuiUrl: z.string().max(2048), webuiToken: z.string().max(16384),
}).strict();

const savedConnectionSchema = z.discriminatedUnion('mode', [
  z.object({ version: z.literal(1), mode: z.literal('managed'), path: z.string().min(1).max(4096) }).strict(),
  z.object({ version: z.literal(1), mode: z.literal('external'), config: connectionConfigSchema }).strict(),
]);

export type SavedConnection = z.infer<typeof savedConnectionSchema>;

interface ConnectionEncryption {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export class SavedConnectionStore {
  constructor(private file: string, private encryption: ConnectionEncryption) {}

  async load(): Promise<SavedConnection | undefined> {
    if (!this.encryption.available()) return;
    try {
      const value = JSON.parse(this.encryption.decrypt(await readFile(this.file)));
      const current = savedConnectionSchema.safeParse(value);
      if (current.success) return current.data;
      const legacy = connectionConfigSchema.safeParse(value);
      return legacy.success ? { version: 1, mode: 'external', config: legacy.data } : undefined;
    } catch { return; }
  }

  async save(value: SavedConnection): Promise<void> {
    if (!this.encryption.available()) return;
    const record = savedConnectionSchema.parse(value);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, this.encryption.encrypt(JSON.stringify(record)), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } finally { await rm(temporary, { force: true }); }
  }
}
