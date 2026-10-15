import { useNavigate } from 'react-router-dom';
import { useConfig } from '../../config';
import { LangButton, useI18n } from '../../i18n';

export default function Privacy() {
  const cfg = useConfig();
  const { t } = useI18n();
  const nav = useNavigate();
  return (
    <div className="page narrow">
      <header className="topbar">
        <button className="back" onClick={() => (history.length > 1 ? nav(-1) : nav('/'))} aria-label="Back">‹</button>
        <h1>{t('privacy')}</h1>
        <LangButton />
      </header>
      <article className="prose">
        {(cfg.privacyPolicy || '').split(/\n{2,}/).map((para, i) => (
          <p key={i}>{para}</p>
        ))}
      </article>
    </div>
  );
}
