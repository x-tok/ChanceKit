import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, CircleEllipsis, CloudDownload, Image, FileText, Link2, LoaderCircle, MessageCircle, RefreshCw, Sparkles, Square, X } from 'lucide-react';
import { bridge } from '../bridge';
import { emptyProcessingDetails, type ProcessingDetailsPage, type ProcessingMessageBucket, type ProcessingMessageItem, type ProcessingStatus } from '../schedule';
import type { InitialSyncProgress } from '../onboarding/initial-sync';
import common from '../App.module.css';
import s from './SyncDialog.module.css';
import { LinkifiedText, MessageImages, MessageLinks } from './MessageContent';

const tabs: { bucket: ProcessingMessageBucket; label: string }[] = [
  { bucket: 'pending', label: '待整理' },
  { bucket: 'running', label: '整理中' },
  { bucket: 'completed', label: '已完成' },
];

const contentLabels: Record<string, { label: string; icon: typeof Image }> = {
  image: { label: '图片', icon: Image }, file: { label: '文件', icon: FileText },
  json: { label: '链接卡片', icon: Link2 }, forward: { label: '合并消息', icon: MessageCircle },
};

function messageTime(value: number) {
  return new Date(value * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function itemState(item: ProcessingMessageItem) {
  if (item.state === 'failed') return '需要重试';
  if (item.state === 'partial') return '已完成，需核对';
  if (item.state === 'running') return '正在整理';
  if (item.state === 'completed') return item.activityTitles.length ? `提取 ${item.activityTitles.length} 项日程` : '未提取到日程';
  return '等待整理';
}

function MessageItem({ item, onError }: { item: ProcessingMessageItem; onError: (message: string) => void }) {
  const content = item.contentTypes.filter(type => type !== 'text' && type !== 'image').map(type => contentLabels[type]).filter(Boolean);
  return <li className={s.messageItem}>
    <div className={s.messageMeta}>
      <strong>{item.groupName}</strong><span>{item.senderName}</span><time>{messageTime(item.messageTime)}</time>
      <small data-state={item.state}>{itemState(item)}</small>
    </div>
    <LinkifiedText text={item.text || '这条消息没有可显示的文字内容'} onError={onError} />
    <MessageImages images={item.images} onError={onError} />
    <MessageLinks links={item.links} onError={onError} />
    {content.length > 0 && <div className={s.contentTypes}>{content.map(({ label, icon: Icon }) => <span key={label}><Icon size={12} />{label}</span>)}</div>}
    {item.activityTitles.length > 0 && <div className={s.outputs} aria-label="提取的日程">
      {item.activityTitles.map(title => <span key={title}><Check size={12} />{title}</span>)}
    </div>}
    {item.error && <span className={s.itemError}><AlertCircle size={12} />{item.error}</span>}
  </li>;
}

export function SyncDialog({ open, onClose, status, progress, since, groups, busy, error, revision, canStart, onStart, onStop, onRetry, onModels, outdated }: {
  open: boolean;
  onClose: () => void;
  status: ProcessingStatus;
  progress?: InitialSyncProgress;
  since: number;
  groups: number;
  busy: boolean;
  error: string;
  revision: number;
  canStart: boolean;
  onStart: () => void;
  onStop: () => void;
  onRetry: () => void;
  onModels: () => void;
  outdated?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [bucket, setBucket] = useState<ProcessingMessageBucket>('pending');
  const [details, setDetails] = useState<ProcessingDetailsPage>(emptyProcessingDetails);
  const [loading, setLoading] = useState(false);
  const [detailsError, setDetailsError] = useState('');
  const request = useRef(0);
  const reading = Boolean(progress);
  const organizing = status.enabled || status.running > 0;
  const totalJobs = status.pending + status.running + status.completed + status.partial + status.failed;
  const doneJobs = status.completed + status.partial + status.failed;
  const settled = !reading && !organizing && totalJobs > 0 && status.pending === 0;
  const hasIssues = status.partial + status.failed > 0;
  const percent = reading
    ? Math.round((progress!.completed / Math.max(1, progress!.total)) * 35)
    : organizing ? Math.round(35 + (doneJobs / Math.max(1, totalJobs)) * 65) : settled ? 100 : 0;

  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
    if (!open && element?.open) element.close();
  }, [open]);

  const load = useCallback(async (append = false) => {
    if (!open) return;
    const ticket = ++request.current;
    setLoading(true);
    try {
      const value = await bridge.processingDetails({ bucket, since, offset: append ? details.items.length : 0, limit: 100 });
      if (ticket !== request.current) return;
      setDetails(current => append ? { ...value, items: [...current.items, ...value.items] } : value);
      setDetailsError('');
    } catch (cause) {
      if (ticket === request.current) setDetailsError(cause instanceof Error ? cause.message : '整理详情读取失败。');
    } finally {
      if (ticket === request.current) setLoading(false);
    }
  }, [bucket, details.items.length, open, since]);

  useEffect(() => { void load(false); return () => { request.current++; }; }, [bucket, open, revision, since, status.pending, status.running, status.completed, status.partial, status.failed]);

  const title = reading ? '正在读取群聊消息' : organizing ? '正在整理日程' : hasIssues && settled ? '部分消息需要处理' : settled ? '本次同步已完成' : '同步群聊消息';
  const description = reading
    ? `正在读取 ${progress!.group || '群聊记录'}，本次新增 ${progress!.added.toLocaleString()} 条消息`
    : organizing ? 'AI 正在按日期读取文字、链接和图片，完成后会自动停止'
      : settled ? '日程已经更新，后续新消息需要手动再次同步' : '读取最近三天的关注群消息，并整理成日程';
  const empty = bucket === 'pending' ? '没有待整理的消息' : bucket === 'running' ? '当前没有正在整理的消息' : '还没有整理完成的消息';

  return <dialog ref={dialog} className={s.dialog} onClose={onClose} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <header className={s.header}>
      <div><span>同步详情</span><h2>{title}</h2><p>{description}</p></div>
      <button className={common.iconButton} aria-label="关闭同步详情" title="关闭同步详情" onClick={onClose}><X size={19} /></button>
    </header>

    <section className={s.overview} aria-label="同步进度">
      <div className={s.progressHeading}><strong>{percent}%</strong><span>{doneJobs} / {totalJobs || '–'} 个日期批次</span></div>
      <div className={s.progressTrack} role="progressbar" aria-label="同步进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ transform: `scaleX(${percent / 100})` }} /></div>
      <ol className={s.stages} aria-label="同步阶段">
        <li data-state={reading ? 'active' : organizing || settled ? 'done' : 'idle'}><span>{reading ? <LoaderCircle size={12} className={common.spin} /> : organizing || settled ? <Check size={12} /> : '1'}</span>读取消息</li>
        <li data-state={organizing ? 'active' : settled ? 'done' : 'idle'}><span>{organizing ? <LoaderCircle size={12} className={common.spin} /> : settled ? <Check size={12} /> : '2'}</span>AI 整理</li>
        <li data-state={settled ? 'done' : 'idle'}><span>{settled ? <Check size={12} /> : '3'}</span>完成</li>
      </ol>
      <dl className={s.metrics}>
        <div><dt>关注群聊</dt><dd>{groups}</dd></div>
        <div><dt>待整理消息</dt><dd>{details.counts.pending}</dd></div>
        <div><dt>正在整理</dt><dd>{details.counts.running}</dd></div>
        <div><dt>已完成消息</dt><dd>{details.counts.completed}</dd></div>
      </dl>
    </section>

    {outdated && <div className={s.notice}><RefreshCw size={15} /><span>处理引擎已更新，请重启应用后再同步。</span></div>}
    {(error || detailsError || status.blockedReason) && <div className={s.notice} role="alert"><AlertCircle size={15} /><span>{error || detailsError || status.blockedReason}</span>{status.blockedReason && <button className={common.textButton} onClick={onModels}>模型配置</button>}</div>}
    {hasIssues && !organizing && <div className={s.notice}><AlertCircle size={15} /><span>{status.partial + status.failed} 个日期批次需要重试或核对</span><button className={common.textButton} disabled={busy} onClick={onRetry}><RefreshCw size={14} />重试</button></div>}

    <nav className={s.tabs} aria-label="消息整理状态">
      {tabs.map(tab => <button key={tab.bucket} aria-current={bucket === tab.bucket ? 'page' : undefined} onClick={() => setBucket(tab.bucket)}>
        {tab.label}<span>{details.counts[tab.bucket]}</span>
      </button>)}
    </nav>
    <div className={s.messageList} role="region" aria-label={`${tabs.find(tab => tab.bucket === bucket)!.label}消息列表`} aria-busy={loading}>
      {details.items.length > 0 ? <ul>{details.items.map(item => <MessageItem key={item.key} item={item} onError={setDetailsError} />)}</ul>
        : <div className={s.empty}>{loading ? <LoaderCircle size={20} className={common.spin} /> : <CircleEllipsis size={22} />}<strong>{loading ? '正在读取消息' : empty}</strong></div>}
      {details.hasMore && <button className={`${common.secondaryButton} ${s.loadMore}`} disabled={loading} onClick={() => void load(true)}>加载更多</button>}
    </div>

    <footer className={s.footer}>
      <p><strong>同步会产生 API 费用，请留意账户额度。</strong><span>每次完成后自动停止。</span></p>
      {reading || organizing ? <button className={s.stopButton} disabled={busy && !reading} onClick={onStop}><Square size={14} />停止同步</button>
        : <button className={common.primaryButton} disabled={!canStart || busy} onClick={onStart}><CloudDownload size={15} />{settled ? '再次同步' : '开始同步'}</button>}
    </footer>
  </dialog>;
}
