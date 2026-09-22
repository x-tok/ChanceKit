import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, Command, DesktopBridge } from '../src/shared';

const bridge: DesktopBridge = {
  platform: process.platform as DesktopBridge['platform'],
  request: <T>(command: Command): Promise<T> => ipcRenderer.invoke('chancekit:request', command),
  subscribe(listener) {
    const handler = (_event: unknown, payload: AppEvent) => listener(payload);
    ipcRenderer.on('chancekit:event', handler);
    return () => ipcRenderer.removeListener('chancekit:event', handler);
  },
  chooseQQ: () => ipcRenderer.invoke('chancekit:choose-qq'),
  exportMessages: (groupId: string) => ipcRenderer.invoke('chancekit:export', groupId),
  openExternal: (url: string) => ipcRenderer.invoke('chancekit:open', url),
  openWebpagePdf: (messageKey, snapshotId) => ipcRenderer.invoke('chancekit:pdf:open', { messageKey, snapshotId }),
  savedConnection: () => ipcRenderer.invoke('chancekit:connection'),
  onboardingStatus: () => ipcRenderer.invoke('chancekit:onboarding:get'),
  completeOnboarding: accountId => ipcRenderer.invoke('chancekit:onboarding:complete', accountId),
  openQQDownload: () => ipcRenderer.invoke('chancekit:qq:download'),
  modelCatalog: () => ipcRenderer.invoke('chancekit:models:catalog'),
  modelSettings: () => ipcRenderer.invoke('chancekit:models:get'),
  saveModelSettings: input => ipcRenderer.invoke('chancekit:models:save', input),
  clearModelSettings: () => ipcRenderer.invoke('chancekit:models:clear'),
  testModelSettings: input => ipcRenderer.invoke('chancekit:models:test', input),
  cancelModelTest: () => ipcRenderer.invoke('chancekit:models:cancel-test'),
  schedule: query => ipcRenderer.invoke('chancekit:schedule:list', query),
  activity: id => ipcRenderer.invoke('chancekit:schedule:detail', id),
  recruitingInformation: query => ipcRenderer.invoke('chancekit:information:list', query),
  informationDetail: key => ipcRenderer.invoke('chancekit:information:detail', key),
  processingStatus: () => ipcRenderer.invoke('chancekit:schedule:status'),
  processingDetails: query => ipcRenderer.invoke('chancekit:schedule:processing-details', query),
  configureProcessing: value => ipcRenderer.invoke('chancekit:schedule:configure', value),
  retryProcessing: key => ipcRenderer.invoke('chancekit:schedule:retry', key),
  jobChatOverview: () => ipcRenderer.invoke('chancekit:job-chat:overview'),
  jobChatSession: sessionId => ipcRenderer.invoke('chancekit:job-chat:session', sessionId),
  jobChatResult: ref => ipcRenderer.invoke('chancekit:job-chat:result', ref),
  sendJobChat: input => ipcRenderer.invoke('chancekit:job-chat:send', input),
  cancelJobChat: sessionId => ipcRenderer.invoke('chancekit:job-chat:cancel', sessionId),
  deleteJobChat: sessionId => ipcRenderer.invoke('chancekit:job-chat:delete', sessionId),
};
contextBridge.exposeInMainWorld('desktop', bridge);
