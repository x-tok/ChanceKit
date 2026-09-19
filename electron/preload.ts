import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, Command, DesktopBridge } from '../src/shared';

const bridge: DesktopBridge = {
  request: <T>(command: Command): Promise<T> => ipcRenderer.invoke('chancekit:request', command),
  subscribe(listener) {
    const handler = (_event: unknown, payload: AppEvent) => listener(payload);
    ipcRenderer.on('chancekit:event', handler);
    return () => ipcRenderer.removeListener('chancekit:event', handler);
  },
  chooseQQ: () => ipcRenderer.invoke('chancekit:choose-qq'),
  exportMessages: (groupId: string) => ipcRenderer.invoke('chancekit:export', groupId),
  openExternal: (url: string) => ipcRenderer.invoke('chancekit:open', url),
  savedConnection: () => ipcRenderer.invoke('chancekit:connection'),
};
contextBridge.exposeInMainWorld('desktop', bridge);
