import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EnvHttpProxyAgent } from 'undici';

const execFileAsync = promisify(execFile);

export function parseMacOSProxy(output) {
  const field = key => output.match(new RegExp(`^\\s*${key} : (.+)$`, 'm'))?.[1].trim();
  const proxy = prefix => {
    if (field(`${prefix}Enable`) !== '1') return '';
    const host = field(`${prefix}Proxy`);
    const port = Number(field(`${prefix}Port`));
    if (!host || /[\s/@?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return '';
    try {
      const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
      // macOS's Secure Web Proxy uses HTTP CONNECT, not necessarily TLS to the proxy.
      return new URL(`http://${hostname}:${port}`).origin;
    } catch { return ''; }
  };
  return { httpProxy: proxy('HTTP'), httpsProxy: proxy('HTTPS') };
}

async function readMacOSProxy() {
  const { stdout } = await execFileAsync('/usr/sbin/scutil', ['--proxy'], { timeout: 3000, encoding: 'utf8' });
  return parseMacOSProxy(stdout);
}

export async function resolveDownloadProxy({
  env = process.env,
  platform = process.platform,
  readSystemProxy = readMacOSProxy,
} = {}) {
  const noProxy = env.no_proxy ?? env.NO_PROXY ?? env.npm_config_noproxy ?? '';
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY ?? '';
  const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY ?? '';
  if (httpProxy || httpsProxy) return { httpProxy, httpsProxy, noProxy, source: 'environment' };
  if (env.npm_config_proxy || env.npm_config_https_proxy) {
    return {
      httpProxy: env.npm_config_proxy || '',
      httpsProxy: env.npm_config_https_proxy || '',
      noProxy,
      source: 'npm configuration',
    };
  }
  if (platform === 'darwin' && noProxy !== '*') {
    try {
      const system = await readSystemProxy();
      if (system.httpProxy || system.httpsProxy) return { ...system, noProxy, source: 'macOS system settings' };
    } catch { /* Direct access is still usable when system settings are unavailable. */ }
  }
  return { httpProxy: '', httpsProxy: '', noProxy, source: 'direct connection' };
}

export async function createDownloadDispatcher(options) {
  const { source, ...proxy } = await resolveDownloadProxy(options);
  return {
    source,
    dispatcher: new EnvHttpProxyAgent({
      ...proxy,
      connect: { timeout: 30_000 },
      proxyTls: { timeout: 30_000 },
      requestTls: { timeout: 30_000 },
    }),
  };
}
