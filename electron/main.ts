import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, utilityProcess, Menu } from 'electron';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Command } from '../src/shared';
import { commandSchema } from './core/validation';
import { RELEASE } from './core/component';
import { BRAND } from '../src/brand';
import { resolveProfileDirectory } from './core/profile';

app.setName(BRAND.name);
const profile = process.env.CHANCEKIT_TEST_DATA ? path.resolve(process.env.CHANCEKIT_TEST_DATA)
  : app.isPackaged ? resolveProfileDirectory(app.getPath('appData')) : path.resolve('.dev-data');
app.setPath('userData', profile);
if (!app.requestSingleInstanceLock()) app.quit();
let window: BrowserWindow | undefined;
let quitting = false;
let worker: Electron.UtilityProcess;
const pending = new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

function request<T = any>(command: Command): Promise<T> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('操作超时，请查看连接状态。')); }, command.type === 'start' ? 600_000 : 60_000);
    pending.set(id, { resolve, reject, timer });
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
      if (data.event && !window?.isDestroyed()) window?.webContents.send('chancekit:event', data.event);
      const call = pending.get(data.id);
      if (call) { pending.delete(data.id); clearTimeout(call.timer); data.error ? call.reject(new Error(data.error)) : call.resolve(data.value); }
    });
  });
  worker.on('exit', () => {
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('消息服务已退出，请重新打开应用。')); }
    pending.clear();
    if (!quitting && window) dialog.showErrorBox('消息服务已停止', `请重新打开${BRAND.name}。已经归档的消息保留在本机。`);
  });
  const connectionPath = path.join(root, 'connection.enc');
  function verifySender(event: Electron.IpcMainInvokeEvent) {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender');
  }
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
  if (quitting || !worker) return;
  event.preventDefault(); quitting = true;
  worker.postMessage({ type: 'shutdown' });
  const timer = setTimeout(() => { worker.kill(); app.quit(); }, 6000);
  worker.once('exit', () => { clearTimeout(timer); app.quit(); });
});
