import { useConfig } from '../config';
import { useI18n } from '../i18n';
import { Icon } from './icons';

const money = (n: number) => '$' + (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** The card's rules in a few short lines: welcome gift, first stamp, how to earn, what you get. */
export function Rules({ joining = false }: { joining?: boolean }) {
  const cfg = useConfig();
  const { t } = useI18n();
  const item = (icon: string, text: string) => (
    <li>
      <span className="rule-icon"><Icon name={icon} size={17} /></span>
      {text}
    </li>
  );
  return (
    <ul className="rules">
      {joining && cfg.welcomeGift && item('gift', t('joinGift').replace('{gift}', cfg.welcomeGift))}
      {joining && cfg.signupStamps > 0 && item('star', t('firstStamp'))}
      {item('receipt', cfg.spendPerStamp > 0 ? t('earnRule').replace('{amount}', money(cfg.spendPerStamp)) : t('earnRuleVisit'))}
      {item('donut', t('rewardRule').replace('{n}', String(cfg.stampsRequired)).replace('{reward}', cfg.rewardSummary))}
    </ul>
  );
}
