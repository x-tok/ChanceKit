import { createRequire } from 'node:module';

// Electron's patched fs traverses .asar files as directories, even in utility processes.
export const runtimeFs: typeof import('node:fs') = createRequire(process.execPath)(process.versions.electron ? 'original-fs' : 'node:fs');
export const runtimeFiles = runtimeFs.promises;

export async function runtimePathExists(file: string): Promise<boolean> {
  try { await runtimeFiles.lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function removeRuntimePath(file: string): Promise<void> {
  await runtimeFiles.rm(file, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export async function discardRuntimePath(file: string, report: (text: string) => void): Promise<void> {
  try { await removeRuntimePath(file); }
  catch { report('部分旧组件文件暂未清理，不影响已准备的组件。'); }
}

export async function recoverRuntimeDirectory(destination: string): Promise<void> {
  const previous = `${destination}.previous`;
  if (!await runtimePathExists(destination) && await runtimePathExists(previous)) await runtimeFiles.rename(previous, destination);
}

export async function replaceRuntimeDirectory(staging: string, destination: string, report: (text: string) => void): Promise<void> {
  const previous = `${destination}.previous`;
  await recoverRuntimeDirectory(destination);
  await removeRuntimePath(previous);
  const hadPrevious = await runtimePathExists(destination);
  if (hadPrevious) await runtimeFiles.rename(destination, previous);
  try { await runtimeFiles.rename(staging, destination); }
  catch (error) {
    if (hadPrevious) {
      try { await runtimeFiles.rename(previous, destination); }
      catch { throw new Error('组件替换未完成，旧副本已保留。请关闭见机后重试。', { cause: error }); }
    }
    throw error;
  }
  await discardRuntimePath(previous, report);
}
