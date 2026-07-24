import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Clock3, Download, KeyRound, ShieldCheck, Trash2 } from 'lucide-react'
import { NavLink } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { apiFetch } from '@/lib/api'
import { formatBeijingDateTime } from '@/lib/utils'

type CodexAccount = {
  id: number
  label: string
  account_id: string | null
  enabled: number
  status: string
  last_used_at: string | null
  last_error: string | null
  models: string[]
  quota_used_percent: number | null
  quota_remaining_percent: number | null
  quota_reset_at: string | null
  quota_synced_at: string | null
  plan_type: string | null
}

type AccountsResponse = { accounts: CodexAccount[] }
type ImportLocalResponse = {
  success: boolean
  account_id: string | null
  models: string[]
  model_discovery_error: string | null
}
type DeviceStartResponse = {
  loginId: string
  verificationUrl: string
  userCode: string
  expiresInSeconds: number
}
type DeviceStatusResponse = {
  status: 'pending' | 'complete' | 'failed'
  imported: number
  account_id: string | null
  models: string[]
  model_discovery_error: string | null
  error: string | null
}

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

function statusStyle(status: string, enabled: boolean) {
  if (!enabled) return 'border-border bg-muted/40 text-muted-foreground'
  if (status === 'healthy') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
  if (status === 'unhealthy') return 'border-red-500/30 bg-red-500/10 text-red-400'
  return 'border-amber-500/30 bg-amber-500/10 text-amber-300'
}

function statusLabel(status: string, enabled: boolean) {
  if (!enabled) return '已禁用'
  if (status === 'healthy') return '健康'
  if (status === 'unhealthy') return '异常'
  return '待检测'
}

export default function AdminCodexAccountsPage() {
  const queryClient = useQueryClient()
  const accountsSectionRef = useRef<HTMLElement>(null)
  const authFileInputRef = useRef<HTMLInputElement>(null)
  const [importResult, setImportResult] = useState<{ imported: number; error: string | null } | null>(null)
  const [deviceAuth, setDeviceAuth] = useState<DeviceStartResponse | null>(null)
  const [isStartingAuth, setIsStartingAuth] = useState(false)
  const [checkingAccountId, setCheckingAccountId] = useState<number | null>(null)
  const [expandedModelAccounts, setExpandedModelAccounts] = useState<Set<number>>(() => new Set())
  const { data, isLoading, error, dataUpdatedAt } = useQuery<AccountsResponse>({
    queryKey: ['admin-codex-accounts'],
    queryFn: () => apiFetch('/api/admin/codex/accounts'),
    refetchInterval: 5_000,
  })

  const updateAccount = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiFetch(`/api/admin/codex/accounts/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-codex-accounts'] }),
  })

  const deleteAccount = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/admin/codex/accounts/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setImportResult({ imported: 0, error: null })
      await queryClient.invalidateQueries({ queryKey: ['admin-codex-accounts'] })
    },
    onError: (mutationError) => {
      setImportResult({ imported: 0, error: mutationError instanceof Error ? mutationError.message : '删除账号失败' })
    },
  })

  const importLocalAccount = useMutation({
    mutationFn: (auth: unknown) => apiFetch<ImportLocalResponse>('/api/admin/codex/import-auth-json', {
      method: 'POST',
      body: JSON.stringify(auth),
    }),
    onSuccess: async (result) => {
      setImportResult({ imported: result.success ? 1 : 0, error: result.model_discovery_error })
      await queryClient.invalidateQueries({ queryKey: ['admin-codex-accounts'] })
    },
    onError: (mutationError) => {
      setImportResult({ imported: 0, error: mutationError instanceof Error ? mutationError.message : '导入失败' })
    },
  })

  const healthCheckAccount = useMutation({
    mutationFn: (id: number) => apiFetch<{ success: boolean; account: CodexAccount }>(
      `/api/admin/codex/accounts/${id}/health-check`,
      { method: 'POST' },
    ),
    onSuccess: async (result) => {
      setImportResult({
        imported: 0,
        error: result.success ? null : result.account.last_error || 'Codex 账号检测失败',
      })
      await queryClient.invalidateQueries({ queryKey: ['admin-codex-accounts'] })
    },
    onError: (mutationError) => {
      setImportResult({ imported: 0, error: mutationError instanceof Error ? mutationError.message : 'Codex 账号检测失败' })
    },
    onSettled: () => setCheckingAccountId(null),
  })

  const importAuthFile = async (file: File | undefined) => {
    if (!file) return
    setImportResult(null)
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('auth.json 文件过大')
      const auth = JSON.parse(await file.text()) as unknown
      importLocalAccount.mutate(auth)
    } catch (fileError) {
      setImportResult({ imported: 0, error: fileError instanceof Error ? fileError.message : '无法读取 auth.json' })
    } finally {
      if (authFileInputRef.current) authFileInputRef.current.value = ''
    }
  }

  useEffect(() => {
    if (!deviceAuth) return
    let stopped = false
    const poll = async () => {
      try {
        const result = await apiFetch<DeviceStatusResponse>(
          `/api/admin/codex-auth/device/status/${deviceAuth.loginId}`,
        )
        if (stopped || result.status === 'pending') return
        setDeviceAuth(null)
        if (result.status === 'complete') {
          setImportResult({ imported: result.imported, error: result.model_discovery_error })
          await queryClient.invalidateQueries({ queryKey: ['admin-codex-accounts'] })
        } else {
          setImportResult({ imported: 0, error: result.error || 'Codex 授权失败' })
        }
      } catch (pollError) {
        if (!stopped) {
          setDeviceAuth(null)
          setImportResult({ imported: 0, error: pollError instanceof Error ? pollError.message : '授权状态检查失败' })
        }
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 2_500)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [deviceAuth, queryClient])

  const startDeviceAuthorization = async () => {
    const popup = window.open('about:blank', '_blank')
    if (popup) popup.opener = null
    setIsStartingAuth(true)
    setImportResult(null)
    try {
      const result = await apiFetch<DeviceStartResponse>('/api/admin/codex-auth/device/start', { method: 'POST' })
      setDeviceAuth(result)
      if (popup) popup.location.href = result.verificationUrl
      else window.open(result.verificationUrl, '_blank', 'noopener,noreferrer')
    } catch (startError) {
      popup?.close()
      setImportResult({ imported: 0, error: startError instanceof Error ? startError.message : '无法启动 Codex 授权' })
    } finally {
      setIsStartingAuth(false)
    }
  }

  const accounts = data?.accounts ?? []
  const enabledCount = accounts.filter((account) => Boolean(account.enabled)).length
  const healthyCount = accounts.filter((account) => Boolean(account.enabled) && account.status === 'healthy').length
  const modelCount = new Set(accounts.flatMap((account) => account.models)).size

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Codex 账号池</h1>
          <p className="mt-2 text-sm text-muted-foreground">管理 OAuth 账号、健康状态和每个账号支持的真实 Codex 模型。</p>
        </div>
        <CodexAdminTabs />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Metric
          icon={<KeyRound className="size-4" />}
          label="账号总数"
          value={accounts.length}
          onClick={() => accountsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        />
        <Metric icon={<ShieldCheck className="size-4" />} label="已启用 / 健康" value={`${enabledCount} / ${healthyCount}`} />
        <Metric icon={<Activity className="size-4" />} label="已发现模型" value={modelCount} />
      </div>

      <section ref={accountsSectionRef} className="scroll-mt-24 rounded-3xl border border-border/70 bg-background/65 p-4 shadow-2xl backdrop-blur-xl sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">OAuth 账号</h2>
            <p className="mt-1 text-xs text-muted-foreground">每 5 秒自动刷新。禁用后会立即退出 Codex 动态路由。</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <Button size="sm" onClick={() => void startDeviceAuthorization()} disabled={isStartingAuth || Boolean(deviceAuth)}>
              <Download className="size-4" />
              {isStartingAuth ? '正在启动授权…' : deviceAuth ? '等待 OpenAI 授权…' : '授权并导入 Codex 账号'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => authFileInputRef.current?.click()}
              disabled={importLocalAccount.isPending}
            >
              {importLocalAccount.isPending ? '正在导入…' : '选择本机 auth.json 导入'}
            </Button>
            <input
              ref={authFileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(event) => void importAuthFile(event.target.files?.[0])}
            />
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock3 className="size-3.5" />
              {dataUpdatedAt ? `更新于 ${new Date(dataUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '尚未更新'}
            </div>
          </div>
        </div>

        {deviceAuth && (
          <div className="mt-5 rounded-2xl border border-sky-500/30 bg-sky-500/10 p-5 text-sm">
            <p className="font-medium text-sky-200">请在 OpenAI 页面完成 Codex 授权</p>
            <p className="mt-2 text-muted-foreground">浏览器已打开授权页，请输入下面的验证码。授权完成后本页面会自动导入账号。</p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <code className="rounded-xl border border-sky-400/30 bg-background/70 px-4 py-2 text-lg font-semibold tracking-widest text-sky-100">
                {deviceAuth.userCode}
              </code>
              <Button size="sm" variant="outline" onClick={() => window.open(deviceAuth.verificationUrl, '_blank', 'noopener,noreferrer')}>
                重新打开授权页面
              </Button>
            </div>
          </div>
        )}

        {importResult && (
          <div className={`mt-5 rounded-2xl border p-4 text-sm ${importResult.error ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'}`}>
            <p>成功导入 {importResult.imported} 个 Codex 授权账号。</p>
            {importResult.error && <p className="mt-1 break-words text-xs opacity-90">错误信息：{importResult.error}</p>}
          </div>
        )}

        {isLoading ? (
          <div className="py-16 text-center text-sm text-muted-foreground">正在读取账号池…</div>
        ) : error ? (
          <div className="mt-5 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
            {error instanceof Error ? error.message : '账号池加载失败'}
          </div>
        ) : accounts.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
            暂无 Codex OAuth 账号。请先通过现有 OAuth 导入流程添加正式账号。
          </div>
        ) : (
          <div className="mt-5 grid items-start gap-4 lg:grid-cols-2">
            {accounts.map((account) => {
              const enabled = Boolean(account.enabled)
              const modelsExpanded = expandedModelAccounts.has(account.id)
              const visibleModels = modelsExpanded ? account.models : account.models.slice(0, 3)
              return (
                <article key={account.id} className="rounded-2xl border border-border/70 bg-card/70 p-5 backdrop-blur-xl">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-lg font-semibold">{account.label}</h3>
                        <span className={`rounded-full border px-2 py-0.5 text-xs ${statusStyle(account.status, enabled)}`}>
                          {statusLabel(account.status, enabled)}
                        </span>
                      </div>
                      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                        {account.account_id || `内部账号 #${account.id}`}
                      </p>
                    </div>
                    <label className="flex shrink-0 items-center gap-2 text-sm">
                      <span>{enabled ? '已启用' : '已禁用'}</span>
                      <Switch
                        checked={enabled}
                        disabled={updateAccount.isPending}
                        onCheckedChange={(checked) => updateAccount.mutate({ id: account.id, enabled: checked })}
                      />
                    </label>
                  </div>

                  <div className="mt-5 grid gap-3 sm:grid-cols-2">
                    <Info
                      label="剩余额度"
                      value={account.quota_remaining_percent == null
                        ? '尚未同步'
                        : `${account.quota_remaining_percent.toFixed(1)}%`}
                    />
                    <Info label="下次额度重置" value={formatBeijingDateTime(account.quota_reset_at)} />
                  </div>

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      {account.plan_type ? `套餐：${account.plan_type}` : '套餐：未同步'}
                      {' · '}
                      {account.quota_used_percent == null ? '已用：未同步' : `已用：${account.quota_used_percent.toFixed(1)}%`}
                    </span>
                    <span>额度同步：{formatBeijingDateTime(account.quota_synced_at)}</span>
                  </div>

                  <div className="mt-5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs text-muted-foreground">支持模型（{account.models.length}）</p>
                      {account.models.length > 3 && (
                        <button
                          type="button"
                          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() => setExpandedModelAccounts((current) => {
                            const next = new Set(current)
                            if (next.has(account.id)) next.delete(account.id)
                            else next.add(account.id)
                            return next
                          })}
                        >
                          {modelsExpanded ? '收起' : `展开全部 ${account.models.length} 个`}
                        </button>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {account.models.length > 0 ? visibleModels.map((model) => (
                        <span key={model} className="rounded-lg border border-border/70 bg-background/70 px-2 py-1 font-mono text-xs">
                          {model}
                        </span>
                      )) : <span className="text-sm text-muted-foreground">尚未发现模型能力</span>}
                    </div>
                  </div>

                  {account.last_error && (
                    <div className="mt-5 rounded-xl border border-red-500/25 bg-red-500/10 p-3">
                      <p className="text-xs font-medium text-red-300">最近错误</p>
                      <p className="mt-1 break-words text-xs leading-5 text-red-200/80">{account.last_error}</p>
                    </div>
                  )}
                  <div className="mt-5 flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={deleteAccount.isPending}
                      onClick={() => {
                        if (window.confirm(`确定删除 Codex 账号“${account.label}”吗？此操作无法撤销。`)) deleteAccount.mutate(account.id)
                      }}
                    >
                      <Trash2 className="size-4" />
                      删除
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={healthCheckAccount.isPending || !enabled}
                      onClick={() => {
                        setCheckingAccountId(account.id)
                        healthCheckAccount.mutate(account.id)
                      }}
                    >
                      {checkingAccountId === account.id ? '检测中…' : '立即检测'}
                    </Button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

function Metric({ icon, label, value, onClick }: { icon: React.ReactNode; label: string; value: React.ReactNode; onClick?: () => void }) {
  const content = (
    <>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">{icon}{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
    </>
  )
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="rounded-2xl border border-border/70 bg-background/65 p-4 text-left backdrop-blur-xl transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {content}
      </button>
    )
  }
  return <div className="rounded-2xl border border-border/70 bg-background/65 p-4 backdrop-blur-xl">{content}</div>
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/45 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium">{value}</p>
    </div>
  )
}
