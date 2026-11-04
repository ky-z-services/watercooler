import { loginSchema, ssoCreateSchema, type SsoPending } from '@watercooler/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Config } from '../config';
import type { AppDeps, AppEnv } from '../context';
import { conflict, forbidden, HttpError, notFound, parseBody, unauthorized } from '../lib/http';
import { verifyPassword } from '../lib/password';
import { RateLimiter } from '../lib/rateLimit';
import { isHttps, startSession } from '../lib/session';
import { MINUTE } from '../lib/time';
import {
  beginSignIn,
  dropPending,
  finishSignIn,
  getPending,
  linkKyz,
  pendingView,
  safeNext,
  savePending,
  SSO_TTL,
} from '../services/sso';
import { createUser, getUserById, getUserByKyzId, getUserByUsername, toMe } from '../services/users';

const STATE_COOKIE = 'wc_sso_state';
const PENDING_COOKIE = 'wc_sso_pending';

/** Where browsers reach this instance, base path included: PUBLIC_URL, or worked out from the request. */
export function publicUrl(c: Context, config: Config): string {
  if (config.publicUrl) return config.publicUrl;
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '');
  return `${proto}://${c.req.header('host') ?? url.host}${config.basePath}`;
}

/**
 * Sign-in with ky-z accounts (users.ky-z.com), when the instance is set up with KYZ_USERS_URL. The
 * server does the OAuth code exchange itself and then starts an ordinary Watercooler session, so
 * nothing else (API, trading SDK) changes. A ky-z account without a Watercooler account first
 * links an existing one (proving it with that account's password) or makes a new one.
 */
export function ssoRoutes({ db, config, now, kyz }: AppDeps) {
  const app = new Hono<AppEnv>();
  const cookiePath = config.basePath || '/';
  const base = config.basePath;
  const linkFailures = new RateLimiter(10, 15 * MINUTE);
  const service = () => {
    if (!kyz) throw notFound('这个站没有开启 ky-z 账号登录');
    return kyz;
  };
  const callbackUrl = (c: Context) => `${publicUrl(c, config)}/api/auth/sso/callback`;
  const shortCookie = (c: Context, name: string, value: string) =>
    setCookie(c, name, value, {
      httpOnly: true,
      // Lax: sent when users.ky-z.com sends the browser back here with a top-level navigation.
      sameSite: 'Lax',
      secure: isHttps(c),
      path: cookiePath,
      maxAge: SSO_TTL / 1000,
    });

  /** Off to the ky-z sign-in page; `link=1` links the signed-in user's account instead. */
  app.get('/auth/sso/login', (c) => {
    const client = service();
    const linking = c.req.query('link') === '1';
    const user = c.get('user');
    if (linking && !user) throw unauthorized('请先登录');
    const { state, challenge } = beginSignIn(db, safeNext(c.req.query('next')), linking ? user!.id : null, now());
    shortCookie(c, STATE_COOKIE, state);
    return c.redirect(
      client.authorizeUrl({
        redirectUri: callbackUrl(c),
        state,
        challenge,
        create: c.req.query('prompt') === 'create',
      }),
    );
  });

  /** Back from the sign-in page with a code (or an error). Always ends in a redirect into the app. */
  app.get('/auth/sso/callback', async (c) => {
    const client = service();
    const q = c.req.query();
    const expected = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: cookiePath });
    const fail = (reason: string) => c.redirect(`${base}/login?sso_error=${reason}`);
    if (q.error) return fail(q.error === 'access_denied' ? 'denied' : 'failed');
    // The state must be the one this browser was sent off with: a code obtained elsewhere is refused.
    if (!q.state || !q.code || q.state !== expected) return fail('expired');
    const flow = finishSignIn(db, q.state, now());
    if (!flow) return fail('expired');

    let profile;
    try {
      const tokens = await client.exchange(q.code, callbackUrl(c), flow.verifier);
      profile = await client.me(tokens.accessToken);
      // Watercooler keeps its own session; the account service's tokens are not needed again.
      void client.revoke(tokens.refreshToken).catch(() => undefined);
    } catch (err) {
      console.warn(`ky-z sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
      return fail('failed');
    }
    if (profile.status !== 'active') return fail('disabled');

    const t = now();
    const linked = getUserByKyzId(db, profile.id);
    // Linking from the settings page: only for the user who asked, and only while still signed in.
    if (flow.linkUserId !== null) {
      const asking = getUserById(db, flow.linkUserId);
      if (!asking || c.get('user')?.id !== asking.id) return fail('expired');
      if (linked && linked.id !== asking.id) return fail('linked_elsewhere');
      try {
        linkKyz(db, asking, profile.id);
      } catch {
        return fail('linked_elsewhere');
      }
      return c.redirect(`${base}${flow.next}`);
    }
    if (linked) {
      if (linked.is_bot) return fail('failed');
      startSession(c, db, cookiePath, linked.id, t);
      return c.redirect(`${base}${flow.next}`);
    }
    shortCookie(c, PENDING_COOKIE, savePending(db, profile, flow.next, t));
    return c.redirect(`${base}/welcome`);
  });

  /** The ky-z sign-in waiting to link or create a Watercooler account. */
  app.get('/auth/sso/pending', (c) => {
    service();
    const row = getPending(db, getCookie(c, PENDING_COOKIE), now());
    if (!row) throw notFound('登录已过期，请重新用 ky-z 账号登录');
    return c.json<SsoPending>(pendingView(db, row));
  });

  const pendingOrFail = (c: Context) => {
    const pendingToken = getCookie(c, PENDING_COOKIE);
    const row = getPending(db, pendingToken, now());
    if (!pendingToken || !row) throw notFound('登录已过期，请重新用 ky-z 账号登录');
    return { pendingToken, row };
  };
  const signIn = (c: Context, userId: number, pendingToken: string, next: string) => {
    dropPending(db, pendingToken);
    deleteCookie(c, PENDING_COOKIE, { path: cookiePath });
    const t = now();
    startSession(c, db, cookiePath, userId, t);
    return c.json({ user: toMe(getUserById(db, userId)!, config, t), next });
  };

  /** Link an existing Watercooler account, proven by its password; from then on ky-z signs it in. */
  app.post('/auth/sso/link', async (c) => {
    service();
    const { pendingToken, row } = pendingOrFail(c);
    const input = await parseBody(c, loginSchema);
    const key = input.username.toLowerCase();
    if (!linkFailures.check(key)) throw new HttpError(429, '尝试次数过多，请 15 分钟后再试');
    const user = getUserByUsername(db, input.username);
    const ok = await verifyPassword(input.password, user?.password_hash ?? 'scrypt$16384$8$1$AAAA$AAAA');
    if (!user || !ok || user.is_bot) {
      linkFailures.hit(key);
      throw unauthorized('用户名或密码错误');
    }
    linkFailures.reset(key);
    linkKyz(db, user, row.kyz_user_id);
    return signIn(c, user.id, pendingToken, row.next);
  });

  /** A new Watercooler account for the ky-z account, with no password of its own. */
  app.post('/auth/sso/create', async (c) => {
    service();
    const { pendingToken, row } = pendingOrFail(c);
    const input = await parseBody(c, ssoCreateSchema);
    if (config.inviteCode !== null && input.inviteCode !== config.inviteCode) throw forbidden('邀请码不正确');
    if (getUserByKyzId(db, row.kyz_user_id)) throw conflict('这个 ky-z 账号已经关联了别的账号');
    const user = await createUser(
      db,
      config,
      { username: input.username, displayName: input.displayName, password: null, kyzUserId: row.kyz_user_id },
      now(),
    );
    return signIn(c, user.id, pendingToken, row.next);
  });

  return app;
}
