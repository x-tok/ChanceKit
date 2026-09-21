import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import { Store, normalizeMessage } from '../electron/core/archive/store';
import { ScheduleStore } from '../electron/core/processing/schedule-store';
import { readReferenceGraph, replyIds } from '../electron/core/archive/message-references';
import { AppService } from '../electron/core/application/service';
import { mockNapCat, sample } from './fixtures';

export const reply = (id: number, target: number, text: string, groupId = 731234567) => ({
  ...sample(id, text, groupId), message: [{ type: 'reply', data: { id: String(target) } }, { type: 'text', data: { text } }],
});
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chancekit-references-'));
  const file = path.join(root, 'messages.sqlite');
  const messages = new Store(file);
  messages.saveGroups('a', [{ group_id: 731234567, group_name: '合成招聘群' }]); messages.follow('a', '731234567', true);
  const schedule = new ScheduleStore(file), db = new DatabaseSync(file);
  t.after(async () => { db.close(); schedule.close(); messages.close(); await rm(root, { recursive: true, force: true }); });
  return { messages, schedule, db };
}

test('quoted originals outside recent context and their earlier sibling replies are linked; neighbors and other groups/accounts are excluded', async t => {
  const f = await fixture(t);
  const original = normalizeMessage(sample(1, '星河宣讲会，明天14:00'), 'a');
  const sibling = normalizeMessage(reply(4, 1, '补充地点：实验楼201'), 'a');
  const current = normalizeMessage(reply(20, 1, '请携带简历参加'), 'a');
  f.messages.put([original, sibling, current, normalizeMessage(reply(21, 1, '未来回复不应纳入'), 'a'),
    normalizeMessage(sample(1, '另一账号'), 'b'), normalizeMessage(sample(1, '另一群', 731234568), 'a'),
    ...Array.from({ length: 10 }, (_, index) => normalizeMessage(sample(index + 6, '无关聊天'), 'a'))]);
  const graph = readReferenceGraph(f.db, current);
  assert.deepEqual(graph.references.map(reference => [reference.message.key, reference.relation]), [[original.key, 'quoted'], [sibling.key, 'related-reply']]);
  assert.deepEqual(graph.missing, []); assert.deepEqual(graph.warnings, []);
});

test('missing, ambiguous and cyclic references stay explicit and quoted chains are bounded', async t => {
  const f = await fixture(t);
  const current = normalizeMessage(reply(20, 1, '补充'), 'a');
  assert.equal(readReferenceGraph(f.db, current).missing[0].id, '1');
  f.messages.put([normalizeMessage(sample(1, 'a'), 'a'), normalizeMessage({ ...sample(2, 'b'), message_id: 1 }, 'a')]);
  assert.match(readReferenceGraph(f.db, current).warnings.join(' '), /重复/);
  const cycle = normalizeMessage(reply(30, 30, '自身引用'), 'a'); f.messages.put([cycle]);
  assert.match(readReferenceGraph(f.db, cycle).warnings.join(' '), /循环/);
  f.messages.put(Array.from({ length: 8 }, (_, index) => normalizeMessage(reply(40 + index, 39 + index, '链中消息'), 'a')));
  const bounded = readReferenceGraph(f.db, normalizeMessage(reply(49, 47, '最后回复'), 'a'));
  assert.equal(bounded.references.filter(reference => reference.relation === 'quoted').length, 4);
  assert.ok(bounded.warnings.length);
  assert.deepEqual(replyIds(normalizeMessage({ ...sample(1, ''), message: '[CQ:reply,id=-42]补充' }, 'a')), ['-42']);
});

test('late originals requeue their dependent reply once, and changes invalidate active extraction', async t => {
  const f = await fixture(t);
  const current = normalizeMessage(reply(20, 1, '地点实验楼201'), 'a');
  f.messages.put([current]); f.schedule.enqueue('a');
  const job = f.schedule.claim('a')!;
  assert.equal(job.referenceGraph!.missing.length, 1);
  f.schedule.complete(job, { activities: [], materials: [], warnings: ['引用缺失'], reviewReasons: ['引用缺失'] });
  f.schedule.enqueue('a'); assert.equal(f.schedule.status('a').pending, 0);
  const original = normalizeMessage(sample(1, '星河宣讲会，9月24日14:00'), 'a');
  f.messages.put([original]); f.schedule.enqueue('a');
  f.schedule.complete(f.schedule.claim('a')!, { activities: [], materials: [], warnings: [] });
  const retried = f.schedule.claim('a')!;
  assert.equal(retried.message.key, current.key);
  assert.equal(retried.referenceGraph!.references[0].message.key, original.key);
  f.messages.put([normalizeMessage(sample(1, '已更正为15:00'), 'a')]);
  assert.equal(f.schedule.isCurrent(retried), false);
  assert.equal(f.schedule.complete(retried, { activities: [], materials: [], warnings: [] }), false);
});

test('QQ missing-reference reads require an actual archived reply and verify identity, group, time and follow state', async () => {
  const fixture = await mockNapCat(), store = new Store(':memory:');
  const service = new AppService(os.tmpdir(), store, () => {});
  try {
    await service.request({ type: 'connect', config: fixture.config });
    await service.request({ type: 'follow', groupId: '731234567', followed: true });
    const current = normalizeMessage(reply(20, 1, '补充地点'), '100010001'); store.put([current]);
    const request = { type: 'resolveReply' as const, accountId: current.accountId, messageKey: current.key, replyId: '1' };
    fixture.respond('get_msg', () => sample(1, '被引用的原消息'));
    const original = await service.resolveReply(request);
    assert.equal(original.text, '被引用的原消息');
    assert.ok(store.message(current.accountId, original.key));
    await assert.rejects(service.resolveReply({ ...request, replyId: '2' }), /不是/);
    await assert.rejects(service.resolveReply({ ...request, accountId: 'other' }), /账号/);
    await assert.rejects(service.request(request as any), /Invalid/);
    for (const update of [{ group_id: 731234568 }, { message_id: 2 }, { time: current.time + 1 }, { self_id: 2 }, { message_type: 'private' }]) {
      fixture.respond('get_msg', () => ({ ...sample(1, '错误来源'), ...update }));
      await assert.rejects(service.resolveReply(request), /不一致/);
    }
    fixture.respond('get_msg', () => sample(1, '原消息'));
    const held = fixture.holdNext('get_msg'); const pending = service.resolveReply(request);
    await held.requested;
    await service.request({ type: 'follow', groupId: current.groupId, followed: false }); held.release();
    await assert.rejects(pending, /关注/);
  } finally { await service.close(); await fixture.close(); }
});
