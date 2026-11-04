import { createApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import type { AppDeps } from '../src/context';
import { openDatabase } from '../src/db';
import type { PolymarketBook, PolymarketClient, PolymarketEvent } from '../src/mimic/client';

/** `extra` adds optional app dependencies (like the runtime), built from the test's db and clock. */
export function setup(
  overrides: Partial<Config> = {},
  extra: (deps: Pick<AppDeps, 'db' | 'config' | 'now'>) => Partial<AppDeps> = () => ({}),
) {
  const db = openDatabase(':memory:');
  const config: Config = { ...loadConfig({}), staticDir: null, ...overrides };
  const clock = { now: Date.UTC(2026, 0, 1, 4) };
  const base = { db, config, now: () => clock.now };
  const app = createApp({ ...base, ...extra(base) });

  function client() {
    // A tiny cookie jar: every cookie the app sets, dropped again when it is cleared.
    const jar = new Map<string, string>();
    async function send(method: string, path: string, body?: unknown): Promise<Response> {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await app.request(`http://localhost/api${path}`, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      for (const line of res.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split(';');
        const [name, ...rest] = pair!.split('=');
        const value = rest.join('=');
        if (!value || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) jar.delete(name!.trim());
        else jar.set(name!.trim(), value);
      }
      return res;
    }
    async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
      const res = await send(method, path, body);
      return { status: res.status, body: (await res.json()) as T };
    }
    return {
      get: <T = any>(path: string) => call<T>('GET', path),
      post: <T = any>(path: string, body: unknown = {}) => call<T>('POST', path, body),
      del: <T = any>(path: string) => call<T>('DELETE', path),
      raw: call,
      /** The response itself, e.g. a redirect. */
      fetch: send,
      cookies: jar,
    };
  }

  async function register(username: string, password = 'secret123') {
    const c = client();
    const res = await c.post('/auth/register', { username, displayName: username.toUpperCase(), password });
    if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
    return c;
  }

  return { db, config, clock, app, client, register };
}

/** A stand-in for polymarket.com: tests set the events and books it serves. */
export function fakePolymarket(top: PolymarketEvent[] = []) {
  const state = {
    top,
    /** Events looked up by id; defaults to the top list. */
    events: new Map<string, PolymarketEvent>(),
    books: new Map<string, PolymarketBook>(),
    fail: false,
    bookCalls: 0,
  };
  const client: PolymarketClient = {
    async topEvents(limit) {
      if (state.fail) throw new Error('network down');
      return state.top.slice(0, limit);
    },
    async events(ids) {
      if (state.fail) throw new Error('network down');
      return ids.flatMap((id) => state.events.get(id) ?? state.top.find((e) => e.id === id) ?? []);
    },
    async book(token) {
      state.bookCalls++;
      if (state.fail) throw new Error('network down');
      return state.books.get(token) ?? { bids: [], asks: [] };
    },
  };
  return { client, state };
}
