import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CopyPlus, Eye, PackagePlus, Plus, Send, Settings2, ShoppingBag, Trash2 } from 'lucide-react'
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
  subpoolCount?: number
  blockingOrderCount?: number
  blockingSubpoolCount?: number
  editingBlockedOrderCount?: number
  editingBlockedSubpoolCount?: number
}

type ProductForm = {
  productKey: string
  name: string
  description: string
  totalPriceYuan: string
  memberLimit: string
  durationValue: string
  durationUnit: 'day' | 'month'
  totalPoints: string
  groupTimeoutHours: string
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
  productKey: 'codex-pro-x20', name: '', description: '', totalPriceYuan: '', memberLimit: '4',
  durationValue: '1', durationUnit: 'month', totalPoints: '100',
  groupTimeoutHours: '168', refundWindowMinutes: '60',
}

const PRODUCT_KEYS = ['codex-pro-x20', 'codex-pro-x5'] as const
const PRODUCT_POINTS_WAN: Record<string, string> = {
  'codex-pro-x20': '100',
  'codex-pro-x5': '25',
}
const GROUP_OPTIONS = [5, 4, 3, 2] as const
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
    totalPriceYuan: String(product.priceMicro * product.memberLimit / 1_000_000),
    memberLimit: String(product.memberLimit),
    durationValue: String(product.durationValue),
    durationUnit: product.durationUnit,
    totalPoints: String(product.totalQuotaUnits / 10_000),
    groupTimeoutHours: String(product.groupTimeoutMinutes / 60),
    refundWindowMinutes: String(product.refundWindowMinutes),
  }
}

function payload(form: ProductForm, includeKey: boolean) {
  const memberLimit = Math.trunc(Number(form.memberLimit))
  const totalPriceMicro = Math.round(Number(form.totalPriceYuan) * 1_000_000)
  const priceMicro = Math.round(totalPriceMicro / memberLimit)
  const totalQuotaUnits = Math.round(Number(form.totalPoints) * 10_000)
  const memberQuotaUnits = Math.floor(totalQuotaUnits / memberLimit)
  if (!form.name.trim() || (includeKey && !form.productKey.trim())) throw new Error('请填写商品名称和商品标识')
  if (!Number.isSafeInteger(memberLimit) || memberLimit < 2) throw new Error('拼单人数至少为 2 人')
  if (!Number.isSafeInteger(totalPriceMicro) || totalPriceMicro <= 0 || !Number.isSafeInteger(priceMicro)) throw new Error('会员总价必须大于 0')
  if (!Number.isSafeInteger(totalQuotaUnits) || totalQuotaUnits <= 0) throw new Error('商品总权益积分必须是大于 0 的整数')
  if (memberQuotaUnits <= 0) throw new Error('商品总权益积分不足以分配给每位成员')
  return {
    ...(includeKey ? { productKey: form.productKey.trim() } : {}),
    name: form.name.trim(), description: form.description.trim() || null,
    priceMicro, memberLimit,
    durationValue: Math.trunc(Number(form.durationValue)), durationUnit: form.durationUnit,
    quotaAllocationType: 'equal', totalQuotaUnits, memberQuotaUnits,
    meterVersion: 'points-v1',
    groupTimeoutMinutes: Math.round(Number(form.groupTimeoutHours) * 60),
    refundWindowMinutes: Math.trunc(Number(form.refundWindowMinutes)),
  }
}

function ProductEditor({ open, source, mode, onOpenChange, onSaved }: {
  open: boolean
  source: Product | null
  mode: 'create' | 'edit' | 'version'
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<ProductForm>(() => toForm(source))
  const hasSource = source !== null
  const save = useMutation({
    mutationFn: () => apiFetch(mode === 'version'
      ? `/api/admin/resources/products/${source!.id}/new-version`
      : mode === 'edit' ? `/api/admin/resources/products/${source!.id}` : '/api/admin/resources/products', {
      method: mode === 'edit' ? 'PUT' : 'POST', body: JSON.stringify(payload(form, mode === 'create')),
    }),
    onSuccess: () => {
      toast.success(mode === 'version' ? `已创建 ${source!.productKey} 的新草稿版本` : mode === 'edit' ? '商品信息已更新' : '商品草稿已创建')
      onOpenChange(false)
      onSaved()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const set = <K extends keyof ProductForm>(key: K, value: ProductForm[K]) => setForm(current => ({ ...current, [key]: value }))
  const nameSuggestions = GROUP_OPTIONS.map(memberLimit => ({
    memberLimit,
    name: `${form.productKey} ${memberLimit}人组`,
  }))
  const changeProductKey = (productKey: string) => setForm(current => ({
    ...current,
    productKey,
    totalPoints: PRODUCT_POINTS_WAN[productKey] ?? current.totalPoints,
    name: !current.name.trim() || current.name.startsWith('codex-pro-')
      ? `${productKey} ${current.memberLimit}人组`
      : current.name,
  }))
  const changeName = (name: string) => {
    const preset = nameSuggestions.find(option => option.name === name)
    setForm(current => ({ ...current, name, ...(preset ? { memberLimit: String(preset.memberLimit) } : {}) }))
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    try { payload(form, mode === 'create'); save.mutate() }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogPopup className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
      <DialogTitle>{mode === 'version' ? `创建 ${source!.productKey} 新版本` : mode === 'edit' ? `编辑 ${source!.name}` : '创建 Codex 拼单商品'}</DialogTitle>
      <DialogDescription className="mt-1">{mode === 'edit' ? '确认后直接更新当前商品；已有订单仍使用购买时冻结的配置。' : '保存后生成草稿，确认配置无误后再发布到用户商城。'}</DialogDescription>
      <form className="mt-6 space-y-5" onSubmit={submit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="商品标识" hint="发布后通过新版本调整配置">
            <select className="h-9 w-full rounded-lg border bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50" value={form.productKey} disabled={hasSource} onChange={e => changeProductKey(e.target.value)}>
              {!PRODUCT_KEYS.includes(form.productKey as typeof PRODUCT_KEYS[number]) && <option value={form.productKey}>{form.productKey}</option>}
              <option value="codex-pro-x20">codex-pro-x20</option>
              <option value="codex-pro-x5">codex-pro-x5</option>
            </select>
          </Field>
          <Field label="商品名称" hint="可从二至五人组中选择，也可以手动输入">
            <Input list="resource-product-name-options" value={form.name} onChange={e => changeName(e.target.value)} placeholder="选择预设名称或手动输入" />
            <datalist id="resource-product-name-options">{nameSuggestions.map(option => <option key={option.memberLimit} value={option.name} />)}</datalist>
          </Field>
        </div>
        <Field label="商品描述"><textarea className="min-h-20 w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30" value={form.description} onChange={e => set('description', e.target.value)} placeholder="面向用户展示的套餐说明" /></Field>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="会员总价（元）" hint={`每人下单价：¥${(Number(form.totalPriceYuan || 0) / Math.max(2, Number(form.memberLimit || 0))).toFixed(2)}`}><Input type="number" min="0.01" step="0.01" value={form.totalPriceYuan} onChange={e => set('totalPriceYuan', e.target.value)} /></Field>
          <Field label="拼单人数"><Input type="number" min="2" step="1" value={form.memberLimit} onChange={e => set('memberLimit', e.target.value)} /></Field>
          <Field label="有效周期"><Input type="number" min="1" step="1" value={form.durationValue} onChange={e => set('durationValue', e.target.value)} /></Field>
          <Field label="周期单位"><select className="h-9 w-full rounded-lg border bg-background px-3 text-sm" value={form.durationUnit} onChange={e => set('durationUnit', e.target.value as ProductForm['durationUnit'])}><option value="month">月</option><option value="day">天</option></select></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="商品总权益积分（万）" hint="以万积分为单位；X20 默认 100 万，X5 默认 25 万"><Input type="number" min="0.0001" step="0.0001" value={form.totalPoints} onChange={e => set('totalPoints', e.target.value)} /></Field>
          <Field label="每位成员积分" hint="由商品总权益积分除以拼单人数自动计算"><Input value={Number.isFinite(Number(form.totalPoints)) ? units(Math.floor(Number(form.totalPoints) * 10_000 / Math.max(2, Number(form.memberLimit || 0)))) : '—'} disabled /></Field>
          <Field label="计量规则" hint="输入 Token × 输入倍率 + 输出 Token × 输出倍率"><Input value="权益积分（points-v1）" disabled /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="成团超时（小时）"><Input type="number" min="1" step="1" value={form.groupTimeoutHours} onChange={e => set('groupTimeoutHours', e.target.value)} /></Field>
          <Field label="退款窗口（分钟）"><Input type="number" min="0" step="1" value={form.refundWindowMinutes} onChange={e => set('refundWindowMinutes', e.target.value)} /></Field>
        </div>
        <div className="flex justify-end gap-2 border-t pt-5">
          <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
          <Button type="submit" disabled={save.isPending}><PackagePlus />{save.isPending ? '保存中' : mode === 'edit' ? '确认更新' : '保存草稿'}</Button>
        </div>
      </form>
    </DialogPopup>
  </Dialog>
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <div><Label>{label}</Label>{hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}<div className="mt-2">{children}</div></div>
}

function ProductDetail({ product, open, onOpenChange, onEdit }: { product: Product | null; open: boolean; onOpenChange: (open: boolean) => void; onEdit: (product: Product) => void }) {
  const query = useQuery<{ product: Product }>({
    queryKey: ['admin-resource-product', product?.id],
    queryFn: () => apiFetch(`/api/admin/resources/products/${product!.id}`),
    enabled: open && product !== null,
  })
  const value = product ? { ...product, ...(query.data?.product ?? {}) } : null
  const blocked = Number(value?.editingBlockedOrderCount || 0) > 0 || Number(value?.editingBlockedSubpoolCount || 0) > 0
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogPopup className="sm:max-w-xl">
    <DialogTitle>商品版本详情</DialogTitle>
    <DialogDescription className="mt-1">没有进行中订单或小号池时，可以直接更新当前商品。</DialogDescription>
    {value && <dl className="mt-6 grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
      <Info label="商品" value={`${value.name} · V${value.version}`} />
      <Info label="状态" value={statusLabel[value.status]} />
      <Info label="商品标识" value={value.productKey} />
      <Info label="会员总价" value={money(value.priceMicro * value.memberLimit)} />
      <Info label="每人下单价" value={money(value.priceMicro)} />
      <Info label="拼单人数" value={`${value.memberLimit} 人`} />
      <Info label="周期" value={cycle(value)} />
      <Info label="总权益积分" value={`${units(value.totalQuotaUnits)} 积分`} />
      <Info label="成员权益积分" value={`${units(value.memberQuotaUnits)} 积分`} />
      <Info label="成团超时" value={`${value.groupTimeoutMinutes / 60} 小时`} />
      <Info label="退款窗口" value={`${value.refundWindowMinutes} 分钟`} />
      <Info label="计量版本" value={value.meterVersion} />
      <Info label="创建时间" value={formatBeijingDateTime(value.createdAt)} />
    </dl>}
    {value?.description && <div className="mt-5 border-t pt-4 text-sm text-muted-foreground">{value.description}</div>}
    <div className="mt-6 flex justify-end gap-2"><DialogClose render={<Button variant="outline" />}>关闭</DialogClose>{value && <Button disabled={blocked} title={blocked ? '商品正在拼单或运行中，不能编辑' : '编辑当前商品'} onClick={() => onEdit(value)}><CopyPlus />编辑商品信息</Button>}</div>
  </DialogPopup></Dialog>
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words font-medium">{value}</dd></div>
}

type PointsPolicy = {
  policy: { officialQuotaFloorPercent: number; defaultInputMultiplier: number; defaultCachedInputMultiplier: number; defaultOutputMultiplier: number }
  models: Array<{ modelId: string; inputMultiplier: number; cachedInputMultiplier: number; outputMultiplier: number; enabled: boolean }>
}

function PointsPolicyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const query = useQuery<PointsPolicy>({ queryKey: ['resource-points-policy'], queryFn: () => apiFetch('/api/admin/resources/points-policy'), enabled: open })
  const [draft, setDraft] = useState<PointsPolicy | null>(null)
  const value = draft ?? query.data ?? null
  const update = (next: PointsPolicy) => setDraft(next)
  const save = useMutation({
    mutationFn: () => apiFetch('/api/admin/resources/points-policy', { method: 'PUT', body: JSON.stringify({
      ...value!.policy, models: value!.models,
    }) }),
    onSuccess: () => { toast.success('积分计费规则已更新'); setDraft(null); onOpenChange(false) },
    onError: (error: Error) => toast.error(error.message),
  })
  return <Dialog open={open} onOpenChange={next => { if (!next) setDraft(null); onOpenChange(next) }}><DialogPopup className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
    <DialogTitle>权益积分计费规则</DialogTitle>
    <DialogDescription className="mt-1">倍率保存后仅影响新请求，已发起请求按预留时的倍率结算。</DialogDescription>
    {query.isError ? <div className="mt-5 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{query.error instanceof Error ? query.error.message : '计费规则加载失败'}</div> : !value ? <TableSkeleton rows={5} /> : <div className="mt-6 space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="官方额度保护线（%）" hint="达到或低于此比例时暂停新请求"><Input type="number" min="0" max="100" step="0.1" value={value.policy.officialQuotaFloorPercent} onChange={e => update({ ...value, policy: { ...value.policy, officialQuotaFloorPercent: Number(e.target.value) } })} /></Field>
        <Field label="默认输入倍率"><Input type="number" min="0.000001" step="0.1" value={value.policy.defaultInputMultiplier} onChange={e => update({ ...value, policy: { ...value.policy, defaultInputMultiplier: Number(e.target.value) } })} /></Field>
        <Field label="默认缓存输入倍率"><Input type="number" min="0.000001" step="0.05" value={value.policy.defaultCachedInputMultiplier} onChange={e => update({ ...value, policy: { ...value.policy, defaultCachedInputMultiplier: Number(e.target.value) } })} /></Field>
        <Field label="默认输出倍率"><Input type="number" min="0.000001" step="0.1" value={value.policy.defaultOutputMultiplier} onChange={e => update({ ...value, policy: { ...value.policy, defaultOutputMultiplier: Number(e.target.value) } })} /></Field>
      </div>
      <div><h3 className="text-sm font-medium">模型倍率</h3><div className="mt-3 overflow-hidden rounded-lg border">
        <div className="hidden grid-cols-[1fr_100px_100px_100px_60px] gap-3 border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground sm:grid"><span>模型</span><span>输入</span><span>缓存输入</span><span>输出</span><span>启用</span></div>
        {value.models.map((model, index) => <div key={model.modelId} className="grid gap-3 border-b p-3 last:border-0 sm:grid-cols-[1fr_100px_100px_100px_60px] sm:items-center"><code className="break-all text-sm">{model.modelId}</code><Input aria-label={`${model.modelId} 输入倍率`} type="number" min="0.000001" step="0.1" value={model.inputMultiplier} onChange={e => update({ ...value, models: value.models.map((item, i) => i === index ? { ...item, inputMultiplier: Number(e.target.value) } : item) })} /><Input aria-label={`${model.modelId} 缓存输入倍率`} type="number" min="0.000001" step="0.05" value={model.cachedInputMultiplier} onChange={e => update({ ...value, models: value.models.map((item, i) => i === index ? { ...item, cachedInputMultiplier: Number(e.target.value) } : item) })} /><Input aria-label={`${model.modelId} 输出倍率`} type="number" min="0.000001" step="0.1" value={model.outputMultiplier} onChange={e => update({ ...value, models: value.models.map((item, i) => i === index ? { ...item, outputMultiplier: Number(e.target.value) } : item) })} /><input aria-label={`${model.modelId} 启用`} type="checkbox" className="size-4" checked={model.enabled} onChange={e => update({ ...value, models: value.models.map((item, i) => i === index ? { ...item, enabled: e.target.checked } : item) })} /></div>)}
      </div></div>
    </div>}
    <div className="mt-6 flex justify-end gap-2"><DialogClose render={<Button variant="outline" />}>取消</DialogClose><Button disabled={!value || save.isPending} onClick={() => save.mutate()}><Settings2 />保存规则</Button></div>
  </DialogPopup></Dialog>
}

export function AdminResourceProductsPage() {
  const queryClient = useQueryClient()
  const [editor, setEditor] = useState<{ open: boolean; source: Product | null; mode: 'create' | 'edit' | 'version'; key: number }>({ open: false, source: null, mode: 'create', key: 0 })
  const [detail, setDetail] = useState<Product | null>(null)
  const [policyOpen, setPolicyOpen] = useState(false)
  const query = useQuery<{ products: Product[] }>({ queryKey: ['admin-resource-products'], queryFn: () => apiFetch('/api/admin/resources/products') })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-resource-products'] })
  const statusChange = useMutation({
    mutationFn: ({ product, action }: { product: Product; action: 'publish' | 'unpublish' }) => apiFetch(`/api/admin/resources/products/${product.id}/${action}`, { method: 'POST' }),
    onSuccess: (_, variables) => { toast.success(variables.action === 'publish' ? '商品已发布' : '商品已下架'); refresh() },
    onError: (error: Error) => toast.error(error.message),
  })
  const remove = useMutation({
    mutationFn: (product: Product) => apiFetch(`/api/admin/resources/products/${product.id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('已下架商品已删除'); refresh() },
    onError: (error: Error) => toast.error(error.message === 'Products with in-progress orders or subpools cannot be deleted'
      ? '该商品仍有进行中的订单或小号池，不能删除'
      : error.message),
  })
  const openVersion = async (product: Product) => {
    try {
      const response = await apiFetch<{ product: Product }>(`/api/admin/resources/products/${product.id}`)
      setEditor(current => ({ open: true, source: response.product, mode: 'version', key: current.key + 1 }))
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
  }
  const statusPriority: Record<Product['status'], number> = { published: 0, draft: 1, unpublished: 2, archived: 3 }
  const rows = [...(query.data?.products ?? [])].sort((left, right) =>
    statusPriority[left.status] - statusPriority[right.status]
    || new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())

  return <div className="mx-auto w-full max-w-7xl">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div><h1 className="text-2xl font-semibold">资源商品管理</h1><p className="mt-1 text-sm text-muted-foreground">创建和管理 Codex 拼单商品、额度承诺及版本状态。</p></div>
      <div className="flex gap-2"><Button variant="outline" onClick={() => setPolicyOpen(true)}><Settings2 />计费规则</Button><Button onClick={() => setEditor(current => ({ open: true, source: null, mode: 'create', key: current.key + 1 }))}><Plus />创建商品</Button></div>
    </div>
    <nav className="mt-6 flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl border border-border/70 bg-background/65 p-1 backdrop-blur-xl [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {tabs.map(([to, label]) => <NavLink key={to} end={to === '/admin/resources'} to={to} className={({ isActive }) => `shrink-0 rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>{label}</NavLink>)}
    </nav>
    <div className="mt-6">
      {query.isLoading ? <TableSkeleton rows={6} /> : !rows.length ? <EmptyState icon={ShoppingBag} title="暂无资源商品" description="创建第一个 Codex 拼单商品草稿。" /> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rows.map(product => { const blocked = Number(product.blockingOrderCount || 0) > 0 || Number(product.blockingSubpoolCount || 0) > 0; return <article key={product.id} className="flex min-h-72 flex-col rounded-lg border bg-card p-5">
          <div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><div className="flex size-11 shrink-0 items-center justify-center rounded-lg border bg-white p-2"><img src="/provider-logos/openai.svg" alt="Codex" className="size-full object-contain" /></div><div className="min-w-0"><h2 className="truncate text-base font-semibold">{product.productKey}</h2><p className="mt-1 truncate text-xs text-muted-foreground">{product.name} · V{product.version}</p></div></div><span className={`inline-flex shrink-0 rounded-full border px-2.5 py-1 text-xs ${statusTone(product.status)}`}>{statusLabel[product.status]}</span></div>
          {product.description && <p className="mt-4 line-clamp-2 text-sm text-muted-foreground">{product.description}</p>}
          <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-y py-4 text-sm"><Info label="每人价格" value={money(product.priceMicro)} /><Info label="拼单人数" value={`${product.memberLimit} 人`} /><Info label="有效周期" value={cycle(product)} /><Info label="每人积分" value={`${units(product.memberQuotaUnits)} 积分`} /><Info label="订单" value={`${product.orderCount || 0} 个`} /><Info label="创建时间" value={formatBeijingDateTime(product.createdAt)} /></dl>
          <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
            {product.status === 'draft' && <Button size="sm" variant="outline" disabled={statusChange.isPending} onClick={() => statusChange.mutate({ product, action: 'publish' })}><Send />发布</Button>}
            {product.status === 'published' && <Button size="sm" variant="outline" disabled={statusChange.isPending} onClick={() => statusChange.mutate({ product, action: 'unpublish' })}>下架</Button>}
            {product.status === 'unpublished' && <Button size="sm" variant="outline" disabled={statusChange.isPending} onClick={() => statusChange.mutate({ product, action: 'publish' })}><Send />重新上架</Button>}
            {product.status === 'unpublished' && <Button size="icon-sm" variant="ghost" title={blocked ? '仍有进行中的订单或小号池，不能删除' : '删除商品及其终态测试记录'} disabled={remove.isPending || blocked} onClick={() => { if (window.confirm(`确定删除“${product.name}”V${product.version}及其已结束的测试记录？删除后无法恢复。`)) remove.mutate(product) }}><Trash2 /></Button>}
            {product.status !== 'draft' && <Button size="icon-sm" variant="ghost" title="创建新版本" onClick={() => void openVersion(product)}><CopyPlus /></Button>}
            <Button size="icon-sm" variant="ghost" title="查看详情" onClick={() => setDetail(product)}><Eye /></Button>
          </div>
        </article>})}
      </div>}
    </div>
    <ProductEditor key={editor.key} open={editor.open} source={editor.source} mode={editor.mode} onOpenChange={open => setEditor(current => ({ ...current, open }))} onSaved={refresh} />
    <PointsPolicyDialog open={policyOpen} onOpenChange={setPolicyOpen} />
    <ProductDetail product={detail} open={detail !== null} onOpenChange={open => { if (!open) setDetail(null) }} onEdit={product => { setDetail(null); setEditor(current => ({ open: true, source: product, mode: 'edit', key: current.key + 1 })) }} />
  </div>
}
