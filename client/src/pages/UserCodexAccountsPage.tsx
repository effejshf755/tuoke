import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Input } from '@/components/ui/input'
import { apiFetch } from '@/lib/api'

type CodexModel = { model_id: string; input_price_per_million: number; output_price_per_million: number; multiplier: number }
const money = (value: number) => `¥${Number(value || 0).toFixed(6)}`

export default function UserCodexAccountsPage() {
  const [search, setSearch] = useState('')
  const query = useQuery<{ models: CodexModel[] }>({ queryKey: ['user-codex-models'], queryFn: () => apiFetch('/api/user/codex-models'), refetchInterval: 15_000 })
  const models = useMemo(() => {
    const value = search.trim().toLowerCase()
    return (query.data?.models ?? []).filter(model => !value || model.model_id.toLowerCase().includes(value))
  }, [query.data, search])

  return <div className="mx-auto w-full max-w-7xl">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><h1 className="text-2xl font-semibold">Codex 模型</h1><p className="mt-1 text-sm text-muted-foreground">普通用户按实际 Token 用量计费。</p></div><div className="text-sm text-muted-foreground">{models.length} 个模型</div></div>
    <div className="relative mt-6 max-w-sm"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索 Codex 模型" /></div>
    {query.isLoading ? <p className="py-16 text-center text-sm text-muted-foreground">正在加载模型…</p> : models.length === 0 ? <p className="py-16 text-center text-sm text-muted-foreground">暂无可用 Codex 模型</p> : <div className="mt-6 grid gap-5 lg:grid-cols-2">{models.map(model => <article key={model.model_id} className="flex min-h-56 flex-col rounded-lg border bg-card p-5 sm:p-6">
      <div className="flex items-center gap-3"><span className="flex size-11 shrink-0 items-center justify-center rounded-lg border bg-white p-2"><img src="/provider-logos/openai.svg" alt="Codex" className="size-full object-contain" /></span><div className="min-w-0"><h2 className="truncate font-semibold">{model.model_id}</h2><p className="mt-1 text-xs text-muted-foreground">按量计费</p></div></div>
      <dl className="mt-5 grid grid-cols-2 gap-4 border-y py-4 text-sm"><div><dt className="text-xs text-muted-foreground">输入价格 / 1M Token</dt><dd className="mt-1 font-medium">{money(model.input_price_per_million)}</dd></div><div><dt className="text-xs text-muted-foreground">输出价格 / 1M Token</dt><dd className="mt-1 font-medium">{money(model.output_price_per_million)}</dd></div></dl>
      <div className="mt-4 flex items-center justify-between text-sm"><span className="text-muted-foreground">计费倍率</span><strong>{model.multiplier.toFixed(3)}×</strong></div>
    </article>)}</div>}
  </div>
}
