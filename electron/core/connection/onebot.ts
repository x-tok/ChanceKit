import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { validateEndpoint } from './validation';

export class OneBotActionError extends Error {
  constructor(readonly retcode: number, readonly wording: string) {
    super(`QQ 接口返回 ${retcode}：${wording}`);
  }
}

export class OneBot extends EventEmitter {
  private socket?: WebSocket;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private timeout = 20_000) { super(); }

  async connect(url: string, token: string): Promise<void> {
    this.close();
    const socket = new WebSocket(validateEndpoint(url, 'ws'), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      handshakeTimeout: 12_000, maxPayload: 32 * 1024 * 1024,
    });
    this.socket = socket;
    socket.on('message', bytes => {
      if (this.socket !== socket) return;
      let response: Record<string, any>;
      try { response = JSON.parse(bytes.toString()); } catch { return; }
      if (response.echo != null) {
        const echo = String(response.echo);
        const request = this.pending.get(echo);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(echo);
        if (response.status === 'ok' && Number(response.retcode) === 0) request.resolve(response.data);
        else request.reject(new OneBotActionError(Number(response.retcode), String(response.wording || response.message || '请求未完成').slice(0, 240)));
      } else if (response.post_type) this.emit('event', response);
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.rejectPending(new Error('连接已断开，请重新连接。'));
      this.emit('disconnected');
    });
    // Keep an error listener after the handshake so transport errors never crash the worker.
    socket.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', () => reject(new Error('无法连接消息服务，请检查地址、令牌与 NapCat 状态。')));
      socket.once('close', () => reject(new Error('消息连接已关闭，请检查访问令牌。')));
    });
  }

  call<T = any>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('消息服务尚未连接。'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new Error('QQ 响应超时，请稍后重试。')); }, this.timeout);
      this.pending.set(echo, { resolve, reject, timer });
      socket.send(JSON.stringify({ action, params, echo }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(echo); reject(new Error('消息请求发送失败。')); }
      });
    });
  }

  private rejectPending(error: Error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }

  close() {
    const socket = this.socket;
    this.socket = undefined;
    this.rejectPending(new Error('连接已停止。'));
    socket?.terminate();
  }
}
