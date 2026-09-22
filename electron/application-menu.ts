import type { MenuItemConstructorOptions } from 'electron';

export function applicationMenuTemplate(appName: string, platform: NodeJS.Platform = process.platform): MenuItemConstructorOptions[] {
  const macOS = platform === 'darwin';

  return [
    ...(macOS ? [{
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services', submenu: [] },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    } satisfies MenuItemConstructorOptions] : []),
    {
      label: '文件',
      submenu: [
        { role: 'close' },
        ...(!macOS ? [{ type: 'separator' }, { role: 'quit' }] as MenuItemConstructorOptions[] : []),
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        ...(macOS ? [
          { type: 'separator' },
          { label: '语音', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] },
        ] as MenuItemConstructorOptions[] : []),
      ],
    },
    {
      label: '显示',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { id: 'toggle-full-screen', role: 'togglefullscreen', accelerator: macOS ? 'Control+Command+F' : 'F11' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(macOS ? [{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[] : []),
      ],
    },
  ];
}
