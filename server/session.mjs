// Signed cookies (HMAC-SHA256) for the login session and the short-lived OAuth handshake.
// No database: a session lives in its cookie; logout revokes its id in memory until it would expire.
import crypto from 'node:crypto';

export const SESSION_ABSOLUTE_MS = 7 * 24 * 3600 * 1000;
export const SESSION_IDLE_MS = 48 * 3600 * 1000;
export const SESSION_REFRESH_MS = 10 * 60 * 1000;
export const OAUTH_TTL_MS = 10 * 60 * 1000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const randomToken = (bytes = 32) => b64u(crypto.randomBytes(bytes));
export const pkceChallenge = (verifier) => b64u(crypto.createHash('sha256').update(verifier).digest());

export function keys(secret) {
  const derive = (label) => crypto.createHmac('sha256', secret).update(`collective-hub:${label}`).digest();
  return { session: derive('session'), oauth: derive('oauth'), csrf: derive('csrf') };
}

const mac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

export function sign(key, payload) {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${b64u(mac(key, body))}`;
}

export function verify(key, value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const dot = value.indexOf('.');
  if (dot < 1) return null;
  const body = value.slice(0, dot);
  let given;
  try { given = Buffer.from(value.slice(dot + 1), 'base64url'); } catch { return null; }
  const want = mac(key, body);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return p && typeof p === 'object' ? p : null; } catch { return null; }
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const csrfToken = (k, sid) => b64u(mac(k.csrf, `csrf:${sid}`));

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (!Object.hasOwn(out, name)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

export function cookieNames(secure) {
  // __Host- pins the cookie to this exact origin over https (no Domain, Path=/, Secure).
  return secure ? { session: '__Host-ch_session', oauth: '__Host-ch_oauth' } : { session: 'ch_session', oauth: 'ch_oauth' };
}

export function serializeCookie(name, value, { maxAgeMs, secure }) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  parts.push(maxAgeMs > 0 ? `Max-Age=${Math.floor(maxAgeMs / 1000)}` : 'Max-Age=0');
  return parts.join('; ');
}

// Logged-out session ids, kept until the session would have expired anyway.
export class Revoked {
  constructor() { this.ids = new Map(); }
  add(sid, until) { this.ids.set(sid, until); }
  has(sid, now) {
    for (const [id, until] of this.ids) if (until <= now) this.ids.delete(id);
    return this.ids.has(sid);
  }
}

// A session payload is valid for the allowed user only, within both the absolute and idle limits.
export function sessionValid(p, { now, allowedId, revoked }) {
  if (!p || typeof p.sid !== 'string' || typeof p.uid !== 'number') return false;
  if (p.uid !== allowedId) return false;
  if (!(now - p.iat < SESSION_ABSOLUTE_MS) || !(now - p.seen < SESSION_IDLE_MS) || p.iat > now + 60000) return false;
  return !revoked.has(p.sid, now);
}
