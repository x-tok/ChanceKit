import { useEffect, useState } from 'react';
import { ArrowRight, Check, CheckCircle2, Download, FolderOpen, LogIn, LogOut, Monitor, RefreshCw } from 'lucide-react';
import type { AppState, QQInstallation } from '../shared';
import { bridge, isDesktop } from '../bridge';
import { onboardingError } from './errors';
import s from './Onboarding.module.css';

export function QQSetupStep({ state, onNext, onError }: { state: AppState; onNext: () => void; onError: (message: string) => void }) {
  const [checking, setChecking] = useState(false);
  const [officialReady, setOfficialReady] = useState(false);
  const [exitReady, setExitReady] = useState(false);
  const isMac = bridge.platform === 'darwin';

  const run = async (action: () => Promise<unknown>) => {
    onError('');
    try { await action(); }
    catch (error) { onError(onboardingError(error)); }
  };
  const detect = async () => {
    if (!isDesktop) return;
    setChecking(true);
    try { await bridge.request({ type: 'detect' }); }
    finally { setChecking(false); }
  };
  useEffect(() => { void run(detect); }, []);

  return <div className={s.stage}>
    <div className={s.stageIntro}><span className={s.eyebrow}>第 1 步，共 3 步</span><h1>先准备好官方 QQ</h1><p>见机会读取你选择的群聊消息。请先在官方 QQ <strong>登录并等待最近消息同步完成</strong>。</p></div>
    <div className={s.statusRow}>
      <span className={s.statusIcon}><Monitor size={25} /></span>
      <div><strong>{checking ? '正在检查 QQ' : state.qq ? '已找到官方 QQ' : '未检测到官方 QQ'}</strong><p>{state.qq ? `${state.qq.version} · ${isMac ? 'macOS' : 'Windows'}` : isMac ? '可从 Mac App Store 安装' : '可从 QQ 官方网站安装'}</p></div>
      {state.qq && <CheckCircle2 className={s.success} size={21} />}
    </div>
    {state.qq && <p className={s.path}>{state.qq.path}</p>}
    <div className={s.actionsLeft}>
      {!state.qq && <button className={s.primaryButton} disabled={!isDesktop} onClick={() => void run(async () => { await bridge.openQQDownload?.(); })}><Download size={17} />{isMac ? '在 App Store 打开' : '前往 QQ 官网'}</button>}
      <button className={s.secondaryButton} disabled={checking || !isDesktop} onClick={() => void run(detect)}><RefreshCw size={16} className={checking ? s.spin : ''} />重新检测</button>
      <button className={s.textButton} disabled={!isDesktop} onClick={() => void run(async () => { const path = await bridge.chooseQQ(); if (path) await bridge.request<QQInstallation>({ type: 'detect', path }); })}><FolderOpen size={16} />选择安装位置</button>
    </div>
    {state.qq && <ol className={s.qqSequence} aria-label="QQ 准备顺序">
      <li className={officialReady ? s.taskComplete : s.taskCurrent}>
        <span className={s.taskMarker}>{officialReady ? <Check size={15} /> : <LogIn size={16} />}</span>
        <div><strong>登录官方 QQ，同步最近消息</strong><p>打开官方 QQ，确认会话列表和最近的云端消息已显示。</p><label><input type="checkbox" checked={officialReady} onChange={event => { setOfficialReady(event.target.checked); if (!event.target.checked) setExitReady(false); }} />我已完成登录与消息同步</label></div>
      </li>
      {isMac && <li className={exitReady ? s.taskComplete : officialReady ? s.taskCurrent : s.taskPending} aria-disabled={!officialReady}>
        <span className={s.taskMarker}>{exitReady ? <Check size={15} /> : <LogOut size={16} />}</span>
        <div><strong>再正常退出官方 QQ</strong><p>见机随后会准备约 1 GB 的独立 QQ 副本，不改动原应用与聊天库。</p><label><input type="checkbox" checked={exitReady} disabled={!officialReady} onChange={event => setExitReady(event.target.checked)} />我已正常退出官方 QQ</label></div>
      </li>}
    </ol>}
    {!isDesktop && <p className={s.previewNote}>浏览器仅用于预览，桌面客户端会执行 QQ 检测和安装引导。</p>}
    <div className={`${s.stageFooter} ${s.stageFooterSolo}`}><button className={s.primaryButton} disabled={!state.qq || !officialReady || (isMac && !exitReady)} onClick={onNext}>继续设置 AI 服务 <ArrowRight size={17} /></button></div>
  </div>;
}
