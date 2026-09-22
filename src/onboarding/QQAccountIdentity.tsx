import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { Account } from '../shared';
import s from './Onboarding.module.css';

const accountName = (account: Account) => account.nickname.trim() || 'QQ 用户';

export function QQAccountIdentity({ account }: { account: Account }) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const name = accountName(account);

  useEffect(() => { setAvatarFailed(false); }, [account.id]);

  return <div className={s.accountIdentity}>
    <span className={s.accountAvatar} aria-hidden="true">
      {!avatarFailed
        ? <img src={`https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(account.id)}&s=100`} alt="" width={40} height={40} onError={() => setAvatarFailed(true)} />
        : Array.from(name)[0]}
      <CheckCircle2 className={s.accountVerified} size={16} />
    </span>
    <span className={s.accountDetails}>
      <strong>{name}</strong>
      <small>QQ 号：{account.id}</small>
    </span>
  </div>;
}
