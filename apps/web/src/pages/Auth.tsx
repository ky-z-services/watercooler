import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CURRENCY_NAME, registerSchema, ssoCreateSchema } from '@watercooler/shared';
import { KeyRound, Link2, UserPlus } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Logo } from '../components/Layout';
import { Drop } from '../components/Money';
import { Button, buttonClass, Card, Empty, Field, Input, PageLoader } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { ssoLoginUrl, useConfig, useMe } from '../lib/auth';
import { COPY, SITE_NAME, usePageTitle } from '../lib/site';

function AuthShell({ title, subtitle, children }: { title: string; subtitle: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center py-8">
      <div className="relative w-full max-w-md">
        <div className="surface relative rounded-lg p-8 shadow-[0_12px_40px_rgb(29_33_41/0.06)]">
          <div className="mb-6 flex justify-center">
            <Logo />
          </div>
          <h1 className="text-center text-2xl font-semibold">{title}</h1>
          <p className="mt-1.5 text-center text-sm text-dim">{subtitle}</p>
          <div className="mt-7">{children}</div>
        </div>
      </div>
    </div>
  );
}

function useAfterAuth() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next');
  return (user: Awaited<ReturnType<typeof api.login>>['user']) => {
    qc.setQueryData(['me'], { user });
    void qc.invalidateQueries();
    navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
  };
}

/** Why a ky-z sign-in came back without signing in (routes/sso.ts). */
const SSO_ERRORS: Record<string, string> = {
  denied: '你取消了 ky-z 账号登录',
  expired: '登录超时了，请重新登录',
  failed: 'ky-z 账号服务暂时连不上，请稍后再试',
  disabled: '这个 ky-z 账号已被停用',
  linked_elsewhere: '这个 ky-z 账号已经关联了另一个账号',
};

const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') ? next : '/');

function SsoButton({ next, create }: { next?: string; create?: boolean }) {
  return (
    <a href={ssoLoginUrl({ next, create })} className={buttonClass({ size: 'lg', className: 'w-full' })}>
      <KeyRound className="size-4" />
      {create ? '注册 ky-z 账号' : '使用 ky-z 账号登录'}
    </a>
  );
}

export function Login() {
  usePageTitle('登录');
  const config = useConfig();
  const { me } = useMe();
  const done = useAfterAuth();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const mutation = useMutation({
    mutationFn: () => api.login(username.trim(), password),
    onSuccess: (res) => done(res.user),
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (me && !mutation.isSuccess) return <Navigate to="/" replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };

  const form = (
    <form onSubmit={submit} className="space-y-4">
      <Field label="用户名">
        <Input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
          required
        />
      </Field>
      <Field label="密码">
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </Field>
      <Button type="submit" size="lg" className="w-full" loading={mutation.isPending}>
        登录
      </Button>
    </form>
  );

  if (config?.sso) {
    const error = params.get('sso_error');
    return (
      <AuthShell title="欢迎回来" subtitle="用 ky-z 账号登录，所有 ky-z 网站通用">
        {error && (
          <p className="mb-4 rounded border border-no/40 px-4 py-3 text-sm text-no">
            {SSO_ERRORS[error] ?? SSO_ERRORS.failed}
          </p>
        )}
        <SsoButton next={safeNext(params.get('next'))} />
        <p className="mt-6 text-center text-sm text-dim">
          还没有 ky-z 账号？{' '}
          <a href={ssoLoginUrl({ create: true })} className="text-brand hover:underline">
            注册一个
          </a>
        </p>
        <details className="mt-6 border-t border-line pt-4">
          <summary className="cursor-pointer text-center text-xs text-faint hover:text-dim">
            用原来的用户名和密码登录
          </summary>
          <div className="mt-4">{form}</div>
          <p className="mt-3 text-center text-xs text-faint">登录后可以在「账号设置」里关联 ky-z 账号</p>
        </details>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="欢迎回来" subtitle="登录后继续你的预测">
      {form}
      <p className="mt-6 text-center text-sm text-dim">
        还没有账号？{' '}
        <Link to={`/register${params.toString() ? `?${params}` : ''}`} className="text-brand hover:underline">
          注册一个
        </Link>
      </p>
      <p className="mt-2 text-center text-xs text-faint">忘记密码请联系站长重置</p>
    </AuthShell>
  );
}

export function Register() {
  usePageTitle('注册');
  const { me } = useMe();
  const config = useConfig();
  const done = useAfterAuth();
  const [params] = useSearchParams();
  const [form, setForm] = useState({ username: '', displayName: '', password: '', inviteCode: '' });
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const mutation = useMutation({
    mutationFn: () => {
      const parsed = registerSchema.safeParse({ ...form, inviteCode: form.inviteCode || undefined });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message);
      return api.register(parsed.data);
    },
    onSuccess: (res) => {
      toast.success(`注册成功，送你 ${config?.startingBalance ?? ''} ${CURRENCY_NAME}`);
      done(res.user);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (me && !mutation.isSuccess) return <Navigate to="/" replace />;

  const gift = (
    <span className="inline-flex items-center gap-1">
      注册即送 <Drop /> <b className="text-fg">{config?.startingBalance ?? 1000}</b> {CURRENCY_NAME}
      {config && config.dailyBonus > 0 && <>，每日签到再领 {config.dailyBonus}</>}
    </span>
  );

  if (config?.sso) {
    return (
      <AuthShell title={COPY.registerTitle} subtitle={gift}>
        <p className="mb-5 text-center text-sm leading-relaxed text-dim">
          {`${SITE_NAME} 使用 ky-z 账号：注册一次，所有 ky-z 网站都能直接登录。`}
        </p>
        <SsoButton create />
        <p className="mt-6 text-center text-sm text-dim">
          已有 ky-z 账号？{' '}
          <a href={ssoLoginUrl({ next: safeNext(params.get('next')) })} className="text-brand hover:underline">
            直接登录
          </a>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={COPY.registerTitle} subtitle={gift}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
        className="space-y-4"
      >
        <Field label="用户名" hint="登录用，字母数字下划线，注册后不可修改">
          <Input value={form.username} onChange={set('username')} autoComplete="username" autoFocus required />
        </Field>
        <Field label="昵称" hint="其他人看到的名字，比如你的花名">
          <Input value={form.displayName} onChange={set('displayName')} required maxLength={24} />
        </Field>
        <Field label="密码" hint="至少 6 位">
          <Input
            type="password"
            value={form.password}
            onChange={set('password')}
            autoComplete="new-password"
            required
          />
        </Field>
        {config?.inviteRequired && (
          <Field label="邀请码" hint="问问拉你进来的人">
            <Input value={form.inviteCode} onChange={set('inviteCode')} required />
          </Field>
        )}
        <Button type="submit" size="lg" className="w-full" loading={mutation.isPending}>
          注册
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-dim">
        已有账号？{' '}
        <Link to={`/login${params.toString() ? `?${params}` : ''}`} className="text-brand hover:underline">
          去登录
        </Link>
      </p>
    </AuthShell>
  );
}

/**
 * After a first ky-z sign-in: link the Watercooler account someone already has (once, with its
 * password) or make a new one. Either way they are signed in afterwards.
 */
export function Welcome() {
  usePageTitle('欢迎');
  const config = useConfig();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pending = useQuery({ queryKey: ['ssoPending'], queryFn: api.ssoPending, retry: false });
  const [link, setLink] = useState({ username: '', password: '' });
  const [fresh, setFresh] = useState<{ username: string; displayName: string; inviteCode: string } | null>(null);
  // Starts from the ky-z account's name until the person edits it.
  const form = fresh ?? {
    username: pending.data?.suggestedUsername ?? '',
    displayName: pending.data?.displayName ?? '',
    inviteCode: '',
  };
  const setForm = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFresh({ ...form, [key]: e.target.value });
  const done = (res: { user: Awaited<ReturnType<typeof api.login>>['user']; next: string }) => {
    qc.setQueryData(['me'], { user: res.user });
    qc.removeQueries({ queryKey: ['ssoPending'] });
    void qc.invalidateQueries();
    navigate(safeNext(res.next), { replace: true });
  };
  const linking = useMutation({
    mutationFn: () => api.ssoLink(link.username.trim(), link.password),
    onSuccess: (res) => {
      toast.success(`已关联，以后用 ky-z 账号登录 ${res.user.displayName}`);
      done(res);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const creating = useMutation({
    mutationFn: () => {
      const parsed = ssoCreateSchema.safeParse({ ...form, inviteCode: form.inviteCode || undefined });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message);
      return api.ssoCreate(parsed.data);
    },
    onSuccess: (res) => {
      toast.success(`注册成功，送你 ${config?.startingBalance ?? ''} ${CURRENCY_NAME}`);
      done(res);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (pending.isPending) return <PageLoader />;
  if (!pending.data)
    return (
      <Empty icon={<KeyRound className="size-10" />} title="登录已过期">
        <a href={ssoLoginUrl()} className={buttonClass({ className: 'mt-4' })}>
          重新用 ky-z 账号登录
        </a>
      </Empty>
    );
  return (
    <div className="mx-auto max-w-3xl py-8">
      <div className="text-center">
        <h1 className="section-title">欢迎，{pending.data.displayName}</h1>
        <p className="mt-2 text-dim">{`第一次用 ky-z 账号登录 ${SITE_NAME}，还差一步。`}</p>
      </div>
      <div className="mt-8 grid gap-5 md:grid-cols-2">
        <Card className="p-6">
          <h2 className="flex items-center gap-2 font-semibold">
            <Link2 className="size-4 text-brand" /> 我已经有 {SITE_NAME} 账号
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-dim">
            输入原来的用户名和密码关联一次，水滴、下注和排名都保留，以后直接用 ky-z 账号登录。
          </p>
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              linking.mutate();
            }}
          >
            <Field label="原来的用户名">
              <Input
                value={link.username}
                onChange={(e) => setLink((l) => ({ ...l, username: e.target.value }))}
                autoComplete="username"
                required
              />
            </Field>
            <Field label="原来的密码">
              <Input
                type="password"
                value={link.password}
                onChange={(e) => setLink((l) => ({ ...l, password: e.target.value }))}
                autoComplete="current-password"
                required
              />
            </Field>
            <Button type="submit" className="w-full" loading={linking.isPending}>
              关联并登录
            </Button>
          </form>
        </Card>
        <Card className="p-6">
          <h2 className="flex items-center gap-2 font-semibold">
            <UserPlus className="size-4 text-brand" /> 我是第一次来
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-dim">
            {`新建一个 ${SITE_NAME} 账号，送 ${config?.startingBalance ?? 1000} ${CURRENCY_NAME}。以后用 ky-z 账号登录，不用另设密码。`}
          </p>
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              creating.mutate();
            }}
          >
            <Field label="用户名" hint="显示在个人主页上，字母数字下划线，之后不可修改">
              <Input value={form.username} onChange={setForm('username')} required />
            </Field>
            <Field label="昵称" hint="其他人看到的名字">
              <Input value={form.displayName} onChange={setForm('displayName')} required maxLength={24} />
            </Field>
            {config?.inviteRequired && (
              <Field label="邀请码" hint="问问拉你进来的人">
                <Input value={form.inviteCode} onChange={setForm('inviteCode')} required />
              </Field>
            )}
            <Button type="submit" variant="outline" className="w-full" loading={creating.isPending}>
              创建账号
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
