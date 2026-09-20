import { writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RuntimeManager } from '../../electron/core/runtime';
import { macLoader, macLaunchArgs } from '../../electron/core/mac-loader';
import { Store } from '../../electron/core/store';

const root = process.argv[2];
// Match the real worker's archive initialization before the main process opens schedules.
const store = new Store(path.join(root, 'messages.sqlite'));
const trace = path.join(root, 'quit-events.jsonl');
const record = (event: string) => appendFileSync(trace, `${JSON.stringify(event)}\n`);
const loader = path.join(root, 'loader.cjs');
const stub = path.join(root, 'napcat-fixture.mjs');
writeFileSync(loader, macLoader);
writeFileSync(stub, `import { app } from 'electron';
import fs from 'node:fs';
process.on('exit', code => fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify('qq-exit:' + code) + '\\n'));
await app.whenReady();
console.log('CHANCEKIT_QUIT_FIXTURE_READY');
setInterval(() => {}, 1000);
`);
const env = { ...process.env, CHANCEKIT_QQ_DATA: path.join(root, 'qq-profile'), CHANCEKIT_NAPCAT_ENTRY: stub };
const child = spawn(process.env.CHANCEKIT_FIXTURE_ELECTRON!, [loader, ...macLaunchArgs], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
child.stdin.on('error', () => {});
child.stderr.resume();
const runtime = new RuntimeManager(root, () => {}, () => {}, '');
Object.assign(runtime, { child });
let ready = false;
let output = '';
child.stdout.on('data', bytes => {
  output += bytes;
  if (!ready && output.includes('CHANCEKIT_QUIT_FIXTURE_READY')) {
    ready = true;
    record('ready');
    process.parentPort.postMessage({ ready: true });
  }
});
child.on('exit', (code, signal) => record(`child-exit:${code}:${signal}`));
process.parentPort.on('message', async ({ data }: { data: any }) => {
  if (data.type === 'shutdown') {
    record('shutdown-start');
    await runtime.stop();
    store.close();
    record('runtime-stopped');
    // Keep cleanup pending long enough to exercise another OS quit request.
    setTimeout(() => { record('worker-exit'); process.exit(0); }, 500);
  } else {
    process.parentPort.postMessage({ id: data.id, value: data.command.type === 'state'
      ? { phase: 'idle', detail: '', groups: [], archived: 0, logs: [], historyBusy: false, runtime: null } : null });
  }
});
