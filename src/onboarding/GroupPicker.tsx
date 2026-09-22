import { useMemo, useRef, useState } from 'react';
import { Search, Users } from 'lucide-react';
import type { Group } from '../shared';
import { groupActivityLabel, sortGroupsByActivity } from './group-list';
import s from './Onboarding.module.css';

export function GroupPicker({ groups, selected, disabled, onToggle }: {
  groups: readonly Group[];
  selected: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return sortGroupsByActivity(groups).filter(group => `${group.name} ${group.id}`.toLowerCase().includes(query));
  }, [groups, search]);

  return <div className={s.groupPicker}>
    <div className={s.groupSearch}><Search size={16} /><input aria-label="搜索群聊" placeholder="搜索群名或群号" value={search} onChange={event => { setSearch(event.target.value); if (listRef.current) listRef.current.scrollTop = 0; }} /></div>
    <div ref={listRef} className={s.groupList} role="group" aria-label="选择关注群聊">
      {filtered.map(group => <label key={group.id} className={selected.has(group.id) ? s.groupSelected : ''}>
        <input type="checkbox" checked={selected.has(group.id)} disabled={disabled} onChange={() => onToggle(group.id)} />
        <span className={s.groupIcon}><Users size={18} /></span>
        <span><strong>{group.name}</strong><small>{groupActivityLabel(group)}</small></span>
      </label>)}
      {filtered.length === 0 && <p className={s.emptyGroups}>没有匹配的群聊</p>}
    </div>
  </div>;
}
