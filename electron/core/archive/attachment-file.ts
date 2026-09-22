import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';

export async function readManagedAttachment(file: string, root: string, expectedName: string, maxBytes: number): Promise<Uint8Array> {
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(file)]);
  const relative = path.relative(canonicalRoot, canonicalFile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('附件缓存路径超出本应用的 QQ 数据目录。');
  if (expectedName && path.basename(canonicalFile) !== path.basename(expectedName)) throw new Error('附件缓存文件名与原消息不一致。');
  const handle = await open(canonicalFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('附件不是普通文件或超过读取上限。');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('附件缓存尚未下载完整。');
      offset += bytesRead;
    }
    return bytes;
  } finally { await handle.close(); }
}
