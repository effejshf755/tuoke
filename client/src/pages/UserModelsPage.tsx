import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type Model = {
  model_id: string; display_name: string; platform: string; context_window: number | null
  enabled: number; billing_configured: boolean; billing_enabled: boolean
  input_price: number | null; output_price: number | null; model_type?: string | null
}
type Category = 'chat' | 'embedding' | 'image' | 'audio' | 'fusion'
const categories: { id: Category; label: string }[] = [
  { id: 'chat', label: '对话模型' }, { id: 'embedding', label: '嵌入模型' },
  { id: 'image', label: '图像' }, { id: 'audio', label: '音频' }, { id: 'fusion', label: '融合' },
]
function typeOf(model: Model): Category {
  const type = (model.model_type ?? '').toLowerCase()
  if (type.includes('embed')) return 'embedding'
  if (type.includes('image')) return 'image'
  if (type.includes('audio')) return 'audio'
  if (type.includes('fusion')) return 'fusion'
  return 'chat'
}
function price(value: number | null) { return value == null ? '—' : value === 0 ? '免费' : `$${value.toFixed(2)} / 1M Tokens` }
function available(model: Model) { return Boolean(model.enabled) && model.billing_configured && model.billing_enabled }

export default function UserModelsPage() {
  const [params, setParams] = useSearchParams()
  const queryCategory = params.get('category')
  const [category, setCategory] = useState<Category>(categories.some(item => item.id === queryCategory) ? queryCategory as Category : 'chat'), [search, setSearch] = useState('')
  const { data, isLoading, isError } = useQuery<{ models: Model[] }>({ queryKey: ['user-models'], queryFn: () => apiFetch('/api/user/models') })
  const models = useMemo(() => (data?.models ?? []).filter(available).filter(model => typeOf(model) === category).filter(model => {
    const q = search.trim().toLowerCase()
    return !q || `${model.display_name} ${model.model_id} ${model.platform}`.toLowerCase().includes(q)
  }), [data?.models, category, search])
  return <div className="max-w-6xl"><div className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-2xl font-semibold">模型中心</h1><p className="mt-1 text-sm text-muted-foreground">查看已开放调用的模型及其详细信息</p></div><div className="text-xs text-muted-foreground">{models.length} 个可用模型</div></div><div className="mt-6 flex flex-wrap gap-3"><Input className="max-w-md" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索模型、Model ID 或 Provider" /><div className="flex flex-wrap gap-1 rounded-xl border bg-card p-1">{categories.map(item => <Button key={item.id} size="sm" variant={category === item.id ? 'default' : 'ghost'} onClick={() => { setCategory(item.id); setParams({ category: item.id }) }}>{item.label}</Button>)}</div></div>{isLoading && <p className="mt-8 text-sm text-muted-foreground">模型加载中…</p>}{isError && <p className="mt-8 text-sm text-destructive">模型列表加载失败，请稍后重试。</p>}{!isLoading && !isError && models.length === 0 && <p className="mt-8 rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">暂无{categories.find(item => item.id === category)?.label}。</p>}<div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{models.map(model => <div key={`${model.platform}-${model.model_id}`} className="rounded-3xl border bg-card p-5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate font-medium" title={model.display_name}>{model.display_name}</h2><p className="mt-1 text-xs text-muted-foreground">{model.platform}</p></div><span className="shrink-0 rounded-full border px-2 py-0.5 text-xs text-green-600">可用</span></div><div className="mt-4 rounded-xl bg-muted/40 p-3"><div className="text-[11px] text-muted-foreground">Model ID</div><code className="mt-1 block break-all text-xs">{model.model_id}</code></div><div className="mt-4 grid grid-cols-2 gap-3 text-sm"><div><div className="text-xs text-muted-foreground">上下文长度</div><div className="mt-1 font-medium">{model.context_window ? model.context_window.toLocaleString() : '—'}</div></div><div><div className="text-xs text-muted-foreground">模型类型</div><div className="mt-1 font-medium">{categories.find(item => item.id === typeOf(model))?.label}</div></div><div><div className="text-xs text-muted-foreground">输入价格</div><div className="mt-1 font-medium">{price(model.input_price)}</div></div><div><div className="text-xs text-muted-foreground">输出价格</div><div className="mt-1 font-medium">{price(model.output_price)}</div></div></div><Link className={buttonVariants({ className: 'mt-4 w-full', variant: 'outline' })} to={`/playground?model=${encodeURIComponent(model.model_id)}`}>在 Playground 中调用</Link></div>)}</div></div>
}
