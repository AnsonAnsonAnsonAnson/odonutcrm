import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, platform } from '../../api';
import { useConfig } from '../../config';
import { LangButton, useI18n } from '../../i18n';
import { Modal, Qr } from '../../components/ui';
import { Icon } from '../../components/icons';

export function WalletButtons({ compact = false }: { compact?: boolean }) {
  const cfg = useConfig();
  const { t } = useI18n();
  const showApple = cfg.appleWallet && (platform.ios || !platform.mobile);
  const showGoogle = cfg.googleWallet && (platform.android || !platform.mobile);
  if (!showApple && !showGoogle) return null;
  return (
    <div className={compact ? 'wallet-buttons compact' : 'wallet-buttons'}>
      {showApple && (
        <a className="wallet-btn apple" href="/api/wallet/apple/pass">
          {t('addApple')}
        </a>
      )}
      {showGoogle && (
        <a className="wallet-btn google" href="/api/wallet/google/save">
          {t('addGoogle')}
        </a>
      )}
    </div>
  );
}

export default function AddToWallet() {
  const cfg = useConfig();
  const { t } = useI18n();
  const nav = useNavigate();
  const loc = useLocation();
  const welcome = (loc.state as any)?.welcome as { title: string }[] | undefined;
  const welcomeStamps = ((loc.state as any)?.welcomeStamps as number | undefined) ?? 0;
  const welcomeClaimed = !!(loc.state as any)?.welcomeClaimed;
  const [showReward, setShowReward] = useState(!!welcome?.length || welcomeStamps > 0 || welcomeClaimed);
  const [handoff, setHandoff] = useState<string | null>(null);

  useEffect(() => {
    if (!platform.mobile) {
      api<{ url: string }>('/api/me/handoff').then((r) => setHandoff(r.url)).catch(() => nav('/'));
    }
  }, []);

  return (
    <div className="wallet-page">
      <div className="wallet-top">
        <LangButton />
        <h1>{t('oneMoreStep')}</h1>
        <p>{t('addToWalletHint')}</p>
        <div className="pass-peek">
          <img src="/icon.svg" alt="" width={90} height={90} />
          <span>{cfg.brandName}</span>
        </div>
      </div>
      <div className="wallet-bottom">
        {platform.mobile ? (
          <WalletButtons />
        ) : (
          <>
            {handoff && <Qr value={handoff} size={180} />}
            <p className="muted">{t('scanByMobile')}</p>
            <WalletButtons compact />
          </>
        )}
        <button className="btn primary" onClick={() => nav('/me', { replace: true })}>{t('skip')}</button>
      </div>
      <Modal open={showReward} onClose={() => setShowReward(false)}>
        <div className="reward-pop">
          <div className="gift"><Icon name="gift" size={30} /></div>
          {(!!welcome?.length || welcomeStamps > 0) && <h2>{t('claimedReward')}</h2>}
          {!!welcome?.length && <p><b>{welcome.map((w) => w.title).join(', ')}</b></p>}
          {welcomeStamps > 0 && <p>{t('welcomeStamps').replace('{n}', String(welcomeStamps))}</p>}
          {welcomeClaimed && <p className="muted">{t('welcomeClaimedNote')}</p>}
          <p className="muted">{t('claimedRewardBody')}</p>
          <button className="btn primary" onClick={() => setShowReward(false)}>{t('confirm')}</button>
        </div>
      </Modal>
    </div>
  );
}
