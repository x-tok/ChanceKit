import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { releaseInfo, installerNames, assertReleaseAvailable, publishRelease } from '../scripts/github-release.mjs';

test('release versions must agree and suffix versions cannot be published as stable', () => {
  const lock = { version: '0.1.0', packages: { '': { version: '0.1.0' } } };
  assert.deepEqual(releaseInfo({ version: '0.1.0' }, lock, true), { version: '0.1.0', tag: 'v0.1.0' });
  assert.throws(() => releaseInfo({ version: '../bad' }, lock, true));
  assert.throws(() => releaseInfo({ version: '0.2.0' }, lock, true));
  assert.throws(() => releaseInfo({ version: '0.1.0' }, { ...lock, packages: { '': { version: '0.2.0' } } }, true));
  const beta = { version: '0.2.0-beta.1', packages: { '': { version: '0.2.0-beta.1' } } };
  assert.throws(() => releaseInfo(beta, beta, false));
  assert.equal(releaseInfo(beta, beta, true).tag, 'v0.2.0-beta.1');
});

function fakeGitHub(failure = '') {
  const calls = [];
  const assets = [];
  const missing = async () => { throw Object.assign(new Error('Not found'), { status: 404 }); };
  const github = {
    rest: {
      git: { getRef: missing },
      repos: {
        getReleaseByTag: missing,
        listReleases: async () => {},
        generateReleaseNotes: async () => ({ data: { body: 'Fixture notes' } }),
        createRelease: async args => { calls.push('draft'); assert.equal(args.draft, true); assert.equal(args.target_commitish, 'fixture-sha'); return { data: { id: 1 } }; },
        uploadReleaseAsset: async args => {
          calls.push('upload');
          if (failure === 'upload') throw new Error('Upload failed');
          assets.push({ name: args.name, size: args.data.length, digest: `sha256:${createHash('sha256').update(args.data).digest('hex')}`, state: 'uploaded' });
        },
        listReleaseAssets: async () => {},
        updateRelease: async args => { calls.push('publish'); assert.equal(args.draft, false); assert.equal(args.make_latest, 'false'); return { data: { html_url: 'https://example.invalid/release' } }; },
      },
    },
    paginate: async method => method === github.rest.repos.listReleases
      ? (failure === 'draft' ? [{ tag_name: 'v0.1.0', draft: true }] : [])
      : failure === 'digest' ? assets.map(asset => ({ ...asset, digest: 'sha256:bad' })) : assets,
  };
  return { github, calls };
}

test('existing releases, tags and API errors stop publishing', async () => {
  const { github } = fakeGitHub();
  await assertReleaseAvailable(github, {}, 'v0.1.0');
  await assert.rejects(assertReleaseAvailable(fakeGitHub('draft').github, {}, 'v0.1.0'), /already exists/);
  github.rest.git.getRef = async () => ({});
  await assert.rejects(assertReleaseAvailable(github, {}, 'v0.1.0'), /already exists/);
  github.rest.repos.getReleaseByTag = async () => ({});
  await assert.rejects(assertReleaseAvailable(github, {}, 'v0.1.0'), /already exists/);
  github.rest.repos.getReleaseByTag = async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); };
  await assert.rejects(assertReleaseAvailable(github, {}, 'v0.1.0'), /Forbidden/);
});

test('only complete, checksum-verified installer sets become public', async () => {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  for (const failure of ['', 'missing', 'extra', 'upload', 'digest']) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'chancekit-release-'));
    const { github, calls } = fakeGitHub(failure);
    try {
      const names = installerNames(version);
      for (const name of failure === 'missing' ? names.slice(1) : names) await writeFile(path.join(directory, name), 'synthetic installer');
      if (failure === 'extra') await writeFile(path.join(directory, 'connection.enc'), 'private fixture');
      const publish = publishRelease(github, { repo: {}, sha: 'fixture-sha' }, true, directory);
      if (failure) {
        await assert.rejects(publish);
        assert.ok(!calls.includes('publish'));
        if (failure === 'missing' || failure === 'extra') assert.deepEqual(calls, []);
      } else {
        await publish;
        assert.deepEqual(calls, ['draft', ...Array(6).fill('upload'), 'publish']);
        assert.equal((await readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n').length, 5);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
