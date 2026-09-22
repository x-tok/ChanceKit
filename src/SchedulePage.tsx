import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, ArrowRight, CalendarDays, CalendarRange, ChevronRight, Clock3, CloudDownload, ExternalLink, LoaderCircle, MapPin, MessageCircle, RefreshCw, Search, Settings2, X } from 'lucide-react';
import { bridge, isDesktop } from './bridge';
import { activityOnDate, activityTimeLabel, activityTypes, addDays, calendarWindowStart, chinaToday, emptyProcessingStatus, isOngoingActivity, scheduleProcessingVersion, type Activity, type ActivityDetail, type ActivityType, type ProcessingStatus, type SchedulePage } from './schedule';
import type { AppState } from './shared';
import s from './Schedule.module.css';
import common from './App.module.css';
import { SourceMaterials } from './SourceMaterials';
import { CalendarMessage } from './CalendarMessage';
import { initialSyncWindow, runInitialSync, type InitialSyncProgress } from './onboarding/initial-sync';
import { SyncDialog } from './schedule-sync/SyncDialog';

const weekday = (day: string) => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${day}T00:00:00Z`).getUTCDay()];
const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试。').replace(/^Error invoking remote method '[^']+': Error: /, '');
const shortDate = (value: string) => `${Number(value.slice(5, 7))}月${Number(value.slice(8))}日`;
const emptyPage: SchedulePage = { activities: [], undated: [] };

export function Schedule({ state, onModels, onGroup }: { state: AppState; onModels: () => void; onGroup: (id: string) => void }) {
  const [anchor, setAnchor] = useState(chinaToday);
  const [selectedDate, setSelectedDate] = useState(chinaToday);
  const week = calendarWindowStart(anchor);
  const [type, setType] = useState<ActivityType | ''>('');
  const [groupId, setGroupId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState<SchedulePage>(emptyPage);
  const [status, setStatus] = useState<ProcessingStatus>(emptyProcessingStatus);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [syncOpen, setSyncOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [syncProgress, setSyncProgress] = useState<InitialSyncProgress>();
  const [selected, setSelected] = useState<ActivityDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailId, setDetailId] = useState('');
  const detail = useRef<HTMLDialogElement>(null);
  const requestNumber = useRef(0);
  const detailNumber = useRef(0);
  const syncController = useRef<AbortController | undefined>(undefined);
  const today = chinaToday();
  const days = Array.from({ length: 7 }, (_, index) => addDays(week, index));
  const scheduled = page.activities.filter(activity => !isOngoingActivity(activity));
  const dailyActivities = scheduled.filter(activity => activityOnDate(activity, selectedDate)).sort((a, b) =>
    (a.startTime ?? '99:99').localeCompare(b.startTime ?? '99:99') || a.title.localeCompare(b.title, 'zh-CN'));
  const ongoing = page.activities.filter(isOngoingActivity).sort((a, b) =>
    a.endDate!.localeCompare(b.endDate!) || a.startDate!.localeCompare(b.startDate!) || a.title.localeCompare(b.title, 'zh-CN'));
  const online = state.phase === 'online' && Boolean(state.account);
  const groups = online ? state.groups.filter(group => group.followed) : [];
  const accountId = online ? state.account?.id : undefined;
  const readingMessages = Boolean(syncProgress);
  const organizing = status.enabled || status.running > 0;
  const queueTotal = status.pending + status.running + status.completed + status.partial + status.failed;
  const syncSettled = !readingMessages && !organizing && queueTotal > 0 && status.pending === 0;
  const syncSince = status.since || initialSyncWindow().since;
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const jumpTo = (day: string) => { setAnchor(day); setSelectedDate(day); };
  const shiftWindow = (offset: number) => {
    const shifted = addDays(anchor, offset);
    jumpTo(shifted < '1970-01-01' ? '1970-01-01' : shifted > '2100-12-31' ? '2100-12-31' : shifted);
  };

  useEffect(() => bridge.subscribe(event => {
    if (event.type === 'schedule' || event.type === 'messages') refresh();
  }), [refresh]);
  useEffect(() => {
    setGroupId(''); setPage(emptyPage); setStatus(emptyProcessingStatus); setSelected(null); setDetailId(''); detail.current?.close(); detailNumber.current++;
    syncController.current?.abort(); setSyncProgress(undefined); setSyncOpen(false); setSyncError('');
  }, [accountId]);
  useEffect(() => {
    if (groupId && !groups.some(group => group.id === groupId)) setGroupId('');
  }, [state.groups, groupId]);
  useEffect(() => {
    const ticket = ++requestNumber.current;
    if (!online || !accountId) {
      setPage(emptyPage); setStatus(emptyProcessingStatus); setLoading(false); setError('');
      return;
    }
    setLoading(true);
    setPage(emptyPage);
    const timer = setTimeout(() => {
      void Promise.all([
        bridge.schedule({ week, ...(type ? { type } : {}), ...(groupId ? { groupId } : {}), ...(search.trim() ? { search: search.trim() } : {}) }),
        bridge.processingStatus(),
      ]).then(([value, processing]) => {
        if (ticket !== requestNumber.current) return;
        setPage(value); setStatus(processing); setError('');
      }).catch(error => { if (ticket === requestNumber.current) setError(errorText(error)); })
        .finally(() => { if (ticket === requestNumber.current) setLoading(false); });
    }, search ? 200 : 50);
    return () => { clearTimeout(timer); requestNumber.current++; };
  }, [week, type, groupId, search, accountId, online, revision, state.groups]);
  useEffect(() => () => { detailNumber.current++; syncController.current?.abort(); }, []);
  const action = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await operation(); refresh(); } catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  };
  const startSync = async () => {
    if (!state.account || state.phase !== 'online') { setSyncError('请先在设置中登录 QQ，再开始同步。'); return; }
    const controller = new AbortController();
    syncController.current?.abort(); syncController.current = controller;
    setBusy(true); setSyncError('');
    setSyncProgress({ completed: 0, total: groups.length, group: '', added: 0 });
    try {
      const window = initialSyncWindow();
      await runInitialSync(state, window.since, bridge, setSyncProgress, controller.signal);
      controller.signal.throwIfAborted();
      setSyncProgress(undefined);
      setStatus(await bridge.configureProcessing({ enabled: true, concurrency: 3, stopWhenIdle: true, since: window.since }));
      refresh();
    } catch (error) {
      if (!controller.signal.aborted) setSyncError(errorText(error));
    } finally {
      if (syncController.current === controller) { syncController.current = undefined; setBusy(false); }
    }
  };
  const stopSync = async () => {
    setBusy(true); setSyncError('');
    try {
      syncController.current?.abort(); syncController.current = undefined; setSyncProgress(undefined);
      setStatus(await bridge.configureProcessing({ enabled: false, concurrency: 3, stopWhenIdle: false }));
      refresh();
    } catch (error) { setSyncError(errorText(error)); }
    finally { setBusy(false); }
  };
  const retrySync = async (messageKeys: string[]) => {
    if (!messageKeys.length) return;
    setBusy(true); setSyncError('');
    try {
      for (const key of new Set(messageKeys)) await bridge.retryProcessing(key);
      setStatus(await bridge.configureProcessing({ enabled: true, concurrency: 3, stopWhenIdle: true, since: syncSince }));
      refresh();
    } catch (error) { setSyncError(errorText(error)); }
    finally { setBusy(false); }
  };
  const openDetail = async (activity: Activity | string) => {
    const ticket = ++detailNumber.current;
    const id = typeof activity === 'string' ? activity : activity.id;
    setDetailId(id); setSelected(null); setDetailBusy(true); detail.current?.showModal();
    try {
      const result = await bridge.activity(id);
      if (ticket === detailNumber.current) setSelected(result);
    } catch (error) { if (ticket === detailNumber.current) setError(errorText(error)); }
    finally { if (ticket === detailNumber.current) setDetailBusy(false); }
  };
  const openLink = (url: string) => void action(() => bridge.openExternal(url));
  const syncUnavailableReason = !isDesktop
    ? '桌面版才能同步群聊消息。'
    : !online
      ? '请先在设置中登录 QQ，再开始同步。'
      : groups.length === 0
        ? '请先在群消息中关注至少一个群聊。'
        : '';
  const startDisabledReason = syncUnavailableReason || (busy ? '当前操作尚未完成，请稍候。' : '');
  const activityButton = (activity: Activity) => <button key={activity.id} className={s.activity} onClick={() => void openDetail(activity)} aria-label={`查看活动：${activity.title}`}>
    <span className={s.activityTop}><span className={s.kind} data-kind={activity.type}>{activity.type}</span>{activity.needsReview && <AlertCircle size={13} aria-label="待核对" />}</span>
    <strong>{activity.title}</strong>
    <span className={s.activityTime}><Clock3 size={12} />{activity.startTime ?? '时间待确认'}{activity.endTime ? `–${activity.endTime}` : ''}</span>
    {activity.location && <span className={s.activityLocation}><MapPin size={12} />{activity.location}</span>}
    <small>{activity.organizer || activity.groupNames[0]}{activity.sourceCount > 1 && ` · ${activity.sourceCount} 条来源`}</small>
  </button>;

  if (!online) return <section className={`${s.page} ${s.loginRequiredPage}`} aria-label="日程">
    <div className={s.loginRequired}>
      <div className={s.loginRequiredMark}><CalendarDays size={34} strokeWidth={1.3} /></div>
      <h1>请先登录 QQ</h1>
      <p>登录后查看群聊消息整理出的日程。</p>
      <button className={common.primaryButton} onClick={onModels}><Settings2 size={16} />前往设置</button>
    </div>
  </section>;

  return <section className={s.page} aria-label="日程">
    <div className={s.scroll}>
      <header className={s.heading}><div><span>活动与机会</span><h1>日程</h1></div>
        <span className={s.syncAction} tabIndex={syncUnavailableReason ? 0 : undefined}>
          <button className={common.primaryButton} disabled={Boolean(syncUnavailableReason)} onClick={() => setSyncOpen(true)} aria-describedby={syncUnavailableReason ? 'schedule-sync-unavailable' : undefined}>
            {readingMessages || organizing ? <LoaderCircle size={15} className={common.spin} /> : <CloudDownload size={15} />}
            {readingMessages || organizing ? '查看同步进度' : syncSettled ? '再次同步' : '开始同步'}
          </button>
          {syncUnavailableReason && <span id="schedule-sync-unavailable" className={s.actionTooltip} role="tooltip">{syncUnavailableReason}</span>}
        </span>
      </header>
      <div className={s.calendarToolbar}>
        <div className={s.weekNavigation}>
          <h2>{week.slice(0, 4)}年 {shortDate(week)} 至 {days[6].slice(0, 4) !== week.slice(0, 4) ? `${days[6].slice(0, 4)}年 ` : ''}{shortDate(days[6])}</h2>
          <button className={common.iconButton} title="前7天" aria-label="前7天" disabled={week === '1970-01-01'} onClick={() => shiftWindow(-7)}><ArrowLeft size={17} /></button>
          <button className={common.iconButton} title="后7天" aria-label="后7天" disabled={days[6] === '2100-12-31'} onClick={() => shiftWindow(7)}><ArrowRight size={17} /></button>
          <button className={common.secondaryButton} onClick={() => jumpTo(today)}>回到今天</button>
        </div>
        <label className={s.datePicker}><CalendarDays size={15} /><input type="date" aria-label="跳转日期" value={selectedDate} min="1970-01-01" max="2100-12-31"
          onChange={event => { if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value) && event.target.validity.valid) jumpTo(event.target.value); }} /></label>
      </div>
      <div className={s.dateStrip} aria-label="七天日期" role="group">
        {days.map(day => {
          const count = scheduled.filter(activity => activityOnDate(activity, day)).length;
          return <button key={day} className={`${s.dateButton} ${day === selectedDate ? s.selectedDate : ''}`}
            aria-label={`${day} ${weekday(day)}${day === today ? ' 今天' : ''}`} aria-pressed={day === selectedDate}
            aria-current={day === today ? 'date' : undefined} aria-controls="daily-activities"
            onClick={() => setSelectedDate(day)}>
            <span className={s.dateName}>{weekday(day)}{day === today && <small>今天</small>}</span>
            <strong>{Number(day.slice(8))}<small>/{Number(day.slice(5, 7))}</small></strong>
            <span className={s.dateCount}>{loading ? '·' : count ? `${count} 场` : '无安排'}</span>
          </button>;
        })}
      </div>
      <div className={s.filters}>
        <label><span>活动类型</span><select aria-label="活动类型" value={type} onChange={event => setType(event.target.value as ActivityType | '')}><option value="">全部类型</option>{activityTypes.map(type => <option key={type} value={type}>{type}</option>)}</select></label>
        <label><span>来源群聊</span><select aria-label="来源群聊" value={groupId} onChange={event => setGroupId(event.target.value)}><option value="">全部关注群</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
        <div className={s.search}><Search size={15} /><input aria-label="搜索活动" placeholder="搜索活动、单位或地点" value={search} onChange={event => setSearch(event.target.value)} maxLength={300} /></div>
        <button className={common.iconButton} aria-label="刷新日程" title="刷新日程" onClick={refresh} disabled={loading}><RefreshCw size={16} className={loading ? common.spin : ''} /></button>
      </div>
      {error && <p className={s.error} role="alert"><AlertCircle size={16} />{error}</p>}
      <section id="daily-activities" className={s.dailySection} aria-label="当日活动" aria-busy={loading}>
        <header className={s.dailyHeading}>
          <div><h2>{shortDate(selectedDate)}<span>{weekday(selectedDate)}{selectedDate === today && ' · 今天'}</span></h2>
            <p aria-live="polite">{loading ? '正在读取活动' : `${dailyActivities.length} 场活动`} · 北京时间</p></div>
        </header>
        <div className={s.tableScroll} tabIndex={0} role="region" aria-label="当日活动表格，可横向滚动">
          <table className={s.activityTable} aria-label="当日活动列表">
            <colgroup><col className={s.nameColumn} /><col className={s.timeColumn} /><col className={s.locationColumn} /><col /></colgroup>
            <thead><tr><th scope="col">宣讲会 / 招聘会名称</th><th scope="col">时间</th><th scope="col">地点</th><th scope="col">原始消息</th></tr></thead>
            <tbody>{!loading && dailyActivities.map(activity => <tr key={activity.id}>
              <th scope="row"><span className={s.kind} data-kind={activity.type}>{activity.type}</span>
                <button className={s.tableTitle} aria-label={`查看活动：${activity.title}`} onClick={() => void openDetail(activity)}>{activity.title}</button></th>
              <td className={s.timeCell}>{activityTimeLabel(activity)}</td>
              <td>{activity.location || '未定'}</td>
              <td><CalendarMessage sources={page.sources?.[activity.id] ?? []} onOpen={openLink} /></td>
            </tr>)}</tbody>
          </table>
          {(loading || !dailyActivities.length) && <div className={s.tableEmpty}>
            {loading ? <LoaderCircle size={22} className={common.spin} /> : <CalendarDays size={24} />}
            <strong>{loading ? '正在读取活动' : error ? '活动暂时无法加载' : search || type || groupId ? '没有符合筛选条件的活动' : '这一天暂无活动'}</strong>
            {!loading && !error && <p>选择其他日期查看安排，或等待新消息提取完成。</p>}
          </div>}
        </div>
      </section>
      {ongoing.length > 0 && <section className={s.ongoing} aria-label="跨期事项" aria-busy={loading}>
        <header><h2><CalendarRange size={16} />跨期事项</h2><span>{ongoing.length} 项</span></header>
        <div>{ongoing.map(activity => <button key={activity.id} className={s.periodRow} onClick={() => void openDetail(activity)} aria-label={`查看活动：${activity.title}`}>
          <span className={s.periodMain}>
            <span className={s.activityTop}><span className={s.kind} data-kind={activity.type}>{activity.type}</span>{activity.needsReview && <AlertCircle size={13} aria-label="待核对" />}</span>
            <strong>{activity.title}</strong>
            <small>{activity.organizer || activity.groupNames[0]}{activity.sourceCount > 1 && ` · ${activity.sourceCount} 条来源`}</small>
          </span>
          <span className={s.periodDates}><CalendarRange size={15} /><span>{activity.startDate} 至 {activity.endDate}
            {(activity.startTime || activity.endTime) && <small>{activity.startTime && `开始 ${activity.startTime}`}{activity.startTime && activity.endTime && ' · '}{activity.endTime && `结束 ${activity.endTime}`}</small>}
          </span></span>
          <ChevronRight size={16} className={s.periodArrow} aria-hidden="true" />
        </button>)}</div>
      </section>}
      {page.undated.length > 0 && <section className={s.undated} aria-label="日期待确认"><header><h2>日期待确认</h2><span>{page.undated.length} 项</span></header><div>{page.undated.map(activityButton)}</div></section>}
    </div>
    <SyncDialog open={syncOpen} onClose={() => setSyncOpen(false)} status={status} progress={syncProgress}
      since={syncSince} groups={groups.length} busy={busy} error={syncError} revision={revision}
      startDisabledReason={startDisabledReason}
      onStart={() => void startSync()} onStop={() => void stopSync()} onRetry={keys => void retrySync(keys)}
      onModels={() => { setSyncOpen(false); onModels(); }} outdated={isDesktop && !loading && (status.processorVersion ?? 0) < scheduleProcessingVersion} />
    <dialog ref={detail} className={`${s.dialog} ${s.detail}`} onClick={event => { if (event.target === detail.current) detail.current?.close(); }}
      onClose={() => { detailNumber.current++; setDetailId(''); }}>
      <div className={s.detailHeading}><span className={s.muted}>活动详情</span><button className={common.iconButton} title="关闭活动详情" aria-label="关闭活动详情" onClick={() => detail.current?.close()}><X size={19} /></button></div>
      {detailBusy ? <p className={s.empty}><LoaderCircle size={22} className={common.spin} />正在读取</p> : selected ? <>
        <span className={s.kind} data-kind={selected.activity.type}>{selected.activity.type}</span><h2>{selected.activity.title}</h2>
        {selected.activity.needsReview && <p className={s.banner}><AlertCircle size={16} />部分信息待确认，请核对原始通知。</p>}
        <dl className={s.facts}>
          <div><dt>{isOngoingActivity(selected.activity) ? '起止日期' : '时间'}</dt><dd>{selected.activity.startDate ?? '日期待确认'}{selected.activity.endDate && ` 至 ${selected.activity.endDate}`}
            {isOngoingActivity(selected.activity)
              ? (selected.activity.startTime || selected.activity.endTime) && <><br />{selected.activity.startTime && `开始 ${selected.activity.startTime}`}{selected.activity.startTime && selected.activity.endTime && ' · '}{selected.activity.endTime && `结束 ${selected.activity.endTime}`}</>
              : <><br />{selected.activity.startTime ?? '时间待确认'}{selected.activity.endTime && ` – ${selected.activity.endTime}`}</>}
            <small>北京时间</small></dd></div>
          <div><dt>地点</dt><dd>{selected.activity.location || '待确认'}</dd></div>
          <div><dt>主办单位</dt><dd>{selected.activity.organizer || '待确认'}</dd></div>
          <div><dt>面向对象</dt><dd>{selected.activity.audience || '未注明'}</dd></div>
          <div><dt>报名截止</dt><dd>{selected.activity.deadline || '未注明'}</dd></div>
        </dl>
        {selected.activity.description && <p className={s.description}>{selected.activity.description}</p>}
        {selected.activity.registrationUrl && <button className={common.secondaryButton} onClick={() => openLink(selected.activity.registrationUrl!)}><ExternalLink size={15} />报名入口</button>}
        <section className={s.sources}><h3>完整原始信息 · {selected.sources.length} 条</h3>{selected.sources.map(source => <details key={source.messageKey} open={selected.sources.length === 1}>
          <summary><MessageCircle size={14} />{source.groupName}</summary>
          <span className={s.sourceMeta}>{source.senderName} · {new Date(source.messageTime * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</span>
          <blockquote>{source.evidence}</blockquote><pre>{source.text}</pre>
          {source.relatedMessages?.map(message => <details key={message.messageKey}>
            <summary>{message.relation === 'quoted' ? '引用原消息' : '同一消息的相关回复'} · {message.senderName}</summary>
            <span className={s.sourceMeta}>{new Date(message.messageTime * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</span>
            <pre>{message.text}</pre>
          </details>)}
          {(source.reviewReasons ?? source.warnings).map(reason => <p className={s.sourceWarning} key={reason}><AlertCircle size={13} />{reason}</p>)}
          {source.reviewReasons !== undefined && source.warnings.length > 0 && <details className={s.readingNotes}>
            <summary>来源阅读说明 · {source.warnings.length}</summary>
            <ul>{source.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
          </details>}
          <SourceMaterials materials={source.materials} onOpen={openLink}
            onPdf={id => void action(() => bridge.openWebpagePdf(source.messageKey, id))} />
          <button className={common.textButton} onClick={() => { detail.current?.close(); onGroup(source.groupId); }}><MessageCircle size={14} />打开群聊</button>
        </details>)}</section>
      </> : detailId && <p className={s.empty}>该活动已更新或来源群已取消关注。</p>}
    </dialog>
  </section>;
}
