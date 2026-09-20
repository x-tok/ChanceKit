import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function releaseInfo(pkg, lock, prerelease) {
  const version = pkg.version;
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/, 'Invalid release version');
  assert.equal(lock.version, version, 'package-lock.json version differs');
  assert.equal(lock.packages[''].version, version, 'lockfile root version differs');
  assert.ok(prerelease || !version.includes('-'), 'A suffixed version must be a pre-release');
  return { version, tag: `v${version}` };
}

export async function readReleaseInfo(prerelease) {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  return releaseInfo(pkg, lock, prerelease);
}

export function installerNames(version) {
  return ['mac-arm64.dmg', 'mac-arm64.zip', 'mac-x64.dmg', 'mac-x64.zip', 'win-x64.exe']
    .map(suffix => `ChanceKit-${version}-${suffix}`).sort();
}

export async function assertReleaseAvailable(github, repo, tag) {
  const duplicate = () => new Error(`${tag} already exists. Use a new version, or remove only the failed draft and its unused tag before retrying.`);
  for (const [get, args] of [
    [github.rest.repos.getReleaseByTag, { ...repo, tag }],
    [github.rest.git.getRef, { ...repo, ref: `tags/${tag}` }],
  ]) {
    try { await get(args); }
    catch (error) { if (error.status === 404) continue; throw error; }
    throw duplicate();
  }
  // Tag lookup omits unpublished drafts. The publish job repeats this with write access.
  const releases = await github.paginate(github.rest.repos.listReleases, { ...repo, per_page: 100 });
  if (releases.some(release => release.tag_name === tag)) throw duplicate();
}

export async function publishRelease(github, context, prerelease, directory = 'release-assets') {
  const { version, tag } = await readReleaseInfo(prerelease);
  const names = installerNames(version);
  assert.deepEqual((await readdir(directory)).sort(), names, 'Missing or unexpected release assets');
  const files = [];
  for (const name of names) {
    const file = path.join(directory, name);
    const stat = await lstat(file);
    assert.ok(stat.isFile() && stat.size > 0, `Invalid installer: ${name}`);
    const digest = createHash('sha256').update(await readFile(file)).digest('hex');
    files.push({ name, file, size: stat.size, digest });
  }
  const sums = Buffer.from(files.map(file => `${file.digest}  ${file.name}\n`).join(''));
  const checksumFile = path.join(directory, 'SHA256SUMS.txt');
  await writeFile(checksumFile, sums);
  files.push({ name: 'SHA256SUMS.txt', file: checksumFile, size: sums.length, digest: createHash('sha256').update(sums).digest('hex') });

  await assertReleaseAvailable(github, context.repo, tag);
  const { data: notes } = await github.rest.repos.generateReleaseNotes({ ...context.repo, tag_name: tag, target_commitish: context.sha });
  const guide = `https://github.com/${context.repo.owner}/${context.repo.repo}/blob/${context.sha}/docs/releases.md`;
  const { data: draft } = await github.rest.repos.createRelease({
    ...context.repo, tag_name: tag, target_commitish: context.sha,
    name: `ChanceKit ${tag}`, draft: true, prerelease,
    body: `[Installation and unsigned macOS instructions](${guide})\n\nNapCat is bundled. Install official QQ separately.\n\n${notes.body}`,
  });
  // Keep the release private until every upload has been checked through GitHub's API.
  for (const file of files) {
    await github.rest.repos.uploadReleaseAsset({
      ...context.repo, release_id: draft.id, name: file.name,
      data: await readFile(file.file),
      headers: { 'content-type': 'application/octet-stream', 'content-length': file.size },
    });
  }
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, { ...context.repo, release_id: draft.id });
  assert.equal(assets.length, files.length, 'Uploaded asset count differs');
  for (const file of files) {
    const asset = assets.find(asset => asset.name === file.name);
    assert.equal(asset?.state, 'uploaded', `Incomplete upload: ${file.name}`);
    assert.equal(asset.size, file.size, `Upload size differs: ${file.name}`);
    assert.equal(asset.digest, `sha256:${file.digest}`, `Upload checksum differs: ${file.name}`);
  }
  const { data: release } = await github.rest.repos.updateRelease({
    ...context.repo, release_id: draft.id, draft: false,
    make_latest: prerelease ? 'false' : 'true',
  });
  return release;
}
