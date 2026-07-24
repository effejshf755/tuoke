import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, BadgeDollarSign, CircleCheckBig, CircleX, Coins, Gauge, Save, Waypoints } from 'lucide-react'
import { NavLink } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { apiFetch } from '@/lib/api'
import { formatBeijingDateTime } from '@/lib/utils'

type Summary = {
  request_count: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  success_count: number
  error_count: number
  billed_micro: number
}

type AccountStat = {
  id: number
  account_id: string | null
  label: string
  enabled: number
  status: string
  request_count: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  success_count: number
  error_count: number
  billed_micro: number
  last_used_at: string | null
  last_error: string | null
}

type ModelStat = {
  model_id: string
  request_count: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  success_count: number
  error_count: number
  billed_micro: number
  last_used_at: string | null
}

type ErrorRecord = {
  id: number
  account_id: number | null
  account_label: string
  model_id: string
  error: string | null
  created_at: string
  user_email: string | null
  api_key_name: string | null
}

type RecentRecord = ErrorRecord & {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  success: number
  billing_amount_micro: number
  billing_status: string
}

type StatsResponse = {
  summary: Summary
  accounts: AccountStat[]
  models: ModelStat[]
  errors: ErrorRecord[]
  recent: RecentRecord[]
}

type BillingModel = {
  model_id: string
  account_count: number
  enabled_account_count: number
  input_price_per_million: number
  output_price_per_million: number
  multiplier: number
  billing_enabled: boolean
}

type BillingResponse = { models: BillingModel[] }

type BillingDraft = Pick<BillingModel, 'input_price_per_million' | 'output_price_per_million' | 'multiplier' | 'billing_enabled'>

function CodexAdminTabs() {
  const itemClass = ({ isActive }: { isActive: boolean }) =>
    `rounded-lg px-3 py-2 text-sm transition-colors ${
      isActive ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
    }`
  return (
    <nav className="flex w-fit gap-1 rounded-xl border border-border/70 bg-background/65 p-1 backdrop-blur-xl">
      <NavLink to="/admin/codex/accounts" className={itemClass}>账号池</NavLink>
      <NavLink to="/admin/codex/monitor" className={itemClass}>监控与计费</NavLink>
    </nav>
  )
}

const integer = new Intl.NumberFormat('zh-CN')
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })

function moneyFromMicro(value: number) {
  return `$${(Number(value || 0) / 1_000_000).toFixed(4)}`
}

function successRate(success: number, total: number) {
  return total > 0 ? (success / total) * 100 : 0
}

export default function AdminCodexStatsPage() {
  const queryClient = useQueryClient()
  const [drafts, setDrafts] = useState<Record<string, BillingDraft>>({})

  const statsQuery = useQuery<StatsResponse>({
    queryKey: ['admin-codex-stats'],
    queryFn: () => apiFetch('/api/admin/codex/stats'),
    refetchInterval: 5_000,
  })
  const billingQuery = useQuery<BillingResponse>({
    queryKey: ['admin-codex-billing'],
    queryFn: () => apiFetch('/api/admin/codex/billing'),
  })

  useEffect(() => {
    if (!billingQuery.data) return
    setDrafts((current) => {
      const next = { ...current }
      for (const model of billingQuery.data.models) {
        if (!next[model.model_id]) {
          next[model.model_id] = {
            input_price_per_million: model.input_price_per_million,
            output_price_per_million: model.output_price_per_million,
            multiplier: model.multiplier,
            billing_enabled: model.billing_enabled,
          }
        }
      }
      return next
    })
  }, [billingQuery.data])

  const saveBilling = useMutation({
    mutationFn: ({ modelId, draft }: { modelId: string; draft: BillingDraft }) =>
      apiFetch('/api/admin/codex/billing', {
        method: 'PUT',
        body: JSON.stringify({ model_id: modelId, ...draft }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-codex-billing'] }),
  })

  const summary = statsQuery.data?.summary ?? {
    request_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    success_count: 0,
    error_count: 0,
    billed_micro: 0,
  }
  const rate = successRate(summary.success_count, summary.request_count)
  const maxAccountRequests = Math.max(1, ...(statsQuery.data?.accounts ?? []).map((row) => row.request_count))
  const maxModelRequests = Math.max(1, ...(statsQuery.data?.models ?? []).map((row) => row.request_count))
  const recentErrors = useMemo(() => statsQuery.data?.errors.slice(0, 20) ?? [], [statsQuery.data])

  function updateDraft(modelId: string, patch: Partial<BillingDraft>) {
    setDrafts((current) => ({
      ...current,
      [modelId]: { ...current[modelId], ...patch },
    }))
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Codex 监控与计费</h1>
          <p className="mt-2 text-sm text-muted-foreground">按 OAuth 账号和真实 Codex 模型统计调用、Token、错误与独立消费。</p>
        </div>
        <CodexAdminTabs />
      </div>

      {statsQuery.error && (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          {statsQuery.error instanceof Error ? statsQuery.error.message : '监控数据加载失败'}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <Metric icon={<Activity />} label="总调用" value={integer.format(summary.request_count)} />
        <Metric icon={<Coins />} label="总 Token" value={compact.format(summary.total_tokens)} hint={`输入 ${compact.format(summary.input_tokens)} · 输出 ${compact.format(summary.output_tokens)}`} />
        <Metric icon={<CircleCheckBig />} label="成功" value={integer.format(summary.success_count)} tone="success" />
        <Metric icon={<CircleX />} label="失败" value={integer.format(summary.error_count)} tone="danger" />
        <Metric icon={<Gauge />} label="成功率" value={`${rate.toFixed(2)}%`} />
        <Metric icon={<BadgeDollarSign />} label="Codex 收费" value={moneyFromMicro(summary.billed_micro)} />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <RankingCard title="账号排行" subtitle="按调用次数排序">
          {(statsQuery.data?.accounts ?? []).length === 0 ? <Empty text="暂无账号调用数据" /> :
            statsQuery.data!.accounts.map((row) => (
              <RankRow
                key={row.id}
                title={row.label}
                subtitle={`${row.status} · ${compact.format(row.total_tokens)} Token · ${moneyFromMicro(row.billed_micro)}`}
                count={row.request_count}
                success={row.success_count}
                errors={row.error_count}
                width={(row.request_count / maxAccountRequests) * 100}
              />
            ))}
        </RankingCard>

        <RankingCard title="模型排行" subtitle="真实发送给 Codex 上游的模型">
          {(statsQuery.data?.models ?? []).length === 0 ? <Empty text="暂无模型调用数据" /> :
            statsQuery.data!.models.map((row) => (
              <RankRow
                key={row.model_id}
                title={row.model_id}
                subtitle={`${compact.format(row.input_tokens)} 输入 · ${compact.format(row.output_tokens)} 输出 · ${moneyFromMicro(row.billed_micro)}`}
                count={row.request_count}
                success={row.success_count}
                errors={row.error_count}
                width={(row.request_count / maxModelRequests) * 100}
              />
            ))}
        </RankingCard>
      </div>

      <section className="rounded-3xl border border-border/70 bg-background/65 p-4 backdrop-blur-xl sm:p-6">
        <div>
          <h2 className="text-xl font-semibold">Codex 独立价格</h2>
          <p className="mt-1 text-sm text-muted-foreground">价格单位与普通模型计费页面一致；只作用于真实 Codex 模型，不改变普通模型计费。</p>
        </div>
        {billingQuery.isLoading ? <Empty text="正在读取 Codex 价格…" /> : billingQuery.error ? (
          <div className="mt-5 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
            {billingQuery.error instanceof Error ? billingQuery.error.message : '价格加载失败'}
          </div>
        ) : (
          <div className="mt-5 grid items-start gap-4 lg:grid-cols-2">
            {(billingQuery.data?.models ?? []).map((model) => {
              const draft = drafts[model.model_id]
              if (!draft) return null
              return (
                <article key={model.model_id} className="rounded-2xl border border-border/70 bg-card/65 p-5 backdrop-blur-xl">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="break-all font-mono text-sm font-semibold">{model.model_id}</h3>
                      <p className="mt-1 text-xs text-muted-foreground">{model.enabled_account_count} / {model.account_count} 个可用账号</p>
                    </div>
                    <label className="flex shrink-0 items-center gap-2 text-sm">
                      计费
                      <Switch checked={draft.billing_enabled} onCheckedChange={(checked) => updateDraft(model.model_id, { billing_enabled: checked })} />
                    </label>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <NumberField label="输入价格 / 1M" value={draft.input_price_per_million} onChange={(value) => updateDraft(model.model_id, { input_price_per_million: value })} />
                    <NumberField label="输出价格 / 1M" value={draft.output_price_per_million} onChange={(value) => updateDraft(model.model_id, { output_price_per_million: value })} />
                    <NumberField label="倍率" value={draft.multiplier} step="0.001" onChange={(value) => updateDraft(model.model_id, { multiplier: value })} />
                  </div>
                  <Button
                    className="mt-4 w-full"
                    disabled={saveBilling.isPending}
                    onClick={() => saveBilling.mutate({ modelId: model.model_id, draft })}
                  >
                    <Save className="size-4" />保存价格
                  </Button>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <div className="grid items-start gap-6 xl:grid-cols-[1.25fr_0.75fr]">
        <section className="rounded-3xl border border-border/70 bg-background/65 p-4 backdrop-blur-xl sm:p-6">
          <h2 className="text-xl font-semibold">最近调用</h2>
          <div className="mt-4 max-h-[34rem] space-y-2 overflow-y-auto pr-1">
            {(statsQuery.data?.recent ?? []).length === 0 ? <Empty text="暂无 Codex 调用记录" /> :
              statsQuery.data!.recent.map((row) => (
                <div key={row.id} className="rounded-xl border border-border/60 bg-card/50 p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="break-all font-mono text-xs">{row.model_id}</span>
                    <span className={row.success ? 'text-emerald-400' : 'text-red-400'}>{row.success ? '成功' : '失败'}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{row.account_label}</span><span>{row.user_email || '系统检测'}</span>
                    <span>{compact.format(row.total_tokens)} Token</span><span>{moneyFromMicro(row.billing_amount_micro)}</span>
                    <span>{formatBeijingDateTime(row.created_at)}</span>
                  </div>
                </div>
              ))}
          </div>
        </section>

        <section className="rounded-3xl border border-border/70 bg-background/65 p-4 backdrop-blur-xl sm:p-6">
          <h2 className="text-xl font-semibold">最近错误</h2>
          <div className="mt-4 max-h-[34rem] space-y-3 overflow-y-auto pr-1">
            {recentErrors.length === 0 ? <Empty text="暂无错误记录" /> : recentErrors.map((row) => (
              <div key={row.id} className="rounded-xl border border-red-500/20 bg-red-500/8 p-3">
                <div className="flex flex-wrap justify-between gap-2 text-xs">
                  <span className="font-mono text-red-200">{row.model_id}</span>
                  <span className="text-muted-foreground">{formatBeijingDateTime(row.created_at)}</span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{row.account_label} · {row.user_email || '系统检测'}</p>
                <p className="mt-2 break-words text-xs leading-5 text-red-300">{row.error || '未知错误'}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function Metric({ icon, label, value, hint, tone }: { icon: React.ReactNode; label: string; value: React.ReactNode; hint?: string; tone?: 'success' | 'danger' }) {
  const color = tone === 'success' ? 'text-emerald-400' : tone === 'danger' ? 'text-red-400' : 'text-foreground'
  return (
    <div className="rounded-2xl border border-border/70 bg-background/65 p-4 backdrop-blur-xl">
      <div className="flex items-center gap-2 text-xs text-muted-foreground [&_svg]:size-4">{icon}{label}</div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

function RankingCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="rounded-3xl border border-border/70 bg-background/65 p-4 backdrop-blur-xl sm:p-6">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  )
}

function RankRow({ title, subtitle, count, success, errors, width }: { title: string; subtitle: string; count: number; success: number; errors: number; width: number }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><p className="truncate text-sm font-medium">{title}</p><p className="mt-1 truncate text-xs text-muted-foreground">{subtitle}</p></div>
        <span className="shrink-0 text-sm font-semibold tabular-nums">{integer.format(count)} 次</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-foreground transition-all" style={{ width: `${Math.max(2, width)}%` }} /></div>
      <div className="mt-2 flex gap-3 text-[11px] text-muted-foreground"><span className="text-emerald-400">成功 {success}</span><span className="text-red-400">失败 {errors}</span><span>成功率 {successRate(success, count).toFixed(2)}%</span></div>
    </div>
  )
}

function NumberField({ label, value, onChange, step = '0.000001' }: { label: string; value: number; onChange: (value: number) => void; step?: string }) {
  return (
    <label className="text-xs text-muted-foreground">
      {label}
      <Input className="mt-2" type="number" min="0" step={step} value={Number.isFinite(value) ? value : 0} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="py-10 text-center text-sm text-muted-foreground"><Waypoints className="mx-auto mb-2 size-5" />{text}</div>
}
