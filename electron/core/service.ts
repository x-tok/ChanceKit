import { mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import type { AppState, AppEvent, Command, ConnectionConfig, HistoryResult, Account, Message } from '../../src/shared';
import { commandSchema, errorText, validateEndpoint } from './validation';
import { Store, normalizeMessage } from './store';
import { OneBot, OneBotActionError } from './onebot';
import { NapCatManagement } from './management';
import { RuntimeManager, detectQQ } from './runtime';
import type { AttachmentRequest, ResolvedAttachment } from './material-document';
import { readManagedAttachment } from './attachment-file';
import { replyIds, type ReplyRequest } from './message-references';

export class AppService {
  readonly state: AppState = { phase: 'idle', detail: '尚未连接 QQ', groups: [], runtime: null, archived: 0, logs: [], historyBusy: false };
  private bot?: OneBot;
  private management?: NapCatManagement;
  private config?: ConnectionConfig;
  private timer?: NodeJS.Timeout;
  private generation = 0;
  private cursors = new Map<string, string>();
  private runtime: RuntimeManager;
  private connectionBusy = false;
  private historyGeneration = 0;
  private stopping?: Promise<void>;

  constructor(private root: string, private store: Store, private emit: (event: AppEvent) => void, componentArchive = '') {
    this.runtime = new RuntimeManager(path.join(root, 'runtime'), text => { this.patch({ detail: text }); this.log(text); }, text => {
      this.generation++;
      clearTimeout(this.timer);
      this.bot?.close(); this.bot = undefined;
      this.patch({ phase: 'error', account: undefined, error: text, detail: '连接组件已停止', qr: undefined });
      this.log(text);
    }, componentArchive);
    this.state.localAccount = store.lastAccount();
    this.reloadLocal();
  }

  private patch(update: Partial<AppState>) { Object.assign(this.state, update); this.emit({ type: 'state', state: this.state }); }
  private log(text: string) {
    this.state.logs = [...this.state.logs, { time: Date.now(), text }].slice(-80);
    this.emit({ type: 'state', state: this.state });
  }
  private reloadLocal() {
    const id = this.state.localAccount?.id;
    this.patch({ groups: id ? this.store.groups(id) : [], archived: id ? this.store.count(id) : 0 });
  }
  private accountId() {
    if (!this.state.localAccount) throw new Error('尚无账号记录。');
    return this.state.localAccount.id;
  }
  private requireGroup(id: string) {
    if (!this.state.groups.some(group => group.id === id)) throw new Error('当前账号没有这个群聊。');
  }
  async resolveReply(input: ReplyRequest): Promise<Message> {
    const bot = this.bot, generation = this.generation;
    const from = this.store.message(input.accountId, input.messageKey);
    const current = () => {
      if (!bot || bot !== this.bot || generation !== this.generation || this.state.phase !== 'online'
        || input.accountId !== this.state.account?.id || !from
        || !this.state.groups.some(group => group.id === from.groupId && group.followed)) {
        throw new Error('请连接引用所属账号并保持来源群已关注。');
      }
      const latest = this.store.message(input.accountId, input.messageKey);
      if (!latest || !replyIds(latest).includes(input.replyId)) throw new Error('该编号不是原消息中的引用。');
    };
    current();
    const raw = await bot!.call('get_msg', { message_id: input.replyId });
    current();
    if (String(raw?.message_id) !== input.replyId || String(raw?.group_id) !== from!.groupId
      || (raw?.self_id !== undefined && String(raw.self_id) !== input.accountId)
      || raw?.message_type !== 'group' || !Number.isFinite(raw?.time) || raw.time <= 0 || raw.time > from!.time
      || !raw?.sender?.user_id || !Array.isArray(raw.message)) throw new Error('QQ 返回的引用消息与原群或编号不一致，未使用。');
    const message = normalizeMessage(raw, input.accountId);
    this.store.put([message]);
    // Refresh archive counters without treating this scoped fetch as a new live-message event.
    this.reloadLocal();
    return message;
  }

  async resolveAttachment(input: AttachmentRequest): Promise<ResolvedAttachment> {
    const bot = this.bot;
    const generation = this.generation;
    if (!bot || this.state.phase !== 'online' || input.accountId !== this.state.account?.id) throw new Error('请连接该消息所属的 QQ 账号后重试附件。');
    const message = this.store.message(input.accountId, input.messageKey);
    const followed = () => Boolean(message && this.state.groups.some(group => group.id === message.groupId && group.followed));
    if (!followed() || !Number.isSafeInteger(input.segmentIndex) || input.segmentIndex < 0) throw new Error('附件不属于当前关注群消息。');
    const segment = message!.segments[input.segmentIndex];
    if (!segment || !['file', 'image'].includes(segment.type)) throw new Error('此消息片段不是附件。');
    const maxSize = segment.type === 'image' ? 20 : 5;
    if (Number(segment.data.file_size) > maxSize * 1024 * 1024) throw new Error(`附件超过 ${maxSize} MB 读取上限。`);
    const current = () => {
      if (generation !== this.generation || this.bot !== bot || this.state.account?.id !== input.accountId || !followed()) throw new Error('连接或关注状态已变化，附件读取已取消。');
    };
    const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048
      && (!/^(?:[a-z]+:|\/|\\)/i.test(value) || /^\/?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value));
    const readResponse = async (value: any): Promise<ResolvedAttachment | undefined> => {
      current();
      if (typeof value?.base64 === 'string') {
        if (value.base64.length > Math.ceil(maxSize * 1024 * 1024 * 4 / 3) + 8 || !/^[a-z0-9+/]*={0,2}$/i.test(value.base64)) throw new Error('附件数据超过读取上限或编码无效。');
        return { bytes: Buffer.from(value.base64, 'base64') };
      }
      if (typeof value?.url === 'string' && /^https?:\/\//i.test(value.url)) return value.url;
      if (typeof value?.file === 'string' && path.isAbsolute(value.file) && this.state.runtime === 'managed') {
        const bytes = await readManagedAttachment(value.file, path.join(this.root, 'runtime', 'qq-profile'),
          segment.type === 'file' ? String(segment.data.file ?? '') : '', maxSize * 1024 * 1024);
        current(); return { bytes };
      }
    };
    const resolveId = async (id: unknown): Promise<ResolvedAttachment | undefined> => {
      if (!validId(id)) return;
      current();
      const action = segment.type === 'file' ? 'get_group_file_url' : 'get_image';
      try {
        const value = await bot.call(action, segment.type === 'file' ? { group_id: message!.groupId, file_id: id } : { file: id });
        const resolved = await readResponse(value);
        if (resolved) return resolved;
      } catch { current(); }
      if (segment.type === 'file') {
        try {
          const resolved = await readResponse(await bot.call('get_file', { file_id: id }));
          if (resolved) return resolved;
        } catch { current(); }
      }
    };
    const originalId = segment.type === 'image' ? segment.data.file_id ?? segment.data.file : segment.data.file_id;
    const original = await resolveId(originalId);
    if (original) return original;
    // NapCat can refresh stale URLs and legacy UUID IDs from the actual archived message.
    let refreshed: any;
    try { refreshed = await bot.call('get_msg', { message_id: message!.externalId }); }
    catch { current(); throw new Error('QQ 无法获取这条原消息的附件，请重新获取该群消息记录后重试。'); }
    current();
    if (String(refreshed?.group_id) !== message!.groupId || String(refreshed?.sender?.user_id) !== message!.senderId
      || Number(refreshed?.time) !== message!.time || !Array.isArray(refreshed.message)) throw new Error('QQ 返回的消息与归档来源不一致，附件读取已取消。');
    const candidate = refreshed.message[input.segmentIndex];
    if (candidate?.type !== segment.type) throw new Error('QQ 返回的附件位置与原消息不一致。');
    if (segment.type === 'image' && typeof candidate.data?.url === 'string' && /^https?:\/\//i.test(candidate.data.url)) return candidate.data.url;
    if (segment.type === 'file' && String(candidate.data?.file ?? candidate.data?.name) !== String(segment.data.file ?? segment.data.name)) throw new Error('QQ 返回的文件名与原消息不一致。');
    const freshId = segment.type === 'image' ? candidate.data?.file_id ?? candidate.data?.file : candidate.data?.file_id;
    const resolved = await resolveId(freshId);
    if (resolved) return resolved;
    throw new Error('QQ 未返回可下载的附件；外接 NapCat 需提供下载链接或 Base64，不能直接读取远端文件路径。');
  }

  async request(input: Command): Promise<unknown> {
    const command = commandSchema.parse(input);
    switch (command.type) {
      case 'state': return this.state;
      case 'detect': {
        const qq = await detectQQ(command.path);
        this.patch({ qq }); return qq ?? null;
      }
      case 'start': {
        if (this.connectionBusy) throw new Error('正在准备连接，请稍候。');
        this.connectionBusy = true;
        const stopping = this.disconnect();
        const generation = this.generation;
        try {
          await stopping;
          if (generation !== this.generation) return;
          this.patch({ phase: 'preparing', detail: '正在检查官方 QQ', runtime: 'managed', error: undefined });
          const qq = await detectQQ(command.path);
          if (generation !== this.generation) return;
          if (!qq) throw new Error('没有找到官方 QQ，请先自行下载安装。');
          this.patch({ qq });
          const config = await this.runtime.start(qq, this.state.localAccount?.id);
          if (generation !== this.generation) { await this.runtime.stop(); return; }
          this.config = config;
          this.management = new NapCatManagement(config.webuiUrl, config.webuiToken);
          this.patch({ phase: 'starting', detail: '正在等待 QQ 登录服务' });
          void this.pollLogin(generation, Date.now() + 120_000);
        } catch (error) {
          if (generation !== this.generation) return;
          await this.runtime.stop();
          if (generation !== this.generation) return;
          this.patch({ phase: 'error', account: undefined, error: errorText(error), detail: '连接未完成' });
          throw error;
        } finally { this.connectionBusy = false; }
        return;
      }
      case 'connect': {
        if (this.connectionBusy) throw new Error('正在准备连接，请稍候。');
        validateEndpoint(command.config.wsUrl, 'ws');
        if (command.config.webuiUrl) validateEndpoint(command.config.webuiUrl, 'http');
        this.connectionBusy = true;
        const stopping = this.disconnect();
        const generation = this.generation;
        try {
          await stopping;
          if (generation !== this.generation) return;
          this.config = command.config;
          this.patch({ runtime: 'external', phase: 'connecting', detail: '正在连接 NapCat', error: undefined });
          if (command.config.webuiUrl) {
            this.management = new NapCatManagement(command.config.webuiUrl, command.config.webuiToken);
            const status = await this.management.status();
            if (generation !== this.generation) return;
            if (!status.isLogin) {
              this.patch({ phase: 'qr', detail: '等待 QQ 扫码确认', qr: status.qrcodeurl, error: status.loginError || undefined });
              void this.pollLogin(generation, Date.now() + 30_000);
              return;
            }
          }
          await this.openBot(generation);
        } catch (error) {
          if (generation !== this.generation) return;
          this.patch({ phase: 'error', account: undefined, detail: '连接未完成', error: errorText(error) });
          throw error;
        } finally { this.connectionBusy = false; }
        return;
      }
      case 'disconnect': await this.disconnect(); return;
      case 'refreshQR': {
        if (!this.management) throw new Error('扫码登录需要连接 NapCat 的登录管理服务。');
        const generation = this.generation;
        await this.management.refreshQR();
        if (generation !== this.generation) return;
        this.patch({ error: undefined, qr: undefined, detail: '正在刷新二维码' }); return;
      }
      case 'refreshGroups': await this.refreshGroups(); return;
      case 'follow':
        this.requireGroup(command.groupId);
        this.store.follow(this.accountId(), command.groupId, command.followed); this.reloadLocal(); return;
      case 'history': this.requireGroup(command.groupId); return this.history(command.groupId, command.older, command.since);
      case 'messages': this.requireGroup(command.groupId); return this.store.messages(this.accountId(), command.groupId, command.search, command.offset);
      case 'export': this.requireGroup(command.groupId); return this.export(command.groupId);
      case 'forward': {
        if (!this.bot) throw new Error('请先连接 QQ。');
        return this.bot.call('get_forward_msg', { message_id: command.id });
      }
    }
  }

  private async pollLogin(generation: number, deadline: number) {
    if (generation !== this.generation || !this.management) return;
    try {
      const status = await this.management.status();
      if (generation !== this.generation) return;
      if (status.isLogin) {
        await this.openBot(generation);
        return;
      }
      this.patch({ phase: 'qr', account: undefined, qr: status.qrcodeurl || undefined, detail: status.isOffline ? 'QQ 已离线，请重新扫码' : '等待 QQ 扫码确认', error: status.loginError || undefined });
      deadline = Date.now() + 30_000;
    } catch (error) {
      if (generation !== this.generation) return;
      if (Date.now() > deadline) {
        if (this.state.runtime === 'managed') await this.runtime.stop();
        if (generation !== this.generation) return;
        this.patch({ phase: 'error', account: undefined, detail: '登录服务未就绪', error: errorText(error) }); return;
      }
    }
    if (generation === this.generation) this.timer = setTimeout(() => { void this.pollLogin(generation, deadline); }, 2500);
  }

  private async openBot(generation: number) {
    if (generation !== this.generation || !this.config) return;
    this.patch({ phase: 'connecting', account: undefined, detail: 'QQ 已登录，正在读取群列表', error: undefined, qr: undefined });
    const bot = new OneBot();
    this.bot?.close();
    this.bot = bot;
    let ready = false;
    const buffered: any[] = [];
    bot.on('event', event => {
      if (generation !== this.generation || this.bot !== bot) return;
      if (!ready) { if (buffered.length < 500) buffered.push(event); return; }
      this.handleEvent(event);
    });
    bot.on('disconnected', () => {
      if (!ready || generation !== this.generation || this.bot !== bot) return;
      this.cursors.clear();
      this.patch({ phase: 'reconnecting', account: undefined, detail: '连接中断，正在重连', error: undefined });
      this.scheduleReconnect(generation);
    });
    try {
      await bot.connect(this.config.wsUrl, this.config.accessToken);
      const raw = await bot.call('get_login_info');
      if (generation !== this.generation || this.bot !== bot) { bot.close(); return; }
      if (!raw?.user_id) throw new Error('QQ 尚未完成登录。');
      const account: Account = { id: String(raw.user_id), nickname: String(raw.nickname ?? '').trim() || 'QQ 用户' };
      const groups = await this.fetchGroups(bot);
      if (generation !== this.generation || this.bot !== bot) return;
      this.store.saveAccount(account);
      this.store.saveGroups(account.id, groups);
      this.patch({ phase: 'online', account, localAccount: account, groups: this.store.groups(account.id), archived: this.store.count(account.id),
        lastEventAt: undefined, detail: 'QQ 已连接，正在接收关注群消息', error: undefined });
      this.log('QQ 连接成功，群列表已更新');
      ready = true;
      for (const event of buffered) this.handleEvent(event);
      // Only a recent-page reconciliation in v0.1; never label this a complete gap recovery.
      for (const group of this.state.groups.filter(g => g.followed)) {
        if (generation !== this.generation) return;
        await this.history(group.id, false).catch(error => this.log(`最近消息补取未完成：${errorText(error)}`));
      }
    } catch (error) {
      if (generation !== this.generation || this.bot !== bot) return;
      bot.close(); this.bot = undefined;
      throw error;
    }
  }

  private scheduleReconnect(generation: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (generation !== this.generation) return;
      try { await this.openBot(generation); }
      catch (error) {
        if (generation !== this.generation) return;
        this.patch({ phase: 'reconnecting', detail: '正在重试连接', error: errorText(error) });
        this.scheduleReconnect(generation);
      }
    }, 3000);
  }

  private handleEvent(event: any) {
    if (!this.state.account || String(event.self_id) !== this.state.account.id) return;
    if (event.meta_event_type === 'heartbeat' && event.status?.online === false) {
      this.patch({ phase: 'reconnecting', account: undefined, detail: 'QQ 已离线，等待恢复' });
      this.bot?.close(); this.bot = undefined;
      if (this.management) void this.pollLogin(this.generation, Date.now() + 30_000);
      else this.scheduleReconnect(this.generation);
      return;
    }
    if (!['message', 'message_sent'].includes(event.post_type) || event.message_type !== 'group') return;
    const groupId = String(event.group_id);
    if (!this.state.groups.some(group => group.id === groupId && group.followed)) return;
    try {
      this.store.put([normalizeMessage(event, this.accountId())]);
      this.patch({ lastEventAt: Date.now() });
      this.reloadLocal();
      this.emit({ type: 'messages', groupId });
    } catch { this.patch({ error: '消息未能写入本地，请检查磁盘空间；恢复后重新获取最近消息。' }); }
  }

  private async refreshGroups() {
    const bot = this.bot;
    const accountId = this.state.account?.id;
    if (!bot || !accountId || this.state.phase !== 'online') throw new Error('请先连接 QQ。');
    const generation = this.generation;
    const groups = await this.fetchGroups(bot);
    if (generation !== this.generation || this.bot !== bot || accountId !== this.state.account?.id) return;
    this.store.saveGroups(accountId, groups);
    this.reloadLocal();
  }

  private async fetchGroups(bot: OneBot) {
    const groups = await bot.call('get_group_list', { no_cache: true });
    if (!Array.isArray(groups)) throw new Error('群列表响应格式不正确。');
    return groups.filter(group => group?.group_id);
  }

  private async history(groupId: string, older: boolean, since?: number): Promise<HistoryResult> {
    if (!this.bot || this.state.phase !== 'online') throw new Error('请先连接 QQ，再获取消息记录。');
    if (this.state.historyBusy) throw new Error('正在读取消息，请等待当前批次完成。');
    const cursor = older ? this.cursors.get(groupId) : undefined;
    if (older && !cursor) throw new Error('连接恢复后需要先刷新最近消息，再继续读取更早记录。');
    const generation = this.generation;
    const ticket = ++this.historyGeneration;
    const accountId = this.accountId();
    this.patch({ historyBusy: true });
    try {
      const result = await this.bot.call('get_group_msg_history', { group_id: groupId, count: 100, reverse_order: Boolean(cursor), ...(cursor ? { message_seq: cursor } : {}) });
      if (generation !== this.generation) throw new Error('连接已切换，这次读取已取消。');
      if (!Array.isArray(result?.messages)) throw new Error('消息历史响应格式不正确。');
      const messages = result.messages.map((raw: any) => normalizeMessage(raw, accountId, groupId));
      messages.sort((a: any, b: any) => a.time - b.time || (a.realSeq && b.realSeq ? Number(BigInt(a.realSeq) - BigInt(b.realSeq)) : 0));
      const oldestTime = messages[0]?.time;
      const archivedMessages = since === undefined ? messages : messages.filter((message: Message) => message.time >= since);
      const added = this.store.put(archivedMessages);
      const next = messages[0]?.externalId;
      const canContinue = Boolean(next && next !== cursor);
      if (next && (older || since !== undefined || !this.cursors.has(groupId))) this.cursors.set(groupId, next);
      this.reloadLocal();
      this.emit({ type: 'messages', groupId });
      this.log(`已读取 ${messages.length} 条群消息，新增 ${added} 条`);
      return {
        added, received: messages.length, canContinue,
        boundary: messages.length === 0 ? 'empty' : canContinue ? 'more' : 'uncertain',
        oldestTime,
        reachedStart: since !== undefined && (messages.length === 0 || !canContinue || (oldestTime !== undefined && oldestTime <= since)),
      };
    } catch (error) {
      if (error instanceof OneBotActionError && error.retcode === 1200 && /^消息.*不存在$/.test(error.wording)) {
        if (!older) this.cursors.delete(groupId);
        return { added: 0, received: 0, canContinue: false, boundary: older ? 'uncertain' : 'empty', reachedStart: since !== undefined };
      }
      throw new Error(`${errorText(error)} 未能确认更早历史的范围。`);
    } finally { if (ticket === this.historyGeneration) this.patch({ historyBusy: false }); }
  }

  private async export(groupId: string): Promise<string> {
    const folder = path.join(this.root, 'exports');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const dest = path.join(folder, 'messages.jsonl');
    const stream = createWriteStream(dest, { mode: 0o600 });
    const complete = finished(stream);
    try {
      for (const message of this.store.export(this.accountId(), groupId)) {
        if (!stream.write(`${JSON.stringify(message)}\n`)) await once(stream, 'drain');
      }
      stream.end();
      await complete;
      return dest;
    } catch (error) { stream.destroy(); await complete.catch(() => {}); throw error; }
  }

  async disconnect() {
    const generation = ++this.generation;
    this.historyGeneration++;
    clearTimeout(this.timer);
    this.bot?.close(); this.bot = undefined;
    this.management = undefined;
    this.config = undefined;
    this.cursors.clear();
    this.patch({ phase: 'stopping', account: undefined, detail: '正在停止连接', error: undefined, qr: undefined, historyBusy: false, lastEventAt: undefined });
    this.stopping ??= this.runtime.stop().finally(() => { this.stopping = undefined; });
    await this.stopping;
    if (generation === this.generation) this.patch({ phase: 'idle', detail: '采集已停止，本地记录仍可查看' });
  }
  async close() { await this.disconnect(); this.store.close(); }
}
