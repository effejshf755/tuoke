import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Transaction = { id: number; type: string; delta: number; balance_after: number; created_at: string }
type Order = { id: number; order_no: string; amount: number; status: string; created_at: string; expires_at?: string | null }
const presets = [10, 20, 50, 100, 200, 500]
const statusText: Record<string, string> = { pending: '待支付', paid: '已到账', cancelled: '已取消', expired: '已过期' }
const date = (v: string) => new Date(v).toLocaleString()

function remaining(expiresAt?: string | null): number {
  return expiresAt ? Math.max(0, new Date(expiresAt.replace(' ', 'T') + 'Z').getTime() - Date.now()) : 0
}

function Countdown({ expiresAt, onExpire }: { expiresAt?: string | null; onExpire: () => void }) {
  const [ms, setMs] = useState(() => remaining(expiresAt))
  useEffect(() => {
    const timer = window.setInterval(() => setMs(remaining(expiresAt)), 1000)
    return () => window.clearInterval(timer)
  }, [expiresAt])
  useEffect(() => { if (expiresAt && ms <= 0) onExpire() }, [expiresAt, ms, onExpire])
  if (!expiresAt || ms <= 0) return null
  const totalSeconds = Math.floor(ms / 1000)
  return <span className="text-xs text-muted-foreground">剩余 {String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:{String(totalSeconds % 60).padStart(2, '0')}</span>
}

export default function UserWalletPanel() {
  const [recharge, setRecharge] = useState(false)
  const [tab, setTab] = useState<'orders' | 'billing'>('orders')
  const [allOrders, setAllOrders] = useState(false), [allBilling, setAllBilling] = useState(false)
  const [amount, setAmount] = useState('10'), [error, setError] = useState('')
  const orders = useQuery<{ orders: Order[] }>({ queryKey: ['user-recharge-orders'], queryFn: () => apiFetch('/api/user/recharge/orders') })
  const billing = useQuery<{ transactions: Transaction[] }>({ queryKey: ['user-wallet-transactions'], queryFn: () => apiFetch('/api/user/wallet/transactions') })
  const settings = useQuery<{ minimum_recharge_micro: number; maximum_recharge_micro: number }>({ queryKey: ['public-platform-settings'], queryFn: () => apiFetch('/api/public/settings') })
  const cancel = useMutation<void, Error, number>({ mutationFn: (id) => apiFetch(`/api/user/recharge/orders/${id}/cancel`, { method: 'POST' }), onSuccess: () => orders.refetch() })
  const create = useMutation<{ order: { id: number } }, Error, number>({ mutationFn: (value) => apiFetch('/api/user/recharge/orders', { method: 'POST', body: JSON.stringify({ amount: value, payment_method: 'alipay' }) }), onSuccess: async ({ order }) => { setRecharge(false); orders.refetch(); const payment = await apiFetch<{ form_action: string; params: Record<string, string> }>(`/api/user/recharge/orders/${order.id}/alipay`, { method: 'POST', body: JSON.stringify({ mode: 'page' }) }); const form = document.createElement('form'); form.method = 'POST'; form.acceptCharset = 'UTF-8'; form.action = payment.form_action; for (const [key, value] of Object.entries(payment.params)) { const input = document.createElement('input'); input.type = 'hidden'; input.name = key; input.value = value; form.appendChild(input) } document.body.appendChild(form); form.submit() } })
  function submit() { const value = Number(amount), min = (settings.data?.minimum_recharge_micro ?? 0) / 1_000_000, max = (settings.data?.maximum_recharge_micro ?? Infinity) / 1_000_000; if (!Number.isFinite(value) || value < min || value > max) { setError(`充值金额需在 $${min} 至 $${max} 之间`); return } setError(''); create.mutate(value) }
  const cancelOrder = (id: number) => { if (!cancel.isPending) cancel.mutate(id) }
  const list = tab === 'orders' ? (allOrders ? orders.data?.orders : orders.data?.orders?.slice(0, 5)) : (allBilling ? billing.data?.transactions : billing.data?.transactions?.slice(0, 5))
  const hasMore = tab === 'orders' ? (orders.data?.orders.length ?? 0) > 5 : (billing.data?.transactions.length ?? 0) > 5
  return <section className="mt-6 rounded-3xl border bg-card p-6"><h2 className="font-medium">钱包</h2><Button className="mt-4" onClick={() => setRecharge(v => !v)}>{recharge ? '收起充值' : '充值'}</Button>{recharge && <div className="mt-4 rounded-2xl border p-4"><Label htmlFor="recharge-amount">充值金额</Label><div className="mt-2 flex flex-wrap gap-2">{presets.map(value => <Button key={value} size="sm" variant={amount === String(value) ? 'default' : 'outline'} onClick={() => setAmount(String(value))}>${value}</Button>)}</div><Input id="recharge-amount" className="mt-3 max-w-xs" type="number" value={amount} onChange={e => setAmount(e.target.value)} step="0.01" />{error && <p className="mt-2 text-sm text-destructive">{error}</p>}<Button className="mt-4" onClick={submit} disabled={create.isPending}>{create.isPending ? '创建中…' : '创建充值订单'}</Button></div>}<div className="mt-6 flex gap-1 border-b"><button className="px-3 py-2 text-sm" onClick={() => setTab('orders')}>充值记录</button><button className="px-3 py-2 text-sm" onClick={() => setTab('billing')}>账单历史</button></div><div className="space-y-2 pt-4">{list?.map(item => 'order_no' in item ? <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3 text-sm"><span>{item.order_no}</span><span>${item.amount.toFixed(2)}</span><span>{statusText[item.status] ?? item.status}</span>{item.status === 'pending' ? <span className="flex items-center gap-2"><Countdown expiresAt={item.expires_at} onExpire={() => orders.refetch()} /><Button size="sm" variant="outline" onClick={() => cancelOrder(item.id)} disabled={cancel.isPending}>取消订单</Button></span> : <span>{date(item.created_at)}</span>}</div> : <div key={item.id} className="flex flex-wrap justify-between rounded-xl border p-3 text-sm"><span>{item.type === 'recharge' ? '充值' : item.type}</span><span>{item.delta >= 0 ? '+' : ''}${(item.delta / 1_000_000).toFixed(2)}</span><span>{date(item.created_at)}</span></div>)}{hasMore && <Button variant="link" onClick={() => tab === 'orders' ? setAllOrders(v => !v) : setAllBilling(v => !v)}>{(tab === 'orders' ? allOrders : allBilling) ? '收起' : '查看全部'}</Button>}</div></section>
}
