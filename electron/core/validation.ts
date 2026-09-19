import { z } from 'zod';

const id = z.string().min(1).max(160);
export const configSchema = z.object({
  wsUrl: z.string().max(2048), accessToken: z.string().max(1024),
  webuiUrl: z.string().max(2048), webuiToken: z.string().max(1024),
});
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state') }),
  z.object({ type: z.literal('detect'), path: z.string().max(4096).optional() }),
  z.object({ type: z.literal('start'), path: z.string().min(1).max(4096) }),
  z.object({ type: z.literal('connect'), config: configSchema }),
  ...(['disconnect', 'refreshQR', 'refreshGroups'] as const).map(type => z.object({ type: z.literal(type) })),
  z.object({ type: z.literal('follow'), groupId: id, followed: z.boolean() }),
  z.object({ type: z.literal('history'), groupId: id, older: z.boolean() }),
  z.object({ type: z.literal('messages'), groupId: id, search: z.string().max(500), offset: z.number().int().min(0).max(10_000_000) }),
  z.object({ type: z.literal('export'), groupId: id }),
  z.object({ type: z.literal('forward'), id }),
]);

export function validateEndpoint(value: string, kind: 'ws' | 'http'): string {
  const url = new URL(value);
  const schemes = kind === 'ws' ? ['ws:', 'wss:'] : ['http:', 'https:'];
  if (!schemes.includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('连接地址格式不正确，请将令牌填在单独的输入框中。');
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!local && !['https:', 'wss:'].includes(url.protocol)) {
    throw new Error('远程连接必须使用 HTTPS 或 WSS。');
  }
  return url.href.replace(/\/$/, '');
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}
