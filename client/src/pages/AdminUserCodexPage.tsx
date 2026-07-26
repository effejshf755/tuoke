import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Save, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'

type CodexModel = {
  model_id: string
  account_count: number
  enabled_account_count: number
  input_price_per_million: number
  output_price_per_million: number
  multiplier: number
  billing_enabled: boolean
  total_tokens: number
  last_used_at: string | null
}

type Draft = Pick<CodexModel, 'input_price_per_million' | 'output_price_per_million' | 'multiplier' | 'billing_enabled'>

function formatTokenCount(value: number): string {
  const amount = Math.max(0, Number(value || 0))
  const units = [
    { value: 1_000_000_000, suffix: 'B' },
    { value: 1_000_000, suffix: 'M' },
    { value: 1_000, suffix: 'K' },
  ]
  const unit = units.find(item => amount >= item.value)
  if (!unit) return new Intl.NumberFormat('zh-CN').format(amount)
  return `${Number((amount / unit.value).toFixed(1))}${unit.suffix}`
}

function PriceField({ label, value, step = '0.000001', onChange }: { label: string; value: number; step?: string; onChange: (value: number) => void }) {
  return <label className="block"><span className="text-xs text-muted-foreground">{label}</span><Input className="mt-2" type="number" min="0" step={step} value={value} onChange={event => onChange(Number(event.target.value))} /></label>
}

export default function AdminUserCodexPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const query = useQuery<{ models: CodexModel[] }>({
    queryKey: ['admin-user-codex-models'],
    queryFn: () => apiFetch('/api/admin/codex/billing'),
    refetchInterval: 5_000,
  })

  useEffect(() => {
    if (!query.data) return
    setDrafts(Object.fromEntries(query.data.models.map(model => [model.model_id, {
      input_price_per_million: model.input_price_per_million,
      output_price_per_million: model.output_price_per_million,
      multiplier: model.multiplier,
      billing_enabled: model.billing_enabled,
    }])))
  }, [query.data])

  const models = useMemo(() => {
    const value = search.trim().toLowerCase()
    return (query.data?.models ?? []).filter(model => !value || model.model_id.toLowerCase().includes(value))
  }, [query.data, search])

  const save = useMutation({
    mutationFn: ({ modelId, draft }: { modelId: string; draft: Draft }) => apiFetch('/api/admin/codex/billing', {
      method: 'PUT', body: JSON.stringify({ model_id: modelId, ...draft }),
    }),
    onSuccess: async () => {
      toast.success('Codex 模型价格已保存')
      await queryClient.invalidateQueries({ queryKey: ['admin-user-codex-models'] })
      await queryClient.invalidateQueries({ queryKey: ['user-codex-models'] })
    },
  })

  const update = (modelId: string, patch: Partial<Draft>) => setDrafts(current => ({
    ...current, [modelId]: { ...current[modelId], ...patch },
  }))

  return <div className="mx-auto w-full max-w-7xl">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div><h1 className="text-2xl font-semibold">Codex 模型计费</h1><p className="mt-1 text-sm text-muted-foreground">设置普通用户按量调用 Codex 账号池模型的价格和倍率。</p></div>
      <div className="text-sm text-muted-foreground">{models.length} 个模型</div>
    </div>
    <div className="relative mt-6 max-w-sm"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索 Codex 模型" /></div>
    {query.isLoading ? <p className="py-16 text-center text-sm text-muted-foreground">正在加载 Codex 账号池模型…</p> : query.isError ? <p className="py-16 text-center text-sm text-destructive">模型加载失败</p> : models.length === 0 ? <p className="py-16 text-center text-sm text-muted-foreground">暂无可配置的 Codex 账号池模型</p> : <div className="mt-6 grid gap-5 lg:grid-cols-2">{models.map(model => {
      const draft = drafts[model.model_id]
      if (!draft) return null
      return <article key={model.model_id} className="flex min-h-72 flex-col rounded-lg border bg-card p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className="flex size-11 shrink-0 items-center justify-center rounded-lg border bg-white p-2"><img src="/provider-logos/openai.svg" alt="Codex" className="size-full object-contain" /></span><div className="min-w-0"><h2 className="truncate text-base font-semibold">{model.model_id}</h2><p className="mt-1 text-xs text-muted-foreground">账号池模型</p></div></div><label className="flex shrink-0 items-center gap-2 text-xs">展示<Switch checked={draft.billing_enabled} onCheckedChange={checked => update(model.model_id, { billing_enabled: checked })} /></label></div>
        <dl className="mt-5 grid grid-cols-2 gap-5 border-y py-4 text-sm"><div><dt className="text-xs text-muted-foreground">真实消耗</dt><dd className="mt-1 text-lg font-semibold" title={`${new Intl.NumberFormat('zh-CN').format(model.total_tokens)} Token`}>{formatTokenCount(model.total_tokens)} Token</dd></div><div><dt className="text-xs text-muted-foreground">计费方式</dt><dd className="mt-1 font-medium">按 Token</dd><p className="mt-1 text-xs text-muted-foreground">每 5 秒刷新</p></div></dl>
        <div className="mt-5 grid gap-4 sm:grid-cols-2"><PriceField label="输入价 / 1M Token" value={draft.input_price_per_million} onChange={value => update(model.model_id, { input_price_per_million: value })} /><PriceField label="输出价 / 1M Token" value={draft.output_price_per_million} onChange={value => update(model.model_id, { output_price_per_million: value })} /></div>
        <div className="mt-auto grid items-end gap-4 pt-4 sm:grid-cols-[minmax(0,1fr)_9rem]"><PriceField label="计费倍率" value={draft.multiplier} step="0.001" onChange={value => update(model.model_id, { multiplier: value })} /><Button variant="outline" disabled={save.isPending} onClick={() => save.mutate({ modelId: model.model_id, draft })}><Save />保存</Button></div>
      </article>
    })}</div>}
  </div>
}
