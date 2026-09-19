import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, ArrowRight, Bot, CalendarDays, Check, Clock3, ExternalLink, LoaderCircle, MapPin, MessageCircle, RefreshCw, Search, Settings2, X } from 'lucide-react';
import { bridge, isDesktop } from './bridge';
import { activityOnDate, activityTypes, addDays, chinaToday, emptyProcessingStatus, weekStart, type Activity, type ActivityDetail, type ActivityType, type ProcessingStatus, type SchedulePage } from './schedule';
import type { AppState } from './shared';
import s from './Schedule.module.css';
import common from './App.module.css';

const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试。').replace(/^Error invoking remote method '[^']+': Error: /, '');
const shortDate = (value: string) => `${Number(value.slice(5, 7))}月${Number(value.slice(8))}日`;
const emptyPage: SchedulePage = { activities: [], undated: [] };

export function Schedule({ state, onModels, onGroup }: { state: AppState; onModels: () => void; onGroup: (id: string) => void }) {
  const [week, setWeek] = useState(() => weekStart(chinaToday()));
  const [type, setType] = useState<ActivityType | ''>('');
  const [groupId, setGroupId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState<SchedulePage>(emptyPage);
  const [status, setStatus] = useState<ProcessingStatus>(emptyProcessingStatus);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<ActivityDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailId, setDetailId] = useState('');
  const consent = useRef<HTMLDialogElement>(null);
  const detail = useRef<HTMLDialogElement>(null);
  const requestNumber = useRef(0);
  const detailNumber = useRef(0);
  const today = chinaToday();
  const days = Array.from({ length: 7 }, (_, index) => addDays(week, index));
  const groups = state.groups.filter(group => group.followed);
  const accountId = state.localAccount?.id;
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => bridge.subscribe(event => {
    if (event.type === 'schedule' || event.type === 'messages') refresh();
  }), [refresh]);
  useEffect(() => {
    setGroupId(''); setPage(emptyPage); setSelected(null); setDetailId(''); detail.current?.close(); detailNumber.current++;
  }, [accountId]);
  useEffect(() => {
    if (groupId && !groups.some(group => group.id === groupId)) setGroupId('');
  }, [state.groups, groupId]);
  useEffect(() => {
    const ticket = ++requestNumber.current;
    setLoading(true);
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
  }, [week, type, groupId, search, accountId, revision, state.groups]);
  useEffect(() => () => { detailNumber.current++; }, []);
  const action = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await operation(); refresh(); } catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  };
  const configure = (enabled: boolean, concurrency = status.concurrency) => action(async () => {
    setStatus(await bridge.configureProcessing({ enabled, concurrency }));
  });
  const openDetail = async (activity: Activity) => {
    const ticket = ++detailNumber.current;
    setDetailId(activity.id); setSelected(null); setDetailBusy(true); detail.current?.showModal();
    try {
      const result = await bridge.activity(activity.id);
      if (ticket === detailNumber.current) setSelected(result);
    } catch (error) { if (ticket === detailNumber.current) setError(errorText(error)); }
    finally { if (ticket === detailNumber.current) setDetailBusy(false); }
  };
  const openLink = (url: string) => void action(() => bridge.openExternal(url));
  const activityButton = (activity: Activity) => <button key={activity.id} className={s.activity} onClick={() => void openDetail(activity)} aria-label={`查看活动：${activity.title}`}>
    <span className={s.activityTop}><span className={s.kind} data-kind={activity.type}>{activity.type}</span>{activity.needsReview && <AlertCircle size={13} aria-label="待核对" />}</span>
    <strong>{activity.title}</strong>
    <span className={s.activityTime}><Clock3 size={12} />{activity.startTime ?? '时间待确认'}{activity.endTime ? `–${activity.endTime}` : ''}</span>
    {activity.location && <span className={s.activityLocation}><MapPin size={12} />{activity.location}</span>}
    <small>{activity.organizer || activity.groupNames[0]}{activity.sourceCount > 1 && ` · ${activity.sourceCount} 条来源`}</small>
  </button>;

  return <section className={s.page} aria-label="日程">
    <div className={s.scroll}>
      <header className={s.heading}><div><span>活动与机会</span><h1>日程</h1></div><span className={s.agent}><Bot size={16} />pi agent</span></header>
      <section className={s.processing} aria-label="消息处理">
        <div className={s.processingMain}>
          <div className={s.processingState}><span className={`${common.statusDot} ${status.enabled && !status.blockedReason ? common.liveDot : ''}`} /><strong>{status.blockedReason && status.enabled ? '等待模型配置' : status.enabled ? status.running ? '正在提取活动' : '自动处理已开启' : '自动处理已暂停'}</strong></div>
          <label className={s.switchLabel}>自动处理<input aria-label="自动处理" type="checkbox" role="switch" checked={status.enabled} disabled={!isDesktop || busy || !accountId || (!groups.length && !status.enabled)}
            onChange={event => { if (event.target.checked) consent.current?.showModal(); else void configure(false); }} /></label>
        </div>
        <div className={s.processingStats} role="status">
          <span>等待 <b>{status.pending}</b></span><span>处理中 <b>{status.running}</b></span><span>已完成 <b>{status.completed}</b></span>
          <span className={status.partial + status.failed ? s.attention : ''}>待检查 <b>{status.partial + status.failed}</b></span>
          <span className={s.groupCount}>{groups.length} 个关注群</span>
        </div>
        <details className={s.queueDetails}>
          <summary><Settings2 size={14} />处理设置与记录</summary>
          <div className={s.queueControls}><label>并发消息数<select aria-label="并发消息数" value={status.concurrency} disabled={!isDesktop || busy || !accountId} onChange={event => void configure(status.enabled, Number(event.target.value))}>{[1, 2, 3, 4, 5, 6].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
            <button className={common.textButton} disabled={!isDesktop || busy || !status.partial && !status.failed} onClick={() => void action(async () => setStatus(await bridge.retryProcessing()))}><RefreshCw size={14} />重试未完成</button>
            <button className={common.textButton} onClick={onModels}><Bot size={14} />模型配置</button>
          </div>
          {status.issues.length > 0 ? <ul className={s.issues}>{status.issues.map(issue => <li key={issue.messageKey}><div><strong>{issue.groupName}</strong><p>{issue.text || '非文字消息'}</p><span>{issue.error}</span></div><button className={common.iconButton} title="重试此消息" aria-label={`重试消息 ${issue.messageKey}`} disabled={busy} onClick={() => void action(async () => setStatus(await bridge.retryProcessing(issue.messageKey)))}><RefreshCw size={15} /></button></li>)}</ul>
            : <p className={s.muted}>暂无异常记录</p>}
        </details>
      </section>
      {!isDesktop && <p className={s.banner}><AlertCircle size={16} />浏览器预览：没有本地群消息，处理与保存不可用。</p>}
      {status.blockedReason && isDesktop && <p className={s.banner}><AlertCircle size={16} />{status.blockedReason}<button className={common.textButton} onClick={onModels}>模型配置</button></p>}
      {error && <p className={s.error} role="alert"><AlertCircle size={16} />{error}</p>}
      <div className={s.calendarToolbar}>
        <div className={s.weekNavigation}>
          <button className={common.iconButton} title="上一周" aria-label="上一周" onClick={() => setWeek(value => addDays(value, -7))}><ArrowLeft size={17} /></button>
          <h2>{week.slice(0, 4)}年 {shortDate(week)} – {shortDate(days[6])}</h2>
          <button className={common.iconButton} title="下一周" aria-label="下一周" onClick={() => setWeek(value => addDays(value, 7))}><ArrowRight size={17} /></button>
          <button className={common.secondaryButton} onClick={() => setWeek(weekStart(today))}>本周</button>
        </div>
        <label className={s.datePicker}><CalendarDays size={15} /><input type="date" aria-label="跳转日期" value={week} min="1970-01-01" max="2100-12-31" onChange={event => { if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) setWeek(weekStart(event.target.value)); }} /></label>
      </div>
      <div className={s.filters}>
        <label><span>活动类型</span><select aria-label="活动类型" value={type} onChange={event => setType(event.target.value as ActivityType | '')}><option value="">全部类型</option>{activityTypes.map(type => <option key={type} value={type}>{type}</option>)}</select></label>
        <label><span>来源群聊</span><select aria-label="来源群聊" value={groupId} onChange={event => setGroupId(event.target.value)}><option value="">全部关注群</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
        <div className={s.search}><Search size={15} /><input aria-label="搜索活动" placeholder="搜索活动、单位或地点" value={search} onChange={event => setSearch(event.target.value)} maxLength={300} /></div>
        <button className={common.iconButton} aria-label="刷新日程" title="刷新日程" onClick={refresh} disabled={loading}><RefreshCw size={16} className={loading ? common.spin : ''} /></button>
      </div>
      <div className={s.calendarSummary}><span>{page.activities.length} 项活动</span><span>北京时间 · UTC+8</span></div>
      <div className={s.week} aria-label="每周活动" aria-busy={loading}>
        {days.map((day, index) => {
          const activities = page.activities.filter(activity => activityOnDate(activity, day));
          return <section key={day} className={`${s.day} ${day === today ? s.today : ''}`} aria-label={`${day} ${weekdays[index]}`}>
            <header><span>{weekdays[index]}</span><strong>{Number(day.slice(8))}</strong>{day === today && <small>今天</small>}</header>
            <div className={s.dayEvents}>{activities.map(activityButton)}{activities.length === 0 && <span className={s.noActivity}>暂无活动</span>}</div>
          </section>;
        })}
      </div>
      {!loading && !page.activities.length && <p className={s.empty}><CalendarDays size={20} />{search || type || groupId ? '没有符合筛选条件的活动' : '本周暂无已提取的活动'}</p>}
      {page.undated.length > 0 && <section className={s.undated} aria-label="日期待确认"><header><h2>日期待确认</h2><span>{page.undated.length} 项</span></header><div>{page.undated.map(activityButton)}</div></section>}
    </div>
    <dialog ref={consent} className={s.dialog}>
      <h2>开启自动处理？</h2>
      <p>已关注群聊的已归档消息及后续新消息、消息中的公开链接正文、图片及支持的群文件内容，将发送给“模型配置”中保存的服务商，用于提取活动信息，可能产生 API 费用。多图或长海报会分批识别，可能增加调用次数和费用。</p>
      <p>处理结果保存在本机。暂停会取消正在处理的请求；已发出的请求仍可能计费。</p>
      <div className={s.dialogActions}><button className={common.secondaryButton} onClick={() => consent.current?.close()}>取消</button><button className={common.primaryButton} onClick={() => { consent.current?.close(); void configure(true); }}><Check size={16} />开启处理</button></div>
    </dialog>
    <dialog ref={detail} className={`${s.dialog} ${s.detail}`} onClose={() => { detailNumber.current++; setDetailId(''); }}>
      <div className={s.detailHeading}><span className={s.muted}>活动详情</span><button className={common.iconButton} title="关闭活动详情" aria-label="关闭活动详情" onClick={() => detail.current?.close()}><X size={19} /></button></div>
      {detailBusy ? <p className={s.empty}><LoaderCircle size={22} className={common.spin} />正在读取</p> : selected ? <>
        <span className={s.kind} data-kind={selected.activity.type}>{selected.activity.type}</span><h2>{selected.activity.title}</h2>
        {selected.activity.needsReview && <p className={s.banner}><AlertCircle size={16} />部分信息待确认，请核对原始通知。</p>}
        <dl className={s.facts}>
          <div><dt>时间</dt><dd>{selected.activity.startDate ?? '日期待确认'}{selected.activity.endDate && ` 至 ${selected.activity.endDate}`}<br />{selected.activity.startTime ?? '时间待确认'}{selected.activity.endTime && ` – ${selected.activity.endTime}`}<small>北京时间</small></dd></div>
          <div><dt>地点</dt><dd>{selected.activity.location || '待确认'}</dd></div>
          <div><dt>主办单位</dt><dd>{selected.activity.organizer || '待确认'}</dd></div>
          <div><dt>面向对象</dt><dd>{selected.activity.audience || '未注明'}</dd></div>
          <div><dt>报名截止</dt><dd>{selected.activity.deadline || '未注明'}</dd></div>
        </dl>
        {selected.activity.description && <p className={s.description}>{selected.activity.description}</p>}
        {selected.activity.registrationUrl && <button className={common.secondaryButton} onClick={() => openLink(selected.activity.registrationUrl!)}><ExternalLink size={15} />报名入口</button>}
        <section className={s.sources}><h3>消息来源 · {selected.sources.length}</h3>{selected.sources.map(source => <details key={source.messageKey} open={selected.sources.length === 1}>
          <summary><MessageCircle size={14} />{source.groupName}</summary>
          <span className={s.sourceMeta}>{source.senderName} · {new Date(source.messageTime * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</span>
          <blockquote>{source.evidence}</blockquote><pre>{source.text}</pre>
          {source.warnings.map(warning => <p className={s.sourceWarning} key={warning}><AlertCircle size={13} />{warning}</p>)}
          {source.materials.map((material, index) => material.url
            ? <button className={common.textButton} key={`${material.url}-${index}`} onClick={() => openLink(material.url)}><ExternalLink size={13} />{material.kind === 'image' ? '查看来源图片' : material.title || (material.kind === 'file' ? '查看来源文件' : '查看来源网页')}</button>
            : <span className={s.sourceMeta} key={`attachment-${index}`}>{material.title || 'QQ 消息附件'}</span>)}
          <button className={common.textButton} onClick={() => { detail.current?.close(); onGroup(source.groupId); }}><MessageCircle size={14} />打开群聊</button>
        </details>)}</section>
      </> : detailId && <p className={s.empty}>该活动已更新或来源群已取消关注。</p>}
    </dialog>
  </section>;
}
