import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CopyPlus, Eye, PackagePlus, Plus, Send, ShoppingBag } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { NavLink } from 'react-router-dom'

import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TableSkeleton } from '@/components/ui/skeleton'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { formatBeijingDateTime } from '@/lib/utils'

type Product = {
  id: number
  productKey: string
  version: number
  name: string
  description?: string | null
  status: 'draft' | 'published' | 'unpublished' | 'archived'
  priceMicro: number
  memberLimit: number
  durationValue: number
  durationUnit: 'day' | 'month'
  quotaAllocationType: 'equal' | 'fixed'
  totalQuotaUnits: number
  memberQuotaUnits: number
  meterVersion: string
  groupTimeoutMinutes: number
  refundWindowMinutes: number
  saleStartsAt?: string | null
  saleEndsAt?: string | null
  createdAt: string
  orderCount: number
}

type ProductForm = {
  productKey: string
  name: string
  description: string
  priceYuan: string
  memberLimit: string
  durationValue: string
  durationUnit: 'day' | 'month'
  totalQuotaUnits: string
  memberQuotaUnits: string
  meterVersion: string
  groupTimeoutMinutes: string
  refundWindowMinutes: string
}

const tabs = [
  ['/admin/resources', '运营概览'],
  ['/admin/resources/products', '商品管理'],
  ['/admin/resources/orders', '订单管理'],
  ['/admin/resources/subpools', '小号池管理'],
  ['/admin/resources/audit', '审计日志'],
] as const

const emptyForm: ProductForm = {
  productKey: '', name: '', description: '', priceYuan: '', memberLimit: '4',
  durationValue: '1', durationUnit: 'month', totalQuotaUnits: '1000000',
  memberQuotaUnits: '250000', meterVersion: 'tokens-v1',
  groupTimeoutMinutes: '10080', refundWindowMinutes: '60',
}

const statusLabel: Record<Product['status'], string> = {
  draft: '草稿', published: '已发布', unpublished: '已下架', archived: '已归档',
}

function money(value: number) {
  return `¥${(Number(value || 0) / 1_000_000).toFixed(2)}`
}

function units(value: number) {
  return new Intl.NumberFormat('zh-CN').format(Number(value || 0))
}

function cycle(product: Product) {
  return `${product.durationValue} ${product.durationUnit === 'month' ? '个月' : '天'}`
}

function statusTone(status: Product['status']) {
  if (status === 'published') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
  if (status === 'draft') return 'border-amber-500/30 bg-amber-500/10 text-amber-300'
  return 'border-border bg-muted/40 text-muted-foreground'
}

function toForm(product?: Product | null): ProductForm {
  if (!product) return { ...emptyForm }
  return {
    productKey: product.productKey,
    name: product.name,
    description: product.description ?? '',
    priceYuan: String(product.priceMicro / 1_000_000),
    memberLimit: String(product.memberLimit),
    durationValue: String(product.durationValue),
    durationUnit: product.durationUnit,
    totalQuotaUnits: String(product.totalQuotaUnits),
    memberQuotaUnits: String(product.memberQuotaUnits),
    meterVersion: product.meterVersion,
    groupTimeoutMinutes: String(product.groupTimeoutMinutes),
    refundWindowMinutes: String(product.refundWindowMinutes),
  }
}

function payload(form: ProductForm, includeKey: boolean) {
  const priceMicro = Math.round(Number(form.priceYuan) * 1_000_000)
  const memberLimit = Math.trunc(Number(form.memberLimit))
  const totalQuotaUnits = Math.trunc(Number(form.totalQuotaUnits))
  const memberQuotaUnits = Math.trunc(Number(form.memberQuotaUnits))
  if (!form.name.trim() || (includeKey && !form.productKey.trim())) throw new Error('请填写商品名称和商品标识')
  if (!Number.isSafeInteger(priceMicro) || priceMicro <= 0) throw new Error('商品价格必须大于 0')
  if (!Number.isSafeInteger(memberLimit) || memberLimit < 2) throw new Error('拼单人数至少为 2 人')
  if (memberQuotaUnits * memberLimit > totalQuotaUnits) throw new Error('成员额度总和不能超过商品总额度')
  return {
    ...(includeKey ? { productKey: form.productKey.trim() } : {}),
    name: form.name.trim(), description: form.description.trim() || null,
    priceMicro, memberLimit,
    durationValue: Math.trunc(Number(form.durationValue)), durationUnit: form.durationUnit,
    quotaAllocationType: 'equal', totalQuotaUnits, memberQuotaUnits,
    meterVersion: form.meterVersion.trim(),
    groupTimeoutMinutes: Math.trunc(Number(form.groupTimeoutMinutes)),
    refundWindowMinutes: Math.trunc(Number(form.refundWindowMinutes)),
  }
}

function ProductEditor({ open, source, onOpenChange, onSaved }: {
  open: boolean
  source: Product | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<ProductForm>(() => toForm(source))
  const isVersion = source !== null
  const save = useMutation({
    mutationFn: () => apiFetch(isVersion
      ? `/api/admin/resources/products/${source.id}/new-version`
      : '/api/admin/resources/products', {
      method: 'POST', body: JSON.stringify(payload(form, !isVersion)),
    }),
    onSuccess: () => {
      toast.success(isVersion ? `已创建 ${source.productKey} 的新草稿版本` : '商品草稿已创建')
      onOpenChange(false)
      onSaved()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const set = <K extends keyof ProductForm>(key: K, value: ProductForm[K]) => setForm(current => ({ ...current, [key]: value }))
  const submit = (event: FormEvent) => {
    event.preventDefault()
    try { payload(form, !isVersion); save.mutate() }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogPopup className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
      <DialogTitle>{isVersion ? `创建 ${source.productKey} 新版本` : '创建 Codex 拼单商品'}</DialogTitle>
      <DialogDescription className="mt-1">保存后生成草稿，确认配置无误后再发布到用户商城。</DialogDescription>
      <form className="mt-6 space-y-5" onSubmit={submit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="商品标识" hint="发布后通过新版本调整配置">
            <Input value={form.productKey} disabled={isVersion} onChange={e => set('productKey', e.target.value)} placeholder="codex-pro20-4p" />
          </Field>
          <Field label="商品名称"><Input value={form.name} onChange={e => set('name', e.target.value)} placeholder="Codex Pro20 四人月拼单" /></Field>
        </div>
        <Field label="商品描述"><textarea className="min-h-20 w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30" value={form.description} onChange={e => set('description', e.target.value)} placeholder="面向用户展示的套餐说明" /></Field>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="价格（元）"><Input type="number" min="0.01" step="0.01" value={form.priceYuan} onChange={e => set('priceYuan', e.target.value)} /></Field>
          <Field label="拼单人数"><Input type="number" min="2" step="1" value={form.memberLimit} onChange={e => set('memberLimit', e.target.value)} /></Field>
          <Field label="有效周期"><Input type="number" min="1" step="1" value={form.durationValue} onChange={e => set('durationValue', e.target.value)} /></Field>
          <Field label="周期单位"><select className="h-9 w-full rounded-lg border bg-background px-3 text-sm" value={form.durationUnit} onChange={e => set('durationUnit', e.target.value as ProductForm['durationUnit'])}><option value="month">月</option><option value="day">天</option></select></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="商品总额度"><Input type="number" min="1" step="1" value={form.totalQuotaUnits} onChange={e => set('totalQuotaUnits', e.target.value)} /></Field>
          <Field label="每位成员额度"><Input type="number" min="1" step="1" value={form.memberQuotaUnits} onChange={e => set('memberQuotaUnits', e.target.value)} /></Field>
          <Field label="计量版本"><Input value={form.meterVersion} onChange={e => set('meterVersion', e.target.value)} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="成团超时（分钟）"><Input type="number" min="1" step="1" value={form.groupTimeoutMinutes} onChange={e => set('groupTimeoutMinutes', e.target.value)} /></Field>
          <Field label="退款窗口（分钟）"><Input type="number" min="0" step="1" value={form.refundWindowMinutes} onChange={e => set('refundWindowMinutes', e.target.value)} /></Field>
        </div>
        <div className="flex justify-end gap-2 border-t pt-5">
          <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
          <Button type="submit" disabled={save.isPending}><PackagePlus />{save.isPending ? '保存中' : '保存草稿'}</Button>
        </div>
      </form>
    </DialogPopup>
  </Dialog>
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <div><Label>{label}</Label>{hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}<div className="mt-2">{children}</div></div>
}

function ProductDetail({ product, open, onOpenChange }: { product: Product | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const query = useQuery<{ product: Product }>({
    queryKey: ['admin-resource-product', product?.id],
    queryFn: () => apiFetch(`/api/admin/resources/products/${product!.id}`),
    enabled: open && product !== null,
  })
  const value = query.data?.product ?? product
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogPopup className="sm:max-w-xl">
    <DialogTitle>商品版本详情</DialogTitle>
    <DialogDescription className="mt-1">已发布版本不可原地修改，配置调整需要创建新版本。</DialogDescription>
    {value && <dl className="mt-6 grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
      <Info label="商品" value={`${value.name} · V${value.version}`} />
      <Info label="状态" value={statusLabel[value.status]} />
      <Info label="商品标识" value={value.productKey} />
      <Info label="价格" value={money(value.priceMicro)} />
      <Info label="拼单人数" value={`${value.memberLimit} 人`} />
      <Info label="周期" value={cycle(value)} />
      <Info label="总额度" value={`${units(value.totalQuotaUnits)} units`} />
      <Info label="成员额度" value={`${units(value.memberQuotaUnits)} units`} />
      <Info label="成团超时" value={`${value.groupTimeoutMinutes} 分钟`} />
      <Info label="退款窗口" value={`${value.refundWindowMinutes} 分钟`} />
      <Info label="计量版本" value={value.meterVersion} />
      <Info label="创建时间" value={formatBeijingDateTime(value.createdAt)} />
    </dl>}
    {value?.description && <div className="mt-5 border-t pt-4 text-sm text-muted-foreground">{value.description}</div>}
    <div className="mt-6 flex justify-end"><DialogClose render={<Button variant="outline" />}>关闭</DialogClose></div>
  </DialogPopup></Dialog>
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words font-medium">{value}</dd></div>
}

export function AdminResourceProductsPage() {
  const queryClient = useQueryClient()
  const [editor, setEditor] = useState<{ open: boolean; source: Product | null; key: number }>({ open: false, source: null, key: 0 })
  const [detail, setDetail] = useState<Product | null>(null)
  const query = useQuery<{ products: Product[] }>({ queryKey: ['admin-resource-products'], queryFn: () => apiFetch('/api/admin/resources/products') })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-resource-products'] })
  const statusChange = useMutation({
    mutationFn: ({ product, action }: { product: Product; action: 'publish' | 'unpublish' }) => apiFetch(`/api/admin/resources/products/${product.id}/${action}`, { method: 'POST' }),
    onSuccess: (_, variables) => { toast.success(variables.action === 'publish' ? '商品已发布' : '商品已下架'); refresh() },
    onError: (error: Error) => toast.error(error.message),
  })
  const openVersion = async (product: Product) => {
    try {
      const response = await apiFetch<{ product: Product }>(`/api/admin/resources/products/${product.id}`)
      setEditor(current => ({ open: true, source: response.product, key: current.key + 1 }))
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
  }
  const rows = query.data?.products ?? []

  return <div className="mx-auto w-full max-w-7xl">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div><h1 className="text-2xl font-semibold">资源商品管理</h1><p className="mt-1 text-sm text-muted-foreground">创建和管理 Codex 拼单商品、额度承诺及版本状态。</p></div>
      <Button onClick={() => setEditor(current => ({ open: true, source: null, key: current.key + 1 }))}><Plus />创建商品</Button>
    </div>
    <nav className="mt-6 flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl border border-border/70 bg-background/65 p-1 backdrop-blur-xl [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {tabs.map(([to, label]) => <NavLink key={to} end={to === '/admin/resources'} to={to} className={({ isActive }) => `shrink-0 rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>{label}</NavLink>)}
    </nav>
    <div className="mt-6">
      {query.isLoading ? <TableSkeleton rows={6} /> : !rows.length ? <EmptyState icon={ShoppingBag} title="暂无资源商品" description="创建第一个 Codex 拼单商品草稿。" /> : <div className="overflow-hidden rounded-xl border bg-card">
        <div className="hidden grid-cols-[1.7fr_.7fr_.8fr_.7fr_.8fr_1.5fr] gap-4 border-b bg-muted/30 px-4 py-3 text-xs text-muted-foreground lg:grid"><span>商品</span><span>状态</span><span>价格</span><span>人数</span><span>周期</span><span>操作</span></div>
        {rows.map(product => <div key={product.id} className="grid gap-3 border-b p-4 last:border-0 lg:grid-cols-[1.7fr_.7fr_.8fr_.7fr_.8fr_1.5fr] lg:items-center lg:gap-4">
          <div className="min-w-0"><div className="truncate font-medium">{product.name}</div><div className="mt-1 truncate text-xs text-muted-foreground">{product.productKey} · V{product.version} · {formatBeijingDateTime(product.createdAt)}</div><div className="mt-1 text-xs text-muted-foreground">额度 {units(product.memberQuotaUnits)}/人 · {product.orderCount || 0} 个订单</div></div>
          <div><span className={`inline-flex rounded-full border px-2.5 py-1 text-xs ${statusTone(product.status)}`}>{statusLabel[product.status]}</span></div>
          <span>{money(product.priceMicro)}</span><span>{product.memberLimit} 人</span><span>{cycle(product)}</span>
          <div className="flex flex-wrap gap-2">
            {product.status === 'draft' && <Button size="sm" variant="outline" disabled={statusChange.isPending} onClick={() => statusChange.mutate({ product, action: 'publish' })}><Send />发布</Button>}
            {product.status === 'published' && <Button size="sm" variant="outline" disabled={statusChange.isPending} onClick={() => statusChange.mutate({ product, action: 'unpublish' })}>下架</Button>}
            {product.status !== 'draft' && <Button size="icon-sm" variant="ghost" title="创建新版本" onClick={() => void openVersion(product)}><CopyPlus /></Button>}
            <Button size="icon-sm" variant="ghost" title="查看详情" onClick={() => setDetail(product)}><Eye /></Button>
          </div>
        </div>)}
      </div>}
    </div>
    <ProductEditor key={editor.key} open={editor.open} source={editor.source} onOpenChange={open => setEditor(current => ({ ...current, open }))} onSaved={refresh} />
    <ProductDetail product={detail} open={detail !== null} onOpenChange={open => { if (!open) setDetail(null) }} />
  </div>
}
