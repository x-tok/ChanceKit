import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, Command, DesktopBridge } from '../src/shared';

const bridge: DesktopBridge = {
  request: <T>(command: Command): Promise<T> => ipcRenderer.invoke('qunxun:request', command),
  subscribe(listener) {
    const handler = (_event: unknown, payload: AppEvent) => listener(payload);
    ipcRenderer.on('qunxun:event', handler);
    return () => ipcRenderer.removeListener('qunxun:event', handler);
  },
  chooseQQ: () => ipcRenderer.invoke('qunxun:choose-qq'),
  exportMessages: (groupId: string) => ipcRenderer.invoke('qunxun:export', groupId),
  openExternal: (url: string) => ipcRenderer.invoke('qunxun:open', url),
  savedConnection: () => ipcRenderer.invoke('qunxun:connection'),
};
contextBridge.exposeInMainWorld('desktop', bridge);
