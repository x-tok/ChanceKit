import type { DesktopBridge } from './shared';

export const isDesktop = Boolean(window.desktop);
const desktopOnly = async (): Promise<never> => { throw new Error('请在群讯桌面客户端中连接 QQ。浏览器仅提供界面预览。'); };
export const bridge: DesktopBridge = window.desktop ?? {
  request: desktopOnly, subscribe: () => () => {}, chooseQQ: desktopOnly,
  exportMessages: desktopOnly, openExternal: async url => { window.open(url, '_blank', 'noopener,noreferrer'); },
  savedConnection: async () => ({}),
};
