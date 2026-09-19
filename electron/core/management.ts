import { createHash } from 'node:crypto';
import { validateEndpoint } from './validation';

export interface LoginStatus { isLogin: boolean; isOffline?: boolean; qrcodeurl?: string; loginError?: string }

export class NapCatManagement {
  private credential = '';
  private credentialAt = 0;
  private authPending?: Promise<void>;
  private base: string;
  constructor(url: string, private token: string) { this.base = validateEndpoint(url, 'http'); }

  private async request(path: string, body: unknown, credential = this.credential): Promise<any> {
    const response = await fetch(`${this.base}/api/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`登录管理服务返回 HTTP ${response.status}。`);
    const result = await response.json() as { code: number; message?: string; data: unknown };
    if (result.code !== 0) throw new Error(String(result.message || 'NapCat 管理请求失败。').slice(0, 240));
    return result.data;
  }

  private async authenticate() {
    if (this.credential && Date.now() - this.credentialAt < 45 * 60_000) return;
    if (this.authPending) return this.authPending;
    this.authPending = (async () => {
      const hash = createHash('sha256').update(`${this.token}.napcat`).digest('hex');
      const result = await this.request('auth/login', { hash }, '');
      if (result.require2FA) throw new Error('该 NapCat 开启了双重验证，请先在其管理界面登录，再使用消息连接模式。');
      if (!result.Credential) throw new Error('登录管理服务没有返回凭据。');
      this.credential = result.Credential;
      this.credentialAt = Date.now();
    })().finally(() => { this.authPending = undefined; });
    return this.authPending;
  }

  async call<T = any>(path: string, body: unknown = {}): Promise<T> {
    await this.authenticate();
    try { return await this.request(path, body); }
    catch (error) {
      if (error instanceof Error && /Authorization|[Cc]redential/.test(error.message)) this.credential = '';
      throw error;
    }
  }
  status(): Promise<LoginStatus> { return this.call('QQLogin/CheckLoginStatus'); }
  refreshQR() { return this.call('QQLogin/RefreshQRcode'); }
}
