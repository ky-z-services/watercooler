import type { Me } from '@watercooler/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export function useMe() {
  const query = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 30_000 });
  return { me: query.data?.user ?? null, loading: query.isPending };
}

export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: Infinity }).data;
}

/** Update the cached user in place (e.g. after a trade changed the balance). */
export function useSetMe() {
  const qc = useQueryClient();
  return (update: (me: Me) => Me) =>
    qc.setQueryData<{ user: Me | null }>(['me'], (old) => (old?.user ? { user: update(old.user) } : old));
}

/**
 * The ky-z sign-in: a full-page trip to users.ky-z.com that comes back signed in (or to the
 * first-time page). `create` opens its sign-up form, `link` links the signed-in account.
 */
export function ssoLoginUrl(opts: { next?: string; create?: boolean; link?: boolean } = {}): string {
  const q = new URLSearchParams();
  if (opts.next && opts.next !== '/') q.set('next', opts.next);
  if (opts.create) q.set('prompt', 'create');
  if (opts.link) q.set('link', '1');
  const query = q.toString();
  return `${import.meta.env.BASE_URL}api/auth/sso/login${query ? `?${query}` : ''}`;
}
