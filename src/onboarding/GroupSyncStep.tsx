import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, LoaderCircle, QrCode, RefreshCw } from 'lucide-react';
import QRCode from 'qrcode';
import type { AppState } from '../shared';
import { bridge, isDesktop } from '../bridge';
import { onboardingError } from './errors';
import { saveGroupSelection } from './initial-sync';
import { GroupPicker } from './GroupPicker';
import { QQAccountIdentity } from './QQAccountIdentity';
import s from './Onboarding.module.css';

export function GroupSyncStep({ state, onBack, onComplete, onError }: { state: AppState; onBack: () => void; onComplete: () => void; onError: (message: string) => void }) {
  const [qrImage, setQRImage] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const initializedAccount = useRef('');
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
  const finish = async () => {
    setSaving(true);
    await run(async () => {
      await saveGroupSelection(state, selected, bridge);
      onComplete();
    });
    setSaving(false);
  };
  return <div className={`${s.stage} ${s.groupStage}`}>
    <button className={s.backButton} disabled={saving} onClick={onBack}><ArrowLeft size={16} />返回</button>
    <div className={s.stageIntro}><span className={s.eyebrow}>第 3 步，共 3 步</span><h1>{online ? '选择你想关注的群聊' : '登录用于同步的 QQ'}</h1><p>{online ? '这些群聊会成为日程的信息来源。进入主页面后，再由你手动开始首次同步。' : '使用手机 QQ 扫码确认。登录成功后即可选择群聊。'}</p></div>
    {!online ? <div className={s.loginArea}>
      <div className={`${s.qrFrame} ${qrImage ? s.qrReady : ''}`}>{qrImage ? <img src={qrImage} width={224} height={224} alt="QQ 登录二维码" /> : <div><QrCode size={54} /><span>{connectionBusy ? state.detail : '准备后显示二维码'}</span></div>}</div>
      <div className={s.loginActions}>
        {state.phase === 'qr' ? <button className={s.secondaryButton} onClick={() => void run(async () => { await bridge.request({ type: 'refreshQR' }); })}><RefreshCw size={16} />刷新二维码</button>
          : <button className={s.primaryButton} disabled={connectionBusy || !state.qq || !isDesktop} onClick={() => void run(async () => { await bridge.request({ type: 'start', path: state.qq!.path }); })}>{connectionBusy ? <LoaderCircle className={s.spin} size={17} /> : <QrCode size={17} />}{state.phase === 'error' ? '重新准备登录' : '开始 QQ 登录'}</button>}
      </div>
    </div> : <>
      <div className={s.accountLine}>{state.account && <QQAccountIdentity account={state.account} />}<span className={s.accountSelection}>{selected.size} 个已选择</span></div>
      <GroupPicker groups={state.groups} selected={selected} disabled={saving} onToggle={toggle} />
      <div className={s.stageFooter}><span>稍后将在日程页面确认同步范围和 API 费用。</span><button className={s.primaryButton} disabled={saving || selected.size === 0} onClick={() => void finish()}>{saving ? <LoaderCircle className={s.spin} size={17} /> : <ArrowRight size={17} />}{saving ? '正在保存' : `关注 ${selected.size} 个群聊并进入日程`}</button></div>
    </>}
  </div>;
}
