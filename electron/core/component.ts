import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import extract from 'extract-zip';
import manifest from '../../resources/napcat/manifest.json';

export const RELEASE = manifest;
const exists = (file: string) => access(file).then(() => true, () => false);
const requiredFiles = ['napcat.mjs', 'NapCatWinBootMain.exe', 'NapCatWinBootHook.dll'];

export async function installBundledNapCat(root: string, archive: string, report: (text: string) => void, signal: AbortSignal): Promise<string> {
  const dest = path.join(root, `napcat-${RELEASE.version}`);
  const marker = path.join(dest, '.verified');
  signal.throwIfAborted();
  if (await exists(marker) && await readFile(marker, 'utf8') === RELEASE.sha256 &&
      (await Promise.all(requiredFiles.map(file => exists(path.join(dest, file))))).every(Boolean)) return dest;

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

  const staging = `${dest}.staging`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    signal.throwIfAborted();
    report('正在解压内置连接组件');
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await extract(archive, { dir: staging, onEntry: entry => {
      signal.throwIfAborted();
      if ((entry.externalFileAttributes >>> 16 & 0o170000) === 0o120000) throw new Error('组件包含不允许的符号链接。');
    } });
    signal.throwIfAborted();
    if (!(await Promise.all(requiredFiles.map(file => exists(path.join(staging, file))))).every(Boolean)) throw new Error('内置组件内容不完整，请重新安装见机。');
    await writeFile(path.join(staging, '.verified'), RELEASE.sha256, { mode: 0o600 });
    await rm(dest, { recursive: true, force: true });
    await rename(staging, dest);
    return dest;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
