import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { modelApis, modelProviders, sameCredentialScope, type ModelConfigInput, type ModelSettings } from '../../../src/model-config';
import { validateEndpoint } from '../connection/validation';

export const modelConfigSchema = z.object({
  provider: z.enum(modelProviders),
  api: z.enum(modelApis),
  baseUrl: z.string().trim().min(1, '请填写 API 地址。').max(2048).transform((url, ctx) => {
    try { return validateEndpoint(url, 'http'); }
    catch { ctx.addIssue({ code: 'custom', message: 'API 地址必须是 HTTPS，或本机 HTTP 地址，且不能包含密钥、查询参数或片段。' }); return z.NEVER; }
  }),
  modelId: z.string().trim().min(1, '请选择或填写模型 ID。').max(256).regex(/^[^\s\x00-\x1f]+$/, '模型 ID 不能包含空格。'),
  contextWindow: z.number().int().min(1024).max(10_000_000),
  maxTokens: z.number().int().min(1).max(1_000_000),
  temperature: z.number().min(0).max(2),
  reasoning: z.boolean(),
  reasoningLevel: z.enum(['off', 'low', 'medium', 'high']),
  imageInput: z.boolean(),
}).strict().superRefine((config, ctx) => {
  if (config.maxTokens > config.contextWindow) ctx.addIssue({ code: 'custom', path: ['maxTokens'], message: '最大输出不能超过上下文窗口。' });
  if (!config.reasoning && config.reasoningLevel !== 'off') ctx.addIssue({ code: 'custom', path: ['reasoningLevel'], message: '当前模型未启用推理能力。' });
});
export const modelConfigInputSchema = z.object({
  config: modelConfigSchema,
  apiKey: z.string().trim().max(16384).refine(key => !/[\r\n]/.test(key), 'API Key 不能包含换行。').optional(),
}).strict();
const storedSchema = z.object({ config: modelConfigSchema, apiKey: z.string().max(16384), updatedAt: z.string().datetime() }).strict();
export type StoredModelSettings = z.infer<typeof storedSchema>;

export interface SecretEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class ModelSettingsStore {
  private readonly file: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(root: string, private encryption: SecretEncryption) {
    this.file = path.join(root, 'model-settings.enc');
  }

  private async read(): Promise<StoredModelSettings | null> {
    let contents: Buffer;
    try { contents = await readFile(this.file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('无法读取模型配置。', { cause: error });
    }
    if (!this.encryption.isEncryptionAvailable()) throw new Error('系统密钥服务不可用，无法读取已保存的模型配置。');
    try { return storedSchema.parse(JSON.parse(this.encryption.decryptString(contents))); }
    catch (cause) { throw new Error('模型配置无法解密或已损坏。原文件已保留，可清除配置后重新设置。', { cause }); }
  }

  private view(value: StoredModelSettings | null): ModelSettings {
    return {
      config: value?.config ?? null, hasApiKey: Boolean(value?.apiKey),
      updatedAt: value?.updatedAt ?? null, encryptionAvailable: this.encryption.isEncryptionAvailable(),
    };
  }

  async get(): Promise<ModelSettings> {
    await this.pending;
    return this.view(await this.read());
  }

  async resolve(input: ModelConfigInput): Promise<StoredModelSettings> {
    const parsed = modelConfigInputSchema.parse(input);
    // An explicit key never needs to decrypt old credentials.
    const previous = parsed.apiKey === undefined ? await this.read() : null;
    return {
      config: parsed.config,
      apiKey: parsed.apiKey ?? (previous && sameCredentialScope(previous.config, parsed.config) ? previous.apiKey : ''),
      updatedAt: new Date().toISOString(),
    };
  }

  async saved(): Promise<StoredModelSettings | null> {
    await this.pending;
    return this.read();
  }

  save(input: ModelConfigInput): Promise<ModelSettings> {
    return this.serialize(async () => {
      if (!this.encryption.isEncryptionAvailable()) throw new Error('系统密钥服务不可用，未保存 API Key。');
      const value = await this.resolve(input);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, this.encryption.encryptString(JSON.stringify(value)), { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.file);
      } finally { await rm(temporary, { force: true }); }
      return this.view(value);
    });
  }

  clear(): Promise<ModelSettings> {
    return this.serialize(async () => {
      await rm(this.file, { force: true });
      return this.view(null);
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
}
