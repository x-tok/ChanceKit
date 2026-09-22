import path from 'node:path';
import os from 'node:os';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { installBundledNapCat } from './component';
import { macLoader, macQuitCommand, macLaunchArgs } from './mac-loader';
import { OneBot } from '../connection/onebot';
import { runtimeFiles, runtimePathExists, discardRuntimePath, recoverRuntimeDirectory, replaceRuntimeDirectory } from './runtime-files';
import type { ConnectionConfig, QQInstallation } from '../../../src/shared';

const exec = promisify(execFile);
const { mkdir, mkdtemp, readFile, writeFile, readdir, stat } = runtimeFiles;
const exists = runtimePathExists;
const readJSON = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
const saveJSON = async (p: string, value: unknown) => writeFile(p, JSON.stringify(value, null, 2), { mode: 0o600 });
const macEntitlements = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/><key>com.apple.security.cs.disable-executable-page-protection</key><true/><key>com.apple.security.network.client</key><true/><key>com.apple.security.network.server</key><true/></dict></plist>';

const hasExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
function waitForExit(child: ChildProcess, timeout: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = (exited: boolean) => { clearTimeout(timer); child.off('exit', onExit); resolve(exited); };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeout);
    child.once('exit', onExit);
  });
}

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
  private connection?: ConnectionConfig;
  private abort?: AbortController;
  private stopping = false;
  private stopPending?: Promise<void>;
  constructor(private root: string, private report: (text: string) => void, private exited: (text: string) => void, private componentArchive: string) {}

  async start(installation: QQInstallation, autoLoginAccount = ''): Promise<ConnectionConfig> {
    if (this.child || this.abort || this.stopPending) throw new Error('连接组件已经在运行或准备中。');
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
        const managedExecutable = path.join(this.root, 'QQRuntime.app/Contents/MacOS/QQ');
        if (stdout.split('\n').some(line => line === managedExecutable || line.startsWith(`${managedExecutable} `))) {
          throw new Error('已有 QQ 连接组件正在使用这个副本。请先关闭另一个见机实例，再重新连接。');
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
        executable = await this.prepareMac(installation, signal);
        args = [...macLaunchArgs];
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
      const child = spawn(executable, args, { cwd: component, env, windowsHide: true, detached: process.platform !== 'win32', stdio: [process.platform === 'darwin' ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      this.child = child;
      this.connection = config;
      child.stdin?.on('error', () => {}); // QQ can exit between checking the pipe and writing the quit command.
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

  private async prepareMac(qq: QQInstallation, signal: AbortSignal) {
    const bundle = path.join(this.root, 'QQRuntime.app');
    const markerPath = 'Contents/Resources/chancekit-runtime.json';
    const executable = path.join(bundle, 'Contents/MacOS/QQ');
    const sourceFiles = ['Contents/Info.plist', 'Contents/MacOS/QQ', 'Contents/Resources/app/wrapper.node', 'Contents/Resources/app/application.asar'];
    const source = await Promise.all(sourceFiles.map(async file => {
      const info = await stat(path.join(qq.path, file));
      return { file, size: info.size, modified: info.mtimeMs, inode: info.ino };
    }));
    const packageData = await readFile(path.join(qq.path, 'Contents/Resources/app/package.json'));
    const identity = JSON.stringify({ path: qq.path, version: qq.version, architecture: qq.architecture, source,
      signing: 'deep', launchArgs: macLaunchArgs,
      packageHash: createHash('sha256').update(packageData).digest('hex'),
      loaderHash: createHash('sha256').update(macLoader).update(macEntitlements).digest('hex') });
    await recoverRuntimeDirectory(bundle);
    await discardRuntimePath(path.join(this.root, 'QQRuntime.staging.app'), this.report);
    try {
      if (await readFile(path.join(bundle, markerPath), 'utf8') === identity &&
          (await readJSON(path.join(bundle, 'Contents/Resources/app/package.json'))).main === './chancekit-loader.cjs' &&
          await readFile(path.join(bundle, 'Contents/Resources/app/chancekit-loader.cjs'), 'utf8') === macLoader && await exists(executable)) {
        await exec('/usr/bin/codesign', ['--verify', '--deep', bundle], { signal });
        await discardRuntimePath(`${bundle}.previous`, this.report);
        return executable;
      }
    } catch { signal.throwIfAborted(); }
    this.report('正在准备独立 QQ 运行副本 · 约需 1 GB 空间');
    await exec('/usr/bin/codesign', ['--verify', qq.path], { signal });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const workspace = await mkdtemp(path.join(this.root, 'qq-runtime-'));
    const staging = path.join(workspace, 'QQRuntime.app');
    try {
      await exec('/usr/bin/ditto', [qq.path, staging], { signal, timeout: 180_000 });
      const appDir = path.join(staging, 'Contents/Resources/app');
      const pkg = JSON.parse(packageData.toString('utf8'));
      await saveJSON(path.join(appDir, 'package.json'), { ...pkg, main: './chancekit-loader.cjs' });
      // NapCat's macOS data path is derived from os.homedir, not Electron userData.
      // A process-local shim isolates its profile without changing HOME or linking old QQ/QCE stores.
      await writeFile(path.join(appDir, 'chancekit-loader.cjs'), macLoader);
      await writeFile(path.join(staging, markerPath), identity);
      const entitlements = path.join(workspace, 'entitlements.plist');
      await writeFile(entitlements, macEntitlements);
      this.report('正在签名独立 QQ 运行副本');
      // Helpers and QQNT must share the copy's ad-hoc signature in multi-process mode.
      await exec('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, staging], { signal, timeout: 90_000 });
      await exec('/usr/bin/codesign', ['--verify', '--deep', staging], { signal });
      signal.throwIfAborted();
      await replaceRuntimeDirectory(staging, bundle, this.report);
      await discardRuntimePath(path.join(this.root, 'qq-runtime.json'), this.report);
      await discardRuntimePath(path.join(this.root, 'runtime-entitlements.plist'), this.report);
    } finally { await discardRuntimePath(workspace, this.report); }
    return executable;
  }

  stop(): Promise<void> {
    this.stopping = true;
    this.abort?.abort();
    this.stopPending ??= this.stopOwnedChild().finally(() => { this.stopPending = undefined; });
    return this.stopPending;
  }

  private async stopOwnedChild() {
    const child = this.child;
    const connection = this.connection;
    this.connection = undefined;
    if (!child?.pid || hasExited(child)) {
      if (this.child === child) this.child = undefined;
      return;
    }
    try {
      if (connection) {
        this.report('正在请求 QQ 正常退出');
        const bot = new OneBot(3000);
        const exited = waitForExit(child, 3000);
        // bot_exit calls process.exit(0), so the socket can close without an action response.
        // Use the owned process exit as confirmation, never a disconnected WebSocket.
        const request = bot.connect(connection.wsUrl, connection.accessToken)
          .then(() => bot.call('bot_exit')).catch(() => {});
        const stopped = await exited;
        bot.close();
        await request;
        if (stopped || hasExited(child)) return;
      }
      if (process.platform === 'darwin' && child.stdin?.writable && !child.stdin.destroyed) {
        const exited = waitForExit(child, 2000);
        child.stdin.write(`${macQuitCommand}\n`);
        if (await exited || hasExited(child)) return;
      }
      this.report('正在停止 QQ 连接进程');
      const terminated = waitForExit(child, 2000);
      if (process.platform === 'win32') {
        await exec('taskkill.exe', ['/PID', String(child.pid), '/T'], { windowsHide: true, timeout: 2000 }).catch(() => {});
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      }
      if (await terminated || hasExited(child)) return;
      this.report('QQ 未响应退出请求，正在结束连接进程');
      const killed = waitForExit(child, 1000);
      if (process.platform === 'win32') {
        await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 1000 }).catch(() => {});
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
      if (!await killed) throw new Error('QQ 连接进程尚未退出，请稍后重试停止连接。');
    } finally {
      if (this.child === child && hasExited(child)) this.child = undefined;
    }
  }
}
