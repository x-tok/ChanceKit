import path from 'node:path';
import { runtimeFiles, replaceRuntimeDirectory } from '../../electron/core/runtime/runtime-files';

async function run() {
  await runtimeFiles.rm(path.join(process.argv[2]!, 'QQRuntime.staging.app'), { recursive: true, force: true });
  await replaceRuntimeDirectory(path.join(process.argv[2]!, 'replacement.app'), path.join(process.argv[2]!, 'QQRuntime.app'), () => {});
  return { ok: true };
}

const parent = (process as NodeJS.Process & { parentPort: { postMessage(value: unknown): void } }).parentPort;
run().then(value => parent.postMessage(value), error => parent.postMessage({ ok: false, code: error.code, message: error.message }));
