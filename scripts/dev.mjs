import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { prepareElectron } from './electron-runtime.mjs';
import './build.mjs';

try { await prepareElectron(); }
catch (error) { console.error(error.message); process.exit(1); }
const { default: electron } = await import('electron');

const server = await createServer({ server: { host: '127.0.0.1', port: 5178, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`见机 ChanceKit 开发界面: ${url}`);
const env = { ...process.env, CHANCEKIT_RENDERER_URL: url };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env });
const stop = async () => { child.kill(); await server.close(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', async code => { await server.close(); process.exit(code ?? 0); });
