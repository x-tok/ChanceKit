import assert from 'node:assert/strict';
import test from 'node:test';
import type { MenuItemConstructorOptions } from 'electron';
import { applicationMenuTemplate } from '../electron/application-menu';

function items(template: MenuItemConstructorOptions[]) {
  return template.flatMap(item => Array.isArray(item.submenu) ? item.submenu : []);
}

test('macOS application menu exposes standard native commands', () => {
  const template = applicationMenuTemplate('见机', 'darwin');
  const topLevel = template.map(item => item.label);
  const commands = items(template);

  assert.deepEqual(topLevel, ['见机', '文件', '编辑', '显示', '窗口']);
  for (const role of ['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit', 'close', 'undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen', 'minimize', 'zoom', 'front']) {
    assert.ok(commands.some(item => item.role === role), `missing macOS menu role: ${role}`);
  }
  assert.equal(commands.find(item => item.role === 'togglefullscreen')?.accelerator, 'Control+Command+F');
});

test('Windows application menu keeps native editing and full-screen shortcuts', () => {
  const template = applicationMenuTemplate('见机', 'win32');
  const commands = items(template);

  assert.equal(template.some(item => item.label === '见机'), false);
  assert.ok(commands.some(item => item.role === 'quit'));
  assert.equal(commands.find(item => item.role === 'togglefullscreen')?.accelerator, 'F11');
});
