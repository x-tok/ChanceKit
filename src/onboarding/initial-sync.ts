import type { AppState, DesktopBridge, HistoryResult } from '../shared';

const INITIAL_SYNC_DAYS = 3;
const CHINA_TIME_ZONE = 'Asia/Shanghai';

export interface InitialSyncWindow {
  date: string;
  since: number;
}

export function initialSyncWindow(now = new Date()): InitialSyncWindow {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CHINA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const today = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - INITIAL_SYNC_DAYS);
  const date = start.toISOString().slice(0, 10);
  return { date, since: Math.floor(Date.parse(`${date}T00:00:00+08:00`) / 1000) };
}

export interface InitialSyncProgress {
  current: number;
  total: number;
  group: string;
  added: number;
}

export async function runInitialSync(
  state: AppState,
  selectedGroupIds: ReadonlySet<string>,
  since: number,
  desktop: Pick<DesktopBridge, 'request' | 'configureProcessing' | 'completeOnboarding'>,
  report: (progress: InitialSyncProgress) => void,
): Promise<void> {
  if (!state.account) throw new Error('请先登录 QQ。');
  const accountId = state.account.id;
  const groups = state.groups.filter(group => selectedGroupIds.has(group.id));
  if (groups.length === 0) throw new Error('请至少选择一个群聊。');

  let totalAdded = 0;
  for (const [index, group] of groups.entries()) {
    report({ current: index + 1, total: groups.length, group: group.name, added: totalAdded });
    let older = false;
    while (true) {
      const result = await desktop.request<HistoryResult>({ type: 'history', groupId: group.id, older, since });
      totalAdded += result.added;
      report({ current: index + 1, total: groups.length, group: group.name, added: totalAdded });
      if (result.reachedStart || !result.canContinue) break;
      older = true;
    }
  }

  for (const group of state.groups) {
    const followed = selectedGroupIds.has(group.id);
    if (group.followed !== followed) await desktop.request({ type: 'follow', groupId: group.id, followed });
  }
  await desktop.configureProcessing({ enabled: true, concurrency: 3 });
  await desktop.request({ type: 'disconnect' });
  await desktop.completeOnboarding?.(accountId);
}
