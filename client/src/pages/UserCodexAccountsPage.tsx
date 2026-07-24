import { useQuery } from '@tanstack/react-query'
import { Bot, Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import { apiFetch } from '@/lib/api'

function displayName(modelId: string) {
  if (modelId === 'codex-auto-review') return 'Codex Auto Review'
  return modelId.split('-').map(part => part.toLowerCase() === 'gpt' ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}

function modelFamily(modelId: string) {
  if (modelId.startsWith('gpt-5.6')) return 'GPT 5.6'
  if (modelId.startsWith('gpt-5.5')) return 'GPT 5.5'
  if (modelId.startsWith('gpt-5.4')) return 'GPT 5.4'
  return 'Codex'
}

export default function UserCodexAccountsPage() {
  const [search, setSearch] = useState('')
  const { data, isLoading } = useQuery<{ models: string[] }>({ queryKey: ['user-codex-models'], queryFn: () => apiFetch('/api/user/codex-models'), refetchInterval: 15_000 })
  const models = useMemo(() => {
    const query = search.trim().toLowerCase()
    return (data?.models ?? []).filter(model => !query || model.toLowerCase().includes(query) || displayName(model).toLowerCase().includes(query))
  }, [data, search])

  return <div className="max-w-6xl">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div><h1 className="text-2xl font-semibold">Codex 支持模型</h1><p className="mt-1 text-sm text-muted-foreground">查看当前 Codex 账号池可调用的模型。</p></div>
      <div className="text-sm text-muted-foreground">共 {data?.models.length ?? 0} 个模型</div>
    </div>
    <div className="relative mt-6 max-w-sm"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索 Codex 模型" className="h-10 w-full rounded-xl border bg-card pl-9 pr-3 text-sm outline-none focus:border-foreground/30" /></div>
    {isLoading ? <p className="py-16 text-center text-sm text-muted-foreground">正在加载模型...</p> : models.length === 0 ? <div className="mt-6 rounded-2xl border border-dashed p-12 text-center text-sm text-muted-foreground">没有找到匹配的模型</div> : <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{models.map(model => <article key={model} className="flex min-h-28 items-center gap-4 rounded-2xl border bg-card p-4 transition-colors hover:bg-muted/30">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-white/25 bg-[#202123] shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]"><img src="/provider-logos/openai.svg" alt="" className="size-6 object-contain brightness-0 invert" /></span>
      <div className="min-w-0"><div className="flex items-center gap-2"><h2 className="truncate font-semibold">{displayName(model)}</h2><span className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">{modelFamily(model)}</span></div><code className="mt-2 block break-all text-xs text-muted-foreground">{model}</code></div>
    </article>)}</div>}
    <div className="mt-6 flex items-center gap-2 text-xs text-muted-foreground"><Bot className="size-4" />模型列表由管理员配置的 Codex 账号池自动更新</div>
  </div>
}
