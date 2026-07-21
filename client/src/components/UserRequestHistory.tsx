import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Input } from '@/components/ui/input'

type RequestRow = { id: number; createdAt: string; apiKeyName: string; requestedModel: string | null; routedModel: string; platform: string; status: string; inputTokens: number; outputTokens: number; totalTokens: number; billingAmountMicro: number; latencyMs: number }
type Response = { requests: RequestRow[]; pagination: { page: number; pages: number; total: number } }
type ApiKey = { id: number; name: string }
const date = (value: string) => new Date(value).toLocaleString()

export default function UserRequestHistory() {
  const [page, setPage] = useState(1), [model, setModel] = useState(''), [status, setStatus] = useState(''), [apiKey, setApiKey] = useState('')
  const keys = useQuery<{ keys: ApiKey[] }>({ queryKey: ['consumer-keys'], queryFn: () => apiFetch('/api/consumer-keys') })
  const query = useQuery<Response>({ queryKey: ['user-requests', page, model, status, apiKey], queryFn: () => {
    const params = new URLSearchParams({ page: String(page), limit: '10', model, status })
    if (apiKey) params.set('api_key_id', apiKey)
    return apiFetch(`/api/user/requests?${params.toString()}`)
  } })
  const reset = (setter: (value: string) => void, value: string) => { setter(value); setPage(1) }
  return <section className="mt-6 rounded-3xl border bg-card p-6"><h2 className="font-medium">请求记录</h2><p className="mt-1 text-xs text-muted-foreground">显示当前用户 API Key 发起的请求，可筛选和分页查看。</p><div className="mt-4 flex flex-wrap gap-3"><Input className="max-w-xs" value={model} onChange={e => reset(setModel, e.target.value)} placeholder="筛选模型" /><select className="h-8 rounded-lg border border-input bg-transparent px-3 text-sm" value={apiKey} onChange={e => reset(setApiKey, e.target.value)}><option value="">全部 API Key</option>{keys.data?.keys.map(key => <option key={key.id} value={key.id}>{key.name}</option>)}</select><select className="h-8 rounded-lg border border-input bg-transparent px-3 text-sm" value={status} onChange={e => reset(setStatus, e.target.value)}><option value="">全部状态</option><option value="success">成功</option><option value="error">失败</option></select></div>{query.isLoading && <p className="py-8 text-center text-sm text-muted-foreground">请求记录加载中…</p>}{query.isError && <p className="py-8 text-center text-sm text-destructive">请求记录加载失败，请稍后重试。</p>}<div className="mt-5 space-y-2">{query.data?.requests.map(item => <details key={item.id} className="rounded-xl border p-3 text-sm"><summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2"><span>{date(item.createdAt)}</span><span className="min-w-0 flex-1 truncate">{item.requestedModel ?? '自动路由'}</span><span className={item.status === 'success' ? 'text-green-600' : 'text-destructive'}>{item.status === 'success' ? '成功' : '失败'}</span><span>${(item.billingAmountMicro / 1_000_000).toFixed(2)}</span></summary><div className="mt-3 grid gap-2 border-t pt-3 text-xs text-muted-foreground sm:grid-cols-2"><span>API Key：{item.apiKeyName}</span><span>实际模型：{item.routedModel}</span><span>提供商：{item.platform}</span><span>输入 Token：{item.inputTokens}</span><span>输出 Token：{item.outputTokens}</span><span>总 Token：{item.totalTokens}</span><span>耗时：{item.latencyMs ?? '-'} ms</span></div></details>)}{!query.isLoading && !query.isError && !query.data?.requests.length && <p className="py-8 text-center text-sm text-muted-foreground">暂无请求记录。</p>}</div><div className="mt-4 flex items-center justify-between text-sm"><span>共 {query.data?.pagination.total ?? 0} 条</span><div className="flex gap-2"><button className="rounded border px-3 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span className="px-2 py-1">{page} / {query.data?.pagination.pages ?? 1}</span><button className="rounded border px-3 py-1 disabled:opacity-40" disabled={page >= (query.data?.pagination.pages ?? 1)} onClick={() => setPage(page + 1)}>下一页</button></div></div></section>
}
