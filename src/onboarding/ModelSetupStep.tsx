import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, ExternalLink, Eye, EyeOff, KeyRound, LoaderCircle, ShieldCheck, Sparkles } from 'lucide-react';
import type { ModelSettings } from '../model-config';
import { defaultModelConfig } from '../model-config';
import { bridge, isDesktop } from '../bridge';
import { onboardingError } from './errors';
import s from './Onboarding.module.css';

export function ModelSetupStep({ onBack, onNext, onError }: { onBack: () => void; onNext: () => void; onError: (message: string) => void }) {
  const [apiKey, setApiKey] = useState('');
  const [settings, setSettings] = useState<ModelSettings>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [keyVisible, setKeyVisible] = useState(false);
  const savedDeepSeek = Boolean(settings?.hasApiKey && settings.config?.provider === 'deepseek');

  useEffect(() => {
    void bridge.modelSettings().then(setSettings).catch(error => onError(onboardingError(error)));
  }, [onError]);

  const open = async (url: string) => {
    onError('');
    try { await bridge.openExternal(url); }
    catch (error) { onError(onboardingError(error)); }
  };
  const save = async () => {
    onError('');
    if (savedDeepSeek && !apiKey.trim()) { onNext(); return; }
    if (!apiKey.trim()) { onError('请填写 DeepSeek API Key。'); return; }
    setBusy(true);
    setNotice('');
    try {
      const input = { config: { ...defaultModelConfig }, apiKey: apiKey.trim() };
      await bridge.testModelSettings(input);
      const saved = await bridge.saveModelSettings(input);
      setSettings(saved);
      setApiKey('');
      setNotice('连接测试通过，配置已保存');
      onNext();
    } catch (error) { onError(onboardingError(error)); }
    finally { setBusy(false); }
  };

  return <div className={s.stage}>
    <button className={s.backButton} onClick={onBack}><ArrowLeft size={16} />返回</button>
    <div className={s.stageIntro}><span className={s.eyebrow}>第 2 步，共 3 步</span><h1>设置 AI 整理服务</h1><p>选择用于整理群消息的 AI 服务，并填写对应的 API Key。</p></div>
    <label className={s.modelChoice}>AI 服务<select aria-label="AI 服务" value="deepseek" onChange={() => {}}><option value="deepseek">DeepSeek V4.1 Flash</option></select></label>
    <dl className={s.modelFacts}>
      <div><dt>API 协议</dt><dd>OpenAI Chat Completions</dd></div>
      <div><dt>API 地址</dt><dd>https://api.deepseek.com</dd></div>
    </dl>
    <label className={s.keyField}>DeepSeek API Key
      {/* Visual masking avoids macOS Secure Keyboard Entry blocking global paste tools. */}
      <span><KeyRound size={17} /><input type="text" className={keyVisible ? '' : s.maskedInput} value={apiKey} onChange={event => { setApiKey(event.target.value); onError(''); }} placeholder={savedDeepSeek ? '已保存，留空继续使用' : '粘贴以 sk- 开头的 API Key'} autoComplete="off" spellCheck={false} /><button type="button" title={keyVisible ? '隐藏 API Key' : '显示 API Key'} aria-label={keyVisible ? '隐藏 API Key' : '显示 API Key'} disabled={!apiKey} onClick={() => setKeyVisible(value => !value)}>{keyVisible ? <EyeOff size={16} /> : <Eye size={16} />}</button></span>
    </label>
    {savedDeepSeek && <p className={s.savedKey}><ShieldCheck size={15} />已有可用的 DeepSeek 配置</p>}
    <details className={s.guide}>
      <summary>如何获取 API Key？</summary>
      <ol><li>登录 DeepSeek 开放平台，进入 API Keys。</li><li>创建一个新密钥并复制到上方输入框。</li><li>确认账户有可用额度，整理消息会产生 API 费用。</li></ol>
      <div><button className={s.textButton} onClick={() => void open('https://platform.deepseek.com/api_keys')}>打开 API Keys <ExternalLink size={14} /></button><button className={s.textButton} onClick={() => void open('https://platform.deepseek.com/top_up')}>查看余额与充值 <ExternalLink size={14} /></button></div>
    </details>
    {notice && <p className={s.successNote}><CheckCircle2 size={16} />{notice}</p>}
    <div className={s.stageFooter}><span>密钥使用系统安全存储加密保存</span><button className={s.primaryButton} disabled={busy || !isDesktop || (!savedDeepSeek && !apiKey.trim())} onClick={() => void save()}>{busy ? <LoaderCircle className={s.spin} size={17} /> : <Sparkles size={17} />}{savedDeepSeek && !apiKey.trim() ? '使用已保存配置' : '测试并继续'} <ArrowRight size={17} /></button></div>
  </div>;
}
