import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, Check, CheckCheck, ChevronDown, ChevronUp, CircleHelp, Download, ExternalLink, FileText, FolderOpen, Hash, ImageOff, Link2, LoaderCircle, MessageCircle, Monitor, Plug, QrCode, RefreshCw, Search, ShieldCheck, Square, Star, Unplug, Users, Wifi, X } from 'lucide-react';
import QRCode from 'qrcode';
import type { Account, AppState, ConnectionConfig, Group, HistoryResult, Message, MessagePage, QQInstallation, Segment } from './shared';
import { bridge, isDesktop } from './bridge';
import { BRAND } from './brand';
import s from './App.module.css';

const initialState: AppState = { phase: 'idle', detail: '尚未连接 QQ', runtime: null, groups: [], archived: 0, historyBusy: false, logs: [] };
const phases = { idle: '未连接', preparing: '准备中', starting: '启动中', qr: '待扫码', connecting: '连接中', online: '已连接', reconnecting: '重连中', stopping: '停止中', error: '连接异常' };
const accountName = (account: Account) => account.nickname.trim() || 'QQ 用户';
const number = new Intl.NumberFormat('zh-CN');
const time = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const date = (value: number) => new Date(value).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
const messageError = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试。').replace(/^Error invoking remote method '[^']+': Error: /, '');

function IconButton({ label, children, onClick, disabled = false, className = '' }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean; className?: string }) {
  return <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className={`${s.iconButton} ${className}`}>{children}</button>;
}
function Avatar({ name, id, size = 'normal' }: { name: string; id?: string; size?: 'normal' | 'large' }) {
  const [failedId, setFailedId] = useState<string>();
  useEffect(() => { setFailedId(undefined); }, [id]);
  return <span className={`${s.avatar} ${size === 'large' ? s.largeAvatar : ''}`} aria-hidden="true">
    {id && failedId !== id ? <img key={id} src={`https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(id)}&s=100`} alt="" width={48} height={48} onError={() => setFailedId(id)} /> : Array.from(name.trim() || 'Q')[0]}
  </span>;
}

export function App() {
  const [state, setState] = useState<AppState>(initialState);
  const [view, setView] = useState<'connect' | 'messages'>('connect');
  const [selected, setSelected] = useState('');
  const [toast, setToast] = useState('');
  const [messageRevision, setMessageRevision] = useState(0);
  const previousAccount = useRef('');
  const online = state.phase === 'online';
  const account = online ? state.account : undefined;
  const notify = useCallback((text: string) => setToast(text), []);
  const run = useCallback(async (action: () => Promise<unknown>) => { try { await action(); } catch (error) { notify(messageError(error)); } }, [notify]);
  useEffect(() => {
    if (isDesktop) void bridge.request<AppState>({ type: 'state' }).then(setState).catch(error => notify(messageError(error)));
    return bridge.subscribe(event => {
      if (event.type === 'state') setState(event.state);
      else setMessageRevision(value => value + 1);
    });
  }, [notify]);
  useEffect(() => {
    const id = state.localAccount?.id || '';
    if (previousAccount.current !== id) { previousAccount.current = id; setSelected(''); }
  }, [state.localAccount?.id]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 8000); return () => clearTimeout(timer); }, [toast]);
  const selectedGroup = state.groups.find(group => group.id === selected);
  return <div className={s.app}>
    <a className={s.skipLink} href="#main-content">跳到主要内容</a>
    <aside className={s.navigation}>
      <div className={s.brandBlock}>
        <div className={s.brand}><span className={s.brandMark}><MessageCircle size={24} strokeWidth={1.8} /></span><span>{BRAND.name}<small>{BRAND.englishName}</small></span></div>
        <p className={s.brandSubtitle}>{BRAND.subtitle}</p>
      </div>
      <nav aria-label="主导航">
        <button className={view === 'messages' ? s.navActive : ''} onClick={() => setView('messages')}><MessageCircle size={18} /><span>群消息</span>{state.groups.filter(g => g.followed).length > 0 && <small>{state.groups.filter(g => g.followed).length}</small>}</button>
        <button className={view === 'connect' ? s.navActive : ''} onClick={() => setView('connect')}><Plug size={18} /><span>连接 QQ</span></button>
      </nav>
      <div className={s.navBottom}>
        <span className={s.localLabel}><ShieldCheck size={15} /> 本地消息库</span>
        <div className={s.navAccount}><Avatar key={account?.id || 'offline'} name={account ? accountName(account) : 'Q'} id={account?.id} /><span>{account ? accountName(account) : '未登录账号'}<small>{account?.id || 'QQ'}</small></span></div>
      </div>
    </aside>
    <main id="main-content" className={s.main}>
      <header className={s.topbar}>
        <div className={s.breadcrumb}>工作空间 <span>/</span> <strong>{view === 'connect' ? '连接 QQ' : '群消息'}</strong></div>
        <div className={s.topbarRight}>{!isDesktop && <span className={s.previewBadge}>浏览器预览</span>}<span className={`${s.connectionStatus} ${online ? s.connected : ''}`}><span />{phases[state.phase]}</span></div>
      </header>
      {view === 'connect' ? <Connection state={state} run={run} onMessages={() => setView('messages')} />
        : <Workspace key={state.localAccount?.id || 'empty'} state={state} group={selectedGroup} select={setSelected} revision={messageRevision} run={run} notify={notify} onConnect={() => setView('connect')} />}
      <footer className={s.statusbar}><span><span className={`${s.statusDot} ${online ? s.liveDot : ''}`} />{state.detail}</span><span>{number.format(state.archived)} 条已归档{state.lastEventAt && ` · 最近消息 ${time(state.lastEventAt)}`}</span></footer>
    </main>
    {toast && <div className={s.toast} role="alert"><span>{toast}</span><IconButton label="关闭提示" onClick={() => setToast('')}><X size={16} /></IconButton></div>}
  </div>;
}

function Connection({ state, run, onMessages }: { state: AppState; run: (action: () => Promise<unknown>) => Promise<void>; onMessages: () => void }) {
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
  useEffect(() => { void bridge.savedConnection().then(saved => { setConfig(c => ({ ...c, ...saved })); setLoginManagement(Boolean(saved.webuiUrl)); }); }, []);
  useEffect(() => {
    let canceled = false;
    setQRImage('');
    if (state.qr) void QRCode.toDataURL(state.qr, { margin: 2, width: 256, errorCorrectionLevel: 'M' }).then(image => { if (!canceled) setQRImage(image); });
    return () => { canceled = true; };
  }, [state.qr]);
  const detect = async () => {
    setChecking(true);
    try { await bridge.request({ type: 'detect' }); setDetected(true); } finally { setChecking(false); }
  };
  useEffect(() => { if (isDesktop) void run(detect); }, []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(() => mode === 'managed' ? bridge.request({ type: 'start', path: state.qq!.path }) : bridge.request({ type: 'connect', config: { ...config, webuiUrl: loginManagement ? config.webuiUrl : '', webuiToken: loginManagement ? config.webuiToken : '' } }));
  };
  return <section className={s.connectionPage}>
    <div className={s.pageHeading}><span className={s.eyebrow}>账号与连接</span><h1>连接你的 QQ</h1></div>
    <div className={s.connectionLayout}>
      <form className={s.connectionForm} onSubmit={submit}>
        <div className={s.segmented} role="group" aria-label="连接方式">
          <button type="button" className={mode === 'managed' ? s.segmentActive : ''} onClick={() => setMode('managed')} disabled={active}><Monitor size={17} /> 本机 QQ</button>
          <button type="button" className={mode === 'external' ? s.segmentActive : ''} onClick={() => setMode('external')} disabled={active}><Link2 size={17} /> 已有 NapCat</button>
        </div>
        {mode === 'managed' ? <div className={s.localSetup}>
          <div className={s.sectionHeading}><h2>QQ 客户端</h2><IconButton label="重新检测 QQ" disabled={checking || active} onClick={() => void run(detect)}><RefreshCw size={16} className={checking ? s.spin : ''} /></IconButton></div>
          <div className={s.installation}>
            <span className={s.installIcon}><Monitor size={26} strokeWidth={1.5} /></span>
            <div><strong>{state.qq ? '已找到官方 QQ' : checking ? '正在检测' : '未检测到 QQ'}</strong><p>{state.qq ? state.qq.version : '安装官方 QQ 后可继续连接'}</p></div>
            {state.qq && <CheckCheck className={s.green} size={20} />}
          </div>
          {state.qq && <div className={s.pathLabel}>{state.qq.path}</div>}
          <div className={s.fileActions}>
            <button type="button" className={s.secondaryButton} disabled={active} onClick={() => void run(async () => { const path = await bridge.chooseQQ(); if (path) { await bridge.request<QQInstallation>({ type: 'detect', path }); setDetected(true); } })}><FolderOpen size={16} />选择已安装 QQ</button>
            {!state.qq && <button type="button" className={s.textButton} onClick={() => void run(() => bridge.openExternal('https://im.qq.com/'))}>下载官方 QQ <ExternalLink size={14} /></button>}
          </div>
          <dl className={s.environmentFacts}><div><dt>内置组件</dt><dd>NapCat <span>4.18.28</span></dd></div><div><dt>运行方式</dt><dd>独立采集进程</dd></div><div><dt>消息归档</dt><dd>本应用独立保存</dd></div></dl>
          {detected && !state.qq && <p className={s.inlineNote}>尚未找到 QQ 安装。安装完成后重新检测。</p>}
        </div> : <div className={s.externalSetup}>
          <label>消息服务地址<input value={config.wsUrl} onChange={e => setConfig({ ...config, wsUrl: e.target.value })} required placeholder="ws://127.0.0.1:3001" disabled={active} autoComplete="off" /></label>
          <label>访问令牌<input value={config.accessToken} onChange={e => setConfig({ ...config, accessToken: e.target.value })} type="password" placeholder="OneBot Access Token" disabled={active} autoComplete="off" /></label>
          <label className={s.checkboxLabel}><input type="checkbox" checked={loginManagement} onChange={e => { setLoginManagement(e.target.checked); if (!config.webuiUrl) setConfig({ ...config, webuiUrl: 'http://127.0.0.1:6099' }); }} disabled={active} />启用扫码登录管理</label>
          {loginManagement && <div className={s.managementFields}><label>登录管理地址<input value={config.webuiUrl} onChange={e => setConfig({ ...config, webuiUrl: e.target.value })} required placeholder="http://127.0.0.1:6099" disabled={active} /></label><label>登录管理令牌<input value={config.webuiToken} type="password" onChange={e => setConfig({ ...config, webuiToken: e.target.value })} placeholder="NapCat WebUI Token" disabled={active} autoComplete="off" /></label></div>}
        </div>}
        {state.error && <div className={s.errorBox} role="alert"><CircleHelp size={18} /><span>{state.error}</span></div>}
        <div className={s.connectActions}>
          {active ? <button type="button" className={s.secondaryButton} disabled={state.phase === 'stopping'} onClick={() => void run(() => bridge.request({ type: 'disconnect' }))}><Square size={15} />{state.phase === 'stopping' ? '正在停止' : '停止连接'}</button> : <button type="submit" className={s.primaryButton} disabled={busy || (mode === 'managed' && !state.qq)}><Plug size={17} />{state.phase === 'error' ? '重新连接' : '连接 QQ'}<ArrowRight size={16} /></button>}
          {online && <button type="button" className={s.primaryButton} onClick={onMessages}>查看群聊 <ArrowRight size={16} /></button>}
        </div>
      </form>
      <div className={s.authorization}>
        <div className={s.authHeading}><span className={s.stepNumber}>{online ? <Check size={16} /> : '02'}</span><h2>{online ? '账号已连接' : 'QQ 登录确认'}</h2></div>
        {online && state.account ? <div className={s.accountSuccess}><Avatar key={state.account.id} name={accountName(state.account)} id={state.account.id} size="large" /><h3>{accountName(state.account)}</h3><p>{state.account.id}</p><span className={s.successLabel}><ShieldCheck size={16} /> 登录成功</span><div className={s.accountNumbers}><span><strong>{state.groups.length}</strong>群聊</span><span><strong>{state.groups.filter(g => g.followed).length}</strong>已关注</span></div></div> : <>
          <div className={`${s.qrFrame} ${qrImage ? s.qrReady : ''}`}>
            {qrImage ? <img src={qrImage} width={224} height={224} alt="QQ 登录二维码" /> : <div className={s.qrPlaceholder}>{busy ? <LoaderCircle size={36} className={s.spin} /> : <QrCode size={54} strokeWidth={1} />}<span>{busy ? '正在准备登录' : '等待连接'}</span></div>}
          </div>
          <h3>{state.phase === 'qr' ? '使用手机 QQ 扫码确认' : busy ? state.detail : '等待生成登录二维码'}</h3>
          {state.phase === 'qr' && <button type="button" className={s.textButton} onClick={() => void run(() => bridge.request({ type: 'refreshQR' }))}><RefreshCw size={15} />刷新二维码</button>}
          <span className={s.authFootnote}><ShieldCheck size={14} />无需在{BRAND.name}中输入 QQ 密码</span>
        </>}
      </div>
    </div>
    {state.logs.length > 0 && <details className={s.logs}><summary>连接活动 <ChevronDown size={14} /></summary><ol>{state.logs.slice(-12).reverse().map((log, index) => <li key={`${log.time}-${index}`}><time>{time(log.time)}</time><span>{log.text}</span></li>)}</ol></details>}
  </section>;
}

function Workspace({ state, group, select, revision, run, notify, onConnect }: { state: AppState; group?: Group; select: (id: string) => void; revision: number; run: (action: () => Promise<unknown>) => Promise<void>; notify: (text: string) => void; onConnect: () => void }) {
  const [groupSearch, setGroupSearch] = useState('');
  const [onlyFollowed, setOnlyFollowed] = useState(false);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<MessagePage>({ messages: [], total: 0, hasMore: false });
  const [loading, setLoading] = useState(false);
  const [boundary, setBoundary] = useState<Record<string, string>>({});
  const [canOlder, setCanOlder] = useState<Record<string, boolean>>({});
  const [exporting, setExporting] = useState(false);
  const readGeneration = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const groupId = group?.id;
  const selectedId = useRef(groupId);
  selectedId.current = groupId;
  const online = state.phase === 'online';
  const groups = state.groups.filter(g => (!onlyFollowed || g.followed) && `${g.name} ${g.id}`.toLowerCase().includes(groupSearch.toLowerCase()));
  useEffect(() => { setSearch(''); setOffset(0); setPage({ messages: [], total: 0, hasMore: false }); }, [groupId]);
  useEffect(() => { if (!online) setCanOlder({}); }, [online]);
  useEffect(() => {
    const generation = ++readGeneration.current;
    if (!groupId) return;
    setLoading(true);
    const timer = setTimeout(() => {
      void bridge.request<MessagePage>({ type: 'messages', groupId, search, offset }).then(result => {
        if (generation !== readGeneration.current) return;
        const nearBottom = scroller.current && scroller.current.scrollHeight - scroller.current.scrollTop - scroller.current.clientHeight < 160;
        setPage(result);
        if (offset === 0 && !search && (nearBottom || revision === 0)) requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight }));
      }).catch(error => { if (generation === readGeneration.current) notify(messageError(error)); }).finally(() => { if (generation === readGeneration.current) setLoading(false); });
    }, search ? 180 : 0);
    return () => { clearTimeout(timer); readGeneration.current++; };
  }, [groupId, search, offset, revision, notify]);
  const loadHistory = async (older: boolean) => {
    if (!groupId) return;
    let result: HistoryResult;
    try { result = await bridge.request<HistoryResult>({ type: 'history', groupId, older }); }
    catch (error) {
      setBoundary(c => ({ ...c, [groupId]: `读取未完成：${messageError(error)}` }));
      throw error;
    }
    setCanOlder(c => ({ ...c, [groupId]: result.canContinue }));
    setBoundary(c => ({ ...c, [groupId]: result.canContinue ? `本次读取 ${result.received} 条，新增 ${result.added} 条` : result.boundary === 'empty' ? 'QQ 当前没有可获取的记录' : '暂时没有更早记录，历史范围尚未确认' }));
    if (selectedId.current !== groupId) return;
    setSearch('');
    const current = await bridge.request<MessagePage>({ type: 'messages', groupId, search: '', offset: 0 });
    if (selectedId.current !== groupId) return;
    setOffset(older ? Math.max(0, current.total - 100) : 0);
    if (!older) { setPage(current); requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight })); }
  };
  return <div className={`${s.workspace} ${group ? s.hasSelection : ''}`}>
    <section className={s.groupPanel} aria-label="群列表">
      <div className={s.groupPanelHeading}><h1>群聊 <span>{state.groups.length}</span></h1><IconButton label="刷新群列表" disabled={!online} onClick={() => void run(() => bridge.request({ type: 'refreshGroups' }))}><RefreshCw size={16} /></IconButton></div>
      <div className={s.searchBox}><Search size={16} /><input aria-label="搜索群聊" placeholder="搜索群名或群号" value={groupSearch} onChange={e => setGroupSearch(e.target.value)} /></div>
      <div className={s.groupTabs}><button className={!onlyFollowed ? s.tabActive : ''} onClick={() => setOnlyFollowed(false)}>全部群聊</button><button className={onlyFollowed ? s.tabActive : ''} onClick={() => setOnlyFollowed(true)}>已关注 <span>{state.groups.filter(g => g.followed).length}</span></button></div>
      <div className={s.groupList}>
        {groups.map(g => <button key={g.id} className={`${s.groupRow} ${g.id === groupId ? s.groupSelected : ''}`} onClick={() => select(g.id)} aria-pressed={g.id === groupId}>
          <span className={s.groupAvatar}><Users size={20} strokeWidth={1.5} /></span><span className={s.groupInfo}><strong>{g.name}</strong><small>{g.memberCount ? `${number.format(g.memberCount)} 人` : g.id}{g.followed && <Star size={11} fill="currentColor" />}</small></span>{g.messageCount > 0 && <span className={s.groupCount}>{number.format(g.messageCount)}</span>}
        </button>)}
        {groups.length === 0 && <div className={s.listEmpty}><Search size={22} /><p>{state.groups.length === 0 ? '暂无群聊' : onlyFollowed ? '暂无关注的群聊' : '没有匹配的群聊'}</p>{state.groups.length === 0 && <button className={s.textButton} onClick={onConnect}>连接 QQ <ArrowRight size={14} /></button>}</div>}
      </div>
      <div className={s.groupFooter}><span className={`${s.statusDot} ${online ? s.liveDot : ''}`} />{online ? '关注群消息实时归档' : '本地记录可离线查看'}</div>
    </section>
    <section className={s.reader} aria-label="消息记录">
      {group ? <>
        <header className={s.readerHeading}>
          <IconButton label="返回群列表" className={s.mobileBack} onClick={() => select('')}><ArrowLeft size={19} /></IconButton>
          <div className={s.readerTitle}><h2>{group.name}</h2><span><Hash size={12} />{group.id}<span>·</span>{number.format(page.total)} 条本地消息</span></div>
          <div className={s.readerActions}><button className={`${s.followButton} ${group.followed ? s.following : ''}`} onClick={() => void run(() => bridge.request({ type: 'follow', groupId: group.id, followed: !group.followed }))}><Star size={15} fill={group.followed ? 'currentColor' : 'none'} />{group.followed ? '已关注' : '关注'}</button><IconButton label="导出消息记录" disabled={exporting || page.total === 0} onClick={() => void run(async () => { setExporting(true); try { if (await bridge.exportMessages(group.id)) notify('消息记录已导出'); } finally { setExporting(false); } })}><Download size={17} /></IconButton></div>
        </header>
        <div className={s.readerToolbar}><div className={s.messageSearch}><Search size={15} /><input aria-label="搜索本地消息" placeholder="搜索本地消息" value={search} onChange={e => { setSearch(e.target.value); setOffset(0); }} />{search && <IconButton label="清除搜索" onClick={() => setSearch('')}><X size={14} /></IconButton>}</div><button className={s.textButton} disabled={!online || state.historyBusy} onClick={() => void run(() => loadHistory(false))}><RefreshCw size={14} className={state.historyBusy ? s.spin : ''} />获取最近消息</button></div>
        <div className={s.messages} ref={scroller}>
          {page.hasMore && <div className={s.historyControl}><button className={s.secondaryButton} disabled={loading} onClick={() => setOffset(value => value + 100)}><ChevronUp size={14} />更早已存消息</button></div>}
          {offset + page.messages.length >= page.total && online && <div className={s.historyControl}><button className={s.textButton} disabled={state.historyBusy || !canOlder[group.id]} onClick={() => void run(() => loadHistory(true))}><ChevronUp size={14} />从 QQ 获取更早记录</button></div>}
          {boundary[group.id] && <div className={s.historyNote}>{boundary[group.id]}</div>}
          {loading && page.messages.length === 0 ? <div className={s.readerEmpty}><LoaderCircle size={28} className={s.spin} /><h3>正在读取本地消息</h3></div> : page.messages.length === 0 ? <div className={s.readerEmpty}><MessageCircle size={36} strokeWidth={1.1} /><h3>{search ? '没有匹配的消息' : '这个群还没有归档消息'}</h3>{!search && <button className={s.primaryButton} disabled={!online || state.historyBusy} onClick={() => void run(() => loadHistory(false))}><RefreshCw size={15} />获取消息记录</button>}</div> : page.messages.map((message, index) => <div key={message.key}>{(index === 0 || date(page.messages[index - 1].time * 1000) !== date(message.time * 1000)) && <div className={s.dayDivider}><span>{date(message.time * 1000)}</span></div>}<MessageRow message={message} notify={notify} /></div>)}
          {offset > 0 && <div className={s.historyControl}><button className={s.secondaryButton} onClick={() => setOffset(value => Math.max(0, value - 100))}>较新消息 <ChevronDown size={14} /></button><button className={s.textButton} onClick={() => setOffset(0)}>回到最新 <ArrowDown size={14} /></button></div>}
        </div>
        <div className={s.readerFooter}><span>{group.followed ? <><Wifi size={14} />{online ? '实时接收已开启' : '实时接收已暂停'}</> : <><Star size={14} />未关注此群</>}</span><span>仅包含已获取的记录</span></div>
      </> : <div className={s.readerEmpty}><div className={s.emptyMark}><MessageCircle size={34} strokeWidth={1.3} /></div><h2>群消息</h2><p>{state.groups.length ? '选择一个群聊' : '连接 QQ 后查看群聊'}</p>{!online && <button className={s.primaryButton} onClick={onConnect}><Plug size={16} />连接 QQ</button>}</div>}
    </section>
  </div>;
}

function safeURL(value: unknown): string | undefined { try { const url = new URL(String(value)); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; } }
function TextContent({ text, notify }: { text: string; notify: (text: string) => void }) {
  return <>{text.split(/(https?:\/\/[^\s<>]+)/g).map((part, index) => safeURL(part) ? <a key={index} href={part} onClick={e => { e.preventDefault(); void bridge.openExternal(part).catch(error => notify(messageError(error))); }}>{part}</a> : <span key={index}>{part}</span>)}</>;
}
function MessageImage({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <span className={s.materialFallback}><ImageOff size={17} />图片已过期或无法加载</span> : <img className={s.messageImage} src={url} loading="lazy" referrerPolicy="no-referrer" alt="群消息图片" onError={() => setFailed(true)} />;
}
function MessageSegments({ segments, notify }: { segments: Segment[]; notify: (text: string) => void }) {
  return <>{segments.map((segment, index) => {
    const data = segment.data;
    const url = safeURL(data.url);
    if (segment.type === 'text') return <TextContent key={index} text={String(data.text || '')} notify={notify} />;
    if (segment.type === 'image') return url?.startsWith('https:') ? <MessageImage key={index} url={url} /> : <span className={s.materialFallback} key={index}><ImageOff size={16} />图片链接不可用</span>;
    if (segment.type === 'at') return <span key={index} className={s.mention}>@{String(data.qq || '')}</span>;
    if (segment.type === 'reply') return <span key={index} className={s.reply}>引用消息 #{String(data.id || '')}</span>;
    if (segment.type === 'forward') return <ForwardMessage key={index} id={String(data.id || '')} notify={notify} />;
    if (segment.type === 'json') {
      let title = '分享卡片'; let target: string | undefined;
      try { const value = JSON.parse(String(data.data)); const meta: any = Object.values(value.meta || {})[0]; title = String(meta?.title || meta?.desc || value.prompt || title); target = safeURL(meta?.jumpUrl || meta?.qqdocurl || meta?.url); } catch {}
      return <span className={s.materialFallback} key={index}><Link2 size={16} />{target ? <a href={target} onClick={e => { e.preventDefault(); void bridge.openExternal(target!).catch(error => notify(messageError(error))); }}>{title}</a> : title}</span>;
    }
    return <span className={s.materialFallback} key={index}><FileText size={15} />{String(data.name || ({ file: '文件', record: '语音消息', video: '视频', face: '表情' } as Record<string, string>)[segment.type] || segment.type)}{url && <button className={s.textButton} onClick={() => void bridge.openExternal(url).catch(error => notify(messageError(error)))}>打开 <ExternalLink size={12} /></button>}</span>;
  })}</>;
}
function ForwardMessage({ id, notify }: { id: string; notify: (text: string) => void }) {
  const [messages, setMessages] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  return <div className={s.forward}><button className={s.textButton} disabled={loading} onClick={async () => {
    if (messages) { setOpen(!open); return; }
    setLoading(true);
    try { const result = await bridge.request<any>({ type: 'forward', id }); setMessages(result.messages || []); setOpen(true); }
    catch (error) { notify(messageError(error)); } finally { setLoading(false); }
  }}><FileText size={16} />合并转发 {loading ? <LoaderCircle size={14} className={s.spin} /> : open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>{open && <div className={s.forwardContents}>{messages?.length === 0 && <span>没有可读取的转发内容</span>}{messages?.map((raw, index) => <div key={index}><strong>{String(raw.sender?.nickname || '转发消息')}</strong><p>{Array.isArray(raw.content || raw.message) ? (raw.content || raw.message).map((item: any) => item.type === 'text' ? String(item.data?.text || '') : `[${item.type}]`).join('') : String(raw.content || raw.message || '')}</p></div>)}</div>}</div>;
}
function MessageRow({ message, notify }: { message: Message; notify: (text: string) => void }) {
  const [details, setDetails] = useState(false);
  return <article className={s.messageRow}><Avatar name={message.senderName} /><div className={s.messageBody}><div className={s.messageMeta}><strong>{message.senderName}</strong><time dateTime={new Date(message.time * 1000).toISOString()}>{time(message.time * 1000)}</time><div className={s.messageTools}><IconButton label="查看原始消息" onClick={() => setDetails(!details)}><FileText size={13} /></IconButton></div></div><div className={s.messageContent}><MessageSegments segments={message.segments} notify={notify} /></div>{details && <pre className={s.rawMessage}>{JSON.stringify(message.raw, null, 2)}</pre>}</div></article>;
}
