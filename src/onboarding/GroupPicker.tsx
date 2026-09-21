import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Search, Users } from 'lucide-react';
import type { Group } from '../shared';
import { groupActivityLabel, onboardingGroupPageSize, sortGroupsByActivity } from './group-list';
import s from './Onboarding.module.css';

export function GroupPicker({ groups, selected, disabled, onToggle }: {
  groups: readonly Group[];
  selected: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return sortGroupsByActivity(groups).filter(group => `${group.name} ${group.id}`.toLowerCase().includes(query));
  }, [groups, search]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / onboardingGroupPageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * onboardingGroupPageSize, (currentPage + 1) * onboardingGroupPageSize);

  return <div className={s.groupPicker}>
    <div className={s.groupSearch}><Search size={16} /><input aria-label="搜索群聊" placeholder="搜索群名或群号" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} /></div>
    <div className={s.groupList} role="group" aria-label="选择关注群聊">
      {visible.map(group => <label key={group.id} className={selected.has(group.id) ? s.groupSelected : ''}>
        <input type="checkbox" checked={selected.has(group.id)} disabled={disabled} onChange={() => onToggle(group.id)} />
        <span className={s.groupIcon}><Users size={18} /></span>
        <span><strong>{group.name}</strong><small>{groupActivityLabel(group)}</small></span>
      </label>)}
      {visible.length === 0 && <p className={s.emptyGroups}>没有匹配的群聊</p>}
    </div>
    <nav className={s.groupPagination} aria-label="群聊分页">
      <button type="button" aria-label="上一页" disabled={disabled || currentPage === 0} onClick={() => setPage(value => Math.max(0, value - 1))}><ChevronLeft size={17} /></button>
      <span>第 {currentPage + 1} / {pageCount} 页<small>共 {filtered.length} 个群聊</small></span>
      <button type="button" aria-label="下一页" disabled={disabled || currentPage >= pageCount - 1} onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))}><ChevronRight size={17} /></button>
    </nav>
  </div>;
}
