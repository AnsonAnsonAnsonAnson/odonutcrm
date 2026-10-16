import { useEffect, useState, type ChangeEvent } from 'react';
import { api, ApiError, fmtDate } from '../../api';
import { ErrorText } from '../../components/ui';

interface Status {
  source: 'env' | 'stored' | null;
  passTypeId: string | null;
  teamId: string | null;
  pendingSince: string | null;
  activatedAt: string | null;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/pkcs10' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function toBase64(buf: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

/** Owner-only wizard: makes the signing request Apple needs and installs the certificate Apple returns. */
export default function AppleWallet() {
  const [st, setSt] = useState<Status | null>(null);
  const [cert, setCert] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const load = () => {
    api<Status>('/api/admin/apple-wallet').then(setSt);
    api('/api/admin/program').then((p) => setCert(p.integrations.appleCert));
  };
  useEffect(load, []);

  async function makeRequest() {
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ csr: string }>('/api/admin/apple-wallet/csr', { body: {} });
      download('odonut-wallet.certSigningRequest', r.csr);
      load();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      await api('/api/admin/apple-wallet/certificate', { body: { certificate: toBase64(await file.arrayBuffer()) } });
      setDone(true);
      load();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm('Turn Apple Wallet off? Cards already in Wallet stop updating until you set it up again.')) return;
    await api('/api/admin/apple-wallet', { method: 'DELETE' });
    setDone(false);
    load();
  }

  if (!st) return <p className="muted">Loading…</p>;

  if (st.source) {
    return (
      <div>
        <h1>Apple Wallet</h1>
        <div className="panel">
          <h3><span className="dot on" /> Apple Wallet is on</h3>
          {done && <p><b>All set.</b> Members can now tap "Add to Apple Wallet" on their card page.</p>}
          <p>Pass Type ID <b>{st.passTypeId}</b>, team <b>{st.teamId}</b>.</p>
          {cert && <p className="muted">Certificate valid until {cert.expiresAt?.slice(0, 10)}. Apple certificates last about a year; renew it before then by running these steps again.</p>}
          {cert?.problems?.map((p: string) => <div key={p} className="error">{p}</div>)}
          {st.source === 'env' ? (
            <p className="muted">Set up with certificate files on the server.</p>
          ) : (
            <>
              <p className="muted">Set up here on {fmtDate(st.activatedAt!)}.</p>
              <button className="btn" onClick={remove}>Turn off Apple Wallet</button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1>Apple Wallet</h1>
      <p className="muted">
        Five steps to let members keep their stamp card in Apple Wallet. You need an Apple Developer account (US$99 a year). Steps 2 and 4
        happen on Apple's website; keep this page open in another tab.
      </p>
      <ol className="steps">
        <li className="panel">
          <h3>1. Join the Apple Developer Program</h3>
          <p>Enrol at <a href="https://developer.apple.com/programs/enroll/" target="_blank" rel="noreferrer">developer.apple.com/programs/enroll</a>. Approval can take a day or two. Skip this if you already have an account.</p>
        </li>
        <li className="panel">
          <h3>2. Create a Pass Type ID</h3>
          <p>
            Open <a href="https://developer.apple.com/account/resources/identifiers/list/passTypeId" target="_blank" rel="noreferrer">Identifiers</a>, click
            <b> +</b>, choose <b>Pass Type IDs</b>, then <b>Continue</b>. Description: <i>O! Donut Card</i>. Identifier: something like <i>pass.com.odonut.card</i>. Click <b>Continue</b>, then <b>Register</b>.
          </p>
        </li>
        <li className="panel">
          <h3>3. Download your signing request</h3>
          <p>This file asks Apple for a certificate. The secret half stays on this server.</p>
          <button className="btn primary" disabled={busy} onClick={makeRequest}>Download signing request</button>
          {st.pendingSince && <p className="muted">Made on {fmtDate(st.pendingSince, true)}. Downloading again makes a new one; use the newest file in step 4.</p>}
        </li>
        <li className="panel">
          <h3>4. Make the certificate at Apple</h3>
          <p>
            Open <a href="https://developer.apple.com/account/resources/certificates/add" target="_blank" rel="noreferrer">Certificates</a>, choose
            <b> Pass Type ID Certificate</b>, then <b>Continue</b>. Pick the Pass Type ID from step 2, click <b>Continue</b>, upload the file from step 3,
            click <b>Continue</b>, then <b>Download</b>. You get a file called <i>pass.cer</i>.
          </p>
        </li>
        <li className="panel">
          <h3>5. Upload the certificate here</h3>
          <label className="btn primary">
            {busy ? 'Checking…' : 'Choose pass.cer'}
            <input type="file" accept=".cer,.crt,.pem" hidden disabled={busy || !st.pendingSince} onChange={upload} />
          </label>
          {!st.pendingSince && <p className="muted">Do step 3 first.</p>}
        </li>
      </ol>
      <ErrorText error={error} />
    </div>
  );
}
