import { emptyProcessingStatus, type ProcessingStatus } from '../../../src/schedule';
import { isLocalModelEndpoint } from '../../../src/model-config';
import type { StoredModelSettings } from '../models/model-settings';
import type { ExtractionResult, ProcessingJob } from './schedule-store';
import { ScheduleStore } from './schedule-store';
import { ExtractionFailure } from './extraction-failure';

type Runner = (job: ProcessingJob, settings: StoredModelSettings, signal: AbortSignal) => Promise<ExtractionResult>;

export class ScheduleProcessor {
  private accountId = '';
  private generation = 0;
  private closed = false;
  private pumping = false;
  private blockedReason?: string;
  private published = '';
  private running = new Map<string, { job: ProcessingJob; controller: AbortController; promise: Promise<void> }>();
  private timer: NodeJS.Timeout;

  constructor(
    readonly store: ScheduleStore,
    private loadSettings: () => Promise<StoredModelSettings | null>,
    private run: Runner,
    private emit: () => void,
  ) {
    this.timer = setInterval(() => this.wake(), 1000);
    this.timer.unref();
  }
  setAccount(accountId: string) {
    if (accountId === this.accountId || this.closed) return;
    this.invalidate();
    this.accountId = accountId;
    this.refresh();
  }
  refresh() {
    if (this.closed) return;
    if (this.accountId) this.store.enqueue(this.accountId);
    for (const active of this.running.values()) {
      if (!this.store.isCurrent(active.job)) active.controller.abort();
    }
    this.publish();
    this.wake();
  }
  modelChanged() { this.invalidate(); this.wake(); }
  private invalidate() {
    this.generation++;
    this.blockedReason = undefined;
    for (const active of this.running.values()) active.controller.abort();
  }
  status(): ProcessingStatus {
    return this.accountId ? { ...this.store.status(this.accountId), blockedReason: this.blockedReason }
      : { ...emptyProcessingStatus, issues: [], blockedReason: '请先连接 QQ 并关注群聊。' };
  }
  async configure(value: { enabled: boolean; concurrency: number }) {
    if (!this.accountId) throw new Error('请先连接 QQ 并关注群聊。');
    const account = this.accountId;
    if (value.enabled) {
      const settings = await this.loadSettings();
      if (!settings || (!settings.apiKey && !isLocalModelEndpoint(settings.config.baseUrl))) throw new Error('请先在模型配置中保存模型和 API Key。');
    }
    if (account !== this.accountId || this.closed) throw new Error('账号已切换，请重试。');
    this.store.configure(account, value);
    if (!value.enabled) this.invalidate();
    this.refresh();
    return this.status();
  }
  retry(messageKey?: string) {
    if (!this.accountId) throw new Error('尚无账号记录。');
    this.store.retry(this.accountId, messageKey);
    this.refresh();
    return this.status();
  }
  private wake() {
    if (this.closed || this.pumping) return;
    void this.pump().catch(() => {
      this.blockedReason = '处理队列暂时不可用，请检查本地存储后重启应用。';
      this.publish();
    });
  }
  private async pump() {
    if (!this.accountId || !this.store.settings(this.accountId).enabled) return;
    this.pumping = true;
    const account = this.accountId;
    const generation = this.generation;
    try {
      let settings: StoredModelSettings | null;
      try { settings = await this.loadSettings(); }
      catch { this.blockedReason = '无法读取模型配置，请检查系统密钥服务。'; this.publish(); return; }
      if (this.closed || generation !== this.generation || account !== this.accountId) return;
      if ([...this.running.values()].some(active => active.controller.signal.aborted)) return;
      if (!settings || (!settings.apiKey && !isLocalModelEndpoint(settings.config.baseUrl))) {
        this.blockedReason = '请保存有效的模型配置和 API Key，队列将自动继续。';
        this.publish();
        return;
      }
      this.blockedReason = undefined;
      const config = this.store.settings(account);
      while (config.enabled && this.running.size < config.concurrency) {
        const job = this.store.claim(account);
        if (!job) break;
        const controller = new AbortController();
        // Register the lease before starting asynchronous work.
        const active = { job, controller, promise: Promise.resolve() };
        this.running.set(job.message.key, active);
        active.promise = Promise.resolve().then(async () => {
          try {
            controller.signal.throwIfAborted();
            const result = await this.run(job, settings!, controller.signal);
            if (controller.signal.aborted || generation !== this.generation || !this.store.isCurrent(job)) this.store.release(job);
            else if (!this.store.complete(job, result)) this.store.release(job);
          } catch (error) {
            if (controller.signal.aborted || generation !== this.generation || !this.store.isCurrent(job)) this.store.release(job);
            else this.store.fail(job, error instanceof Error ? error.message : '消息处理失败。', Date.now(), error instanceof ExtractionFailure ? error.materials : []);
          } finally {
            this.running.delete(job.message.key);
            if (!this.closed) { this.publish(); this.wake(); }
          }
        }).catch(() => { this.blockedReason = '处理结果未能写入本地，请检查磁盘空间并重启。'; });
      }
      this.publish();
    } finally { this.pumping = false; }
  }
  private publish() {
    if (this.closed) return;
    const value = JSON.stringify(this.status());
    if (value !== this.published) { this.published = value; this.emit(); }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.invalidate();
    await Promise.all([...this.running.values()].map(active => active.promise));
    this.store.close();
  }
}
