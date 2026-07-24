import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Box, CalendarClock, Check, Clock3, CreditCard, History, PackageCheck, ReceiptText, ShoppingBag, Users } from 'lucide-react'
import { Link, NavLink, useParams } from 'react-router-dom'
import { useState } from 'react'

import { apiFetch } from '@/lib/api'
import { formatBeijingDateTime } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/empty-state'
import { CardSkeleton, TableSkeleton } from '@/components/ui/skeleton'

type Product = {
  id: number; productKey: string; version: number; name: string; description: string | null
  priceMicro: number; memberLimit: number; waitingMembers: number
  durationValue: number; durationUnit: 'day' | 'month'
  totalQuotaUnits: number; memberQuotaUnits: number; meterVersion: string
  quotaAllocationType?: string; groupTimeoutMinutes?: number; refundWindowMinutes?: number
}
type ResourceOrder = {
  id: number; orderNo: string; productId: number; productName: string; productVersion: number
  priceMicro: number; memberLimit: number; memberQuotaUnits: number; status: string
  paidAt: string | null; refundableUntil: string | null; refundedAt: string | null
  createdAt: string; subpoolId: number | null; subpoolStatus: string | null; memberCount: number
}
type Subscription = {
  subpoolId: number; status: string; startsAt: string; endsAt: string | null
  productId: number; productName: string; productVersion: number
  totalQuotaUnits: number; usedQuotaUnits: number; reservedQuotaUnits: number
  remainingQuotaUnits: number; quotaResetsAt: string | null; meterVersion: string
}
type UsageRecord = {
  reservationId: number; requestId: number | null; modelId: string | null
  consumedQuotaUnits: number; inputTokens: number; outputTokens: number
  totalTokens: number; createdAt: string
}
type WalletResponse = { wallet: { balance: number; available_balance: number; reserved_balance: number } }

const tabs = [
  { to: '/resources/products', label: '套餐商城', icon: ShoppingBag },
  { to: '/resources/orders', label: '我的订单', icon: ReceiptText },
  { to: '/resources/subscriptions', label: '我的套餐', icon: PackageCheck },
  { to: '/resources/usage', label: '使用记录', icon: History },
]

function money(micro: number) { return `$${(micro / 1_000_000).toFixed(2)}` }
function number(value: number) { return new Intl.NumberFormat('zh-CN').format(value ?? 0) }
function cycle(product: Product) { return `${product.durationValue} ${product.durationUnit === 'month' ? '个月' : '天'}` }
function quota(value: number) { return `${number(value)} units` }
function remainingMembers(product: Product) { return Math.max(0, product.memberLimit - product.waitingMembers) }

function ResourceShell({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-6xl">
    <div><h1 className="text-2xl font-semibold">{title}</h1><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>
    <nav className="mt-6 flex gap-1 overflow-x-auto border-b pb-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="资源商城导航">
      {tabs.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} className={({ isActive }) => `flex h-10 shrink-0 items-center gap-2 border-b-2 px-3 text-sm transition-colors ${isActive ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}><Icon className="size-4" />{label}</NavLink>)}
    </nav>
    <div className="mt-6">{children}</div>
  </div>
}

function Progress({ current, total }: { current: number; total: number }) {
  const percent = total > 0 ? Math.min(100, current / total * 100) : 0
  return <div>
    <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">拼单进度</span><span className="font-medium tabular-nums">{current}/{total}</span></div>
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-foreground transition-[width]" style={{ width: `${percent}%` }} /></div>
  </div>
}

function PurchaseButton({ product, className }: { product: Product; className?: string }) {
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const wallet = useQuery<WalletResponse>({ queryKey: ['user-wallet'], queryFn: () => apiFetch('/api/user/wallet'), enabled: open })
  const purchase = useMutation({
    mutationFn: () => apiFetch(`/api/resources/products/${product.id}/purchase`, {
      method: 'POST', body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    }),
    onSuccess: () => {
      setOpen(false)
      toast.success('购买成功，订单已进入拼单。')
      client.invalidateQueries({ queryKey: ['resource-products'] })
      client.invalidateQueries({ queryKey: ['resource-orders'] })
      client.invalidateQueries({ queryKey: ['user-wallet'] })
    },
  })
  const available = wallet.data?.wallet.available_balance ?? 0
  const price = product.priceMicro / 1_000_000
  return <>
    <Button className={className} onClick={() => setOpen(true)}><CreditCard />立即购买</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup>
        <DialogTitle>确认购买</DialogTitle>
        <DialogDescription className="mt-1">使用钱包余额购买，付款后立即进入拼单队列。</DialogDescription>
        <div className="mt-5 divide-y rounded-2xl border px-4">
          <div className="flex justify-between gap-4 py-3 text-sm"><span className="text-muted-foreground">商品</span><span className="text-right font-medium">{product.name}</span></div>
          <div className="flex justify-between gap-4 py-3 text-sm"><span className="text-muted-foreground">支付金额</span><span className="font-medium">{money(product.priceMicro)}</span></div>
          <div className="flex justify-between gap-4 py-3 text-sm"><span className="text-muted-foreground">可用余额</span><span className={available < price ? 'text-destructive' : ''}>{wallet.isLoading ? '查询中…' : `$${available.toFixed(2)}`}</span></div>
        </div>
        {wallet.data && available < price && <p className="mt-3 text-sm text-destructive">钱包余额不足，请先前往“我的”页面充值。</p>}
        <div className="mt-6 flex justify-end gap-2"><DialogClose render={<Button variant="outline" />}>取消</DialogClose><Button onClick={() => purchase.mutate()} disabled={purchase.isPending || wallet.isLoading || available < price}>{purchase.isPending ? '处理中…' : '确认支付'}</Button></div>
      </DialogPopup>
    </Dialog>
  </>
}

function ProductCard({ product }: { product: Product }) {
  return <article className="flex min-h-[330px] flex-col rounded-2xl border bg-card p-5 transition-colors hover:bg-card/80">
    <div className="flex items-start justify-between gap-3"><div><Badge variant="outline">Codex 月拼单</Badge><h2 className="mt-3 text-lg font-semibold">{product.name}</h2></div><div className="text-right"><div className="text-xl font-semibold tabular-nums">{money(product.priceMicro)}</div><div className="text-xs text-muted-foreground">/{cycle(product)}</div></div></div>
    <p className="mt-3 line-clamp-2 min-h-10 text-sm text-muted-foreground">{product.description || '共享平台服务额度，真实授权账号信息完全隔离。'}</p>
    <div className="mt-5"><Progress current={product.waitingMembers} total={product.memberLimit} /><p className="mt-2 text-xs text-muted-foreground">{remainingMembers(product) > 0 ? `还差 ${remainingMembers(product)} 人成团` : '当前队列即将成团'}</p></div>
    <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-sm"><div><span className="block text-xs text-muted-foreground">个人额度</span><span className="mt-1 block font-medium">{quota(product.memberQuotaUnits)}</span></div><div><span className="block text-xs text-muted-foreground">拼单人数</span><span className="mt-1 block font-medium">{product.memberLimit} 人</span></div><div><span className="block text-xs text-muted-foreground">服务周期</span><span className="mt-1 block font-medium">{cycle(product)}</span></div><div><span className="block text-xs text-muted-foreground">退款规则</span><span className="mt-1 block font-medium">60 分钟内</span></div></div>
    <div className="mt-auto flex gap-2 pt-6"><Link to={`/resources/products/${product.id}`} className={buttonVariants({ variant: 'outline', className: 'flex-1' })}>查看详情</Link><PurchaseButton product={product} className="flex-1" /></div>
  </article>
}

export function ResourceProductsPage() {
  const query = useQuery<{ products: Product[] }>({ queryKey: ['resource-products'], queryFn: () => apiFetch('/api/resources/products') })
  return <ResourceShell title="Codex 拼单商城" description="购买 Tuoke 提供的 Codex 使用服务，授权账号信息不会对用户公开。">
    {query.isLoading ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[1, 2, 3].map(i => <CardSkeleton key={i} className="h-[330px]" />)}</div> : !query.data?.products.length ? <EmptyState icon={ShoppingBag} title="暂无在售套餐" description="管理员发布商品后会显示在这里。" /> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{query.data.products.map(product => <ProductCard key={product.id} product={product} />)}</div>}
  </ResourceShell>
}

export function ResourceProductDetailPage() {
  const { id } = useParams()
  const query = useQuery<{ product: Product }>({ queryKey: ['resource-product', id], queryFn: () => apiFetch(`/api/resources/products/${id}`) })
  const product = query.data?.product
  return <ResourceShell title="商品详情" description="确认拼单规则、额度和退款期限后使用钱包余额购买。">
    <Link to="/resources/products" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />返回商城</Link>
    {query.isLoading ? <CardSkeleton className="mt-5 h-96" /> : product && <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_320px]">
      <section className="min-w-0"><Badge variant="outline">Codex · Dedicated</Badge><h2 className="mt-4 text-2xl font-semibold">{product.name}</h2><p className="mt-3 text-sm leading-6 text-muted-foreground">{product.description || 'Tuoke Codex 使用服务，平台统一管理执行资源。'}</p>
        <div className="mt-7 grid gap-5 border-y py-6 sm:grid-cols-2"><Rule icon={Users} label="拼单规则" value={`${product.memberLimit} 人成团，当前 ${product.waitingMembers} 人`} /><Rule icon={CalendarClock} label="服务周期" value={cycle(product)} /><Rule icon={Box} label="个人额度" value={quota(product.memberQuotaUnits)} /><Rule icon={Clock3} label="退款规则" value={`付款后 ${product.refundWindowMinutes ?? 60} 分钟内，未成团可退款`} /></div>
        <div className="mt-6"><h3 className="font-medium">额度规则</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">本套餐总额度 {quota(product.totalQuotaUnits)}，按 {product.memberLimit} 名成员分配。调用时仅扣除您的个人额度，其他成员使用量不会占用您的份额。</p></div>
      </section>
      <aside className="h-fit rounded-2xl border bg-card p-5"><div className="text-sm text-muted-foreground">套餐价格</div><div className="mt-1 text-3xl font-semibold tabular-nums">{money(product.priceMicro)}</div><div className="mt-5"><Progress current={product.waitingMembers} total={product.memberLimit} /></div><p className="mt-3 text-sm text-muted-foreground">还差 {remainingMembers(product)} 人成团。成团后由管理员绑定资源并激活。</p><PurchaseButton product={product} className="mt-6 w-full" /><p className="mt-3 text-center text-xs text-muted-foreground">仅支持钱包余额支付</p></aside>
    </div>}
  </ResourceShell>
}

function Rule({ icon: Icon, label, value }: { icon: typeof Users; label: string; value: string }) { return <div className="flex gap-3"><Icon className="mt-0.5 size-4 text-muted-foreground" /><div><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-sm font-medium">{value}</div></div></div> }

const orderLabels: Record<string, string> = { pending_payment: '等待支付', paid_waiting_group: '等待拼单', grouped: '已成团 · 等待管理员激活', active: '已激活', refunded: '已退款', refund_pending: '退款处理中', completed: '已完成', cancelled: '已取消', expired: '已过期', failed: '失败' }

export function ResourceOrdersPage() {
  const client = useQueryClient()
  const query = useQuery<{ orders: ResourceOrder[] }>({ queryKey: ['resource-orders'], queryFn: () => apiFetch('/api/resources/orders') })
  const refund = useMutation({ mutationFn: (id: number) => apiFetch(`/api/resources/orders/${id}/refund`, { method: 'POST' }), onSuccess: () => { toast.success('退款成功，余额已退回钱包。'); client.invalidateQueries({ queryKey: ['resource-orders'] }); client.invalidateQueries({ queryKey: ['resource-products'] }); client.invalidateQueries({ queryKey: ['user-wallet'] }) } })
  return <ResourceShell title="我的资源订单" description="查看拼单进度、激活状态和退款期限。">
    {query.isLoading ? <TableSkeleton rows={5} /> : !query.data?.orders.length ? <EmptyState icon={ReceiptText} title="还没有资源订单" action={<Link to="/resources/products" className={buttonVariants()}>浏览套餐</Link>} /> : <div className="overflow-hidden rounded-2xl border bg-card"><div className="hidden grid-cols-[1.5fr_1fr_1fr_1fr_auto] gap-4 border-b bg-muted/30 px-4 py-3 text-xs text-muted-foreground md:grid"><span>商品</span><span>状态</span><span>拼单进度</span><span>创建时间</span><span className="w-16" /></div>{query.data.orders.map(order => <div key={order.id} className="grid gap-3 border-b p-4 last:border-0 md:grid-cols-[1.5fr_1fr_1fr_1fr_auto] md:items-center md:gap-4"><div><div className="font-medium">{order.productName}</div><code className="mt-1 block text-xs text-muted-foreground">{order.orderNo}</code></div><div><Badge variant="outline">{orderLabels[order.status] ?? order.status}</Badge></div><div className="text-sm tabular-nums">{order.subpoolId ? `${order.memberCount}/${order.memberLimit}` : '尚未入队'}</div><div className="text-sm text-muted-foreground">{formatBeijingDateTime(order.createdAt)}</div><div className="w-16">{order.status === 'paid_waiting_group' && order.refundableUntil && Date.parse(order.refundableUntil.replace(' ', 'T') + 'Z') > Date.now() && <Button size="sm" variant="outline" disabled={refund.isPending} onClick={() => refund.mutate(order.id)}>退款</Button>}</div></div>)}</div>}
  </ResourceShell>
}

export function ResourceSubscriptionsPage() {
  const query = useQuery<{ subscriptions: Subscription[] }>({ queryKey: ['resource-subscriptions'], queryFn: () => apiFetch('/api/resources/subscriptions'), refetchInterval: 30_000 })
  return <ResourceShell title="我的 Codex 套餐" description="查看当前有效套餐、个人额度和到期时间。">
    {query.isLoading ? <div className="grid gap-4 md:grid-cols-2">{[1, 2].map(i => <CardSkeleton key={i} className="h-64" />)}</div> : !query.data?.subscriptions.length ? <EmptyState icon={PackageCheck} title="暂无激活套餐" description="订单成团并由管理员激活后会显示在这里。" action={<Link to="/resources/products" className={buttonVariants()}>选购套餐</Link>} /> : <div className="grid gap-4 md:grid-cols-2">{query.data.subscriptions.map(item => { const usedPercent = item.totalQuotaUnits ? Math.min(100, item.usedQuotaUnits / item.totalQuotaUnits * 100) : 0; return <article key={item.subpoolId} className="rounded-2xl border bg-card p-5"><div className="flex items-start justify-between gap-3"><div><Badge variant="secondary"><Check />运行中</Badge><h2 className="mt-3 text-lg font-semibold">{item.productName}</h2></div><span className="text-xs text-muted-foreground">V{item.productVersion}</span></div><div className="mt-6"><div className="flex justify-between text-sm"><span className="text-muted-foreground">剩余额度</span><span className="font-semibold tabular-nums">{quota(item.remainingQuotaUnits)}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-foreground" style={{ width: `${100 - usedPercent}%` }} /></div><div className="mt-2 flex justify-between text-xs text-muted-foreground"><span>已使用 {quota(item.usedQuotaUnits)}</span><span>总计 {quota(item.totalQuotaUnits)}</span></div></div><div className="mt-6 grid grid-cols-2 gap-4 border-t pt-4 text-sm"><div><div className="text-xs text-muted-foreground">到期时间</div><div className="mt-1">{formatBeijingDateTime(item.endsAt)}</div></div><div><div className="text-xs text-muted-foreground">额度重置</div><div className="mt-1">{formatBeijingDateTime(item.quotaResetsAt)}</div></div></div></article> })}</div>}
  </ResourceShell>
}

export function ResourceUsagePage() {
  const query = useQuery<{ records: UsageRecord[] }>({ queryKey: ['resource-usage'], queryFn: () => apiFetch('/api/resources/usage?limit=100') })
  return <ResourceShell title="Codex 使用记录" description="仅显示您自己的套餐调用和额度消耗。">
    {query.isLoading ? <TableSkeleton rows={7} /> : !query.data?.records.length ? <EmptyState icon={History} title="暂无使用记录" description="通过套餐调用 Codex 后，记录会显示在这里。" /> : <div className="overflow-hidden rounded-2xl border bg-card"><div className="hidden grid-cols-[1.2fr_1.4fr_1fr_1fr] gap-4 border-b bg-muted/30 px-4 py-3 text-xs text-muted-foreground sm:grid"><span>时间</span><span>模型</span><span>额度消耗</span><span>Token</span></div>{query.data.records.map(record => <div key={record.reservationId} className="grid gap-2 border-b p-4 last:border-0 sm:grid-cols-[1.2fr_1.4fr_1fr_1fr] sm:items-center sm:gap-4"><span className="text-sm text-muted-foreground">{formatBeijingDateTime(record.createdAt)}</span><code className="break-all text-sm">{record.modelId || '自动路由'}</code><span className="text-sm tabular-nums">{quota(record.consumedQuotaUnits)}</span><div className="text-sm tabular-nums"><span>{number(record.totalTokens)}</span><div className="mt-0.5 text-xs text-muted-foreground">输入 {number(record.inputTokens)} · 输出 {number(record.outputTokens)}</div></div></div>)}</div>}
  </ResourceShell>
}
