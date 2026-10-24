import { useConfig } from '../config';
import { useI18n } from '../i18n';

const money = (n: number) => '$' + (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** The card's rules in a few short lines: welcome gift, first stamp, how to earn, what you get. */
export function Rules({ joining = false }: { joining?: boolean }) {
  const cfg = useConfig();
  const { t } = useI18n();
  return (
    <ul className="rules">
      {joining && cfg.welcomeGift && <li>🎁 {t('joinGift').replace('{gift}', cfg.welcomeGift)}</li>}
      {joining && cfg.signupStamps > 0 && <li>⭐ {t('firstStamp')}</li>}
      <li>🧾 {cfg.spendPerStamp > 0 ? t('earnRule').replace('{amount}', money(cfg.spendPerStamp)) : t('earnRuleVisit')}</li>
      <li>🍩 {t('rewardRule').replace('{n}', String(cfg.stampsRequired)).replace('{reward}', cfg.rewardSummary)}</li>
    </ul>
  );
}
