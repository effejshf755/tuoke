import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Copy, Upload } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiFetch } from '@/lib/api'
import { formatBeijingDateTime } from '@/lib/utils'

type Order = {
  id: number
  order_no: string
  amount: number
  status: string
  payment_method: string | null
  payment_reference: string | null
  proof_submitted_at: string | null
  created_at: string
}
type Transaction = { id: number; type: string; delta: number; balance_after: number; created_at: string }
type ManualConfig = { threshold: number; qr_image: string; instructions: string }

const presets = [10, 20, 50, 100, 200, 500]
const statusText: Record<string, string> = { pending: '待确认', paid: '已到账', cancelled: '已取消', expired: '已过期' }
const money = (value: number) => `¥${Number(value || 0).toFixed(2)}`

export default function UserWalletPanel() {
  const [amount, setAmount] = useState('10')
  const [activeManualOrder, setActiveManualOrder] = useState<Order | null>(null)
  const [proof, setProof] = useState<File | null>(null)
  const [error, setError] = useState('')
  const wallet = useQuery<{ wallet: { balance: number; available_balance: number; reserved_balance: number } }>({ queryKey: ['user-wallet'], queryFn: () => apiFetch('/api/user/wallet') })
  const orders = useQuery<{ orders: Order[] }>({ queryKey: ['user-recharge-orders'], queryFn: () => apiFetch('/api/user/recharge/orders') })
  const billing = useQuery<{ transactions: Transaction[] }>({ queryKey: ['user-wallet-transactions'], queryFn: () => apiFetch('/api/user/wallet/transactions') })
  const settings = useQuery<{ minimum_recharge_micro: number; maximum_recharge_micro: number }>({ queryKey: ['public-platform-settings'], queryFn: () => apiFetch('/api/public/settings') })
  const manual = useQuery<ManualConfig>({ queryKey: ['manual-recharge-config'], queryFn: () => apiFetch('/api/user/recharge/manual-config') })

  const create = useMutation<{ order: Order }, Error, { value: number; method: 'alipay' | 'manual' }>({
    mutationFn: ({ value, method }) => apiFetch('/api/user/recharge/orders', { method: 'POST', body: JSON.stringify({ amount: value, payment_method: method }) }),
    onSuccess: async ({ order }, variables) => {
      await orders.refetch()
      if (variables.method === 'manual') { setActiveManualOrder(order); return }
      const payment = await apiFetch<{ form_action: string; params: Record<string, string> }>(`/api/user/recharge/orders/${order.id}/alipay`, { method: 'POST', body: '{}' })
      const form = document.createElement('form')
      form.method = 'POST'; form.acceptCharset = 'UTF-8'; form.action = payment.form_action
      Object.entries(payment.params).forEach(([name, value]) => { const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.appendChild(input) })
      document.body.appendChild(form); form.submit()
    },
    onError: (requestError) => setError(requestError.message),
  })
  const upload = useMutation({
    mutationFn: async () => {
      if (!activeManualOrder || !proof) throw new Error('请选择付款截图')
      const body = new FormData(); body.append('proof', proof)
      return apiFetch(`/api/user/recharge/orders/${activeManualOrder.id}/proof`, { method: 'POST', body })
    },
    onSuccess: async () => { setProof(null); await orders.refetch(); setActiveManualOrder((order) => order ? { ...order, proof_submitted_at: new Date().toISOString() } : order) },
    onError: (requestError) => setError((requestError as Error).message),
  })

  function submit() {
    const value = Number(amount)
    const min = (settings.data?.minimum_recharge_micro ?? 1_000_000) / 1_000_000
    const max = (settings.data?.maximum_recharge_micro ?? Number.MAX_SAFE_INTEGER) / 1_000_000
    if (!Number.isFinite(value) || value < min || value > max) { setError(`充值金额需要在 ${money(min)} 至 ${money(max)} 之间`); return }
    const threshold = manual.data?.threshold ?? 100
    const method = value >= threshold ? 'manual' : 'alipay'
    if (method === 'manual' && !manual.data?.qr_image) { setError('管理员尚未配置大额充值收款码，请稍后再试'); return }
    setError(''); create.mutate({ value, method })
  }

  const available = wallet.data?.wallet.available_balance ?? wallet.data?.wallet.balance ?? 0
  return <section className="mt-6 rounded-2xl border bg-card p-6">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-medium">钱包</h2><p className="mt-1 text-sm text-muted-foreground">当前可用余额</p></div><div className="text-3xl font-semibold tabular-nums">{money(available)}</div></div>
    <div className="mt-5 border-y py-5">
      <Label htmlFor="recharge-amount">充值金额</Label>
      <div className="mt-2 flex flex-wrap gap-2">{presets.map((value) => <Button key={value} size="sm" variant={amount === String(value) ? 'default' : 'outline'} onClick={() => setAmount(String(value))}>{money(value)}</Button>)}</div>
      <Input id="recharge-amount" className="mt-3 max-w-xs" type="number" min="1" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
      <p className="mt-2 text-xs text-muted-foreground">100元以下使用支付宝在线支付，100元及以上使用收款码人工核对。</p>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <Button className="mt-4" onClick={submit} disabled={create.isPending}>{create.isPending ? '创建中...' : '立即充值'}</Button>
    </div>

    {activeManualOrder && <div className="mt-5 border-b pb-5">
      <h3 className="font-medium">大额人工充值</h3>
      <div className="mt-4 grid gap-5 sm:grid-cols-[180px_1fr]">
        <img className="aspect-square w-[180px] border object-contain" src={manual.data?.qr_image} alt="充值收款二维码" />
        <div className="space-y-3 text-sm"><p>应付金额：<strong>{money(activeManualOrder.amount)}</strong></p><div><p className="text-muted-foreground">付款备注码</p><div className="mt-1 flex items-center gap-2"><code className="border bg-muted px-3 py-2 text-base">{activeManualOrder.payment_reference}</code><Button size="icon" variant="outline" title="复制备注码" onClick={() => navigator.clipboard.writeText(activeManualOrder.payment_reference ?? '')}><Copy /></Button></div></div><p className="text-xs text-muted-foreground">付款金额和备注码必须完全一致，否则管理员无法确认。到账通常在管理员核对后完成。</p></div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3"><Input className="max-w-sm" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setProof(event.target.files?.[0] ?? null)} /><Button variant="outline" disabled={!proof || upload.isPending} onClick={() => upload.mutate()}><Upload />{upload.isPending ? '上传中...' : '提交付款截图'}</Button>{activeManualOrder.proof_submitted_at && <span className="text-sm text-emerald-600">付款凭证已提交，等待管理员确认</span>}</div>
    </div>}

    <div className="mt-6 grid gap-6 lg:grid-cols-2"><div><h3 className="font-medium">充值记录</h3><div className="mt-3 space-y-2">{orders.data?.orders.slice(0, 8).map((order) => <div key={order.id} className="border-b py-3 text-sm"><div className="flex flex-wrap justify-between gap-2"><span className="font-mono text-xs">{order.order_no}</span><span>{money(order.amount)}</span><span>{statusText[order.status] ?? order.status}</span></div>{order.payment_reference && <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>备注码 {order.payment_reference}{order.proof_submitted_at ? ' · 凭证已提交' : ''}</span>{order.status === 'pending' && <Button size="sm" variant="outline" onClick={() => { setActiveManualOrder(order); setProof(null); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>查看付款信息</Button>}</div>}</div>)}</div></div><div><h3 className="font-medium">账单记录</h3><div className="mt-3 space-y-2">{billing.data?.transactions.slice(0, 8).map((item) => <div key={item.id} className="flex flex-wrap justify-between gap-2 border-b py-3 text-sm"><span>{item.type === 'recharge' ? '充值' : item.type}</span><span>{item.delta >= 0 ? '+' : ''}{money(item.delta / 1_000_000)}</span><span className="text-xs text-muted-foreground">{formatBeijingDateTime(item.created_at)}</span></div>)}</div></div></div>
  </section>
}
