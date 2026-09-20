import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDownloadProxy } from './download-proxy.mjs';

const require = createRequire(import.meta.url);

export async function prepareElectron({
  env = process.env,
  platform = process.platform,
  readSystemProxy,
  installer = require.resolve('electron/install.js'),
  timeout = 600_000,
} = {}) {
  const { httpProxy, httpsProxy, noProxy, source } = await resolveDownloadProxy({ env, platform, readSystemProxy });
  // Electron's installer runs in another process, so a local fetch dispatcher is not inherited.
  const installEnv = {
    ...env,
    ELECTRON_GET_USE_PROXY: '1',
    http_proxy: httpProxy, HTTP_PROXY: httpProxy,
    https_proxy: httpsProxy, HTTPS_PROXY: httpsProxy,
    no_proxy: noProxy, NO_PROXY: noProxy,
  };
  console.log(`Checking Electron runtime (download connection: ${source})`);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [installer], { env: installEnv, stdio: 'inherit', timeout });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(signal ? `installer stopped by ${signal}` : `installer exited with code ${code}`));
      });
    });
  } catch (cause) {
    throw new Error(
      `Electron preparation failed: ${cause.message}\n`
      + 'Check your connection or set HTTPS_PROXY to your HTTP proxy URL, then run npm run prepare:electron.\n'
      + 'The official installer reuses cached downloads; deleting node_modules is not required.',
      { cause },
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await prepareElectron(); console.log('Electron runtime: ready'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
