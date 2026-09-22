import { readFile, readlink, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repository = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const profile = path.join(repository, '.dev-data');
const instancePidFile = path.join(profile, 'chancekit.pid');
const exec = promisify(execFile);

if (path.dirname(profile) !== repository || path.basename(profile) !== '.dev-data') {
  throw new Error(`Refusing to remove an unexpected path: ${profile}`);
}

async function activeProfileOwner() {
  try {
    const pid = processIdFromText(await readFile(instancePidFile, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return pid; }
      catch (error) { if (error?.code !== 'ESRCH') return pid; }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let lockTarget;
  try {
    lockTarget = await readlink(path.join(profile, 'SingletonLock'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    if (error?.code === 'EINVAL') return 'active-profile-lock';
    throw error;
  }
  const match = lockTarget.match(/-(\d+)$/);
  if (!match) return undefined;
  const pid = Number(match[1]);
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    if (error?.code === 'ESRCH') return undefined;
    return pid;
  }
}

export function processIdFromText(value) {
  const pid = Number(value.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export function managedRuntimePidsFromProcessList(output, executable) {
  const pids = [];
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const command = match[2];
    if (command === executable || command.startsWith(`${executable} `)) pids.push(Number(match[1]));
  }
  return pids;
}

export function processIdsFromLines(output) {
  return output.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    .map(Number).filter(value => Number.isSafeInteger(value) && value > 0);
}

async function activeManagedRuntimeOwners() {
  if (process.platform === 'darwin') {
    const executable = path.join(profile, 'runtime', 'QQRuntime.app', 'Contents', 'MacOS', 'QQ');
    const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,args=']);
    return managedRuntimePidsFromProcessList(stdout, executable);
  }
  if (process.platform === 'win32') {
    const runtimeRoot = `${path.join(profile, 'runtime')}${path.sep}`.replaceAll("'", "''");
    const script = `$root = '${runtimeRoot}'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) } | Select-Object -ExpandProperty ProcessId`;
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    return processIdsFromLines(stdout);
  }
  return [];
}

async function main() {
  const owner = await activeProfileOwner();
  if (owner) {
    const detail = owner === 'active-profile-lock' ? 'an active profile lock' : `PID ${owner}`;
    throw new Error(`ChanceKit development instance is still running (${detail}). Close it before clearing data.`);
  }
  const runtimeOwners = await activeManagedRuntimeOwners();
  if (runtimeOwners.length) {
    throw new Error(`ChanceKit QQ runtime is still running (PID ${runtimeOwners.join(', ')}). Close it before clearing data.`);
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  console.log(`Cleared ChanceKit development data: ${profile}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
