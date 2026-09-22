import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortGroupsByActivity } from '../src/onboarding/group-list';
import type { Group } from '../src/shared';

const group = (id: string, name: string, messageCount: number, lastMessageAt?: number): Group => ({
  id, name, memberCount: 100, maxMembers: 500, followed: false, messageCount, lastMessageAt,
});

test('onboarding groups sort by local recent activity', () => {
  const sorted = sortGroupsByActivity([
    group('1', '乙群', 9),
    group('2', '甲群', 2, 200),
    group('3', '丙群', 3, 100),
    group('4', '丁群', 12),
  ]);
  assert.deepEqual(sorted.map(item => item.id), ['2', '3', '4', '1']);
});
