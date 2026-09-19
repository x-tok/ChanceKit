import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const directory = fileURLToPath(new URL('../resources/napcat/', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
const archive = path.join(directory, manifest.archive);

export async function verifyNapCatBundle(file = archive) {
  try {
    if ((await stat(file)).size !== manifest.size) throw new Error('size mismatch');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest('hex') !== manifest.sha256) throw new Error('checksum mismatch');
  } catch (cause) {
    throw new Error('Bundled NapCat is missing or invalid. Run npm run prepare:napcat before building.', { cause });
  }
}

async function prepare() {
  try { await verifyNapCatBundle(); console.log(`NapCat ${manifest.version}: bundle verified`); return; } catch { /* Fetch only during maintainer preparation. */ }
  const partial = `${archive}.part`;
  try {
    console.log(`Preparing official NapCat ${manifest.version} for the app bundle`);
    const signal = AbortSignal.timeout(300_000);
    const response = await fetch(manifest.url, { signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`NapCat download failed: HTTP ${response.status}`);
    let size = 0;
    const limit = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length;
      callback(size > manifest.size ? new Error('NapCat archive exceeds pinned size') : null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(partial, { mode: 0o600 }), { signal });
    await verifyNapCatBundle(partial);
    await rename(partial, archive);
    console.log(`NapCat ${manifest.version}: ready (${manifest.size} bytes)`);
  } finally { await rm(partial, { force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--download')) await prepare();
  else await verifyNapCatBundle();
}
