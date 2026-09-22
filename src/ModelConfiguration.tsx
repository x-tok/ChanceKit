import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Activity, AlertCircle, Bot, Check, Circle, Eye, EyeOff, KeyRound, LoaderCircle, RotateCcw, Save, Server, ShieldCheck, SlidersHorizontal, Square, Trash2, Zap } from 'lucide-react';
import { bridge, isDesktop } from './bridge';
import { configForProvider, defaultModelConfig, isLocalModelEndpoint, modelProviderPresets, recommendedMaxOutputTokens, sameCredentialScope, type ModelConfig, type ModelConfigInput, type ModelProviderEntry, type ModelSettings, type ModelTestResult, type ReasoningLevel } from './model-config';
import s from './ModelConfiguration.module.css';
import common from './App.module.css';

const emptySettings: ModelSettings = { config: null, hasApiKey: false, updatedAt: null, encryptionAvailable: false };
const apiLabels = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': 'Google Generative AI',
};
const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试。').replace(/^Error invoking remote method '[^']+': Error: /, '');
const reasoningLabels: Record<ReasoningLevel, string> = { off: '关闭', low: '低', medium: '中', high: '高' };

export function ModelConfiguration({ active, embedded = false }: { active: boolean; embedded?: boolean }) {
  const [settings, setSettings] = useState<ModelSettings>(emptySettings);
  const [catalog, setCatalog] = useState<ModelProviderEntry[]>(modelProviderPresets);
  const [draft, setDraft] = useState<ModelConfig>({ ...defaultModelConfig });
  const [apiKey, setApiKey] = useState<string>();
  const [visibleKey, setVisibleKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ModelTestResult>();
  const [testError, setTestError] = useState('');
  const [notice, setNotice] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const testSection = useRef<HTMLElement>(null);
  const clearDialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const busy = loading || saving || testing;
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.config ?? defaultModelConfig) || apiKey !== undefined;
  const retainedKey = apiKey === undefined && settings.hasApiKey && sameCredentialScope(settings.config, draft);
  const local = isLocalModelEndpoint(draft.baseUrl);
  const configured = Boolean(settings.config && (settings.hasApiKey || isLocalModelEndpoint(settings.config.baseUrl)));
  const provider = catalog.find(provider => provider.id === draft.provider);
  const knownModel = provider?.models.find(model => model.id === draft.modelId);
  const reasoningLevels = knownModel?.reasoningLevels ?? ['off', 'low', 'medium', 'high'] as ReasoningLevel[];

  useEffect(() => {
    mounted.current = true;
    void Promise.all([bridge.modelSettings(), bridge.modelCatalog()]).then(([value, providers]) => {
      if (!mounted.current) return;
      setSettings(value);
      setDraft(value.config ?? { ...defaultModelConfig });
      const entries = providers.length ? providers : modelProviderPresets;
      const saved = value.config;
      setCatalog(saved && !entries.some(entry => entry.id === saved.provider)
        ? [...entries, { id: saved.provider, name: `${saved.provider}（已保存）`, api: saved.api, baseUrl: saved.baseUrl, models: [] }]
        : entries);
    }).catch(error => { if (mounted.current) setLoadError(errorText(error)); })
      .finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; void bridge.cancelModelTest().catch(() => {}); };
  }, []);
  useEffect(() => {
    if (active && (testing || result || testError)) testSection.current?.scrollIntoView({ block: 'nearest' });
  }, [active, testing, result, testError]);

  const resetFeedback = () => { setError(''); setNotice(''); setResult(undefined); setTestError(''); };
  const update = (changes: Partial<ModelConfig>) => { setDraft(value => ({ ...value, ...changes })); resetFeedback(); };
  const updateScope = (changes: Partial<ModelConfig>) => { update(changes); setApiKey(undefined); setVisibleKey(false); };
  const selectProvider = (id: ModelConfig['provider']) => {
    const preset = catalog.find(provider => provider.id === id)!;
    updateScope(configForProvider(preset));
  };
  const selectModel = (modelId: string) => {
    const model = provider?.models.find(model => model.id === modelId);
    if (!model) { update({ modelId }); return; }
    const changes: Partial<ModelConfig> = {
      modelId, api: model.api, contextWindow: model.contextWindow,
      maxTokens: Math.min(recommendedMaxOutputTokens, model.maxTokens, model.contextWindow),
      reasoning: model.reasoning, reasoningLevel: model.reasoningLevels?.[0] ?? 'off', imageInput: model.imageInput,
    };
    if (draft.baseUrl === provider?.baseUrl || provider?.models.some(entry => entry.baseUrl === draft.baseUrl)) changes.baseUrl = model.baseUrl;
    if (model.api !== draft.api || (changes.baseUrl && changes.baseUrl !== draft.baseUrl)) updateScope(changes);
    else update(changes);
  };
  const restore = () => {
    setDraft(settings.config ?? { ...defaultModelConfig });
    setApiKey(undefined); setVisibleKey(false); resetFeedback();
  };
  const input = (): ModelConfigInput => ({ config: draft, ...(apiKey !== undefined ? { apiKey } : {}) });
  const validate = () => {
    setError('');
    if (!form.current?.reportValidity()) return false;
    try {
      const url = new URL(draft.baseUrl);
      if ((!local && url.protocol !== 'https:') || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    } catch { setError('API 地址必须使用 HTTPS（本机可用 HTTP），且不能包含密钥或查询参数。'); return false; }
    if (draft.maxTokens > draft.contextWindow) { setError('最大输出不能超过上下文窗口。'); return false; }
    return true;
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!validate()) return;
    setSaving(true); setNotice('');
    try {
      const saved = await bridge.saveModelSettings(input());
      setSettings(saved); setDraft(saved.config!); setApiKey(undefined); setVisibleKey(false); setNotice('配置已保存');
    } catch (error) { setError(errorText(error)); }
    finally { setSaving(false); }
  };
  const testConnection = async () => {
    if (!validate()) return;
    if (!local && !retainedKey && !apiKey?.trim()) { setError('请填写 API Key。'); return; }
    setTesting(true); setResult(undefined); setTestError(''); setNotice('');
    try {
      const value = await bridge.testModelSettings(input());
      if (mounted.current) setResult(value);
    } catch (error) { if (mounted.current) setTestError(errorText(error)); }
    finally { if (mounted.current) setTesting(false); }
  };
  const clear = async () => {
    clearDialog.current?.close(); setSaving(true);
    try {
      const value = await bridge.clearModelSettings();
      setSettings(value); setDraft({ ...defaultModelConfig }); setApiKey(undefined); setVisibleKey(false);
      setLoadError(''); resetFeedback(); setNotice('配置已清除');
    } catch (error) { setError(errorText(error)); }
    finally { setSaving(false); }
  };

  return <section hidden={!active} className={`${s.page} ${embedded ? s.embedded : ''}`} aria-label="模型配置">
    <div className={s.scroll}>
      <div className={s.content}>
        {!embedded && <header className={s.heading}>
          <div><span className={s.eyebrow}>智能体设置</span><h1>模型配置</h1></div>
          <span className={s.agentLabel}><Bot size={18} />pi agent</span>
        </header>}
        <div className={s.configSummary}>
          <span className={`${s.configStatus} ${configured && !dirty ? s.ready : ''}`}><Circle size={7} fill="currentColor" />{loading ? '正在读取' : dirty ? '有未保存的更改' : configured ? '已配置' : '待配置'}</span>
          <span>{settings.updatedAt ? `上次保存 ${new Date(settings.updatedAt).toLocaleString('zh-CN', { hour12: false })}` : '默认 LLM'}</span>
          <button className={common.iconButton} type="button" title="清除模型配置" aria-label="清除模型配置" disabled={!isDesktop || busy || (!settings.config && !loadError)} onClick={() => clearDialog.current?.showModal()}><Trash2 size={16} /></button>
        </div>
        {!isDesktop && <div className={s.warning} role="status"><AlertCircle size={17} />浏览器预览：保存和连接测试不可用。</div>}
        {loadError && <div className={s.warning} role="alert"><AlertCircle size={17} />{loadError}</div>}
        {isDesktop && !loading && !loadError && !settings.encryptionAvailable && <div className={s.warning} role="alert"><ShieldCheck size={17} />系统密钥服务不可用，暂时无法保存。</div>}
        <form id="model-configuration-form" ref={form} onSubmit={event => void save(event)}>
          <fieldset disabled={busy || Boolean(loadError)} className={s.fieldset}>
            <section className={s.section}>
              <div className={s.sectionTitle}><Server size={18} /><h2>服务连接</h2></div>
              <div className={s.fields}>
                <label>服务商<select aria-label="服务商" value={draft.provider} onChange={event => selectProvider(event.target.value as ModelConfig['provider'])}>{catalog.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
                <label>API 协议<select aria-label="API 协议" value={draft.api} onChange={event => updateScope({ api: event.target.value as ModelConfig['api'] })}>{Object.entries(apiLabels).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
                <label className={s.wide}>API 地址<input type="url" value={draft.baseUrl} onChange={event => updateScope({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" required maxLength={2048} spellCheck={false} autoComplete="off" /></label>
                <div className={`${s.keyField} ${s.wide}`}>
                  <label htmlFor="model-api-key">API Key {local && <small>本地服务可留空</small>}</label>
                  <div className={s.keyInput}>
                    <KeyRound size={16} />
                    {/* Visual masking avoids macOS Secure Keyboard Entry blocking global paste tools. */}
                    <input id="model-api-key" type="text" className={visibleKey ? '' : s.maskedKey} value={apiKey ?? ''} onChange={event => { setApiKey(event.target.value); resetFeedback(); }} placeholder={retainedKey ? '已保存，留空保留现有密钥' : '输入 API Key'} maxLength={16384} autoComplete="off" spellCheck={false} />
                    <button type="button" className={common.iconButton} title={visibleKey ? '隐藏新密钥' : '显示新密钥'} aria-label={visibleKey ? '隐藏新密钥' : '显示新密钥'} disabled={!apiKey} onClick={() => setVisibleKey(value => !value)}>{visibleKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                  </div>
                  <div className={s.keyStatus}>
                    <span><ShieldCheck size={13} />{retainedKey ? '密钥已加密保存' : apiKey === '' && settings.hasApiKey ? '保存后移除密钥' : apiKey ? '新密钥待保存' : '未设置密钥'}</span>
                    {retainedKey && <button type="button" onClick={() => { setApiKey(''); resetFeedback(); }}>移除密钥</button>}
                  </div>
                  {settings.hasApiKey && !sameCredentialScope(settings.config, draft) && !apiKey && <p className={s.scopeNotice}>服务地址或协议已更改，需要重新填写密钥。</p>}
                </div>
              </div>
            </section>
            <section className={s.section}>
              <div className={s.sectionTitle}><SlidersHorizontal size={18} /><h2>模型与参数</h2></div>
              <div className={s.fields}>
                {Boolean(provider?.models.length) && <label className={s.wide}>模型<select aria-label="模型" value={knownModel?.id ?? ''} onChange={event => event.target.value ? selectModel(event.target.value) : update({ modelId: '' })}>{provider?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}<option value="">自定义模型</option></select></label>}
                <label className={s.wide}>模型 ID<input aria-label="模型 ID" list="pi-model-catalog" value={draft.modelId} onChange={event => selectModel(event.target.value)} placeholder="选择或输入模型 ID" required maxLength={256} pattern="[^\s]+" spellCheck={false} autoComplete="off" /><datalist id="pi-model-catalog">{provider?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist></label>
                {knownModel && <div className={`${s.modelMeta} ${s.wide}`}><Check size={14} /><span>{knownModel.name}</span><span>预设模型</span></div>}
                <label>上下文窗口 <span className={s.numberInput}><input aria-label="上下文窗口" type="number" min={1024} max={10000000} step={1} required value={draft.contextWindow} onChange={event => update({ contextWindow: Number(event.target.value) })} /><small>tokens</small></span></label>
                <label>最大输出 <span className={s.numberInput}><input aria-label="最大输出" type="number" min={1} max={Math.min(draft.contextWindow, 1000000)} step={1} required value={draft.maxTokens} onChange={event => update({ maxTokens: Number(event.target.value) })} /><small>tokens</small></span></label>
                <div className={`${s.capabilities} ${s.wide}`}>
                  <label><input type="checkbox" checked={draft.reasoning} disabled={Boolean(knownModel)} onChange={event => update({ reasoning: event.target.checked, reasoningLevel: event.target.checked ? 'medium' : 'off' })} />推理模型</label>
                  <label><input type="checkbox" checked={draft.imageInput} disabled={Boolean(knownModel)} onChange={event => update({ imageInput: event.target.checked })} />图像输入</label>
                </div>
                {draft.reasoning ? <label className={s.wide}>推理强度<select aria-label="推理强度" value={draft.reasoningLevel} onChange={event => update({ reasoningLevel: event.target.value as ModelConfig['reasoningLevel'] })}>{[...new Set([...reasoningLevels, draft.reasoningLevel])].map(level => <option key={level} value={level}>{reasoningLabels[level]}</option>)}</select></label>
                  : <div className={`${s.temperature} ${s.wide}`}><label htmlFor="model-temperature">温度 <span>Temperature</span></label><div><input aria-label="温度滑块" type="range" min={0} max={2} step={0.1} value={draft.temperature} onChange={event => update({ temperature: Number(event.target.value) })} /><input id="model-temperature" type="number" min={0} max={2} step={0.1} required value={draft.temperature} onChange={event => update({ temperature: Number(event.target.value) })} /></div><div className={s.rangeLabels}><span>0 · 确定性更高</span><span>2 · 多样性更高</span></div></div>}
              </div>
            </section>
          </fieldset>
        </form>
        <section ref={testSection} className={`${s.section} ${s.testSection}`} aria-label="连接测试">
          <div className={s.sectionTitle}><Activity size={18} /><h2>连接测试</h2></div>
          <div className={s.testContent}>
            <div className={`${s.testState} ${result ? s.ready : ''} ${testError ? s.failed : ''}`} role="status">
              {testing ? <LoaderCircle size={17} className={common.spin} /> : result ? <Check size={17} /> : testError ? <AlertCircle size={17} /> : <Circle size={8} />}
              <strong>{testing ? '正在请求模型' : result ? '连接成功' : testError ? '测试未完成' : '尚未测试'}</strong>
              {result && <span>{result.latencyMs.toLocaleString()} ms</span>}
            </div>
            {testError && <p className={s.testError}>{testError}</p>}
            {result && <><pre className={s.reply}>{result.reply}</pre><div className={s.usage}><span>输入 {result.inputTokens} tokens</span><span>输出 {result.outputTokens} tokens</span></div></>}
            <p className={s.testDisclosure}>测试请求仅含 “Reply with only OK.”，不包含 QQ 消息，可能产生 API 费用。</p>
          </div>
        </section>
      </div>
    </div>
    <footer className={s.footer}>
      {error && <div className={s.footerError} role="alert"><AlertCircle size={17} /><span>{error}</span></div>}
      <div className={s.footerState} role="status">{saving ? <><LoaderCircle size={15} className={common.spin} />正在保存</> : notice ? <><Check size={15} />{notice}</> : <><ShieldCheck size={15} />本机加密存储</>}</div>
      <div className={s.actions}>
        <button type="button" title="撤销未保存的更改" aria-label="撤销未保存的更改" className={common.iconButton} disabled={busy || !dirty} onClick={restore}><RotateCcw size={17} /></button>
        {testing ? <button type="button" className={common.secondaryButton} onClick={() => void bridge.cancelModelTest().catch(error => setError(errorText(error)))}><Square size={14} />取消测试</button>
          : <button type="button" className={common.secondaryButton} disabled={busy || !isDesktop || Boolean(loadError)} onClick={() => void testConnection()}><Zap size={16} />测试连接</button>}
        <button form="model-configuration-form" type="submit" className={common.primaryButton} disabled={busy || !dirty || !isDesktop || !settings.encryptionAvailable || Boolean(loadError)}><Save size={16} />保存配置</button>
      </div>
    </footer>
    <dialog ref={clearDialog} className={s.dialog}>
      <h2>清除模型配置？</h2><p>已保存的模型参数和 API Key 将从本机移除。此操作不会更改 QQ 连接或消息记录。</p>
      <div><button type="button" className={common.secondaryButton} onClick={() => clearDialog.current?.close()}>取消</button><button type="button" className={s.dangerButton} onClick={() => void clear()}><Trash2 size={16} />清除配置</button></div>
    </dialog>
  </section>;
}
