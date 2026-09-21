import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Check, CheckCheck, ChevronDown, CircleHelp, ExternalLink, FolderOpen, Link2, LoaderCircle, Monitor, Plug, QrCode, RefreshCw, ShieldCheck, Square } from 'lucide-react';
import QRCode from 'qrcode';
import type { Account, AppState, ConnectionConfig, QQInstallation } from '../shared';
import { bridge, isDesktop } from '../bridge';
import { BRAND } from '../brand';
import common from '../App.module.css';
import s from './QQConnectionSettings.module.css';

const accountName = (account: Account) => account.nickname.trim() || 'QQ 用户';
const time = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

function IconButton({ label, children, onClick, disabled = false }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className={common.iconButton}>{children}</button>;
}
function Avatar({ account }: { account: Account }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [account.id]);
  return <span className={s.avatar} aria-hidden="true">{!failed ? <img src={`https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(account.id)}&s=100`} alt="" width={76} height={76} onError={() => setFailed(true)} /> : Array.from(accountName(account))[0]}</span>;
}

export function QQConnectionSettings({ state, run, onMessages }: { state: AppState; run: (action: () => Promise<unknown>) => Promise<void>; onMessages: () => void }) {
  const [mode, setMode] = useState<'managed' | 'external'>('managed');
  const [checking, setChecking] = useState(false);
  const [detected, setDetected] = useState(false);
  const [config, setConfig] = useState<ConnectionConfig>({ wsUrl: 'ws://127.0.0.1:3001', accessToken: '', webuiUrl: '', webuiToken: '' });
  const [loginManagement, setLoginManagement] = useState(false);
  const [qrImage, setQRImage] = useState('');
  const busy = ['preparing', 'starting', 'connecting'].includes(state.phase);
  const active = !['idle', 'error'].includes(state.phase);
  const online = state.phase === 'online';

  useEffect(() => { if (state.runtime) setMode(state.runtime); }, [state.runtime]);
  useEffect(() => { void bridge.savedConnection().then(saved => { setConfig(current => ({ ...current, ...saved })); setLoginManagement(Boolean(saved.webuiUrl)); }); }, []);
  useEffect(() => {
    let cancelled = false;
    setQRImage('');
    if (state.qr) void QRCode.toDataURL(state.qr, { margin: 2, width: 256, errorCorrectionLevel: 'M' }).then(image => { if (!cancelled) setQRImage(image); });
    return () => { cancelled = true; };
  }, [state.qr]);
  const detect = async () => {
    setChecking(true);
    try { await bridge.request({ type: 'detect' }); setDetected(true); }
    finally { setChecking(false); }
  };
  useEffect(() => { if (isDesktop) void run(detect); }, []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(() => mode === 'managed' ? bridge.request({ type: 'start', path: state.qq!.path }) : bridge.request({ type: 'connect', config: { ...config, webuiUrl: loginManagement ? config.webuiUrl : '', webuiToken: loginManagement ? config.webuiToken : '' } }));
  };

  return <section className={s.root} aria-label="QQ 连接设置">
    <div className={s.layout}>
      <form className={s.form} onSubmit={submit}>
        <div className={s.segmented} role="group" aria-label="连接方式">
          <button type="button" className={mode === 'managed' ? s.segmentActive : ''} onClick={() => setMode('managed')} disabled={active}><Monitor size={17} /> 本机 QQ</button>
          <button type="button" className={mode === 'external' ? s.segmentActive : ''} onClick={() => setMode('external')} disabled={active}><Link2 size={17} /> 已有 NapCat</button>
        </div>
        {mode === 'managed' ? <div className={s.localSetup}>
          <div className={s.sectionHeading}><h3>QQ 客户端</h3><IconButton label="重新检测 QQ" disabled={checking || active} onClick={() => void run(detect)}><RefreshCw size={16} className={checking ? s.spin : ''} /></IconButton></div>
          <div className={s.installation}><span className={s.installIcon}><Monitor size={26} /></span><div><strong>{state.qq ? '已找到官方 QQ' : checking ? '正在检测' : '未检测到 QQ'}</strong><p>{state.qq ? state.qq.version : '安装官方 QQ 后可继续连接'}</p></div>{state.qq && <CheckCheck className={s.green} size={20} />}</div>
          {state.qq && <div className={s.path}>{state.qq.path}</div>}
          <div className={s.fileActions}>
            <button type="button" className={common.secondaryButton} disabled={active} onClick={() => void run(async () => { const path = await bridge.chooseQQ(); if (path) { await bridge.request<QQInstallation>({ type: 'detect', path }); setDetected(true); } })}><FolderOpen size={16} />选择已安装 QQ</button>
            {!state.qq && <button type="button" className={common.textButton} onClick={() => void run(() => bridge.openExternal('https://im.qq.com/'))}>下载官方 QQ <ExternalLink size={14} /></button>}
          </div>
          <dl className={s.facts}><div><dt>内置组件</dt><dd>NapCat <span>4.18.28</span></dd></div><div><dt>运行方式</dt><dd>独立采集进程</dd></div><div><dt>消息归档</dt><dd>本应用独立保存</dd></div></dl>
          {detected && !state.qq && <p className={s.note}>尚未找到 QQ 安装。安装完成后重新检测。</p>}
        </div> : <div className={s.externalSetup}>
          <label>消息服务地址<input value={config.wsUrl} onChange={event => setConfig({ ...config, wsUrl: event.target.value })} required placeholder="ws://127.0.0.1:3001" disabled={active} autoComplete="off" /></label>
          <label>访问令牌<input value={config.accessToken} onChange={event => setConfig({ ...config, accessToken: event.target.value })} type="password" placeholder="OneBot Access Token" disabled={active} autoComplete="off" /></label>
          <label className={s.checkbox}><input type="checkbox" checked={loginManagement} onChange={event => { setLoginManagement(event.target.checked); if (!config.webuiUrl) setConfig({ ...config, webuiUrl: 'http://127.0.0.1:6099' }); }} disabled={active} />启用扫码登录管理</label>
          {loginManagement && <div className={s.management}><label>登录管理地址<input value={config.webuiUrl} onChange={event => setConfig({ ...config, webuiUrl: event.target.value })} required placeholder="http://127.0.0.1:6099" disabled={active} /></label><label>登录管理令牌<input value={config.webuiToken} type="password" onChange={event => setConfig({ ...config, webuiToken: event.target.value })} placeholder="NapCat WebUI Token" disabled={active} autoComplete="off" /></label></div>}
        </div>}
        {state.error && <div className={s.error} role="alert"><CircleHelp size={18} /><span>{state.error}</span></div>}
        <div className={s.actions}>
          {active ? <button type="button" className={common.secondaryButton} disabled={state.phase === 'stopping'} onClick={() => void run(() => bridge.request({ type: 'disconnect' }))}><Square size={15} />{state.phase === 'stopping' ? '正在停止' : '停止连接'}</button> : <button type="submit" className={common.primaryButton} disabled={busy || (mode === 'managed' && !state.qq)}><Plug size={17} />{state.phase === 'error' ? '重新连接' : '连接 QQ'}<ArrowRight size={16} /></button>}
          {online && <button type="button" className={common.primaryButton} onClick={onMessages}>查看群聊 <ArrowRight size={16} /></button>}
        </div>
      </form>
      <div className={s.authorization}>
        <div className={s.authHeading}><span>{online ? <Check size={16} /> : '02'}</span><h3>{online ? '账号已连接' : 'QQ 登录确认'}</h3></div>
        {online && state.account ? <div className={s.account}><Avatar account={state.account} /><h3>{accountName(state.account)}</h3><p>{state.account.id}</p><span><ShieldCheck size={16} /> 登录成功</span><div><span><strong>{state.groups.length}</strong>群聊</span><span><strong>{state.groups.filter(group => group.followed).length}</strong>已关注</span></div></div> : <>
          <div className={`${s.qrFrame} ${qrImage ? s.qrReady : ''}`}>{qrImage ? <img src={qrImage} width={224} height={224} alt="QQ 登录二维码" /> : <div>{busy ? <LoaderCircle size={36} className={s.spin} /> : <QrCode size={54} />}<span>{busy ? '正在准备登录' : '等待连接'}</span></div>}</div>
          <h3>{state.phase === 'qr' ? '使用手机 QQ 扫码确认' : busy ? state.detail : '等待生成登录二维码'}</h3>
          {state.phase === 'qr' && <button type="button" className={common.textButton} onClick={() => void run(() => bridge.request({ type: 'refreshQR' }))}><RefreshCw size={15} />刷新二维码</button>}
          <span className={s.footnote}><ShieldCheck size={14} />无需在{BRAND.name}中输入 QQ 密码</span>
        </>}
      </div>
    </div>
    {state.logs.length > 0 && <details className={s.logs}><summary>连接活动 <ChevronDown size={14} /></summary><ol>{state.logs.slice(-12).reverse().map((log, index) => <li key={`${log.time}-${index}`}><time>{time(log.time)}</time><span>{log.text}</span></li>)}</ol></details>}
  </section>;
}
