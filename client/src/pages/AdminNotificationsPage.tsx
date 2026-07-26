import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, Send, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { formatBeijingDateTime } from '@/lib/utils'

type Notification = { id: number; title: string; content: string; kind: 'info' | 'important' | 'maintenance'; publishedAt: string; publishedBy: string | null; readCount: number; recipientCount: number }
const kinds = [['info', '普通通知'], ['important', '重要通知'], ['maintenance', '维护通知']] as const

export default function AdminNotificationsPage() {
  const client = useQueryClient()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [kind, setKind] = useState<Notification['kind']>('info')
  const query = useQuery<{ notifications: Notification[] }>({ queryKey: ['admin-notifications'], queryFn: () => apiFetch('/api/admin/notifications') })
  const publish = useMutation({
    mutationFn: () => apiFetch('/api/admin/notifications', { method: 'POST', body: JSON.stringify({ title, content, kind }) }),
    onSuccess: () => { setTitle(''); setContent(''); setKind('info'); toast.success('通知已发布'); client.invalidateQueries({ queryKey: ['admin-notifications'] }); client.invalidateQueries({ queryKey: ['user-notifications'] }) },
  })
  const remove = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/admin/notifications/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('通知已删除'); client.invalidateQueries({ queryKey: ['admin-notifications'] }); client.invalidateQueries({ queryKey: ['user-notifications'] }) },
  })
  const valid = title.trim().length > 0 && title.trim().length <= 120 && content.trim().length > 0 && content.trim().length <= 4000

  return <div className="mx-auto w-full max-w-5xl">
    <div><h1 className="text-2xl font-semibold">消息通知</h1><p className="mt-1 text-sm text-muted-foreground">手动发布全站消息并查看用户阅读情况。</p></div>
    <section className="mt-6 rounded-lg border bg-card p-5 sm:p-6">
      <div className="flex items-center gap-3"><BellRing className="size-5" /><h2 className="font-medium">发布新通知</h2></div>
      <div className="mt-5 grid gap-4 sm:grid-cols-[1fr_180px]"><div><Label htmlFor="notification-title">标题</Label><Input id="notification-title" className="mt-2" value={title} maxLength={120} onChange={event => setTitle(event.target.value)} placeholder="请输入通知标题" /></div><div><Label htmlFor="notification-kind">类型</Label><select id="notification-kind" className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={kind} onChange={event => setKind(event.target.value as Notification['kind'])}>{kinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></div>
      <div className="mt-4"><div className="flex items-center justify-between gap-3"><Label htmlFor="notification-content">内容</Label><span className="text-xs text-muted-foreground">{content.length}/4000</span></div><Textarea id="notification-content" className="mt-2 min-h-32" value={content} maxLength={4000} onChange={event => setContent(event.target.value)} placeholder="请输入需要发送给所有用户的内容" /></div>
      <div className="mt-5 flex justify-end"><Button disabled={!valid || publish.isPending} onClick={() => publish.mutate()}><Send />{publish.isPending ? '发布中…' : '发布通知'}</Button></div>
    </section>
    <div className="mt-8 flex items-center justify-between"><h2 className="font-medium">发布记录</h2><span className="text-sm text-muted-foreground">{query.data?.notifications.length ?? 0} 条</span></div>
    {query.isLoading ? <p className="py-12 text-center text-sm text-muted-foreground">正在加载…</p> : !query.data?.notifications.length ? <p className="mt-4 border-y py-12 text-center text-sm text-muted-foreground">尚未发布通知</p> : <div className="mt-3 divide-y border-y">{query.data.notifications.map(item => <article key={item.id} className="grid gap-4 py-5 sm:grid-cols-[1fr_auto]">
      <div><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{item.title}</h3><span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">{kinds.find(([value]) => value === item.kind)?.[1]}</span></div><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{item.content}</p><p className="mt-3 text-xs text-muted-foreground">{formatBeijingDateTime(item.publishedAt)} · {item.publishedBy ?? '管理员'} · 已读 {item.readCount}/{item.recipientCount}</p></div>
      <Button size="icon" variant="ghost" title="删除通知" disabled={remove.isPending} onClick={() => window.confirm('删除后所有用户都无法再看到这条通知，确认删除？') && remove.mutate(item.id)}><Trash2 /></Button>
    </article>)}</div>}
  </div>
}
