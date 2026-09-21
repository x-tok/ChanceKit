import type { Group } from '../shared';

export function sortGroupsByActivity(groups: readonly Group[]): Group[] {
  return [...groups].sort((left, right) =>
    (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0)
    || right.messageCount - left.messageCount
    || left.name.localeCompare(right.name, 'zh-CN'));
}

export function groupActivityLabel(group: Group): string {
  if (!group.lastMessageAt) return group.memberCount ? `${group.memberCount.toLocaleString()} 人` : `群号 ${group.id}`;
  const value = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(group.lastMessageAt * 1000));
  return `最近消息 ${value}`;
}
