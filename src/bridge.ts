import type { DesktopBridge } from './shared';
import { emptyInformationPage, emptyProcessingDetails, emptyProcessingStatus } from './schedule';

export const isDesktop = Boolean(window.desktop);
const desktopOnly = async (): Promise<never> => { throw new Error('请在见机桌面客户端中连接 QQ。浏览器仅提供界面预览。'); };
const modelDesktopOnly = async (): Promise<never> => { throw new Error('模型配置需要在见机桌面客户端中保存和测试。'); };
export const bridge: DesktopBridge = window.desktop ?? {
  platform: /Mac/i.test(navigator.userAgent) ? 'darwin' : /Windows/i.test(navigator.userAgent) ? 'win32' : 'linux',
  request: desktopOnly, subscribe: () => () => {}, chooseQQ: desktopOnly,
  exportMessages: desktopOnly, openExternal: async url => { window.open(url, '_blank', 'noopener,noreferrer'); },
  savedConnection: async () => ({}),
  onboardingStatus: async () => ({ completed: new URLSearchParams(location.search).get('onboarding') !== '1' }),
  completeOnboarding: async () => {},
  openQQDownload: async () => { window.open('https://im.qq.com/', '_blank', 'noopener,noreferrer'); },
  openWebpagePdf: desktopOnly,
  modelCatalog: async () => [],
  modelSettings: async () => ({ config: null, hasApiKey: false, updatedAt: null, encryptionAvailable: false }),
  saveModelSettings: modelDesktopOnly, clearModelSettings: modelDesktopOnly,
  testModelSettings: modelDesktopOnly, cancelModelTest: async () => {},
  schedule: async () => ({ activities: [], undated: [] }), activity: async () => null,
  recruitingInformation: async () => ({ ...emptyInformationPage, items: [] }), informationDetail: async () => null,
  processingStatus: async () => ({ ...emptyProcessingStatus, issues: [] }),
  processingDetails: async () => ({ ...emptyProcessingDetails, items: [] }),
  configureProcessing: desktopOnly, retryProcessing: desktopOnly,
};
