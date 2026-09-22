import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('desktop installs native application commands', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'chancekit-menu-e2e-'));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env: { ...env, CHANCEKIT_TEST_DATA: folder } });
  try {
    await app.firstWindow();
    const menu = await app.evaluate(({ Menu }) => {
      const applicationMenu = Menu.getApplicationMenu();
      const commands = applicationMenu?.items.flatMap(item => item.submenu?.items.map(command => ({
        id: command.id,
        role: command.role,
        accelerator: command.accelerator,
      })) ?? []) ?? [];
      return { topLevel: applicationMenu?.items.map(item => item.label) ?? [], commands };
    });

    expect(menu.topLevel).toContain('编辑');
    expect(menu.topLevel).toContain('显示');
    expect(menu.topLevel).toContain('窗口');
    expect(menu.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'copy' }),
      expect.objectContaining({ role: 'paste' }),
      expect.objectContaining({ role: 'close' }),
      expect.objectContaining({ role: 'minimize' }),
    ]));
    const fullScreen = menu.commands.find(command => command.id === 'toggle-full-screen');
    expect(fullScreen).toMatchObject({ role: 'togglefullscreen', accelerator: process.platform === 'darwin' ? 'Control+Command+F' : 'F11' });
  } finally {
    await app.close();
    await rm(folder, { recursive: true, force: true });
  }
});
