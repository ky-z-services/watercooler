/**
 * The ky-z account service (github.com/ky-z-services/ky-z-users): every ky-z site signs people in
 * there with OAuth 2.0 authorization code + PKCE. This instance does the exchange on the server,
 * so the browser only ever holds Watercooler's own session cookie.
 */

/** The ky-z account as /api/v1/users/me describes it. */
export interface KyzProfile {
  id: string;
  username: string | null;
  displayName: string;
  /** active, disabled or deleted. */
  status: string;
}

export interface KyzClient {
  /** The sign-in page to send the browser to. */
  authorizeUrl(params: { redirectUri: string; state: string; challenge: string; create?: boolean }): string;
  /** Ends the sign-in on the account service too, then comes back to `returnTo`. */
  logoutUrl(returnTo: string): string;
  /** Swap the code from the sign-in page for tokens (bound to the redirect URI and PKCE verifier). */
  exchange(code: string, redirectUri: string, verifier: string): Promise<{ accessToken: string; refreshToken: string }>;
  me(accessToken: string): Promise<KyzProfile>;
  /** Ends the account-service session a refresh token belongs to. */
  revoke(refreshToken: string): Promise<void>;
}

/** The account service refused or could not be reached. */
export class KyzError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const TIMEOUT = 10_000;

export function createKyzClient(baseUrl: string, fetchImpl: typeof fetch = fetch): KyzClient {
  async function call(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
    } catch (err) {
      throw new KyzError(`ky-z 账号服务连不上：${err instanceof Error ? err.message : String(err)}`, 'unreachable');
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // OAuth endpoints answer {error, error_description}; the API answers {error: {code, message}}.
      const err = body.error as string | { code?: string; message?: string } | undefined;
      const code = typeof err === 'string' ? err : (err?.code ?? `http_${res.status}`);
      const message = typeof err === 'string' ? String(body.error_description ?? err) : (err?.message ?? '');
      throw new KyzError(`ky-z 账号服务返回 ${res.status} ${code}：${message}`, code);
    }
    return body;
  }
  const form = (fields: Record<string, string>) => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });

  return {
    authorizeUrl({ redirectUri, state, challenge, create }) {
      const q = new URLSearchParams({
        response_type: 'code',
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      });
      if (create) q.set('prompt', 'create');
      return `${baseUrl}/oauth/authorize?${q}`;
    },
    logoutUrl: (returnTo) => `${baseUrl}/logout?${new URLSearchParams({ post_logout_redirect_uri: returnTo })}`,
    async exchange(code, redirectUri, verifier) {
      const body = await call(
        '/oauth/token',
        form({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }),
      );
      if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string')
        throw new KyzError('ky-z 账号服务没有返回 token', 'invalid_response');
      return { accessToken: body.access_token, refreshToken: body.refresh_token };
    },
    async me(accessToken) {
      const body = await call('/api/v1/users/me', { headers: { authorization: `Bearer ${accessToken}` } });
      if (typeof body.id !== 'string' || !body.id) throw new KyzError('ky-z 账号服务没有返回用户', 'invalid_response');
      return {
        id: body.id,
        username: typeof body.username === 'string' && body.username ? body.username : null,
        displayName: typeof body.display_name === 'string' ? body.display_name : '',
        status: typeof body.status === 'string' ? body.status : 'active',
      };
    },
    async revoke(refreshToken) {
      await call('/oauth/revoke', form({ token: refreshToken }));
    },
  };
}
