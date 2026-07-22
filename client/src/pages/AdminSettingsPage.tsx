import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch } from '@/lib/api'

type Settings = {
  default_consumer_rpm: number
  registration_enabled: boolean
  new_user_bonus_micro: number
  minimum_recharge_micro: number
  maximum_recharge_micro: number
  platform_notice: string
  maintenance_mode: boolean
}

type SettingsDraft = {
  defaultConsumerRpm: string
  registrationEnabled: boolean
  newUserBonus: string
  minimumRecharge: string
  maximumRecharge: string
  platformNotice: string
  maintenanceMode: boolean
}

const amountFromMicro = (micro: number) => {
  const value = Number(micro || 0) / 1_000_000
  return value.toFixed(6).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')
}

const draftFromSettings = (settings: Settings): SettingsDraft => ({
  defaultConsumerRpm: String(settings.default_consumer_rpm),
  registrationEnabled: settings.registration_enabled,
  newUserBonus: amountFromMicro(settings.new_user_bonus_micro),
  minimumRecharge: amountFromMicro(settings.minimum_recharge_micro),
  maximumRecharge: amountFromMicro(settings.maximum_recharge_micro),
  platformNotice: settings.platform_notice,
  maintenanceMode: settings.maintenance_mode,
})

const amountToMicro = (value: string) => Math.round(Number(value) * 1_000_000)

function SettingCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border bg-card/85 p-5 shadow-sm backdrop-blur-md">
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      <div className="mt-5 space-y-4">{children}</div>
    </section>
  )
}

function SettingsEditor({ initialSettings }: { initialSettings: Settings }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<SettingsDraft>(() => draftFromSettings(initialSettings))
  const [savedForm, setSavedForm] = useState<SettingsDraft>(() => draftFromSettings(initialSettings))
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(savedForm), [form, savedForm])

  function buildPayload(draft: SettingsDraft): Settings | null {
    const rpm = Number(draft.defaultConsumerRpm)
    const bonus = Number(draft.newUserBonus)
    const minimum = Number(draft.minimumRecharge)
    const maximum = Number(draft.maximumRecharge)

    if (!Number.isInteger(rpm) || rpm < 0 || rpm > 100000) {
      setError('默认 RPM 必须是 0～100000 的整数；设为 0 会禁止使用平台默认限额的密钥调用。')
      return null
    }
    if (!Number.isFinite(bonus) || bonus < 0) {
      setError('新用户赠送余额必须是大于或等于 0 的金额。')
      return null
    }
    if (!Number.isFinite(minimum) || minimum <= 0 || !Number.isFinite(maximum) || maximum <= 0) {
      setError('最小和最大充值金额必须大于 0。')
      return null
    }
    if (minimum > maximum) {
      setError('最小充值金额不能大于最大充值金额。')
      return null
    }
    if (draft.platformNotice.length > 2000) {
      setError('平台公告不能超过 2000 个字符。')
      return null
    }

    return {
      default_consumer_rpm: rpm,
      registration_enabled: draft.registrationEnabled,
      new_user_bonus_micro: amountToMicro(String(bonus)),
      minimum_recharge_micro: amountToMicro(String(minimum)),
      maximum_recharge_micro: amountToMicro(String(maximum)),
      platform_notice: draft.platformNotice,
      maintenance_mode: draft.maintenanceMode,
    }
  }

  const save = useMutation({
    mutationFn: (payload: Settings) => apiFetch<{ settings: Settings }>('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
    onSuccess: (data) => {
      const next = draftFromSettings(data.settings)
      setForm(next)
      setSavedForm(next)
      setError('')
      setMessage('系统设置已保存并立即生效。')
      queryClient.setQueryData(['admin-settings'], data)
    },
    onError: (saveError) => {
      setMessage('')
      setError((saveError as Error).message || '保存失败，请稍后重试。')
    },
  })

  function update<K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) {
    setMessage('')
    setError('')
    setForm((current) => ({ ...current, [key]: value }))
  }

  function submit() {
    const payload = buildPayload(form)
    if (payload) save.mutate(payload)
  }

  return (
    <div className="max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">系统设置</h1>
          <p className="mt-1 text-sm text-muted-foreground">管理 API 限额、注册策略、充值范围和平台运行状态。</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border px-3 py-1">默认 {form.defaultConsumerRpm || 0} RPM</span>
          <span className="rounded-full border px-3 py-1">注册{form.registrationEnabled ? '开放' : '关闭'}</span>
          <span className={`rounded-full border px-3 py-1 ${form.maintenanceMode ? 'border-amber-500/50 text-amber-400' : ''}`}>{form.maintenanceMode ? '维护模式' : '正常运行'}</span>
        </div>
      </div>

      {error && <div className="mt-5 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}
      {message && <div className="mt-5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-400">{message}</div>}

      <div className="mt-6 grid items-start gap-5 lg:grid-cols-2">
        <SettingCard title="API 设置" description="设置普通用户 API Key 未单独配置时使用的默认每分钟请求上限。">
          <div>
            <Label htmlFor="default-consumer-rpm">默认 API Key RPM</Label>
            <Input id="default-consumer-rpm" className="mt-2" inputMode="numeric" value={form.defaultConsumerRpm} onChange={(event) => update('defaultConsumerRpm', event.target.value)} placeholder="例如：60" />
            <p className="mt-2 text-xs text-muted-foreground">允许 0～100000；设为 0 会禁止所有使用平台默认限额的密钥调用。</p>
          </div>
        </SettingCard>

        <SettingCard title="用户注册" description="控制新用户是否可以创建账号，以及注册成功后自动发放的余额。">
          <label className="flex items-center justify-between gap-4 rounded-xl bg-background/45 px-3 py-3">
            <span><span className="block text-sm font-medium">开放注册</span><span className="mt-1 block text-xs text-muted-foreground">关闭后现有用户仍可正常登录。</span></span>
            <Switch checked={form.registrationEnabled} onCheckedChange={(checked) => update('registrationEnabled', checked)} />
          </label>
          <div>
            <Label htmlFor="new-user-bonus">新用户赠送余额（美元）</Label>
            <Input id="new-user-bonus" className="mt-2" inputMode="decimal" value={form.newUserBonus} onChange={(event) => update('newUserBonus', event.target.value)} placeholder="例如：5.00" />
          </div>
        </SettingCard>

        <SettingCard title="充值设置" description="限制用户每笔充值订单可提交的金额范围。">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="minimum-recharge">最小充值金额（美元）</Label>
              <Input id="minimum-recharge" className="mt-2" inputMode="decimal" value={form.minimumRecharge} onChange={(event) => update('minimumRecharge', event.target.value)} placeholder="例如：1.00" />
            </div>
            <div>
              <Label htmlFor="maximum-recharge">最大充值金额（美元）</Label>
              <Input id="maximum-recharge" className="mt-2" inputMode="decimal" value={form.maximumRecharge} onChange={(event) => update('maximumRecharge', event.target.value)} placeholder="例如：1000.00" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">保存时会校验最小金额不能大于最大金额。</p>
        </SettingCard>

        <SettingCard title="平台状态" description="公告会展示给用户；维护模式用于临时阻止普通 API 请求。">
          <div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="platform-notice">平台公告</Label>
              <span className="text-xs text-muted-foreground">{form.platformNotice.length}/2000</span>
            </div>
            <Textarea id="platform-notice" className="mt-2 min-h-28 bg-background/70" value={form.platformNotice} maxLength={2000} onChange={(event) => update('platformNotice', event.target.value)} placeholder="留空则不显示公告" />
          </div>
          <label className="flex items-center justify-between gap-4 rounded-xl bg-background/45 px-3 py-3">
            <span><span className="block text-sm font-medium">维护模式</span><span className="mt-1 block text-xs text-muted-foreground">开启前请确认不会影响正在调用 API 的用户。</span></span>
            <Switch checked={form.maintenanceMode} onCheckedChange={(checked) => update('maintenanceMode', checked)} />
          </label>
        </SettingCard>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3 rounded-2xl border bg-card/90 p-4 shadow-sm backdrop-blur-md">
        <Button disabled={save.isPending || !dirty} onClick={submit}>{save.isPending ? '保存中…' : '保存设置'}</Button>
        <Button variant="outline" disabled={save.isPending || !dirty} onClick={() => { setForm(savedForm); setError(''); setMessage('') }}>撤销未保存修改</Button>
        <span className="text-xs text-muted-foreground">{dirty ? '有尚未保存的修改' : '当前设置已保存'}</span>
      </div>
    </div>
  )
}

export default function AdminSettingsPage() {
  const query = useQuery<{ settings: Settings }>({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch('/api/admin/settings'),
  })

  if (query.isError) return <div className="rounded-2xl border border-destructive/40 bg-destructive/10 p-5 text-sm text-destructive">系统设置加载失败，请刷新页面重试。</div>
  if (query.isLoading || !query.data) return <div className="py-12 text-center text-sm text-muted-foreground">正在加载系统设置…</div>

  return <SettingsEditor initialSettings={query.data.settings} />
}
