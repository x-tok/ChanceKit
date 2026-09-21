import { useState } from 'react';
import { MessageCircle } from 'lucide-react';
import type { AppState } from '../shared';
import { BRAND } from '../brand';
import { QQSetupStep } from './QQSetupStep';
import { ModelSetupStep } from './ModelSetupStep';
import { GroupSyncStep } from './GroupSyncStep';
import { OnboardingProgress } from './OnboardingProgress';
import s from './Onboarding.module.css';

type Step = 1 | 2 | 3;
export function Onboarding({ state, onComplete }: { state: AppState; onComplete: () => void }) {
  const [step, setStep] = useState<Step>(1);
  const [error, setError] = useState('');

  return <main className={s.page} lang="zh-CN">
    <header className={s.header}>
      <div className={s.brand}><span><MessageCircle size={23} /></span><strong>{BRAND.name}<small>{BRAND.englishName}</small></strong></div>
    </header>
    <div className={s.shell}>
      <OnboardingProgress step={step} />
      <div className={s.mainColumn}>
        <section className={s.content}>
          {step === 1 && <QQSetupStep state={state} onNext={() => { setError(''); setStep(2); }} onError={setError} />}
          {step === 2 && <ModelSetupStep onBack={() => { setError(''); setStep(1); }} onNext={() => { setError(''); setStep(3); }} onError={setError} />}
          {step === 3 && <GroupSyncStep state={state} onBack={() => { setError(''); setStep(2); }} onComplete={onComplete} onError={setError} />}
        </section>
        {error && <div className={s.error} role="alert">{error}</div>}
      </div>
    </div>
  </main>;
}
