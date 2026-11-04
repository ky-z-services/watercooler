import { createHash, randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { DB } from '../db';
import type { UserRow } from '../services/users';
import { DAY } from './time';

const COOKIE_NAME = 'wc_session';
const SESSION_TTL = 30 * DAY;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function isHttps(c: Context): boolean {
  return new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
}

function setSessionCookie(c: Context, token: string, cookiePath: string): void {
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttps(c),
    path: cookiePath,
    maxAge: SESSION_TTL / 1000,
  });
}

export function startSession(c: Context, db: DB, cookiePath: string, userId: number, now: number): void {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    hashToken(token),
    userId,
    now,
    now + SESSION_TTL,
  );
  // Opportunistic cleanup of expired sessions.
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  setSessionCookie(c, token, cookiePath);
}

/** Resolve the session cookie to a user, sliding the expiry forward when it is half used. */
export function loadSessionUser(c: Context, db: DB, cookiePath: string, now: number): UserRow | null {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = db
    .prepare(
      `SELECT u.*, s.expires_at AS session_expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(tokenHash, now) as (UserRow & { session_expires_at: number }) | undefined;
  if (!row) return null;
  if (row.session_expires_at - now < SESSION_TTL / 2) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(now + SESSION_TTL, tokenHash);
    setSessionCookie(c, token, cookiePath);
  }
  const { session_expires_at: _, ...user } = row;
  return user;
}

export function endSession(c: Context, db: DB, cookiePath: string): void {
  const token = getCookie(c, COOKIE_NAME);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  deleteCookie(c, COOKIE_NAME, { path: cookiePath });
}

/** Log a user out everywhere except, optionally, the current session. */
export function revokeSessions(c: Context | null, db: DB, userId: number, keepCurrent: boolean): void {
  const token = c ? getCookie(c, COOKIE_NAME) : undefined;
  if (keepCurrent && token) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, hashToken(token));
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}
