import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../api';
import { ErrorText, Spinner } from '../../components/ui';
import { useAdminMe } from './AdminLayout';

/** ISO timestamp <-> the value a datetime-local input wants, in the browser's time zone. */
const toLocal = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null);

function privacyTemplate(brand: string) {
  return `${brand} Club privacy policy

This policy explains what personal data ${brand} ("we") collects through the ${brand} Club, why, and your choices. It follows the Personal Data (Privacy) Ordinance (Cap. 486).

What we collect
Your name, email address, mobile number, date of birth and gender when you join; your stamps, rewards and visits when you use your card; and, if you add the card to Apple Wallet or Google Wallet or allow notifications, a device identifier so we can update your card.

Why we use it
To run your membership: keep your stamp card, issue and check rewards, send your sign-in codes, and send birthday and reward messages. If you opt in, we also send offers and news. You can opt out at any time in Member settings, and we will stop.

Who we share it with
Only the service providers that help us run the club (hosting, email and text message delivery, Apple and Google for wallet card updates). They may only use it for that purpose. We do not sell your data.

How long we keep it
While you are a member. If you delete your account in Member settings, we delete your profile and card. We keep anonymous sales totals.

Your rights
You can ask for a copy of your data or ask us to correct it. Contact us at [your email] or at [your shop address].

Changes
We will post any changes on this page.

Last updated: [date]`;
}

export default function Settings() {
  const me = useAdminMe();
  const owner = me.role === 'owner';
  const [p, setP] = useState<any>(null);
  const [integrations, setIntegrations] = useState<any>(null);
  const [templates, setTemplates] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => {
    api('/api/admin/program').then((r) => {
      setP(r.program);
      setIntegrations(r.integrations);
    });
    api('/api/admin/templates').then(setTemplates);
  }, []);
  if (!p) return <Spinner />;

  const set = (k: string, num = false) => (e: any) =>
    setP({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : num ? Number(e.target.value) : e.target.value || (k.endsWith('_template_id') ? null : '') });

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const { id, updated_at, ...body } = p;
    try {
      setP(await api('/api/admin/program', { method: 'PATCH', body }));
      setOk('Saved. Wallet passes refresh the next time each phone checks in.');
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  const tplSelect = (k: string) => (
    <select value={p[k] ?? ''} onChange={set(k)} disabled={!owner}>
      <option value="">None</option>
      {templates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
    </select>
  );

  const Status = ({ on, label, help }: { on: boolean; label: string; help: string }) => (
    <li><span className={on ? 'dot on' : 'dot'} /> <b>{label}</b>: {on ? 'connected' : <span className="muted">{help}</span>}</li>
  );

  return (
    <form onSubmit={save}>
      <h1>Program & automations</h1>
      <div className="panel">
        <h3>Integrations</h3>
        <ul className="list">
          <Status on={integrations.appleWallet} label="Apple Wallet" help="set it up under Apple Wallet in the menu" />
          {integrations.appleCert && (
            <li>
              <span className={integrations.appleCert.ok ? 'dot on' : 'dot warn'} /> <b>Apple certificate</b>: valid until {integrations.appleCert.expiresAt?.slice(0, 10)}
              {integrations.appleCert.problems.map((p: string) => <div key={p} className="error">{p}</div>)}
            </li>
          )}
          <Status on={integrations.googleWallet} label="Google Wallet" help="add your issuer ID and service account (see docs/04)" />
          <Status on={integrations.webPush} label="Web push" help="set VAPID keys" />
          <Status on={integrations.email} label="Email (sign-in codes)" help="set SMTP settings; codes only appear in the server log until then" />
          <Status on={integrations.sms} label="SMS sign-in (Twilio)" help="optional; set the TWILIO_* settings to let members sign in with their mobile number" />
          <Status on={integrations.httpsReady} label="Public https URL" help={`PUBLIC_URL is ${integrations.publicUrl}; Apple Wallet updates need https`} />
        </ul>
        {owner && integrations.googleWallet && (
          <button type="button" className="btn" onClick={() => api('/api/admin/program/google-sync', { body: {} }).then(() => setOk('Google Wallet class updated'), (e) => setError(e.message))}>
            Sync Google Wallet design
          </button>
        )}
      </div>

      <fieldset disabled={!owner} className="panel form">
        <h3>Stamp card</h3>
        <div className="row wrap">
          <label>Program name<input value={p.name} onChange={set('name')} /></label>
          <label>Brand name<input value={p.brand_name} onChange={set('brand_name')} /></label>
          <label>Stamps for a reward<input type="number" min={2} max={20} value={p.stamps_required} onChange={set('stamps_required', true)} /></label>
          <label>Reward voucher{tplSelect('reward_template_id')}</label>
        </div>
        <div className="row wrap">
          <label>Max stamps per scan<input type="number" min={1} max={20} value={p.max_stamps_per_scan} onChange={set('max_stamps_per_scan', true)} /></label>
          <label>Seconds between purchase stamps (anti-fraud)<input type="number" min={0} value={p.stamp_cooldown_seconds} onChange={set('stamp_cooldown_seconds', true)} /></label>
        </div>
        <div className="row wrap">
          <label>Card colour<input type="color" value={p.background_color} onChange={set('background_color')} /></label>
          <label>Text colour<input type="color" value={p.foreground_color} onChange={set('foreground_color')} /></label>
          <label>Label colour<input type="color" value={p.label_color} onChange={set('label_color')} /></label>
        </div>
        <label>Terms<textarea value={p.terms} onChange={set('terms')} /></label>
        <label>Privacy policy (shown at /privacy and linked from sign-up)<textarea rows={8} value={p.privacy_policy ?? ''} onChange={set('privacy_policy')} /></label>
        {owner && !p.privacy_policy?.trim() && (
          <button type="button" className="btn" onClick={() => setP({ ...p, privacy_policy: privacyTemplate(p.brand_name) })}>
            Start from a template
          </button>
        )}
        {p.privacy_policy?.includes('[your email]') && <p className="muted">Fill in the parts in [brackets] and have it checked before launch.</p>}
      </fieldset>

      <fieldset disabled={!owner} className="panel form">
        <h3>Launch promotion: bonus stamps</h3>
        <p className="muted">Multiply every purchase stamp for a set period, for example double stamps for the first two weeks. It shows on the member page and the counter screen; adjustments are never multiplied.</p>
        <div className="row wrap">
          <label>Multiplier
            <select value={p.stamp_multiplier} onChange={set('stamp_multiplier', true)}>
              <option value={1}>Off</option>
              <option value={2}>Double stamps (2×)</option>
              <option value={3}>Triple stamps (3×)</option>
            </select>
          </label>
          <label>Starts (blank = now)<input type="datetime-local" value={toLocal(p.multiplier_starts_at)} onChange={(e) => setP({ ...p, multiplier_starts_at: fromLocal(e.target.value) })} /></label>
          <label>Ends (blank = until switched off)<input type="datetime-local" value={toLocal(p.multiplier_ends_at)} onChange={(e) => setP({ ...p, multiplier_ends_at: fromLocal(e.target.value) })} /></label>
          <label className="grow">Name shown to members<input maxLength={40} value={p.multiplier_label} onChange={set('multiplier_label')} /></label>
        </div>
      </fieldset>

      <fieldset disabled={!owner} className="panel form">
        <h3>Automations</h3>
        <p className="muted">These run every day at 10:00 (Hong Kong time) and message members through their wallet pass and web push.</p>
        <div className="auto">
          <h4>Welcome</h4>
          <label>Voucher on sign-up{tplSelect('welcome_template_id')}</label>
        </div>
        <div className="auto">
          <label className="check"><input type="checkbox" checked={p.birthday_enabled} onChange={set('birthday_enabled')} /><h4>Birthday treat</h4></label>
          <div className="row wrap">
            <label>Voucher{tplSelect('birthday_template_id')}</label>
            <label className="grow">Message<input value={p.birthday_message} onChange={set('birthday_message')} /></label>
          </div>
        </div>
        <div className="auto">
          <label className="check"><input type="checkbox" checked={p.winback_enabled} onChange={set('winback_enabled')} /><h4>Win back lapsed members</h4></label>
          <div className="row wrap">
            <label>After days without a visit<input type="number" min={7} value={p.winback_days} onChange={set('winback_days', true)} /></label>
            <label>Voucher{tplSelect('winback_template_id')}</label>
            <label className="grow">Message<input value={p.winback_message} onChange={set('winback_message')} /></label>
          </div>
        </div>
        <div className="auto">
          <label className="check"><input type="checkbox" checked={p.referral_enabled} onChange={set('referral_enabled')} /><h4>Refer a friend</h4></label>
          <label>Voucher for the referrer, after the friend's first purchase{tplSelect('referral_template_id')}</label>
        </div>
        <div className="auto">
          <label className="check"><input type="checkbox" checked={p.welcome_email_enabled} onChange={set('welcome_email_enabled')} /><h4>Welcome email</h4></label>
          <p className="muted">Sent right after sign-up with a link back to the Member Center.</p>
        </div>
        <div className="auto">
          <label className="check"><input type="checkbox" checked={p.near_reward_enabled} onChange={set('near_reward_enabled')} /><h4>Almost there nudge</h4></label>
          <div className="row wrap">
            <label>Stamps away from a reward<input type="number" min={1} max={5} value={p.near_reward_within} onChange={set('near_reward_within', true)} /></label>
            <label>After days without a visit<input type="number" min={1} max={90} value={p.near_reward_after_days} onChange={set('near_reward_after_days', true)} /></label>
            <label className="grow">Message<input value={p.near_reward_message} onChange={set('near_reward_message')} /></label>
          </div>
        </div>
        <div className="auto">
          <label className="check"><input type="checkbox" checked={p.tiers_enabled} onChange={set('tiers_enabled')} /><h4>Membership tiers</h4></label>
          <label>Count stamps from the last this many days<input type="number" min={30} max={3650} value={p.tier_window_days} onChange={set('tier_window_days', true)} /></label>
          <p className="muted">Edit the tiers themselves on the Tiers page.</p>
        </div>
        <div className="auto">
          <h4>Expiry reminder</h4>
          <label>Remind members this many days before a voucher expires (0 = off)<input type="number" min={0} max={30} value={p.expiry_reminder_days} onChange={set('expiry_reminder_days', true)} /></label>
        </div>
      </fieldset>
      <ErrorText error={error} />
      {ok && <p className="success">{ok}</p>}
      {owner && <button className="btn primary">Save settings</button>}
    </form>
  );
}
