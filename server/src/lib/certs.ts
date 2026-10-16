import { X509Certificate, createPrivateKey } from 'node:crypto';
import type { Config } from '../config.js';

export interface AppleCertStatus {
  ok: boolean;
  /** Certificate end date (ISO). */
  expiresAt: string | null;
  daysLeft: number | null;
  problems: string[];
}

/** Checks the Pass Type ID certificate: dates, that it matches the key and the Pass Type ID, and that Apple's WWDR CA issued it. */
export function checkAppleCert(apple: NonNullable<Config['apple']>, now = new Date()): AppleCertStatus {
  const problems: string[] = [];
  let expiresAt: string | null = null;
  let daysLeft: number | null = null;
  try {
    const cert = new X509Certificate(apple.cert);
    const end = new Date(cert.validTo);
    expiresAt = end.toISOString();
    daysLeft = Math.floor((end.getTime() - now.getTime()) / 86_400_000);
    if (daysLeft < 0) problems.push('The Pass Type ID certificate has expired. Passes stop updating; renew it at developer.apple.com.');
    else if (daysLeft <= 30) problems.push(`The Pass Type ID certificate expires in ${daysLeft} days. Renew it before then.`);
    try {
      const key = createPrivateKey({ key: apple.key, passphrase: apple.keyPassphrase });
      if (!cert.checkPrivateKey(key)) problems.push('pass-key.pem does not belong to pass-cert.pem. Use the key you made the signing request with.');
    } catch (e: any) {
      problems.push(`Could not read the pass private key: ${e.message}`);
    }
    const uid = /UID=([^\n,]+)/.exec(cert.subject)?.[1]?.trim();
    if (uid && uid !== apple.passTypeId) problems.push(`The certificate is for ${uid} but APPLE_PASS_TYPE_ID is ${apple.passTypeId}.`);
    const team = /OU=([^\n,]+)/.exec(cert.subject)?.[1]?.trim();
    if (team && team !== apple.teamId) problems.push(`The certificate belongs to team ${team} but APPLE_TEAM_ID is ${apple.teamId}.`);
    try {
      const wwdr = new X509Certificate(apple.wwdr);
      if (!cert.checkIssued(wwdr)) problems.push('wwdr.pem is not the Apple intermediate that issued your certificate. Download "Worldwide Developer Relations - G4".');
      if (new Date(wwdr.validTo) < now) problems.push('wwdr.pem has expired. Download the current one from apple.com/certificateauthority.');
    } catch (e: any) {
      problems.push(`Could not read wwdr.pem: ${e.message}`);
    }
  } catch (e: any) {
    problems.push(`Could not read pass-cert.pem: ${e.message}`);
  }
  return { ok: problems.length === 0, expiresAt, daysLeft, problems };
}
