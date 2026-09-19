import { access, mkdir, readFile, writeFile, rename, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { installBundledNapCat } from './component';
import type { ConnectionConfig, QQInstallation } from '../../src/shared';

const exec = promisify(execFile);
const exists = async (p: string) => access(p).then(() => true, () => false);
const readJSON = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
const saveJSON = async (p: string, value: unknown) => writeFile(p, JSON.stringify(value, null, 2), { mode: 0o600 });

async function windowsPackage(exe: string): Promise<string> {
  const root = path.dirname(exe);
  for (const base of [path.join(root, 'versions'), path.join(root, 'resources', 'app', 'versions')]) {
    try {
      const config = await readJSON(path.join(root, 'versions', 'config.json'));
      for (const suffix of ['resources/app/package.json', 'package.json']) {
        const candidate = path.join(base, String(config.curVersion), suffix);
        if (await exists(candidate)) return candidate;
      }
    } catch { /* Older QQ packages may not have a version selector. */ }
  }
  return path.join(root, 'resources', 'app', 'package.json');
}

export async function detectQQ(selected?: string): Promise<QQInstallation | undefined> {
  const candidates = selected ? [selected] : process.platform === 'darwin'
    ? ['/Applications/QQ.app', path.join(os.homedir(), 'Applications/QQ.app')]
    : [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tencent/QQNT/QQ.exe'), path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tencent/QQNT/QQ.exe'), path.join(process.env.LOCALAPPDATA || '', 'Programs/Tencent/QQNT/QQ.exe')];
  if (!selected && process.platform === 'win32') {
    for (const hive of ['HKCU', 'HKLM']) {
      try {
        const { stdout } = await exec('reg.exe', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\QQ.exe`, '/ve'], { windowsHide: true });
        const match = stdout.match(/REG_SZ\s+(.+?QQ\.exe)/i);
        if (match) candidates.unshift(match[1].trim());
      } catch { /* The file picker covers nonstandard installations. */ }
    }
  }
  for (let candidate of candidates) {
    if (process.platform === 'darwin' && candidate.endsWith('/Contents/MacOS/QQ')) candidate = path.resolve(candidate, '../../..');
    if (!await exists(candidate)) continue;
    try {
      const pkgPath = process.platform === 'darwin' ? path.join(candidate, 'Contents/Resources/app/package.json') : await windowsPackage(candidate);
      const pkg = await readJSON(pkgPath);
      if (pkg.name !== 'qq-chat' || !String(pkg.main).includes('application.asar')) throw new Error('请选择未修改的官方 QQ 安装，不能使用其他工具生成的运行副本。');
      return { path: candidate, version: String(pkg.version), architecture: String(pkg.eleArch || 'unknown'), platform: process.platform };
    } catch (error) { if (selected) throw error; }
  }
  return undefined;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

export class RuntimeManager {
  private child?: ChildProcess;
  private abort?: AbortController;
  private stopping = false;
  constructor(private root: string, private report: (text: string) => void, private exited: (text: string) => void, private componentArchive: string) {}

  async start(installation: QQInstallation, autoLoginAccount = ''): Promise<ConnectionConfig> {
    if (this.child || this.abort) throw new Error('连接组件已经在运行或准备中。');
    if (!['darwin', 'win32'].includes(process.platform)) throw new Error('本机自动启动仅支持 macOS 和 Windows。');
    this.stopping = false;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    try {
      // Refuse a second desktop session without terminating any user process.
      if (process.platform === 'darwin') {
        const { stdout } = await exec('/bin/ps', ['-axo', 'args=']);
        if (stdout.split('\n').some(line => line.startsWith(path.join(installation.path, 'Contents/MacOS/QQ')))) {
          throw new Error('桌面 QQ 正在运行。请先正常退出 QQ，再点击连接；之后可随时停止采集并重新打开 QQ。');
        }
      }
      const component = await installBundledNapCat(this.root, this.componentArchive, this.report, signal);
      const webPort = await freePort();
      let wsPort = await freePort();
      while (wsPort === webPort) wsPort = await freePort();
      const config: ConnectionConfig = { webuiUrl: `http://127.0.0.1:${webPort}`, wsUrl: `ws://127.0.0.1:${wsPort}`, webuiToken: randomBytes(24).toString('hex'), accessToken: randomBytes(24).toString('hex') };
      const configDir = path.join(component, 'config');
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await saveJSON(path.join(configDir, 'webui.json'), { host: '127.0.0.1', port: webPort, prefix: '', token: config.webuiToken, loginRate: 20, autoLoginAccount: /^\d+$/.test(autoLoginAccount) ? autoLoginAccount : '', accessControlMode: 'none' });
      const onebot = { network: { websocketServers: [{ name: 'chancekit', enable: true, host: '127.0.0.1', port: wsPort, token: config.accessToken, messagePostFormat: 'array', reportSelfMessage: true, enableForcePushEvent: true, heartInterval: 15000 }] } };
      await saveJSON(path.join(configDir, 'onebot11.json'), onebot);
      // NapCat prefers account-specific files after the first successful login.
      for (const name of await readdir(configDir)) if (/^onebot11_\d+\.json$/.test(name)) await saveJSON(path.join(configDir, name), onebot);
      const env: NodeJS.ProcessEnv = { ...process.env, NAPCAT_WORKDIR: component, NAPCAT_DISABLE_MULTI_PROCESS: '1', CHANCEKIT_NAPCAT_ENTRY: path.join(component, 'napcat.mjs'), CHANCEKIT_QQ_DATA: path.join(this.root, 'qq-profile') };
      delete env.ELECTRON_RUN_AS_NODE;
      let executable: string;
      let args: string[];
      if (process.platform === 'darwin') {
        executable = await this.prepareMac(installation, component, signal);
        args = ['--single-process', '--disable-gpu'];
      } else {
        const pkg = await windowsPackage(installation.path);
        const patch = { ...await readJSON(pkg), main: './loadNapCat.js' };
        await saveJSON(path.join(component, 'qqnt.json'), patch);
        await writeFile(path.join(component, 'loadNapCat.js'), `import(require('node:url').pathToFileURL(process.env.CHANCEKIT_NAPCAT_ENTRY).href).catch(e => { console.error(e); process.exit(1); });\n`);
        Object.assign(env, { NAPCAT_PATCH_PACKAGE: path.join(component, 'qqnt.json'), NAPCAT_LOAD_PATH: path.join(component, 'loadNapCat.js'), NAPCAT_INJECT_PATH: path.join(component, 'NapCatWinBootHook.dll'), NAPCAT_QQ_PACKAGE_INFO_PATH: pkg });
        executable = path.join(component, 'NapCatWinBootMain.exe');
        args = [installation.path, path.join(component, 'NapCatWinBootHook.dll')];
      }
      signal.throwIfAborted();
      this.report('正在启动 QQ 连接组件');
      const child = spawn(executable, args, { cwd: component, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      // Upstream stdout may contain login URLs and tokens. Consume it without forwarding or persisting it.
      child.stdout?.resume();
      child.stderr?.resume();
      child.on('error', () => {
        if (this.child !== child) return;
        this.child = undefined;
        if (!this.stopping) this.exited('QQ 连接进程无法启动，请检查 QQ 版本与系统权限。');
      });
      child.on('exit', (code, exitSignal) => {
        const owned = this.child === child;
        if (owned) this.child = undefined;
        if (owned && !this.stopping) this.exited(`QQ 连接进程已退出（${exitSignal || code || 0}）。请检查版本兼容性后重试。`);
      });
      return config;
    } finally { this.abort = undefined; }
  }

  private async prepareMac(qq: QQInstallation, component: string, signal: AbortSignal) {
    const bundle = path.join(this.root, 'QQRuntime.app');
    const marker = path.join(this.root, 'qq-runtime.json');
    const identity = JSON.stringify({ path: qq.path, version: qq.version, architecture: qq.architecture, loader: 2 });
    if (await exists(marker) && await readFile(marker, 'utf8') === identity && await exists(path.join(bundle, 'Contents/MacOS/QQ'))) return path.join(bundle, 'Contents/MacOS/QQ');
    this.report('正在准备独立 QQ 运行副本 · 约需 1 GB 空间');
    await exec('/usr/bin/codesign', ['--verify', qq.path], { signal });
    const staging = path.join(this.root, 'QQRuntime.staging.app');
    await rm(staging, { recursive: true, force: true });
    try {
      await exec('/usr/bin/ditto', [qq.path, staging], { signal, timeout: 180_000 });
      const appDir = path.join(staging, 'Contents/Resources/app');
      const pkg = await readJSON(path.join(appDir, 'package.json'));
      await saveJSON(path.join(appDir, 'package.json'), { ...pkg, main: './chancekit-loader.cjs' });
      // NapCat's macOS data path is derived from os.homedir, not Electron userData.
      // A process-local shim isolates its profile without changing HOME or linking old QQ/QCE stores.
      const loader = `const fs = require('node:fs');\nconst os = require('node:os');\nconst path = require('node:path');\nconst data = process.env.CHANCEKIT_QQ_DATA;\nif (!data || !process.env.CHANCEKIT_NAPCAT_ENTRY) throw new Error('Launch this runtime from ChanceKit');\nfs.mkdirSync(path.join(data, 'Library/Application Support/QQ'), {recursive:true});\nos.homedir = () => data;\nrequire('node:module').syncBuiltinESMExports();\nrequire('electron').app.setPath('userData', path.join(data, 'electron'));\nimport(require('node:url').pathToFileURL(process.env.CHANCEKIT_NAPCAT_ENTRY).href).catch(e => { console.error(e); process.exit(1); });\n`;
      await writeFile(path.join(appDir, 'chancekit-loader.cjs'), loader);
      const entitlements = path.join(this.root, 'runtime-entitlements.plist');
      await writeFile(entitlements, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/><key>com.apple.security.cs.disable-executable-page-protection</key><true/><key>com.apple.security.network.client</key><true/><key>com.apple.security.network.server</key><true/></dict></plist>');
      this.report('正在签名独立 QQ 运行副本');
      await exec('/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', entitlements, staging], { signal, timeout: 90_000 });
      await exec('/usr/bin/codesign', ['--verify', staging], { signal });
      signal.throwIfAborted();
      await rm(bundle, { recursive: true, force: true });
      await rename(staging, bundle);
      await writeFile(marker, identity);
    } finally { await rm(staging, { recursive: true, force: true }); }
    return path.join(bundle, 'Contents/MacOS/QQ');
  }

  async stop() {
    this.stopping = true;
    this.abort?.abort();
    const child = this.child;
    if (!child?.pid) return;
    this.child = undefined;
    if (process.platform === 'win32') {
      await exec('taskkill.exe', ['/PID', String(child.pid), '/T'], { windowsHide: true }).catch(() => {});
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} resolve(); }, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
}
