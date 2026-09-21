import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { OnboardingStore } from './store';

export type IpcSenderVerifier = (event: IpcMainInvokeEvent) => void;

export interface OnboardingIpcOptions {
  ipcMain: IpcMain;
  store: OnboardingStore;
  platform: NodeJS.Platform;
  verifySender: IpcSenderVerifier;
  openExternal: (url: string) => Promise<unknown>;
}

export function qqDownloadTarget(platform: NodeJS.Platform): string {
  return platform === 'darwin'
    ? 'macappstore://itunes.apple.com/app/id451108668'
    : 'https://im.qq.com/pcqq/index.shtml';
}

export function registerOnboardingIpc(options: OnboardingIpcOptions): void {
  const { ipcMain, store, platform, verifySender, openExternal } = options;
  ipcMain.handle('chancekit:onboarding:get', event => {
    verifySender(event);
    return store.status();
  });
  ipcMain.handle('chancekit:onboarding:complete', (event, accountId: string) => {
    verifySender(event);
    return store.complete(accountId);
  });
  ipcMain.handle('chancekit:qq:download', async event => {
    verifySender(event);
    await openExternal(qqDownloadTarget(platform));
  });
}
