import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronRight, LoaderCircle, MessageCircle, Newspaper, RefreshCw, Search, X } from 'lucide-react';
import { bridge, isDesktop } from './bridge';
import { emptyInformationPage, type InformationCategory, type InformationDetail, type InformationPage, type RecruitingInformation } from './schedule';
import type { AppState } from './shared';
import s from './Schedule.module.css';
import common from './App.module.css';
import { SourceMaterials } from './SourceMaterials';

const messageDate = (seconds: number) => new Date(seconds * 1000).toLocaleString('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const stateLabel = (item: RecruitingInformation) => item.processingState === 'running' ? '正在补读'
  : item.processingState === 'pending' ? '等待补读' : item.category === 'incomplete' ? '内容待补全' : '资讯推送';
const errorText = (error: unknown) => (error instanceof Error ? error.message : '读取失败，请重试。').replace(/^Error invoking remote method '[^']+': Error: /, '');

export function RecruitingInformationPanel({ state, revision, showIncomplete, processingEnabled, onChange, onGroup, onActivity }: {
  state: AppState; revision: number; showIncomplete: number; processingEnabled: boolean;
  onChange: () => void; onGroup: (id: string) => void; onActivity: (id: string) => void;
}) {
  const [category, setCategory] = useState<InformationCategory>('information');
  const [groupId, setGroupId] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<InformationPage>(emptyInformationPage);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [selected, setSelected] = useState<InformationDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const section = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const groups = state.groups.filter(group => group.followed);
  const scope = JSON.stringify(groups.map(group => [group.id, group.name]));
  const available = typeof bridge.recruitingInformation === 'function' && typeof bridge.informationDetail === 'function';

  useEffect(() => {
    if (!showIncomplete) return;
    setCategory('incomplete'); setOffset(0); setGroupId(''); setSearch('');
    section.current?.scrollIntoView({ block: 'start' });
  }, [showIncomplete]);
  useEffect(() => {
    if (groupId && !groups.some(group => group.id === groupId)) { setGroupId(''); setOffset(0); }
    setSelectedKey(''); setSelected(null); dialog.current?.close();
  }, [scope]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    if (!available) { setLoading(false); return; }
    const timer = setTimeout(() => {
      void bridge.recruitingInformation({ category, offset, ...(groupId ? { groupId } : {}), ...(search.trim() ? { search: search.trim() } : {}) })
        .then(value => {
          if (!active) return;
          if (offset > 0 && !value.items.length) { setOffset(Math.max(0, offset - 20)); return; }
          setPage(value); setError('');
        }).catch(error => { if (active) { setPage(emptyInformationPage); setError(errorText(error)); } })
        .finally(() => { if (active) setLoading(false); });
    }, search ? 200 : 30);
    return () => { active = false; clearTimeout(timer); };
  }, [category, groupId, search, offset, revision, scope, available]);
  useEffect(() => {
    let active = true;
    if (!selectedKey || !available) return;
    setDetailBusy(true);
    void bridge.informationDetail(selectedKey).then(value => {
      if (active) { setSelected(value); setActionError(''); }
    }).catch(error => { if (active) { setSelected(null); setActionError(errorText(error)); } })
      .finally(() => { if (active) setDetailBusy(false); });
    return () => { active = false; };
  }, [selectedKey, revision, scope, available]);
  const act = async (operation: () => Promise<unknown>) => {
    setActionError('');
    try { await operation(); } catch (error) { setActionError(errorText(error)); }
  };
  const retry = async () => {
    setRetryBusy(true);
    try { await act(async () => { await bridge.retryProcessing(selectedKey); onChange(); }); }
    finally { setRetryBusy(false); }
  };
  const choose = (value: InformationCategory) => { setCategory(value); setOffset(0); };
  const open = (item: RecruitingInformation) => {
    setSelected(null); setSelectedKey(item.messageKey); setDetailBusy(true); setActionError(''); dialog.current?.showModal();
  };

  return <section className={s.information} aria-label="招聘资讯" ref={section}>
    <header className={s.informationHeading}><div><h2><Newspaper size={17} />招聘资讯</h2>
      <p>保留未安排进日历的推送与待补全材料 · 按消息发布时间排列，不限所选周</p></div>
      <button className={common.iconButton} aria-label="刷新招聘资讯" title="刷新招聘资讯" onClick={onChange} disabled={loading || !available}><RefreshCw size={16} /></button>
    </header>
    {!available ? <p className={s.muted}>请重启应用，加载招聘资讯与已有推送记录。</p> : <>
      <div className={s.informationFilters}>
        <div role="group" aria-label="资讯分类" className={s.informationTabs}>
          <button aria-pressed={category === 'information'} onClick={() => choose('information')}>资讯推送 <span>{page.counts.information}</span></button>
          <button aria-pressed={category === 'incomplete'} onClick={() => choose('incomplete')}>待补全 <span>{page.counts.incomplete}</span></button>
        </div>
        <label className={s.informationGroup}><span className={s.muted}>来源群</span>
          <select aria-label="资讯来源群" value={groupId} onChange={event => { setGroupId(event.target.value); setOffset(0); }}>
            <option value="">全部关注群</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
        </label>
        <div className={s.search}><Search size={15} /><input aria-label="搜索招聘资讯" placeholder="搜索资讯、文件名或原文" value={search} maxLength={300} onChange={event => { setSearch(event.target.value); setOffset(0); }} /></div>
      </div>
      {error && <p className={s.error} role="alert">{error}</p>}
      <div aria-busy={loading}>
        {loading ? <p className={s.empty}><LoaderCircle size={18} className={common.spin} />正在读取资讯</p>
          : page.items.length > 0 ? <ul className={s.informationList}>{page.items.map(item => <li key={item.messageKey}>
            <button className={s.informationRow} onClick={() => open(item)} aria-label={`查看资讯：${item.title}`}>
              <span className={s.informationBody}>
                <span className={s.informationMeta}><span className={s.informationBadge} data-category={item.category}>{stateLabel(item)}</span>
                  <time dateTime={new Date(item.messageTime * 1000).toISOString()}>{messageDate(item.messageTime)}</time></span>
                <strong>{item.title}</strong>
                {item.summary && item.summary !== item.title && <span className={s.informationSummary}>{item.summary}</span>}
                <small>{item.groupName}</small>
              </span><ChevronRight size={16} aria-hidden="true" />
            </button>
          </li>)}</ul> : !error && <p className={s.empty}>{search || groupId ? '没有符合筛选条件的资讯'
            : category === 'incomplete' ? '暂无待补全材料' : '暂无资讯推送；读到的招聘公告与岗位信息会保留在这里。'}</p>}
      </div>
      {page.total > 20 && <div className={s.informationPagination}>
        <span>{offset + 1}–{Math.min(offset + 20, page.total)} / {page.total} 条</span>
        <button className={common.iconButton} aria-label="上一页资讯" disabled={offset === 0 || loading} onClick={() => setOffset(value => Math.max(0, value - 20))}><ArrowLeft size={16} /></button>
        <button className={common.iconButton} aria-label="下一页资讯" disabled={!page.hasMore || loading} onClick={() => setOffset(value => value + 20)}><ArrowRight size={16} /></button>
      </div>}
    </>}
    <dialog ref={dialog} className={`${s.dialog} ${s.detail}`} onClose={() => { setSelectedKey(''); setSelected(null); }}>
      <div className={s.detailHeading}><span className={s.muted}>资讯详情</span><button className={common.iconButton} aria-label="关闭资讯详情" onClick={() => dialog.current?.close()}><X size={19} /></button></div>
      {actionError && <p className={s.error} role="alert">{actionError}</p>}
      {detailBusy ? <p className={s.empty}><LoaderCircle size={20} className={common.spin} />正在读取</p> : selected ? <>
        <span className={s.informationBadge} data-category={selected.item.category}>{stateLabel(selected.item)}</span>
        <h2>{selected.item.title}</h2>
        <span className={s.sourceMeta}>{selected.item.groupName} · {selected.senderName}<br />消息发布时间：{messageDate(selected.item.messageTime)}（北京时间）</span>
        {selected.item.summary && <p className={s.description}>{selected.item.summary}</p>}
        {selected.item.category === 'incomplete' && <div className={s.informationNotice}>
          <p>材料尚未读全，原消息已保留。可以直接查看来源，或再次尝试读取。</p>
          <button className={common.secondaryButton} disabled={retryBusy || ['pending', 'running'].includes(selected.item.processingState)}
            onClick={() => void retry()}><RefreshCw size={14} />{stateLabel(selected.item) === '内容待补全' ? '重新读取' : stateLabel(selected.item)}</button>
          {!processingEnabled && <small>自动处理已暂停，重新读取会先加入队列，开启后继续。</small>}
        </div>}
        <section className={s.sources}><h3>原消息与来源</h3><pre>{selected.text || '这条消息没有文字，请查看下方来源材料。'}</pre>
          {selected.relatedMessages?.map(message => <details key={message.messageKey}>
            <summary>{message.relation === 'quoted' ? '引用原消息' : '同一消息的相关回复'} · {message.senderName}</summary>
            <span className={s.sourceMeta}>{messageDate(message.messageTime)}（北京时间）</span><pre>{message.text}</pre>
          </details>)}
          <div className={s.informationLinks}><SourceMaterials materials={selected.materials}
            onOpen={url => void act(() => bridge.openExternal(url))}
            onPdf={id => void act(() => bridge.openWebpagePdf(selected.item.messageKey, id))} />
            <button className={common.textButton} onClick={() => { dialog.current?.close(); onGroup(selected.item.groupId); }}><MessageCircle size={14} />打开来源群聊</button>
            {selected.activityIds.map((id, index) => <button key={id} className={common.textButton} onClick={() => { dialog.current?.close(); onActivity(id); }}>查看已提取活动{selected.activityIds.length > 1 ? ` ${index + 1}` : ''}<ChevronRight size={14} /></button>)}
          </div>
          {(selected.reason || selected.diagnostics.length > 0) && <details className={s.readingNotes}><summary>材料读取记录</summary>
            <ul>{[...new Set([selected.reason, ...selected.diagnostics].filter(Boolean))].map(note => <li key={note}>{note}</li>)}</ul>
          </details>}
        </section>
      </> : !actionError && <p className={s.empty}>这条资讯已更新、提取为日程，或来源群已取消关注。关闭后可查看最新列表。</p>}
    </dialog>
  </section>;
}
