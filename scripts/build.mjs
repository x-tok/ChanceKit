import { build } from 'esbuild';
import { verifyNapCatBundle } from './napcat-bundle.mjs';

await verifyNapCatBundle();

await build({
  entryPoints: ['electron/main.ts', 'electron/preload.ts', 'electron/worker.ts'],
  outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, bundle: true,
  platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'sharp'], sourcemap: true,
});
