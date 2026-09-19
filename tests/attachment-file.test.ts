import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readManagedAttachment } from '../electron/core/attachment-file';

test('managed attachment files must remain in the cache, match the archived filename and obey size limits', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'chancekit-attachments-'));
  const root = path.join(folder, 'qq-profile');
  await mkdir(root);
  await writeFile(path.join(root, 'notice.docx'), 'document');
  await writeFile(path.join(folder, 'secret.docx'), 'private');
  await symlink(path.join(folder, 'secret.docx'), path.join(root, 'link.docx'));
  try {
    assert.equal(Buffer.from(await readManagedAttachment(path.join(root, 'notice.docx'), root, 'notice.docx', 100)).toString(), 'document');
    await assert.rejects(readManagedAttachment(path.join(folder, 'secret.docx'), root, 'secret.docx', 100), /超出/);
    await assert.rejects(readManagedAttachment(path.join(root, 'link.docx'), root, 'link.docx', 100), /超出/);
    await assert.rejects(readManagedAttachment(path.join(root, 'notice.docx'), root, 'different.docx', 100), /不一致/);
    await assert.rejects(readManagedAttachment(path.join(root, 'notice.docx'), root, 'notice.docx', 2), /上限/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
