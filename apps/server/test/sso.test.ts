import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KyzError, type KyzClient, type KyzProfile } from '../src/lib/kyz';
import { createUser } from '../src/services/users';
import { setup } from './helpers';

/** A stand-in for users.ky-z.com that checks the code, redirect URI and PKCE verifier like the real one. */
function fakeKyz() {
  const accounts = new Map<string, KyzProfile>();
  const codes = new Map<string, { kyzId: string; redirectUri: string; challenge: string }>();
  const state = { revoked: [] as string[], down: false };
  const client: KyzClient = {
    authorizeUrl: ({ redirectUri, state: s, challenge, create }) =>
      `https://users.example/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: s,
        ...(create ? { prompt: 'create' } : {}),
      })}`,
    logoutUrl: (returnTo) =>
      `https://users.example/logout?${new URLSearchParams({ post_logout_redirect_uri: returnTo })}`,
    async exchange(code, redirectUri, verifier) {
      if (state.down) throw new KyzError('down', 'unreachable');
      const c = codes.get(code);
      codes.delete(code);
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!c || c.redirectUri !== redirectUri || c.challenge !== challenge)
        throw new KyzError('bad code', 'invalid_grant');
      return { accessToken: `at-${c.kyzId}`, refreshToken: `rt-${c.kyzId}` };
    },
    async me(accessToken) {
      return accounts.get(accessToken.slice(3))!;
    },
    async revoke(refreshToken) {
      state.revoked.push(refreshToken);
    },
  };
  /** The person signs in as `kyzId` on the sign-in page; returns the callback path to follow. */
  function signIn(authorizeLocation: string, kyzId: string): string {
    const url = new URL(authorizeLocation);
    const code = randomBytes(8).toString('hex');
    const redirectUri = url.searchParams.get('redirect_uri')!;
    codes.set(code, { kyzId, redirectUri, challenge: url.searchParams.get('code_challenge')! });
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state')!);
    return back.pathname.replace(/^\/api/, '') + back.search;
  }
  const add = (id: string, username: string | null, displayName: string, status = 'active') =>
    accounts.set(id, { id, username, displayName, status });
  return { client, signIn, add, state };
}

function ssoEnv(overrides: Parameters<typeof setup>[0] = {}) {
  const kyz = fakeKyz();
  const env = setup(overrides, () => ({ kyz: kyz.client }));
  kyz.add('k-alice', 'alice', '爱丽丝');
  kyz.add('k-bob', 'bob', 'Bob');
  /** Go through the whole sign-in in `browser` as `kyzId`; returns where it lands. */
  async function signIn(browser: ReturnType<typeof env.client>, kyzId: string, query = '') {
    const start = await browser.fetch('GET', `/auth/sso/login${query}`);
    expect(start.status).toBe(302);
    const back = await browser.fetch('GET', kyz.signIn(start.headers.get('location')!, kyzId));
    expect(back.status).toBe(302);
    return back.headers.get('location')!;
  }
  return { env, kyz, signIn };
}

describe('ky-z sign-in', () => {
  it('sends people to users.ky-z.com with PKCE and makes a Watercooler account on the first visit', async () => {
    const { env, kyz, signIn } = ssoEnv();
    const browser = env.client();
    expect((await browser.get('/config')).body.sso).toBe(true);

    const start = await browser.fetch('GET', '/auth/sso/login?next=/market/7&prompt=create');
    const authorize = new URL(start.headers.get('location')!);
    expect(authorize.origin + authorize.pathname).toBe('https://users.example/oauth/authorize');
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: 'code',
      redirect_uri: 'http://localhost/api/auth/sso/callback',
      code_challenge_method: 'S256',
      prompt: 'create',
    });
    expect(authorize.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);

    const welcome = await browser.fetch('GET', kyz.signIn(authorize.toString(), 'k-alice'));
    expect(welcome.headers.get('location')).toBe('/welcome');
    expect(kyz.state.revoked).toEqual(['rt-k-alice']);
    expect((await browser.get('/auth/me')).body.user).toBeNull();
    expect((await browser.get('/auth/sso/pending')).body).toEqual({
      displayName: '爱丽丝',
      suggestedUsername: 'alice',
    });

    const created = await browser.post('/auth/sso/create', { username: 'alice', displayName: '爱丽丝' });
    expect(created.body).toMatchObject({
      next: '/market/7',
      user: { username: 'alice', displayName: '爱丽丝', balance: 1000, kyzLinked: true, hasPassword: false },
    });
    expect((await browser.get('/auth/sso/pending')).status).toBe(404);

    // Signing out ends the ky-z sign-in as well; the next ky-z sign-in comes straight back in.
    const out = await browser.post('/auth/logout');
    expect(out.body.ssoLogoutUrl).toBe(
      'https://users.example/logout?post_logout_redirect_uri=http%3A%2F%2Flocalhost%2F',
    );
    expect((await browser.get('/auth/me')).body.user).toBeNull();
    expect(await signIn(browser, 'k-alice', '?next=/portfolio')).toBe('/portfolio');
    expect((await browser.get('/auth/me')).body.user).toMatchObject({ username: 'alice' });
  });

  it('links an existing account by its password, keeping its money', async () => {
    const { env, signIn } = ssoEnv();
    const old = await createUser(
      env.db,
      env.config,
      { username: 'xiaoming', displayName: '小明', password: 'secret123' },
      0,
    );
    env.db.prepare('UPDATE users SET balance = 4242 WHERE id = ?').run(old.id);
    const browser = env.client();
    expect(await signIn(browser, 'k-alice')).toBe('/welcome');

    expect((await browser.post('/auth/sso/link', { username: 'xiaoming', password: 'wrong-pass' })).status).toBe(401);
    const linked = await browser.post('/auth/sso/link', { username: 'xiaoming', password: 'secret123' });
    expect(linked.body.user).toMatchObject({ id: old.id, balance: 42.42, kyzLinked: true, hasPassword: true });

    // Another ky-z account cannot take the same Watercooler account over.
    const other = env.client();
    expect(await signIn(other, 'k-bob')).toBe('/welcome');
    const taken = await other.post('/auth/sso/link', { username: 'xiaoming', password: 'secret123' });
    expect(taken.status).toBe(409);
    // The password still signs in, e.g. for the Python SDK.
    expect((await env.client().post('/auth/login', { username: 'xiaoming', password: 'secret123' })).status).toBe(200);
  });

  it('links the signed-in account from the settings page', async () => {
    const { env, signIn } = ssoEnv();
    await createUser(env.db, env.config, { username: 'lili', displayName: '丽丽', password: 'secret123' }, 0);
    const browser = env.client();
    expect((await browser.fetch('GET', '/auth/sso/login?link=1')).status).toBe(401);
    await browser.post('/auth/login', { username: 'lili', password: 'secret123' });
    expect(await signIn(browser, 'k-bob', '?link=1&next=/settings')).toBe('/settings');
    expect((await browser.get('/auth/me')).body.user).toMatchObject({ username: 'lili', kyzLinked: true });

    // From now on that ky-z account signs in as lili anywhere.
    expect(await signIn(env.client(), 'k-bob')).toBe('/');

    // It cannot be linked to a second account as well.
    await createUser(env.db, env.config, { username: 'dawei', displayName: '大伟', password: 'secret123' }, 0);
    const dawei = env.client();
    await dawei.post('/auth/login', { username: 'dawei', password: 'secret123' });
    expect(await signIn(dawei, 'k-bob', '?link=1')).toBe('/login?sso_error=linked_elsewhere');
    expect((await dawei.get('/auth/me')).body.user).toMatchObject({ username: 'dawei', kyzLinked: false });
  });

  it('refuses codes the browser did not ask for, cancelled and failed sign-ins and stray return paths', async () => {
    const { env, kyz, signIn } = ssoEnv();
    // A sign-in started in the attacker's browser cannot be finished in the victim's.
    const attacker = env.client();
    const start = await attacker.fetch('GET', '/auth/sso/login');
    const victim = env.client();
    const stolen = await victim.fetch('GET', kyz.signIn(start.headers.get('location')!, 'k-bob'));
    expect(stolen.headers.get('location')).toBe('/login?sso_error=expired');
    expect((await victim.get('/auth/sso/pending')).status).toBe(404);

    const browser = env.client();
    const denied = await browser.fetch('GET', '/auth/sso/callback?error=access_denied&state=x');
    expect(denied.headers.get('location')).toBe('/login?sso_error=denied');

    kyz.state.down = true;
    expect(await signIn(browser, 'k-alice')).toBe('/login?sso_error=failed');
    kyz.state.down = false;
    kyz.add('k-gone', 'gone', 'Gone', 'disabled');
    expect(await signIn(browser, 'k-gone')).toBe('/login?sso_error=disabled');

    // Only paths inside the app come back out of a sign-in.
    const evil = env.client();
    expect(await signIn(evil, 'k-alice', '?next=//evil.example/x')).toBe('/welcome');
    expect((await evil.post('/auth/sso/create', { username: 'alice', displayName: 'A' })).body.next).toBe('/');
  });

  it('closes password sign-up, keeps sign-in reachable in private mode and asks invite codes of new accounts', async () => {
    const { env, signIn } = ssoEnv({ privateMode: true, inviteCode: 'join-us' });
    const browser = env.client();
    expect(
      (await browser.post('/auth/register', { username: 'zoe', displayName: 'Zoe', password: 'secret123' })).status,
    ).toBe(403);
    expect(await signIn(browser, 'k-alice')).toBe('/welcome');
    expect((await browser.get('/auth/sso/pending')).status).toBe(200);
    expect((await browser.post('/auth/sso/create', { username: 'alice', displayName: 'A' })).status).toBe(403);
    expect(
      (await browser.post('/auth/sso/create', { username: 'alice', displayName: 'A', inviteCode: 'join-us' })).status,
    ).toBe(200);
  });

  it('lets an account made through ky-z set its first password without an old one', async () => {
    const { env, signIn } = ssoEnv();
    const browser = env.client();
    await signIn(browser, 'k-alice');
    await browser.post('/auth/sso/create', { username: 'alice', displayName: 'A' });
    expect((await env.client().post('/auth/login', { username: 'alice', password: 'whatever' })).status).toBe(401);
    expect((await browser.post('/auth/password', { newPassword: 'first-pass' })).status).toBe(200);
    expect((await browser.get('/auth/me')).body.user.hasPassword).toBe(true);
    expect((await browser.post('/auth/password', { newPassword: 'second-pass' })).status).toBe(400);
    expect((await env.client().post('/auth/login', { username: 'alice', password: 'first-pass' })).status).toBe(200);
  });

  it('is off without KYZ_USERS_URL', async () => {
    const env = setup();
    const browser = env.client();
    expect((await browser.get('/config')).body.sso).toBe(false);
    expect((await browser.fetch('GET', '/auth/sso/login')).status).toBe(404);
    expect((await browser.post('/auth/logout')).body).toEqual({ ok: true });
  });
});
