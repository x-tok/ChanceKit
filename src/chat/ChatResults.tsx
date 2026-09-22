import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CalendarDays, LoaderCircle, MapPin, X } from 'lucide-react';
import { jobResultKey, type ChatWebSource, type JobOpportunity, type JobResultDetail } from '../chat';
import { activityTimeLabel } from '../schedule';
import { SourceMaterials } from '../SourceMaterials';
import { bridge } from '../bridge';
import { ChatMarkdown, chatLink } from './ChatMarkdown';
import common from '../App.module.css';
import s from '../JobChatPage.module.css';

const categoryLabel = (item: JobOpportunity) => item.activityType || ({
  information: '招聘资讯', incomplete: '待补全', activity: '活动', processed: '已处理消息',
}[item.category]);
const dateTime = (value: number) => new Date(value * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
type Result = JobOpportunity | ChatWebSource;
const isWeb = (item: Result): item is ChatWebSource => 'kind' in item && item.kind === 'web';
const resultKey = (item: Result) => isWeb(item) ? item.url : jobResultKey(item);
const webState = (item: ChatWebSource) => ({ snippet: '搜索摘要 · 未核实正文', read: '已读取网页', unavailable: '正文未能核实' }[item.status]);
const hostname = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };

function ResultCard({ item, onOpen }: { item: Result; onOpen: () => void }) {
  const web = isWeb(item);
  return <button type="button" className={s.source} onClick={onOpen} aria-label={`查看详情：${item.title}`} data-result={resultKey(item)}>
    <span className={s.sourceMeta}><span>{web ? '网络来源' : `本地 · ${categoryLabel(item)}`}</span><time>{web ? '查询于 ' : ''}{new Date(web ? item.fetchedAt : item.messageTime * 1000).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}</time></span>
    <strong>{item.title}</strong>
    {!web && (item.startDate || item.location) && <span className={s.cardFacts}>
      {item.startDate && <span><CalendarDays size={12} />{item.startDate}</span>}
      {item.location && <span><MapPin size={12} />{item.location}</span>}
    </span>}
    {web && <span className={s.cardFacts}>{webState(item)}</span>}
    <span className={s.sourceSummary}>{item.summary || '点击查看完整信息与原始消息。'}</span>
    <span className={s.sourceFooter}><span>{web ? hostname(item.url) : item.groupName}</span><span className={s.cardAction}>查看详情 <ArrowRight size={13} /></span></span>
  </button>;
}

function ResultDetails({ value, onError }: { value: JobResultDetail; onError: (message: string) => void }) {
  const { activity, item, sources } = value;
  const open = (url: string) => {
    const safe = chatLink(url);
    if (safe) void bridge.openExternal(safe).catch(() => onError('链接打开失败，请稍后重试。'));
  };
  return <>
    <span className={s.detailKind}>{categoryLabel(item)}</span>
    {activity ? <dl className={s.facts}>
      <div><dt>时间</dt><dd>{activity.startDate ?? '日期未注明'}{activity.endDate && activity.endDate !== activity.startDate && ` 至 ${activity.endDate}`} · {activityTimeLabel(activity)}（北京时间）</dd></div>
      <div><dt>地点</dt><dd>{activity.location || '未注明'}</dd></div>
      <div><dt>主办单位</dt><dd>{activity.organizer || '未注明'}</dd></div>
      <div><dt>面向对象</dt><dd>{activity.audience || '未注明'}</dd></div>
      <div><dt>报名截止</dt><dd>{activity.deadline || '未注明'}</dd></div>
    </dl> : null}
    <ChatMarkdown text={activity?.description || item.summary} onError={onError} />
    {activity?.registrationUrl && chatLink(activity.registrationUrl) && <button className={common.textButton} onClick={() => open(activity.registrationUrl!)}>打开报名入口 <ArrowRight size={14} /></button>}
    <section className={s.detailSources} aria-label="原始消息">
      <h3>原始消息与来源 · {sources.length} 条</h3>
      {sources.map(source => <details key={source.messageKey} open={sources.length === 1}>
        <summary>{source.groupName}</summary>
        <p className={s.detailMeta}>{source.senderName} · {dateTime(source.messageTime)}</p>
        {source.evidence && <blockquote>{source.evidence}</blockquote>}
        <pre>{source.text || '这条消息没有文字内容。'}</pre>
        <SourceMaterials materials={source.materials} onOpen={open}
          onPdf={id => void bridge.openWebpagePdf(source.messageKey, id).catch(() => onError('阅读副本暂时无法打开。'))} />
        {source.relatedMessages?.map(related => <details key={related.messageKey}>
          <summary>{related.relation === 'quoted' ? '引用消息' : '相关回复'} · {related.senderName}</summary>
          <pre>{related.text}</pre>
        </details>)}
        {(source.warnings.length > 0 || Boolean(source.reviewReasons?.length)) && <details>
          <summary>读取说明</summary><ul>{[...new Set([...source.warnings, ...source.reviewReasons ?? []])].map(reason => <li key={reason}>{reason}</li>)}</ul>
        </details>}
      </details>)}
    </section>
  </>;
}

function WebDetails({ source, onError }: { source: ChatWebSource; onError: (message: string) => void }) {
  const url = chatLink(source.url);
  return <>
    <span className={s.detailKind}>网络来源 · {webState(source)}</span>
    <p className={s.detailMeta}>读取于 {dateTime(source.fetchedAt / 1000)}（北京时间，非发布时间）</p>
    {url && <a className={s.webLink} href={url} onClick={event => {
      event.preventDefault();
      void bridge.openExternal(url).catch(() => onError('链接打开失败，请稍后重试。'));
    }}>{source.url} <ArrowRight size={14} /></a>}
    {source.note && <p>{source.note}</p>}
    <section className={s.detailSources}>
      <h3>{source.status === 'read' ? '网页正文摘录' : '搜索摘要与读取说明'}</h3>
      <pre>{source.text || source.summary || '未能读取正文，请打开来源网站核对。'}</pre>
      <p className={s.detailMeta}>这是本轮查询保存的内容，招聘状态与截止日期请以来源网站为准。</p>
    </section>
  </>;
}

export function ChatResults({ items, webSources = [] }: { items: JobOpportunity[]; webSources?: ChatWebSource[] }) {
  const allItems: Result[] = [...items, ...webSources];
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Result | null>(null);
  const [fromList, setFromList] = useState(false);
  const [value, setValue] = useState<JobResultDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const lastSelected = useRef('');
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open) dialog.current?.close();
  }, [open]);
  useEffect(() => {
    if (!open || !selected) return;
    heading.current?.focus();
    if (isWeb(selected)) { setLoading(false); return; }
    let current = true;
    setLoading(true); setValue(null); setError('');
    void bridge.jobChatResult({ messageKey: selected.messageKey, ...(selected.activityId ? { activityId: selected.activityId } : {}) })
      .then(result => { if (current) setValue(result); })
      .catch(() => { if (current) setError('详情读取失败，请关闭后重试。'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [selected, open]);
  const choose = (item: Result, list: boolean) => {
    lastSelected.current = resultKey(item);
    setFromList(list); setValue(null); setLoading(true); setError(''); setSelected(item); setOpen(true);
  };
  const back = () => {
    setSelected(null); setError('');
    requestAnimationFrame(() => [...dialog.current?.querySelectorAll<HTMLButtonElement>('button[data-result]') ?? []]
      .find(button => button.dataset.result === lastSelected.current)?.focus());
  };
  if (!allItems.length) return null;
  return <section className={s.results} aria-label="相关信息">
    <div className={s.resultsHeading}><strong>相关信息</strong><span>{allItems.length} 条</span></div>
    <div className={s.sources}>{allItems.slice(0, 4).map(item => <ResultCard key={resultKey(item)} item={item} onOpen={() => choose(item, false)} />)}</div>
    {allItems.length > 4 && <button type="button" className={`${common.textButton} ${s.allResults}`} onClick={() => {
      setSelected(null); setError(''); setOpen(true);
    }}>查看全部 {allItems.length} 条相关信息 <ArrowRight size={14} /></button>}
    <dialog ref={dialog} className={s.resultDialog} aria-label={selected ? '信息详情' : '全部相关信息'}
      onClose={() => setOpen(false)} onClick={event => { if (event.target === dialog.current) setOpen(false); }}>
      <header className={s.dialogHeader}>
        {selected && fromList && <button className={common.iconButton} aria-label="返回全部相关信息" onClick={back}><ArrowLeft size={18} /></button>}
        <h2 ref={heading} tabIndex={-1}>{selected?.title ?? `全部相关信息 · ${allItems.length} 条`}</h2>
        <button className={common.iconButton} aria-label="关闭结果弹窗" onClick={() => setOpen(false)}><X size={19} /></button>
      </header>
      {error && <p className={s.dialogError} role="alert">{error}</p>}
      {selected ? <div className={s.detailBody} aria-busy={loading}>
        {isWeb(selected) ? <WebDetails source={selected} onError={setError} />
          : loading ? <p className={s.detailState}><LoaderCircle size={20} className={common.spin} />正在读取详情</p>
          : value ? <ResultDetails value={value} onError={setError} />
            : !error && <p className={s.detailState}>这条信息已更新或不在当前关注范围内，请重新查询。</p>}
      </div> : <div className={s.dialogGrid}>{allItems.map(item => <ResultCard key={resultKey(item)} item={item} onOpen={() => choose(item, true)} />)}</div>}
    </dialog>
  </section>;
}
