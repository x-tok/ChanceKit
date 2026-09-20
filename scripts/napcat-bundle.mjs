import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { fetch } from 'undici';
import { createDownloadDispatcher } from './download-proxy.mjs';

const directory = fileURLToPath(new URL('../resources/napcat/', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
const archive = path.join(directory, manifest.archive);

export async function verifyNapCatBundle(file = archive, release = manifest) {
  try {
    if ((await stat(file)).size !== release.size) throw new Error('size mismatch');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest('hex') !== release.sha256) throw new Error('checksum mismatch');
  } catch (cause) {
    throw new Error('Bundled NapCat is missing or invalid. Run npm run prepare:napcat before building.', { cause });
  }
}

const retryableCodes = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
]);

function canRetry(error) {
  return [408, 429, 500, 502, 503, 504].includes(error.status)
    || retryableCodes.has(error.cause?.code ?? error.code);
}

export async function prepareNapCatBundle({
  file = archive,
  release = manifest,
  dispatcher,
  attempts = 3,
  retryDelay = 1000,
  timeout = 300_000,
} = {}) {
  try { await verifyNapCatBundle(file, release); console.log(`NapCat ${release.version}: bundle verified`); return; } catch { /* Fetch only during maintainer preparation. */ }
  const partial = `${file}.part`;
  let ownedDispatcher;
  try {
    console.log(`Preparing official NapCat ${release.version} for the app bundle`);
    if (!dispatcher) {
      const configured = await createDownloadDispatcher();
      dispatcher = ownedDispatcher = configured.dispatcher;
      console.log(`Download connection: ${configured.source}`);
    }
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const signal = AbortSignal.timeout(timeout);
      try {
        const response = await fetch(release.url, { signal, redirect: 'follow', dispatcher });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw Object.assign(new Error(`NapCat download failed: HTTP ${response.status}`), { status: response.status });
        }
        let size = 0;
        const limit = new Transform({ transform(chunk, _encoding, callback) {
          size += chunk.length;
          callback(size > release.size ? new Error('NapCat archive exceeds pinned size') : null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(partial, { mode: 0o600 }), { signal });
        await verifyNapCatBundle(partial, release);
        await rename(partial, file);
        console.log(`NapCat ${release.version}: ready (${release.size} bytes)`);
        return;
      } catch (error) {
        if (attempt === attempts || (!signal.aborted && !canRetry(error))) throw error;
        console.warn(`NapCat download attempt ${attempt}/${attempts} failed; retrying...`);
      } finally { await rm(partial, { force: true }); }
      await delay(retryDelay * attempt);
    }
  } catch (cause) {
    const detail = cause.cause?.code ?? cause.cause?.message ?? cause.message;
    throw new Error(
      `NapCat preparation failed: ${detail}\n`
      + 'Check your connection to GitHub or set HTTPS_PROXY to your HTTP proxy URL and retry npm run prepare:napcat.\n'
      + `Alternatively, place the official NapCat ${release.version} ZIP at ${file}; its pinned size and SHA-256 must match.`,
      { cause },
    );
  } finally {
    await ownedDispatcher?.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes('--download')) await prepareNapCatBundle();
    else await verifyNapCatBundle();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
