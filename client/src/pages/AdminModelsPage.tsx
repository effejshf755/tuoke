import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch } from '@/lib/api'

type ModelMetadata = {
  manufacturer?: string
  upstreamPlatform?: string
  modelType?: string
  billingType?: string
  apiType?: string
  sourceMethod?: string
  description?: string
}

type ModelHealth = {
  status: 'success' | 'failed'
  lastCheckedAt: string
  error: string | null
  latencyMs: number
}

type ModelRow = {
  id: number
  platform: string
  modelId: string
  displayName: string
  enabled: boolean
  fallbackEnabled: boolean
  metadata?: ModelMetadata
  health: ModelHealth | null
}

type BillingRow = {
  id: number
  platform: string
  model_id: string
  display_name: string
  model_enabled: boolean
  billing_configured: boolean
  input_price_per_million: number
  output_price_per_million: number
  multiplier: number
  billing_enabled: boolean
}

type UnifiedModel = {
  id: number
  platform: string
  modelId: string
  displayName: string
  enabled: boolean
  fallbackEnabled: boolean
  userVisible: boolean
  billingConfigured: boolean
  inputPrice: number
  outputPrice: number
  multiplier: number
  billingEnabled: boolean
  metadata: ModelMetadata
  health: ModelHealth | null
}

type Draft = {
  enabled: boolean
  fallbackEnabled: boolean
  inputPrice: string
  outputPrice: string
  multiplier: string
  billingEnabled: boolean
}

type OpenRouterCandidate = {
  modelId: string
  name: string
  contextLength: number | null
  description: string
  pricing: { prompt: string; completion: string }
  metadata: ModelMetadata
  free: boolean
}

const EMPTY_METADATA: Required<ModelMetadata> = {
  manufacturer: '',
  upstreamPlatform: '',
  modelType: '',
  billingType: '',
  apiType: '',
  sourceMethod: '',
  description: '',
}

function metadataValue(value: string | undefined) {
  return value?.trim() || '未设置'
}

function SwitchField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex min-h-12 items-center justify-between gap-3 rounded-xl border px-3 text-sm">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-primary" />
    </label>
  )
}

function NumberField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="grid gap-1.5 text-xs text-muted-foreground">
      {label}
      <Input type="number" min="0" step="0.000001" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  )
}

export default function AdminModelsPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'visible' | 'health-success'>('all')
  const [sortBy, setSortBy] = useState<'default' | 'available' | 'health' | 'name' | 'platform'>(() => {
    const saved = window.localStorage.getItem('admin-models-sort')
    return saved === 'available' || saved === 'health' || saved === 'name' || saved === 'platform' ? saved : 'default'
  })
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [drafts, setDrafts] = useState<Record<number, Partial<Draft>>>({})
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [discoverOpen, setDiscoverOpen] = useState(false)
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([])
  const [selectedModelIds, setSelectedModelIds] = useState<number[]>([])

  useEffect(() => {
    window.localStorage.setItem('admin-models-sort', sortBy)
  }, [sortBy])

  const modelsQuery = useQuery<ModelRow[]>({
    queryKey: ['admin-models-base'],
    queryFn: () => apiFetch('/api/models'),
  })

  const billingQuery = useQuery<{ models: BillingRow[] }>({
    queryKey: ['admin-models-billing'],
    queryFn: () => apiFetch('/api/admin/billing/models'),
  })

  const discover = useMutation<{ count: number; models: OpenRouterCandidate[] }, Error>({
    mutationFn: () => apiFetch('/api/models/discover/openrouter-free'),
    onSuccess: () => {
      setDiscoverOpen(true)
      setSelectedCandidates([])
      setError('')
    },
    onError: (mutationError) => setError(mutationError.message),
  })

  const availableCandidates = discover.data?.models ?? []

  const importSelected = useMutation<{ added: number; skipped: number }, Error>({
    mutationFn: () => apiFetch('/api/models/import/openrouter-free', {
      method: 'POST',
      body: JSON.stringify({
        models: (discover.data?.models ?? []).filter((candidate) => selectedCandidates.includes(candidate.modelId)),
      }),
    }),
    onSuccess: (result) => {
      setMessage(`已添加 ${result.added} 个模型，跳过 ${result.skipped} 个已存在模型`)
      setSelectedCandidates([])
      queryClient.invalidateQueries({ queryKey: ['admin-models-base'] })
      queryClient.invalidateQueries({ queryKey: ['admin-models-billing'] })
    },
    onError: (mutationError) => setError(mutationError.message),
  })

  const healthCheck = useMutation<{ id: number; health: ModelHealth }, Error, UnifiedModel>({
    mutationFn: (model) => apiFetch(`/api/models/${model.id}/health-check`, { method: 'POST' }),
    onSuccess: (result, model) => {
      setMessage(result.health.status === 'success' ? `模型检测成功：${model.displayName}` : `模型检测失败：${model.displayName}`)
      queryClient.invalidateQueries({ queryKey: ['admin-models-base'] })
    },
    onError: (mutationError) => setError(mutationError.message),
  })

  const healthCheckAll = useMutation<{ total: number; success: number; failed: number }, Error>({
    mutationFn: () => apiFetch('/api/models/health-check-all', { method: 'POST' }),
    onSuccess: (result) => {
      setMessage(`全部检测完成：共 ${result.total} 个，成功 ${result.success} 个，失败 ${result.failed} 个`)
      queryClient.invalidateQueries({ queryKey: ['admin-models-base'] })
    },
    onError: (mutationError) => setError(mutationError.message),
  })

  const bulkUpdate = useMutation<void, Error, { action: 'visible' | 'hidden' | 'start' | 'stop' }>({
    mutationFn: async ({ action }) => {
      const selected = models.filter((model) => selectedModelIds.includes(model.id))
      await Promise.all(selected.map(async (model) => {
        if (action === 'start' || action === 'stop') {
          await apiFetch(`/api/models/${model.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: action === 'start', fallbackEnabled: model.fallbackEnabled }) })
        } else {
          await apiFetch(`/api/admin/billing/models/${model.id}`, { method: 'PUT', body: JSON.stringify({ input_price_per_million: model.inputPrice, output_price_per_million: model.outputPrice, multiplier: model.multiplier, billing_enabled: action === 'visible' }) })
        }
      }))
    },
    onSuccess: async () => { setMessage(`批量操作完成：${selectedModelIds.length} 个模型`); setError(''); setSelectedModelIds([]); await queryClient.invalidateQueries({ queryKey: ['admin-models-base'] }); await queryClient.invalidateQueries({ queryKey: ['admin-models-billing'] }) },
    onError: (mutationError) => { setMessage(''); setError(mutationError.message) },
  })

  const models = useMemo(() => {
    const baseById = new Map((modelsQuery.data ?? []).map((model) => [model.id, model]))

    return (billingQuery.data?.models ?? []).map((billing): UnifiedModel => {
      const base = baseById.get(billing.id)
      const enabled = base?.enabled ?? billing.model_enabled
      const fallbackEnabled = base?.fallbackEnabled ?? false
      const billingConfigured = billing.billing_configured
      const billingEnabled = billing.billing_enabled

      return {
        id: billing.id,
        platform: billing.platform,
        modelId: base?.modelId ?? billing.model_id,
        displayName: base?.displayName ?? billing.display_name,
        enabled,
        fallbackEnabled,
        userVisible: enabled && billingConfigured && billingEnabled,
        billingConfigured,
        inputPrice: billing.input_price_per_million,
        outputPrice: billing.output_price_per_million,
        multiplier: billing.multiplier,
        billingEnabled,
        metadata: { ...EMPTY_METADATA, ...(base?.metadata ?? {}) },
        health: base?.health ?? null,
      }
    })
  }, [billingQuery.data, modelsQuery.data])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = models.filter((model) => {
      if (statusFilter === 'enabled' && !model.enabled) return false
      if (statusFilter === 'visible' && !model.userVisible) return false
      if (statusFilter === 'health-success' && model.health?.status !== 'success') return false
      if (!q) return true
      const searchable = [
        model.platform,
        model.modelId,
        model.displayName,
        ...Object.values(model.metadata),
      ].join(' ').toLowerCase()
      return searchable.includes(q)
    })

    return [...filtered].sort((a, b) => {
      if (sortBy === 'available') {
        return Number(b.userVisible) - Number(a.userVisible) || a.displayName.localeCompare(b.displayName)
      }
      if (sortBy === 'health') {
        const rank = (model: UnifiedModel) => model.health?.status === 'success' ? 0 : model.health?.status === 'failed' ? 2 : 1
        return rank(a) - rank(b) || a.displayName.localeCompare(b.displayName)
      }
      if (sortBy === 'name') return a.displayName.localeCompare(b.displayName)
      if (sortBy === 'platform') return a.platform.localeCompare(b.platform) || a.displayName.localeCompare(b.displayName)
      return 0
    })
  }, [models, search, sortBy, statusFilter])

  const enabledCount = models.filter((model) => model.enabled).length
  const visibleCount = models.filter((model) => model.userVisible).length
  const healthSuccessCount = models.filter((model) => model.health?.status === 'success').length
  const loading = modelsQuery.isLoading || billingQuery.isLoading

  function draftFor(model: UnifiedModel): Draft {
    const draft = drafts[model.id] ?? {}
    return {
      enabled: draft.enabled ?? model.enabled,
      fallbackEnabled: draft.fallbackEnabled ?? model.fallbackEnabled,
      inputPrice: draft.inputPrice ?? String(model.inputPrice),
      outputPrice: draft.outputPrice ?? String(model.outputPrice),
      multiplier: draft.multiplier ?? String(model.multiplier),
      billingEnabled: draft.billingEnabled ?? model.billingEnabled,
    }
  }

  function updateDraft(id: number, patch: Partial<Draft>) {
    setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? {}), ...patch } }))
  }

  const saveModel = useMutation({
    mutationFn: async (model: UnifiedModel) => {
      const draft = draftFor(model)
      const inputPrice = Number(draft.inputPrice)
      const outputPrice = Number(draft.outputPrice)
      const multiplier = Number(draft.multiplier)

      if (![inputPrice, outputPrice, multiplier].every((value) => Number.isFinite(value) && value >= 0)) {
        throw new Error('价格和倍率必须是大于或等于 0 的数字')
      }

      await apiFetch(`/api/models/${model.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          enabled: draft.enabled,
          fallbackEnabled: draft.fallbackEnabled,
        }),
      })

      await apiFetch(`/api/admin/billing/models/${model.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          input_price_per_million: inputPrice,
          output_price_per_million: outputPrice,
          multiplier,
          billing_enabled: draft.billingEnabled,
        }),
      })
    },
    onSuccess: async (_data, model) => {
      setError('')
      setMessage(`模型配置已保存：${model.displayName}`)
      setDrafts((current) => {
        const next = { ...current }
        delete next[model.id]
        return next
      })
      await queryClient.invalidateQueries({ queryKey: ['admin-models-base'] })
      await queryClient.invalidateQueries({ queryKey: ['admin-models-billing'] })
    },
    onError: (mutationError) => {
      setMessage('')
      setError((mutationError as Error).message)
    },
  })

  return (
    <div className="max-w-[1700px]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">统一模型管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">自动导入和维护模型资料，集中查看来源、可见性与健康检测结果。</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <Button size="sm" variant="outline" onClick={() => healthCheckAll.mutate()} disabled={healthCheckAll.isPending || healthCheck.isPending}>
            {healthCheckAll.isPending ? '正在检测全部…' : '检测全部模型'}
          </Button>
          <Button size="sm" onClick={() => discover.mutate()} disabled={discover.isPending}>
            {discover.isPending ? '正在同步…' : '同步 OpenRouter 免费模型'}
          </Button>
          <button type="button" aria-pressed={statusFilter === 'enabled'} onClick={() => setStatusFilter(statusFilter === 'enabled' ? 'all' : 'enabled')} className={`rounded-full border px-3 py-1 text-xs transition-colors hover:bg-accent ${statusFilter === 'enabled' ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}>启用 {enabledCount}</button>
          <button type="button" aria-pressed={statusFilter === 'visible'} onClick={() => setStatusFilter(statusFilter === 'visible' ? 'all' : 'visible')} className={`rounded-full border px-3 py-1 text-xs transition-colors hover:bg-accent ${statusFilter === 'visible' ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}>用户可见 {visibleCount}</button>
          <button type="button" aria-pressed={statusFilter === 'health-success'} onClick={() => setStatusFilter(statusFilter === 'health-success' ? 'all' : 'health-success')} className={`rounded-full border px-3 py-1 text-xs transition-colors hover:bg-accent ${statusFilter === 'health-success' ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}>检测成功 {healthSuccessCount}</button>
        </div>
      </div>

      {discoverOpen && (
        <div className="mt-6 rounded-3xl border bg-card/90 p-4 shadow-sm backdrop-blur-md">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">OpenRouter 免费模型候选</h2>
              <p className="mt-1 text-sm text-muted-foreground">候选资料来自 OpenRouter /models，选中后会自动写入模型资料和免费计费规则。</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setDiscoverOpen(false)}>关闭</Button>
          </div>
          <div className="mt-4 overflow-x-auto">
            <Button size="sm" className="mb-3" onClick={() => importSelected.mutate()} disabled={selectedCandidates.length === 0 || importSelected.isPending}>
              {importSelected.isPending ? '正在添加…' : `添加选中模型（${selectedCandidates.length}）`}
            </Button>
            <Button size="sm" variant="outline" className="mb-3 ml-2" onClick={() => setSelectedCandidates(selectedCandidates.length === availableCandidates.length ? [] : availableCandidates.map((candidate) => candidate.modelId))} disabled={availableCandidates.length === 0}>
              {selectedCandidates.length === availableCandidates.length ? '取消全选' : '一键全选'}
            </Button>
            <table className="w-full min-w-[900px] border-separate border-spacing-y-2 text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">选择</th>
                  <th className="px-4 py-2 font-medium">模型名称</th>
                  <th className="px-4 py-2 font-medium">模型 ID</th>
                  <th className="px-4 py-2 font-medium">厂家</th>
                  <th className="px-4 py-2 font-medium">上下文</th>
                  <th className="px-4 py-2 font-medium">价格</th>
                </tr>
              </thead>
              <tbody>
                {(discover.data?.models ?? []).map((candidate) => (
                  <tr key={candidate.modelId}>
                    <td className="rounded-l-2xl border-y border-l bg-background/60 px-4 py-3">
                      <input type="checkbox" checked={selectedCandidates.includes(candidate.modelId)} onChange={(event) => setSelectedCandidates((current) => event.target.checked ? [...current, candidate.modelId] : current.filter((id) => id !== candidate.modelId))} />
                    </td>
                    <td className="border-y bg-background/60 px-4 py-3 font-medium">{candidate.name}</td>
                    <td className="border-y bg-background/60 px-4 py-3 font-mono text-xs">{candidate.modelId}</td>
                    <td className="border-y bg-background/60 px-4 py-3">{metadataValue(candidate.metadata.manufacturer)}</td>
                    <td className="border-y bg-background/60 px-4 py-3">{candidate.contextLength?.toLocaleString() ?? '未知'}</td>
                    <td className="rounded-r-2xl border-y border-r bg-background/60 px-4 py-3"><Badge variant="default">免费</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {discover.data?.models.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">暂未发现免费模型。</p>}
          </div>
        </div>
      )}

      <div className="mt-6 rounded-3xl border bg-card/70 p-4 backdrop-blur">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 flex-wrap gap-3">
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索平台、模型 ID、名称或厂家" className="sm:max-w-md" />
            <select aria-label="模型排序" value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)} className="h-9 rounded-md border border-input bg-background/85 px-3 text-sm text-foreground backdrop-blur-md" style={{ colorScheme: 'dark' }}>
              <option value="default">默认顺序</option>
              <option value="available">可用优先</option>
              <option value="health">健康优先</option>
              <option value="name">名称排序</option>
              <option value="platform">平台排序</option>
            </select>
            <Button size="sm" variant="outline" onClick={() => setSelectedModelIds(selectedModelIds.length === rows.length ? [] : rows.map((model) => model.id))} disabled={rows.length === 0 || bulkUpdate.isPending}>
              {selectedModelIds.length === rows.length ? '取消全选' : '一键全选'}
            </Button>
            {selectedModelIds.length > 0 && <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">已选 {selectedModelIds.length}</span><Button size="sm" onClick={() => bulkUpdate.mutate({ action: 'visible' })} disabled={bulkUpdate.isPending}>用户可见</Button><Button size="sm" variant="outline" onClick={() => bulkUpdate.mutate({ action: 'hidden' })} disabled={bulkUpdate.isPending}>用户不可见</Button><Button size="sm" variant="outline" onClick={() => bulkUpdate.mutate({ action: 'start' })} disabled={bulkUpdate.isPending}>启动</Button><Button size="sm" variant="outline" onClick={() => bulkUpdate.mutate({ action: 'stop' })} disabled={bulkUpdate.isPending}>停止</Button></div>}
          </div>
          <div className="text-sm text-muted-foreground">共 {rows.length} 个模型</div>
        </div>

        {message && <div className="mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{message}</div>}
        {error && <div className="mt-4 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}

        <div className="mt-4 grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          {loading && <div className="rounded-2xl border bg-background/70 p-8 text-center text-sm text-muted-foreground md:col-span-2 xl:col-span-3">正在加载模型配置…</div>}
          {!loading && rows.length === 0 && <div className="rounded-2xl border bg-background/70 p-8 text-center text-sm text-muted-foreground md:col-span-2 xl:col-span-3">没有找到匹配的模型。</div>}
          {!loading && rows.map((model) => {
            const draft = draftFor(model)
            const visible = model.userVisible
            const expanded = expandedId === model.id
            return (
              <article key={model.id} className={`relative h-fit min-h-[150px] self-start rounded-2xl border bg-card/90 p-5 shadow-sm backdrop-blur-md transition-shadow hover:shadow-md ${expanded ? 'z-40' : 'z-0'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <input type="checkbox" aria-label={`选择 ${model.displayName}`} checked={selectedModelIds.includes(model.id)} onChange={(event) => setSelectedModelIds((current) => event.target.checked ? [...current, model.id] : current.filter((id) => id !== model.id))} className="size-4 accent-primary" />
                    <Badge variant="secondary">{model.platform}</Badge>
                    <Badge variant={visible ? 'default' : 'outline'}>{visible ? '用户可见' : '不可见'}</Badge>
                  </div>
                  <div className="shrink-0 text-right">
                    {model.health ? <Badge variant={model.health.status === 'success' ? 'default' : 'destructive'}>{model.health.status === 'success' ? '检测成功' : '检测失败'}</Badge> : <Badge variant="outline">未检测</Badge>}
                    <div className="mt-1 text-[11px] text-muted-foreground">{model.health ? `${model.health.latencyMs} ms` : '—'}</div>
                  </div>
                </div>

                <h2 className="mt-4 line-clamp-2 text-lg font-semibold">{model.displayName}</h2>
                <p className="mt-1 min-h-8 break-all font-mono text-xs text-muted-foreground" title={model.modelId}>{model.modelId}</p>

                <Button type="button" size="sm" variant="outline" className="mt-4 w-full" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : model.id)}>
                  {expanded ? '收起设置' : '展开设置'}
                </Button>

                {expanded && (
                  <div className="absolute left-0 right-0 top-full z-50 mt-2 rounded-2xl border border-border/80 bg-background/95 p-5 shadow-2xl backdrop-blur-xl">
                    {model.health?.error && <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" title={model.health.error}>{model.health.error}</div>}

                    <div className="grid grid-cols-2 gap-3">
                      <SwitchField label="启用" checked={draft.enabled} onChange={(checked) => updateDraft(model.id, { enabled: checked })} />
                      <SwitchField label="Fallback" checked={draft.fallbackEnabled} onChange={(checked) => updateDraft(model.id, { fallbackEnabled: checked })} />
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-3">
                      <NumberField label="输入价格 / 1M" value={draft.inputPrice} onChange={(value) => updateDraft(model.id, { inputPrice: value })} />
                      <NumberField label="输出价格 / 1M" value={draft.outputPrice} onChange={(value) => updateDraft(model.id, { outputPrice: value })} />
                      <NumberField label="倍率" value={draft.multiplier} onChange={(value) => updateDraft(model.id, { multiplier: value })} />
                      <SwitchField label="启用计费" checked={draft.billingEnabled} onChange={(checked) => updateDraft(model.id, { billingEnabled: checked })} />
                    </div>

                    <div className="mt-5 flex gap-2">
                      <Button className="flex-1" variant="outline" onClick={() => healthCheck.mutate(model)} disabled={healthCheck.isPending}>{healthCheck.isPending ? '检测中…' : '检测'}</Button>
                      <Button className="flex-1" onClick={() => saveModel.mutate(model)} disabled={saveModel.isPending}>{saveModel.isPending ? '保存中…' : '保存'}</Button>
                    </div>
                  </div>
                )}
              </article>
            )
          })}
        </div>
      </div>
    </div>
  )
}
