import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CircleAlert, LoaderCircle, QrCode, RefreshCw, Sparkles } from 'lucide-react';
import QRCode from 'qrcode';
import type { AppState } from '../shared';
import { bridge, isDesktop } from '../bridge';
import { onboardingError } from './errors';
import { initialSyncWindow, runInitialSync, type InitialSyncProgress } from './initial-sync';
import { GroupPicker } from './GroupPicker';
import { QQAccountIdentity } from './QQAccountIdentity';
import s from './Onboarding.module.css';

export function GroupSyncStep({ state, onBack, onComplete, onError }: { state: AppState; onBack: () => void; onComplete: () => void; onError: (message: string) => void }) {
  const [qrImage, setQRImage] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<InitialSyncProgress>();
  const initializedAccount = useRef('');
  const cutoff = useMemo(initialSyncWindow, []);
  const cutoffLabel = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' }).format(new Date(cutoff.since * 1000));
  const online = state.phase === 'online' && Boolean(state.account);
  const connectionBusy = ['preparing', 'starting', 'connecting', 'stopping'].includes(state.phase);

  useEffect(() => {
    let cancelled = false;
    setQRImage('');
    if (state.qr) void QRCode.toDataURL(state.qr, { margin: 2, width: 256, errorCorrectionLevel: 'M' })
      .then(image => { if (!cancelled) setQRImage(image); });
    return () => { cancelled = true; };
  }, [state.qr]);
  useEffect(() => {
    const accountId = state.account?.id ?? '';
    if (!accountId || initializedAccount.current === accountId) return;
    initializedAccount.current = accountId;
    setSelected(new Set(state.groups.filter(group => group.followed).map(group => group.id)));
  }, [state.account?.id, state.groups]);

  const run = async (action: () => Promise<void>) => {
    onError('');
    try { await action(); }
    catch (error) { onError(onboardingError(error)); }
  };
  const toggle = (id: string) => setSelected(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const sync = async () => {
    setSyncing(true);
    setProgress({ current: 0, total: selected.size, group: '', added: 0 });
    await run(async () => {
      await runInitialSync(state, selected, cutoff.since, bridge, setProgress);
      onComplete();
    });
    setSyncing(false);
  };
  return <div className={`${s.stage} ${s.groupStage}`}>
    <button className={s.backButton} disabled={syncing} onClick={onBack}><ArrowLeft size={16} />返回</button>
    <div className={s.stageIntro}><span className={s.eyebrow}>第 3 步，共 3 步</span><h1>{online ? '选择需要整理的群聊' : '登录用于同步的 QQ'}</h1><p>{online ? `首次同步会读取 ${cutoffLabel} 至今的消息，完成后自动停止连接。` : '使用手机 QQ 扫码确认。登录成功后即可选择群聊。'}</p></div>
    {!online ? <div className={s.loginArea}>
      <div className={`${s.qrFrame} ${qrImage ? s.qrReady : ''}`}>{qrImage ? <img src={qrImage} width={224} height={224} alt="QQ 登录二维码" /> : <div><QrCode size={54} /><span>{connectionBusy ? state.detail : '准备后显示二维码'}</span></div>}</div>
      <div className={s.loginActions}>
        {state.phase === 'qr' ? <button className={s.secondaryButton} onClick={() => void run(async () => { await bridge.request({ type: 'refreshQR' }); })}><RefreshCw size={16} />刷新二维码</button>
          : <button className={s.primaryButton} disabled={connectionBusy || !state.qq || !isDesktop} onClick={() => void run(async () => { await bridge.request({ type: 'start', path: state.qq!.path }); })}>{connectionBusy ? <LoaderCircle className={s.spin} size={17} /> : <QrCode size={17} />}{state.phase === 'error' ? '重新准备登录' : '开始 QQ 登录'}</button>}
      </div>
    </div> : <>
      <div className={s.accountLine}>{state.account && <QQAccountIdentity account={state.account} />}<span className={s.accountSelection}>{selected.size} 个已选择</span></div>
      <GroupPicker groups={state.groups} selected={selected} disabled={syncing} onToggle={toggle} />
      {progress && <div className={s.progress} role="status"><span><LoaderCircle className={syncing ? s.spin : ''} size={17} /></span><div><strong>{syncing ? `正在同步 ${progress.current} / ${progress.total}` : '同步已停止'}</strong><p>{progress.group} · 已新增 {progress.added.toLocaleString()} 条</p></div></div>}
      <div className={s.stageFooter}><span className={s.billingNotice}><CircleAlert size={15} />同步后会开始 AI 整理并产生 API 费用，请留意账户额度。</span><button className={s.primaryButton} disabled={syncing || selected.size === 0} onClick={() => void sync()}>{syncing ? <LoaderCircle className={s.spin} size={17} /> : <Sparkles size={17} />}{syncing ? '正在同步并整理' : `同步 ${selected.size} 个群聊并开始整理`}</button></div>
    </>}
  </div>;
}
