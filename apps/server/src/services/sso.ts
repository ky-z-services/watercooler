import { createHash, randomBytes } from 'node:crypto';
import type { SsoPending } from '@watercooler/shared';
import type { DB } from '../db';
import { conflict } from '../lib/http';
import type { KyzProfile } from '../lib/kyz';
import { MINUTE } from '../lib/time';
import { BOT_USERNAME_PREFIX, getUserByKyzId, getUserByUsername, type UserRow } from './users';

/**
 * Signing in with a ky-z account. A sign-in on its way to users.ky-z.com is remembered by its
 * state (with the PKCE verifier and where to come back to); one that comes back without a
 * Watercooler account waits as "pending" until the person links an existing account or makes one.
 * Only hashes of the state and pending tokens are stored, like session tokens.
 */

/** How long both a trip to the sign-in page and the link-or-create step may take. */
export const SSO_TTL = 10 * MINUTE;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const token = () => randomBytes(32).toString('base64url');

/** A path inside the app to come back to; anything else (other sites, //host) becomes "/". */
export function safeNext(next: string | undefined | null): string {
  return next && /^\/(?![/\\])[^\s]*$/.test(next) && next.length <= 500 ? next : '/';
}

/**
 * Start a sign-in: the state to put in the URL and the cookie, and the PKCE challenge. `linkUserId`
 * is the signed-in user who asked to link their account to whichever ky-z account signs in.
 */
export function beginSignIn(
  db: DB,
  next: string,
  linkUserId: number | null,
  now: number,
): { state: string; challenge: string } {
  const state = token();
  const verifier = token();
  db.prepare('DELETE FROM sso_states WHERE created_at <= ?').run(now - SSO_TTL);
  db.prepare(
    'INSERT INTO sso_states (state_hash, verifier, next, link_user_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(hash(state), verifier, safeNext(next), linkUserId, now);
  return { state, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** The sign-in a state belongs to, used up; null when unknown or too old. */
export function finishSignIn(
  db: DB,
  state: string,
  now: number,
): { verifier: string; next: string; linkUserId: number | null } | null {
  const row = db
    .prepare('DELETE FROM sso_states WHERE state_hash = ? RETURNING verifier, next, link_user_id, created_at')
    .get(hash(state)) as
    { verifier: string; next: string; link_user_id: number | null; created_at: number } | undefined;
  return row && row.created_at > now - SSO_TTL
    ? { verifier: row.verifier, next: row.next, linkUserId: row.link_user_id }
    : null;
}

/** Link a Watercooler account to a ky-z account, which must not be linked to any other. */
export function linkKyz(db: DB, user: UserRow, kyzUserId: string): void {
  if (user.kyz_user_id === kyzUserId) return;
  if (user.kyz_user_id !== null) throw conflict('这个账号已经关联了另一个 ky-z 账号');
  if (getUserByKyzId(db, kyzUserId)) throw conflict('这个 ky-z 账号已经关联了别的账号');
  db.prepare('UPDATE users SET kyz_user_id = ? WHERE id = ?').run(kyzUserId, user.id);
}

interface PendingRow {
  kyz_user_id: string;
  kyz_username: string | null;
  display_name: string;
  next: string;
  created_at: number;
}

/** A ky-z sign-in without a Watercooler account; returns the token for the pending cookie. */
export function savePending(db: DB, profile: KyzProfile, next: string, now: number): string {
  const t = token();
  db.prepare('DELETE FROM sso_pending WHERE created_at <= ? OR kyz_user_id = ?').run(now - SSO_TTL, profile.id);
  db.prepare(
    `INSERT INTO sso_pending (token_hash, kyz_user_id, kyz_username, display_name, next, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(hash(t), profile.id, profile.username, profile.displayName, next, now);
  return t;
}

export function getPending(db: DB, pendingToken: string | undefined, now: number): PendingRow | null {
  if (!pendingToken) return null;
  const row = db.prepare('SELECT * FROM sso_pending WHERE token_hash = ?').get(hash(pendingToken)) as
    PendingRow | undefined;
  return row && row.created_at > now - SSO_TTL ? row : null;
}

export function dropPending(db: DB, pendingToken: string): void {
  db.prepare('DELETE FROM sso_pending WHERE token_hash = ?').run(hash(pendingToken));
}

/** A free username to offer a new account: the ky-z username when it fits, else one made up. */
export function suggestUsername(db: DB, kyzUsername: string | null, kyzUserId: string): string {
  const free = (u: string) =>
    /^[a-zA-Z0-9_.-]{2,24}$/.test(u) &&
    !u.toLowerCase().startsWith(BOT_USERNAME_PREFIX) &&
    getUserByUsername(db, u) === undefined;
  if (kyzUsername && free(kyzUsername)) return kyzUsername;
  const base = (kyzUsername ?? '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 16) || 'kyz';
  for (let i = 0; ; i++) {
    const candidate = `${base}-${(i === 0 ? kyzUserId.replace(/[^a-zA-Z0-9]/g, '') : randomBytes(4).toString('hex')).slice(0, 6)}`;
    if (free(candidate)) return candidate;
  }
}

export function pendingView(db: DB, row: PendingRow): SsoPending {
  return {
    displayName: row.display_name.trim().slice(0, 24) || row.kyz_username || 'ky-z 用户',
    suggestedUsername: suggestUsername(db, row.kyz_username, row.kyz_user_id),
  };
}
