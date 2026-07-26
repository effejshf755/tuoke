import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, CheckCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import { formatBeijingDateTime } from '@/lib/utils'

type Notification = {
  id: number
  title: string
  content: string
  kind: 'info' | 'important' | 'maintenance'
  publishedAt: string
  readAt: string | null
}

const kindLabel = { info: '通知', important: '重要', maintenance: '维护' }

export default function NotificationsPage() {
  const client = useQueryClient()
  const query = useQuery<{ notifications: Notification[]; unreadCount: number }>({
    queryKey: ['user-notifications'],
    queryFn: () => apiFetch('/api/user/notifications'),
    refetchInterval: 15_000,
  })
  const refresh = () => client.invalidateQueries({ queryKey: ['user-notifications'] })
  const read = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/user/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: refresh,
  })
  const readAll = useMutation({
    mutationFn: () => apiFetch('/api/user/notifications/read-all', { method: 'POST' }),
    onSuccess: refresh,
  })

  return <div className="mx-auto w-full max-w-4xl">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="text-2xl font-semibold">消息通知</h1><p className="mt-1 text-sm text-muted-foreground">查看平台发布的服务和运营消息。</p></div>
      <Button variant="outline" disabled={!query.data?.unreadCount || readAll.isPending} onClick={() => readAll.mutate()}><CheckCheck />全部已读</Button>
    </div>
    {query.isLoading ? <p className="py-16 text-center text-sm text-muted-foreground">正在加载消息…</p> : query.isError ? <p className="py-16 text-center text-sm text-destructive">消息加载失败</p> : !query.data?.notifications.length ? <div className="mt-8 border-y py-16 text-center"><Bell className="mx-auto size-6 text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">暂无消息</p></div> : <div className="mt-6 divide-y border-y">{query.data.notifications.map(item => <button key={item.id} type="button" className="grid w-full gap-3 px-1 py-5 text-left sm:grid-cols-[auto_1fr_auto] sm:px-3" onClick={() => !item.readAt && read.mutate(item.id)}>
      <span className={`mt-1 size-2 rounded-full ${item.readAt ? 'bg-muted' : 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,.65)]'}`} />
      <span className="min-w-0"><span className="flex flex-wrap items-center gap-2"><strong className="text-sm">{item.title}</strong><span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">{kindLabel[item.kind]}</span></span><span className="mt-2 block whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{item.content}</span></span>
      <span className="text-xs text-muted-foreground sm:text-right">{formatBeijingDateTime(item.publishedAt)}<span className="mt-1 block">{item.readAt ? '已读' : '未读'}</span></span>
    </button>)}</div>}
  </div>
}
