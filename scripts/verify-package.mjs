import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractFile, listPackage } from '@electron/asar';
import { verifyNapCatBundle } from './napcat-bundle.mjs';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const appOut = process.platform === 'darwin'
  ? path.join('release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', `${pkg.productName}.app`, 'Contents/Resources')
  : path.join('release', 'win-unpacked/resources');
const archive = path.join(appOut, 'app.asar');
const packaged = JSON.parse(extractFile(archive, 'package.json').toString());
assert.equal(packaged.name, pkg.name);
assert.equal(packaged.version, pkg.version);
for (const entry of ['dist/index.html', 'dist-electron/main.cjs', 'dist-electron/preload.cjs', 'dist-electron/worker.cjs']) {
  assert.ok(extractFile(archive, entry).length > 0, `Missing packaged entry: ${entry}`);
}
for (const entry of listPackage(archive)) {
  assert.ok(!/(?:^|[/\\])(?:\.dev-data|qq-profile|connection\.enc)(?:[/\\]|$)|\.(?:db|sqlite)(?:$|-)/i.test(entry), `Private data in package: ${entry}`);
}
await verifyNapCatBundle(path.join(appOut, 'napcat/NapCat.Shell.zip'));
assert.deepEqual(
  JSON.parse(await readFile(path.join(appOut, 'napcat/manifest.json'), 'utf8')),
  JSON.parse(await readFile('resources/napcat/manifest.json', 'utf8')),
);
assert.ok((await readFile(path.join(appOut, 'napcat/NOTICE.md'), 'utf8')).length > 0);
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--verify', '--deep', '--strict', path.resolve(appOut, '../..')], { stdio: 'inherit' });
}
console.log('Packaged entry points, version, and bundled NapCat verified.');
