import { Check } from 'lucide-react';
import s from './Onboarding.module.css';

const steps = [
  { value: 1, label: 'QQ 准备' },
  { value: 2, label: 'AI 服务' },
  { value: 3, label: '选择群聊' },
] as const;

export function OnboardingProgress({ step }: { step: 1 | 2 | 3 }) {
  return <aside className={s.progressRail} aria-label="初始化进度">
    <ol className={s.steps}>
      {steps.map(item => <li key={item.value} className={step === item.value ? s.current : step > item.value ? s.done : ''} aria-current={step === item.value ? 'step' : undefined}>
        <span className={s.stepMarker}>{step > item.value ? <Check size={15} /> : item.value}</span>
        <span className={s.stepCopy}><small>步骤 {item.value}</small><strong>{item.label}</strong></span>
      </li>)}
    </ol>
  </aside>;
}
