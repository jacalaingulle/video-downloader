// Optional family passcode. When SITE_PASSCODE is set, visitors enter it once on the page; the server
// then remembers the browser with a signed, HTTP-only cookie for 30 days. Without SITE_PASSCODE the
// site stays open, which is how local development runs.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const COOKIE = 'spectra_pass';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Derived from the passcode, so changing SITE_PASSCODE signs everyone out.
const token = (passcode) => createHmac('sha256', passcode).update('spectra-family-access').digest('base64url');

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

export const isLocked = () => Boolean(config.passcode);

export function isUnlocked(req) {
  if (!config.passcode) return true;
  const cookie = readCookie(req, COOKIE);
  return Boolean(cookie) && safeEqual(cookie, token(config.passcode));
}

/** Checks a passcode and, when it is right, remembers this browser. */
export function unlock(req, res, passcode) {
  if (!config.passcode || typeof passcode !== 'string' || !safeEqual(passcode, config.passcode)) return false;
  res.cookie(COOKIE, token(config.passcode), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: MAX_AGE_MS,
    path: '/',
  });
  return true;
}

export function requirePasscode(req, res, next) {
  if (isUnlocked(req)) return next();
  res.status(401).json({ error: 'Enter the passcode to continue.', locked: true });
}
