import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, utilityProcess, Menu, net } from 'electron';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Command } from '../src/shared';
import { commandSchema } from './core/validation';
import { RELEASE } from './core/component';
import { BRAND } from '../src/brand';
import { resolveProfileDirectory } from './core/profile';
import { ModelSettingsStore, modelConfigInputSchema } from './core/model-settings';
import { getModelCatalog, testPiModel } from './core/pi-model';
import { ScheduleStore } from './core/schedule-store';
import { ScheduleProcessor } from './core/schedule-processor';
import { extractActivities } from './core/activity-agent';
import { informationQuerySchema, processingConfigSchema, scheduleQuerySchema } from './core/activity-schema';
import { emptyInformationPage } from '../src/schedule';
import { z } from 'zod';
import type { AppState } from '../src/shared';
import type { AttachmentRequest, ResolvedAttachment } from './core/material-document';
import type { ReplyRequest } from './core/message-references';
import { InformationTitleReader } from './core/information-titles';
import { WebpagePdfStore } from './core/webpage-pdf';
import { downloadPublicMaterial } from './core/message-materials';
import { printWebpagePdf } from './webpage-pdf-printer';
import { registerOnboardingIpc } from './onboarding/ipc';
import { OnboardingStore } from './onboarding/store';

app.setName(BRAND.name);
const profile = process.env.CHANCEKIT_TEST_DATA ? path.resolve(process.env.CHANCEKIT_TEST_DATA)
  : app.isPackaged ? resolveProfileDirectory(app.getPath('appData')) : path.resolve('.dev-data');
app.setPath('userData', profile);
if (!app.requestSingleInstanceLock()) app.quit();
let window: BrowserWindow | undefined;
let quitting = false;
let shutdownComplete = false;
let workerExited = false;
let worker: Electron.UtilityProcess;
let modelTest: AbortController | undefined;
let processor: ScheduleProcessor | undefined;
let titleReader: InformationTitleReader | undefined;
let archiveAccountId = '';
let followedSignature = '';
let scheduleRefreshTimer: NodeJS.Timeout | undefined;
const pending = new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

function request<T = any>(command: Command | AttachmentRequest | ReplyRequest, signal?: AbortSignal): Promise<T> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const cleanup = () => { pending.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(signal!.reason); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('操作超时，请查看连接状态。')); }, command.type === 'start' ? 600_000 : command.type === 'resolveAttachment' ? 90_000 : 60_000);
    pending.set(id, { resolve: data => { cleanup(); resolve(data); }, reject: error => { cleanup(); reject(error); }, timer });
    signal?.addEventListener('abort', abort, { once: true });
    worker.postMessage({ id, command });
  });
}

app.whenReady().then(async () => {
  const root = app.getPath('userData');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const componentArchive = path.join(app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'), 'napcat', RELEASE.archive);
  worker = utilityProcess.fork(path.join(__dirname, 'worker.cjs'), [root, componentArchive], { serviceName: `${BRAND.name}消息服务` });
  const ready = new Promise<void>(resolve => {
    worker.on('message', data => {
      if (data.ready) resolve();
      if (data.event?.type === 'state') {
        archiveAccountId = data.event.state.localAccount?.id ?? '';
        processor?.setAccount(archiveAccountId);
        const signature = JSON.stringify([archiveAccountId, data.event.state.groups
          .filter((group: { followed: boolean }) => group.followed)
          .map((group: { id: string; name: string }) => [group.id, group.name])]);
        if (signature !== followedSignature) { followedSignature = signature; processor?.refresh(); }
      }
      if (data.event?.type === 'messages' && !scheduleRefreshTimer) {
        scheduleRefreshTimer = setTimeout(() => { scheduleRefreshTimer = undefined; processor?.refresh(); }, 50);
      }
      if (data.event && !window?.isDestroyed()) window?.webContents.send('chancekit:event', data.event);
      const call = pending.get(data.id);
      if (call) { pending.delete(data.id); clearTimeout(call.timer); data.error ? call.reject(new Error(data.error)) : call.resolve(data.value); }
    });
  });
  worker.on('exit', () => {
    workerExited = true;
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('消息服务已退出，请重新打开应用。')); }
    pending.clear();
    if (!quitting && window) dialog.showErrorBox('消息服务已停止', `请重新打开${BRAND.name}。已经归档的消息保留在本机。`);
  });
  const connectionPath = path.join(root, 'connection.enc');
  function verifySender(event: Electron.IpcMainInvokeEvent) {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender');
  }
  registerOnboardingIpc({
    ipcMain,
    store: new OnboardingStore(root, Boolean(process.env.CHANCEKIT_TEST_DATA)),
    platform: process.platform,
    verifySender,
    openExternal: url => shell.openExternal(url),
  });
  const modelSettings = new ModelSettingsStore(root, {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable()
      && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encryptString: value => safeStorage.encryptString(value),
    decryptString: value => safeStorage.decryptString(value),
  });
  ipcMain.handle('chancekit:models:catalog', event => { verifySender(event); return getModelCatalog(); });
  ipcMain.handle('chancekit:models:get', event => { verifySender(event); return modelSettings.get(); });
  ipcMain.handle('chancekit:models:save', async (event, input) => {
    verifySender(event);
    const saved = await modelSettings.save(modelConfigInputSchema.parse(input));
    processor?.modelChanged();
    return saved;
  });
  ipcMain.handle('chancekit:models:clear', async event => {
    verifySender(event);
    modelTest?.abort();
    const cleared = await modelSettings.clear();
    processor?.modelChanged();
    return cleared;
  });
  ipcMain.handle('chancekit:models:test', async (event, input) => {
    verifySender(event);
    if (modelTest) throw new Error('已有连接测试正在运行。');
    const parsed = modelConfigInputSchema.parse(input);
    const controller = modelTest = new AbortController();
    try {
      const settings = await modelSettings.resolve(parsed);
      return await testPiModel(settings, { signal: controller.signal, fetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init) });
    } finally { if (modelTest === controller) modelTest = undefined; }
  });
  ipcMain.handle('chancekit:models:cancel-test', event => { verifySender(event); modelTest?.abort(); });
  await ready;
  const initial = await request<AppState>({ type: 'state' });
  archiveAccountId = initial.localAccount?.id ?? '';
  const scheduleStore = new ScheduleStore(path.join(root, 'messages.sqlite'));
  const webpagePdfs = new WebpagePdfStore(path.join(root, 'webpage-pdfs'), printWebpagePdf);
  titleReader = new InformationTitleReader(scheduleStore.information, () => archiveAccountId,
    () => { if (!window?.isDestroyed()) window?.webContents.send('chancekit:event', { type: 'schedule' }); });
  processor = new ScheduleProcessor(scheduleStore, () => modelSettings.saved(),
    async (job, settings, signal) => {
      const attempted = new Set<string>();
      for (let count = 0; count < 4; count++) {
        signal.throwIfAborted();
        const missing = job.referenceGraph?.missing.find(item => !attempted.has(`${item.fromKey}:${item.id}`));
        if (!missing) break;
        attempted.add(`${missing.fromKey}:${missing.id}`);
        try { await request({ type: 'resolveReply', accountId: job.message.accountId, messageKey: missing.fromKey, replyId: missing.id }, signal); }
        catch { signal.throwIfAborted(); }
        if (!scheduleStore.refreshReferences(job)) throw new Error('原消息已更新，引用读取结果未采用。');
      }
      return extractActivities(job, settings, {
        signal, fetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
        readWebpagePdf: (input, signal, consumePages) => webpagePdfs.read(job.message.accountId, input, signal, consumePages),
        resolveAttachment: (segmentIndex, signal) => request<ResolvedAttachment>({
          type: 'resolveAttachment', accountId: job.message.accountId, messageKey: job.message.key, segmentIndex,
        }, signal),
        resolveReferencedAttachment: (messageKey, segmentIndex, signal) => request<ResolvedAttachment>({
          type: 'resolveAttachment', accountId: job.message.accountId, messageKey, segmentIndex,
        }, signal),
      });
    },
    () => { if (!window?.isDestroyed()) window?.webContents.send('chancekit:event', { type: 'schedule' }); });
  processor.setAccount(archiveAccountId);
  ipcMain.handle('chancekit:schedule:list', (event, input) => {
    verifySender(event);
    const query = scheduleQuerySchema.parse(input);
    return archiveAccountId ? scheduleStore.page(archiveAccountId, query) : { activities: [], undated: [] };
  });
  ipcMain.handle('chancekit:schedule:detail', (event, input) => {
    verifySender(event);
    const id = z.string().regex(/^[a-f0-9]{64}$/).parse(input);
    return archiveAccountId ? scheduleStore.detail(archiveAccountId, id) : null;
  });
  ipcMain.handle('chancekit:schedule:status', event => { verifySender(event); return processor!.status(); });
  ipcMain.handle('chancekit:information:list', (event, input) => {
    verifySender(event);
    const query = informationQuerySchema.parse(input);
    const page = archiveAccountId ? scheduleStore.information.page(archiveAccountId, query) : emptyInformationPage;
    if (archiveAccountId) titleReader?.request(archiveAccountId, page.items.map(item => item.messageKey));
    return page;
  });
  ipcMain.handle('chancekit:information:detail', (event, input) => {
    verifySender(event);
    const key = z.string().regex(/^[a-f0-9]{64}$/).parse(input);
    return archiveAccountId ? scheduleStore.information.detail(archiveAccountId, key) : null;
  });
  ipcMain.handle('chancekit:pdf:open', async (event, input) => {
    verifySender(event);
    const { messageKey, snapshotId } = z.object({
      messageKey: z.string().regex(/^[a-f0-9]{64}$/), snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict().parse(input);
    const accountId = archiveAccountId;
    if (!scheduleStore.hasSnapshot(accountId, messageKey, snapshotId)) throw new Error('PDF 不属于当前关注消息。');
    let file: string;
    try { file = await webpagePdfs.file(accountId, snapshotId); }
    catch { throw new Error('PDF 快照已清理，请重新读取原消息。'); }
    if (accountId !== archiveAccountId || !scheduleStore.hasSnapshot(accountId, messageKey, snapshotId)) throw new Error('PDF 来源或账号已变化。');
    const error = await shell.openPath(file);
    if (error) throw new Error('PDF 打开失败，请检查系统 PDF 阅读器。');
  });
  ipcMain.handle('chancekit:schedule:configure', (event, input) => {
    verifySender(event); return processor!.configure(processingConfigSchema.parse(input));
  });
  ipcMain.handle('chancekit:schedule:retry', (event, input) => {
    verifySender(event); return processor!.retry(z.string().regex(/^[a-f0-9]{64}$/).optional().parse(input));
  });
  ipcMain.handle('chancekit:request', async (event, input) => {
    verifySender(event);
    const command = commandSchema.parse(input);
    await ready;
    const result = await request(command);
    if (command.type === 'connect' && safeStorage.isEncryptionAvailable()) {
      await writeFile(connectionPath, safeStorage.encryptString(JSON.stringify(command.config)), { mode: 0o600 });
    }
    return result;
  });
  ipcMain.handle('chancekit:connection', async event => {
    verifySender(event);
    try {
      if (!safeStorage.isEncryptionAvailable()) return {};
      const stored = JSON.parse(safeStorage.decryptString(await readFile(connectionPath)));
      return stored;
    } catch { return {}; }
  });
  ipcMain.handle('chancekit:choose-qq', async event => {
    verifySender(event);
    const selection = await dialog.showOpenDialog(window!, { title: '选择官方 QQ', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'QQ', extensions: ['exe'] }] : [{ name: 'QQ', extensions: ['app'] }] });
    return selection.canceled ? null : selection.filePaths[0];
  });
  ipcMain.handle('chancekit:export', async (event, groupId) => {
    verifySender(event);
    const command = commandSchema.parse({ type: 'export', groupId });
    const selection = await dialog.showSaveDialog(window!, { title: '导出消息记录', defaultPath: `群消息-${groupId}.jsonl`, filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }] });
    if (selection.canceled || !selection.filePath) return false;
    const source = await request<string>(command);
    await copyFile(source, selection.filePath);
    return true;
  });
  ipcMain.handle('chancekit:open', async (event, input: string) => {
    verifySender(event);
    const url = new URL(input);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('不支持这个链接。');
    await shell.openExternal(url.href);
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: BRAND.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] } as Electron.MenuItemConstructorOptions] : []),
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }] },
  ]));
  window = new BrowserWindow({ width: 1240, height: 820, minWidth: 900, minHeight: 640, backgroundColor: '#ffffff', title: BRAND.name, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  if (process.env.CHANCEKIT_RENDERER_URL) await window.loadURL(process.env.CHANCEKIT_RENDERER_URL);
  else await window.loadFile(path.join(__dirname, '../dist/index.html'));
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  modelTest?.abort();
  titleReader?.close();
  if (shutdownComplete || !worker || workerExited) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  clearTimeout(scheduleRefreshTimer);
  const finish = () => { clearTimeout(timer); shutdownComplete = true; app.quit(); };
  // Allow the protocol request and process fallback to finish before killing the worker.
  const timer = setTimeout(() => { worker.kill(); finish(); }, 10_000);
  worker.once('exit', finish);
  void (async () => {
    try { await processor?.close(); }
    finally {
      if (!shutdownComplete && !workerExited) worker.postMessage({ type: 'shutdown' });
    }
  })().catch(error => console.error('退出时清理日程任务失败：', error));
});
