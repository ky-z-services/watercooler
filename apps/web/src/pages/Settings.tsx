import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, buttonClass, Card, Field, Input } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { ssoLoginUrl, useConfig, useMe } from '../lib/auth';
import { usePageTitle } from '../lib/site';

export default function SettingsPage() {
  usePageTitle('账号设置');
  const { me } = useMe();
  const config = useConfig();
  const qc = useQueryClient();
  // Accounts made through a ky-z sign-in set a first password without an old one.
  const firstPassword = me !== null && !me.hasPassword;
  const [displayName, setDisplayName] = useState(me?.displayName ?? '');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const profile = useMutation({
    mutationFn: () => api.updateProfile(displayName.trim()),
    onSuccess: (res) => {
      qc.setQueryData(['me'], res);
      void qc.invalidateQueries();
      toast.success('昵称已更新');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const password = useMutation({
    mutationFn: () => api.changePassword(firstPassword ? undefined : oldPassword, newPassword),
    onSuccess: () => {
      setOldPassword('');
      setNewPassword('');
      if (firstPassword) void qc.invalidateQueries({ queryKey: ['me'] });
      toast.success(firstPassword ? '密码已设置' : '密码已修改，其他设备已退出登录');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="section-title">账号设置</h1>
      <Card className="space-y-4 p-6">
        <h2 className="font-semibold">个人资料</h2>
        <Field label="用户名" hint="用户名不可修改">
          <Input value={me?.username ?? ''} disabled className="opacity-60" />
        </Field>
        <Field label="昵称">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={24} />
        </Field>
        <Button
          onClick={() => profile.mutate()}
          loading={profile.isPending}
          disabled={!displayName.trim() || displayName.trim() === me?.displayName}
        >
          保存
        </Button>
      </Card>
      {config?.sso && me && (
        <Card className="space-y-3 p-6">
          <h2 className="font-semibold">ky-z 账号</h2>
          {me.kyzLinked ? (
            <p className="text-sm leading-relaxed text-dim">已关联 ky-z 账号，用它登录所有 ky-z 网站。</p>
          ) : (
            <>
              <p className="text-sm leading-relaxed text-dim">
                还没有关联 ky-z 账号。关联后就用 ky-z 账号登录，水滴、下注和排名都不变。
              </p>
              <a href={ssoLoginUrl({ link: true, next: '/settings' })} className={buttonClass()}>
                关联 ky-z 账号
              </a>
            </>
          )}
        </Card>
      )}
      <Card className="space-y-4 p-6">
        <h2 className="font-semibold">{firstPassword ? '设置密码' : '修改密码'}</h2>
        {firstPassword ? (
          <p className="text-sm leading-relaxed text-dim">
            账号是用 ky-z 账号注册的，平时不需要密码。设一个密码后也能用用户名和密码登录，比如给 Python SDK 用。
          </p>
        ) : (
          <Field label="当前密码">
            <Input
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
        )}
        <Field label="新密码" hint="至少 6 位">
          <Input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <Button
          onClick={() => password.mutate()}
          loading={password.isPending}
          disabled={(!firstPassword && !oldPassword) || newPassword.length < 6}
        >
          {firstPassword ? '设置密码' : '修改密码'}
        </Button>
      </Card>
    </div>
  );
}
