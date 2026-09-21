import { Monitor, Settings2 } from 'lucide-react';
import type { AppState } from '../shared';
import { ModelConfiguration } from '../ModelConfiguration';
import { QQConnectionSettings } from './QQConnectionSettings';
import s from './SettingsPage.module.css';

export function SettingsPage({ active, state, run, onMessages }: { active: boolean; state: AppState; run: (action: () => Promise<unknown>) => Promise<void>; onMessages: () => void }) {
  return <section hidden={!active} className={s.page} aria-label="设置">
    <header className={s.heading}><span>应用设置</span><h1>设置</h1><p>管理 QQ 连接和消息整理模型。</p></header>
    <section className={s.section} aria-labelledby="qq-settings-title">
      <div className={s.sectionHeading}><Monitor size={19} /><div><h2 id="qq-settings-title">QQ 连接</h2><p>检测本机 QQ、登录账号或管理高级连接。</p></div></div>
      <QQConnectionSettings state={state} run={run} onMessages={onMessages} />
    </section>
    <section className={s.section} aria-labelledby="model-settings-title">
      <div className={s.sectionHeading}><Settings2 size={19} /><div><h2 id="model-settings-title">消息整理模型</h2><p>更新 API Key、协议和模型参数。</p></div></div>
      <ModelConfiguration active embedded />
    </section>
  </section>;
}
