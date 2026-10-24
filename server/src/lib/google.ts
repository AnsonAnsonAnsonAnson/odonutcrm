import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { HttpError } from './auth.js';

export type GoogleKeys = JWTVerifyGetKey;

// Google's public signing keys, fetched once and cached (jose refreshes them when Google rotates).
let googleKeys: GoogleKeys | null = null;
export const defaultGoogleKeys = () => (googleKeys ??= createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')));

export interface GoogleProfile {
  sub: string;
  email: string;
  firstName: string;
  lastName: string;
}

/** Checks a "Sign in with Google" ID token: signed by Google, for this shop's client ID, unexpired, email verified. */
export async function verifyGoogleIdToken(token: string, clientId: string, keys: GoogleKeys): Promise<GoogleProfile> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: clientId,
      algorithms: ['RS256'],
    }));
  } catch {
    throw new HttpError(401, 'Google sign-in did not work. Please try again or use your email.');
  }
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!payload.sub || !email || payload.email_verified !== true) {
    throw new HttpError(401, 'Your Google account email is not verified. Please use your email instead.');
  }
  return {
    sub: payload.sub,
    email,
    firstName: typeof payload.given_name === 'string' ? payload.given_name.slice(0, 60) : '',
    lastName: typeof payload.family_name === 'string' ? payload.family_name.slice(0, 60) : '',
  };
}
