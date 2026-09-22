import type { AppState, DesktopBridge, HistoryResult } from '../shared';
export { recentHistoryWindow as initialSyncWindow, type RecentHistoryWindow as InitialSyncWindow } from '../history-window';

export interface InitialSyncProgress {
  completed: number;
  total: number;
  group: string;
  added: number;
}

export async function saveGroupSelection(
  state: AppState,
  selectedGroupIds: ReadonlySet<string>,
  desktop: Pick<DesktopBridge, 'request' | 'completeOnboarding'>,
): Promise<void> {
  if (!state.account) throw new Error('请先登录 QQ。');
  if (selectedGroupIds.size === 0) throw new Error('请至少选择一个群聊。');
  for (const group of state.groups) {
    const followed = selectedGroupIds.has(group.id);
    if (group.followed !== followed) await desktop.request({ type: 'follow', groupId: group.id, followed });
  }
  await desktop.completeOnboarding?.(state.account.id);
}

export async function runInitialSync(
  state: AppState,
  since: number,
  desktop: Pick<DesktopBridge, 'request'>,
  report: (progress: InitialSyncProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!state.account) throw new Error('请先登录 QQ。');
  const groups = state.groups.filter(group => group.followed);
  if (groups.length === 0) throw new Error('请至少关注一个群聊。');

  let totalAdded = 0;
  for (const [index, group] of groups.entries()) {
    signal?.throwIfAborted();
    report({ completed: index, total: groups.length, group: group.name, added: totalAdded });
    let older = false;
    while (true) {
      signal?.throwIfAborted();
      const result = await desktop.request<HistoryResult>({ type: 'history', groupId: group.id, older, since });
      totalAdded += result.added;
      report({ completed: index, total: groups.length, group: group.name, added: totalAdded });
      if (result.reachedStart || !result.canContinue) break;
      older = true;
    }
    report({ completed: index + 1, total: groups.length, group: group.name, added: totalAdded });
  }
}
