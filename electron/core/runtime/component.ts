import { createHash } from 'node:crypto';
import path from 'node:path';
import extract from 'extract-zip';
import manifest from '../../../resources/napcat/manifest.json';
import { runtimeFs, runtimeFiles, runtimePathExists, discardRuntimePath, recoverRuntimeDirectory, replaceRuntimeDirectory } from './runtime-files';

const { createReadStream } = runtimeFs;
const { mkdir, mkdtemp, readFile, cp, stat, writeFile } = runtimeFiles;
export const RELEASE = manifest;
const exists = runtimePathExists;
const requiredFiles = ['napcat.mjs', 'NapCatWinBootMain.exe', 'NapCatWinBootHook.dll'];

export async function installBundledNapCat(root: string, archive: string, report: (text: string) => void, signal: AbortSignal): Promise<string> {
  const dest = path.join(root, `napcat-${RELEASE.version}`);
  const marker = path.join(dest, '.verified');
  signal.throwIfAborted();
  await recoverRuntimeDirectory(dest);
  if (await exists(marker) && await readFile(marker, 'utf8') === RELEASE.sha256 &&
      (await Promise.all(requiredFiles.map(file => exists(path.join(dest, file))))).every(Boolean)) {
    await discardRuntimePath(`${dest}.previous`, report);
    await discardRuntimePath(`${dest}.staging`, report);
    return dest;
  }

  report('正在校验内置 NapCat 连接组件');
  try {
    if ((await stat(archive)).size !== RELEASE.size) throw new Error('size mismatch');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive, { signal })) hash.update(chunk);
    if (hash.digest('hex') !== RELEASE.sha256) throw new Error('checksum mismatch');
  } catch (error) {
    signal.throwIfAborted();
    throw new Error('内置 NapCat 组件缺失或损坏，请重新安装见机。', { cause: error });
  }

  await mkdir(root, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(root, `napcat-${RELEASE.version}.staging-`));
  try {
    signal.throwIfAborted();
    report('正在解压内置连接组件');
    await extract(archive, { dir: staging, onEntry: entry => {
      signal.throwIfAborted();
      if ((entry.externalFileAttributes >>> 16 & 0o170000) === 0o120000) throw new Error('组件包含不允许的符号链接。');
    } });
    signal.throwIfAborted();
    if (!(await Promise.all(requiredFiles.map(file => exists(path.join(staging, file))))).every(Boolean)) throw new Error('内置组件内容不完整，请重新安装见机。');
    const previousConfig = path.join(dest, 'config');
    if (await exists(previousConfig)) await cp(previousConfig, path.join(staging, 'config'), { recursive: true });
    await writeFile(path.join(staging, '.verified'), RELEASE.sha256, { mode: 0o600 });
    signal.throwIfAborted();
    await replaceRuntimeDirectory(staging, dest, report);
    await discardRuntimePath(`${dest}.staging`, report);
    return dest;
  } finally { await discardRuntimePath(staging, report); }
}
