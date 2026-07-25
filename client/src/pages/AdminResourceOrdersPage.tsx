import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, ReceiptText, RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { NavLink } from 'react-router-dom'

import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { TableSkeleton } from '@/components/ui/skeleton'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { formatBeijingDateTime } from '@/lib/utils'

type Order = {
  id: number; orderNo: string; status: string; userEmail: string; productName: string
  priceMicro: number; subpoolId: number | null; subpoolStatus: string | null
  memberCount: number; memberLimit: number; paidAt: string | null
  refundableUntil: string | null; refundedAt: string | null; createdAt: string
}
type Member = { id: number; email: string; status: string; allocationUnits: number | null; usedUnits: number | null; reservedUnits: number | null }
type Detail = { order: Record<string, unknown>; members: Member[] }

const statuses = [
  ['all', '全部状态'], ['pending_payment', '等待支付'], ['paid_waiting_group', '等待拼单'],
  ['grouped', '已成团'], ['active', '已激活'], ['refunded', '已退款'],
] as const
const labels: Record<string, string> = Object.fromEntries(statuses)
const money = (value: number) => `￥${(Number(value || 0) / 1_000_000).toFixed(2)}`
const units = (value: number | null | undefined) => `${new Intl.NumberFormat('zh-CN').format(Number(value || 0))} Token`

export function AdminResourceOrdersPage() {
  const [status, setStatus] = useState('all')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [refundId, setRefundId] = useState<number | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const queryClient = useQueryClient()
  const orders = useQuery<{ orders: Order[] }>({
    queryKey: ['admin-resource-orders', status],
    queryFn: () => apiFetch(`/api/admin/resources/orders${status === 'all' ? '' : `?status=${status}`}`),
  })
  const detail = useQuery<Detail>({
    queryKey: ['admin-resource-order', selectedId],
    queryFn: () => apiFetch(`/api/admin/resources/orders/${selectedId}`),
    enabled: selectedId !== null,
  })
  const refund = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/admin/resources/orders/${id}/refund`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('退款成功，款项已退回用户钱包')
      setRefundId(null)
      queryClient.invalidateQueries({ queryKey: ['admin-resource-orders'] })
      queryClient.invalidateQueries({ queryKey: ['admin-resource-products'] })
      queryClient.invalidateQueries({ queryKey: ['admin-resource-subpools'] })
    },
  })
  const remove = useMutation({
    mutationFn: (orderIds: number[]) => apiFetch<{ deletedCount: number }>('/api/admin/resources/orders', {
      method: 'DELETE', body: JSON.stringify({ orderIds }),
    }),
    onSuccess: (result) => {
      toast.success(`已删除 ${result.deletedCount} 个退款订单`)
      setSelected([])
      queryClient.invalidateQueries({ queryKey: ['admin-resource-orders'] })
      queryClient.invalidateQueries({ queryKey: ['admin-resource-products'] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const visibleRefunded = orders.data?.orders.filter(order => order.status === 'refunded').map(order => order.id) ?? []
  const allRefundedSelected = visibleRefunded.length > 0 && visibleRefunded.every(id => selected.includes(id))

  return <div className="mx-auto w-full max-w-7xl">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div><h1 className="text-2xl font-semibold">资源订单</h1><p className="mt-1 text-sm text-muted-foreground">查询拼单订单、支付状态和钱包退款。</p></div>
      <div className="flex flex-wrap gap-2"><Button variant="destructive" disabled={!selected.length || remove.isPending} onClick={() => { if (window.confirm(`确定删除选中的 ${selected.length} 个退款订单？钱包流水会保留。`)) remove.mutate(selected) }}><Trash2 />删除选中</Button><select value={status} onChange={event => { setStatus(event.target.value); setSelected([]) }} className="h-9 rounded-lg border bg-background px-3 text-sm">
        {statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></div>
    </div>
    <ResourceAdminTabs />
    <div className="mt-6">
      {orders.isLoading ? <TableSkeleton rows={8} /> : !orders.data?.orders.length ? <EmptyState icon={ReceiptText} title="暂无资源订单" /> :
        <div className="overflow-hidden rounded-2xl border bg-card">
          <div className="hidden grid-cols-[auto_1.5fr_1.2fr_.8fr_.8fr_1fr_auto] gap-4 border-b bg-muted/30 px-4 py-3 text-xs text-muted-foreground lg:grid">
            <input type="checkbox" aria-label="选择全部退款订单" checked={allRefundedSelected} disabled={!visibleRefunded.length} onChange={event => setSelected(event.target.checked ? visibleRefunded : [])} /><span>订单 / 商品</span><span>用户</span><span>状态</span><span>拼单</span><span>支付时间</span><span>操作</span>
          </div>
          {orders.data.orders.map(order => <div key={order.id} className="grid gap-3 border-b p-4 last:border-0 lg:grid-cols-[auto_1.5fr_1.2fr_.8fr_.8fr_1fr_auto] lg:items-center lg:gap-4">
            <input type="checkbox" aria-label={`选择订单 ${order.orderNo}`} checked={selected.includes(order.id)} disabled={order.status !== 'refunded'} title={order.status === 'refunded' ? '选择退款订单' : '只有已退款订单可以删除'} onChange={event => setSelected(current => event.target.checked ? [...current, order.id] : current.filter(id => id !== order.id))} />
            <div><div className="font-medium">{order.productName}</div><code className="mt-1 block text-xs text-muted-foreground">{order.orderNo} · {money(order.priceMicro)}</code></div>
            <span className="break-all text-sm">{order.userEmail}</span>
            <Badge variant="outline">{labels[order.status] ?? order.status}</Badge>
            <span className="text-sm">{order.subpoolId ? `${order.memberCount}/${order.memberLimit}` : '未入池'}</span>
            <span className="text-sm text-muted-foreground">{formatBeijingDateTime(order.paidAt)}</span>
            <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => setSelectedId(order.id)}><Eye />详情</Button>{order.status === 'paid_waiting_group' && <Button size="sm" variant="outline" onClick={() => setRefundId(order.id)}><RotateCcw />退款</Button>}</div>
          </div>)}
        </div>}
    </div>

    <Dialog open={selectedId !== null} onOpenChange={open => !open && setSelectedId(null)}><DialogPopup className="max-w-2xl"><DialogTitle>订单详情</DialogTitle><DialogDescription className="mt-1">订单、商品冻结快照、小号池和成员额度。</DialogDescription>{detail.isLoading ? <div className="mt-6"><TableSkeleton rows={4} /></div> : detail.data && <div className="mt-6 space-y-5"><div className="grid gap-3 rounded-xl border p-4 sm:grid-cols-2">{Object.entries(detail.data.order).filter(([key]) => ['order_no','order_status','userEmail','product_name_snapshot','price_micro','subpoolName','subpoolStatus','created_at','paid_at','refundable_until'].includes(key)).map(([key, value]) => <div key={key}><div className="text-xs text-muted-foreground">{key}</div><div className="mt-1 break-all text-sm">{String(value ?? '—')}</div></div>)}</div><div><h3 className="text-sm font-medium">小号池成员</h3><div className="mt-2 divide-y rounded-xl border">{detail.data.members.map(member => <div key={member.id} className="grid gap-2 p-3 text-sm sm:grid-cols-[1.5fr_.7fr_1fr]"><span>{member.email}</span><span>{member.status}</span><span>{units(member.usedUnits)} / {units(member.allocationUnits)}</span></div>)}{!detail.data.members.length && <p className="p-4 text-sm text-muted-foreground">尚无成员</p>}</div></div></div>}<div className="mt-6 flex justify-end"><DialogClose render={<Button variant="outline" />}>关闭</DialogClose></div></DialogPopup></Dialog>
    <Dialog open={refundId !== null} onOpenChange={open => !open && setRefundId(null)}><DialogPopup><DialogTitle>确认钱包退款</DialogTitle><DialogDescription className="mt-2">仅退回用户钱包，不调用支付宝。系统会再次校验退款窗口、激活状态和调用记录。</DialogDescription><div className="mt-6 flex justify-end gap-2"><DialogClose render={<Button variant="outline" />}>取消</DialogClose><Button disabled={refund.isPending} onClick={() => refundId && refund.mutate(refundId)}>{refund.isPending ? '退款中…' : '确认退款'}</Button></div></DialogPopup></Dialog>
  </div>
}

function ResourceAdminTabs() {
  const tabs = [['/admin/resources', '运营概览'], ['/admin/resources/products', '商品管理'], ['/admin/resources/orders', '订单管理'], ['/admin/resources/subpools', '小号池管理'], ['/admin/resources/audit', '审计日志']]
  return <nav className="mt-6 flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl border border-border/70 bg-background/65 p-1 backdrop-blur-xl">{tabs.map(([to, label]) => <NavLink key={to} end={to==='/admin/resources'} to={to} className={({isActive})=>`shrink-0 rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>{label}</NavLink>)}</nav>
}
