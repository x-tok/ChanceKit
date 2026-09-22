import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { extractFile, listPackage } from '@electron/asar';
import { verifyNapCatBundle } from './napcat-bundle.mjs';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const appOut = process.argv[2] ? path.resolve(process.argv[2]) : process.platform === 'darwin'
  ? path.join('release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', `${pkg.productName}.app`, 'Contents/Resources')
  : path.join('release', 'win-unpacked/resources');
const targetPlatform = process.argv[3] ?? process.platform;
const targetArch = process.argv[4] ?? process.arch;
const archive = path.join(appOut, 'app.asar');
const packaged = JSON.parse(extractFile(archive, 'package.json').toString());
assert.equal(packaged.name, pkg.name);
assert.equal(packaged.version, pkg.version);
for (const entry of [
  'dist/index.html',
  'dist-electron/main.cjs',
  'dist-electron/preload.cjs',
  'dist-electron/worker.cjs',
  'LICENSE',
  'PRIVACY.md',
  'DISCLAIMER.md',
  'THIRD_PARTY_NOTICES.md',
]) {
  assert.ok(extractFile(archive, entry).length > 0, `Missing packaged entry: ${entry}`);
}
for (const entry of listPackage(archive)) {
  assert.ok(!/(?:^|[/\\])(?:\.dev-data|qq-profile|connection\.enc)(?:[/\\]|$)|\.(?:db|sqlite)(?:$|-)/i.test(entry), `Private data in package: ${entry}`);
}
const nativeTarget = `${targetPlatform}-${targetArch}`;
const nativePackages = path.join(`${archive}.unpacked`, 'node_modules');
const canvasSuffix = targetPlatform === 'darwin' ? `darwin-${targetArch}`
  : targetPlatform === 'win32' && targetArch === 'x64' ? 'win32-x64-msvc' : null;
const sharpSuffix = targetPlatform === 'darwin' ? `darwin-${targetArch}`
  : targetPlatform === 'win32' && targetArch === 'x64' ? 'win32-x64' : null;
assert.ok(canvasSuffix && sharpSuffix, `Unsupported package verification target: ${nativeTarget}`);
const canvasPackages = (await readdir(path.join(nativePackages, '@napi-rs')))
  .filter(name => name.startsWith('canvas-')).sort();
const sharpPackages = (await readdir(path.join(nativePackages, '@img')))
  .filter(name => name.startsWith('sharp-') && !name.startsWith('sharp-libvips-')).sort();
assert.deepEqual(canvasPackages, [`canvas-${canvasSuffix}`], `Packaged canvas binary does not match ${nativeTarget}`);
assert.deepEqual(sharpPackages, [`sharp-${sharpSuffix}`], `Packaged sharp binary does not match ${nativeTarget}`);
await verifyNapCatBundle(path.join(appOut, 'napcat/NapCat.Shell.zip'));
assert.deepEqual(
  JSON.parse(await readFile(path.join(appOut, 'napcat/manifest.json'), 'utf8')),
  JSON.parse(await readFile('resources/napcat/manifest.json', 'utf8')),
);
assert.ok((await readFile(path.join(appOut, 'napcat/NOTICE.md'), 'utf8')).length > 0);
assert.deepEqual(
  await readFile(path.join(appOut, 'napcat/LICENSE.txt')),
  await readFile('licenses/NapCatQQ-v4.18.28-LICENSE.txt'),
);
const appBundle = path.resolve(appOut, '../..');
if (path.extname(appBundle) === '.app') {
  execFileSync('codesign', ['--verify', '--deep', '--strict', appBundle], { stdio: 'inherit' });
}
console.log('Packaged entry points, version, and bundled NapCat verified.');
