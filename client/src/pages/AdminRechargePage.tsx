import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ImageUp } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch } from '@/lib/api'
import { formatBeijingDateTime } from '@/lib/utils'

type Order = { id:number; order_no:string; user_id:number; email:string; amount:number; status:string; payment_method:string|null; payment_reference:string|null; proof_submitted_at:string|null; provider_trade_no:string|null; note:string|null; created_at:string; paid_at:string|null }
const statuses = [['', '全部'], ['pending', '待确认'], ['paid', '已到账'], ['cancelled', '已取消'], ['expired', '已过期']]
const labels: Record<string, string> = { pending:'待确认', paid:'已到账', cancelled:'已取消', expired:'已过期' }
const money = (value:number) => `¥${Number(value || 0).toFixed(2)}`
const date = (value:string|null) => value ? formatBeijingDateTime(value) : '-'

export default function AdminRechargePage() {
  const client = useQueryClient()
  const [search,setSearch] = useState(''); const [status,setStatus] = useState('')
  const [selected,setSelected] = useState<Order|null>(null); const [tradeNo,setTradeNo] = useState(''); const [note,setNote] = useState('')
  const [qr,setQr] = useState<File|null>(null); const [proofImage,setProofImage] = useState(''); const [message,setMessage] = useState('')
  const orders = useQuery<{orders:Order[]}>({queryKey:['admin-recharge-orders',search,status],queryFn:()=>apiFetch(`/api/admin/recharge/orders?q=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}`)})
  const grouped = useMemo(()=>{const map=new Map<string,Order[]>(); for(const order of orders.data?.orders??[]) map.set(order.email,[...(map.get(order.email)??[]),order]); return Array.from(map,([email,items])=>({email,items}))},[orders.data?.orders])
  const uploadQr = useMutation({mutationFn:()=>{if(!qr) throw new Error('请选择二维码图片'); const body=new FormData(); body.append('qr',qr); return apiFetch('/api/admin/recharge/manual-config/qr',{method:'POST',body})},onSuccess:()=>{setQr(null);setMessage('大额充值收款二维码已更新。');client.invalidateQueries({queryKey:['manual-recharge-config']})}})
  const showProof = useMutation<{image:string},Error,number>({mutationFn:(id)=>apiFetch(`/api/admin/recharge/orders/${id}/proof`),onSuccess:(data)=>setProofImage(data.image)})
  const markPaid = useMutation<{balance_after?:number;balance?:number},Error,Order>({mutationFn:(order)=>apiFetch(`/api/admin/recharge/orders/${order.id}/mark-paid`,{method:'POST',body:JSON.stringify({provider_trade_no:tradeNo.trim()||undefined,note:note.trim()||undefined})}),onSuccess:(data)=>{setSelected(null);setTradeNo('');setNote('');setProofImage('');setMessage(`到账成功，用户新余额：${money(data.balance_after??data.balance??0)}`);client.invalidateQueries({queryKey:['admin-recharge-orders']});client.invalidateQueries({queryKey:['admin-users']});client.invalidateQueries({queryKey:['admin-wallet-users']})}})
  function prepare(order:Order){setSelected(order);setProofImage('');if(order.proof_submitted_at)showProof.mutate(order.id)}

  return <div className="max-w-[1500px]">
    <h1 className="text-xl font-semibold">充值订单</h1><p className="mt-1 text-sm text-muted-foreground">核对在线支付和大额人工充值，为用户安全入账。</p>
    <section className="mt-5 border-y py-5"><h2 className="font-medium">大额充值收款码</h2><p className="mt-1 text-xs text-muted-foreground">仅用于100元及以上人工充值。更新后用户创建的新订单会立即显示该二维码。</p><div className="mt-3 flex flex-wrap items-center gap-3"><Input className="max-w-sm" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event)=>setQr(event.target.files?.[0]??null)}/><Button variant="outline" disabled={!qr||uploadQr.isPending} onClick={()=>uploadQr.mutate()}><ImageUp />{uploadQr.isPending?'上传中...':'更新收款码'}</Button></div>{uploadQr.isError&&<p className="mt-2 text-sm text-destructive">{uploadQr.error.message}</p>}</section>
    <div className="mt-5 flex flex-wrap gap-3"><Input className="max-w-sm" value={search} onChange={(event)=>setSearch(event.target.value)} placeholder="搜索订单号或用户邮箱"/><select className="h-9 border bg-background px-3 text-sm" value={status} onChange={(event)=>setStatus(event.target.value)}>{statuses.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div>
    {message&&<div className="mt-4 border px-4 py-3 text-sm">{message}</div>}
    {selected&&<section className="mt-5 max-w-2xl border p-5"><h2 className="font-medium">确认到账：{selected.order_no}</h2><p className="mt-1 text-sm">{selected.email} · {money(selected.amount)}{selected.payment_reference?` · 备注码 ${selected.payment_reference}`:''}</p>{selected.payment_method==='manual'&&<div className="mt-4">{showProof.isPending?<p className="text-sm text-muted-foreground">正在加载付款凭证...</p>:proofImage?<img className="max-h-96 max-w-full border object-contain" src={proofImage} alt="用户付款凭证"/>:<p className="text-sm text-destructive">用户尚未提交付款凭证，请勿确认到账。</p>}</div>}<div className="mt-4"><label className="text-xs">交易号（建议填写）</label><Input className="mt-1.5" value={tradeNo} onChange={(event)=>setTradeNo(event.target.value)}/></div><div className="mt-3"><label className="text-xs">审核备注</label><Textarea className="mt-1.5" value={note} onChange={(event)=>setNote(event.target.value)}/></div><div className="mt-4 flex gap-2"><Button disabled={markPaid.isPending||(selected.payment_method==='manual'&&!selected.proof_submitted_at)} onClick={()=>markPaid.mutate(selected)}>{markPaid.isPending?'处理中...':'确认实际到账'}</Button><Button variant="outline" onClick={()=>{setSelected(null);setProofImage('')}}>取消</Button></div>{markPaid.isError&&<p className="mt-3 text-sm text-destructive">{markPaid.error.message}</p>}</section>}
    <div className="mt-6 grid gap-4 md:grid-cols-2">{grouped.map((group)=><section key={group.email} className="border bg-card p-5"><div className="flex justify-between gap-3"><div><h2 className="truncate text-sm font-medium">{group.email}</h2><p className="mt-1 text-xs text-muted-foreground">{group.items.length} 条充值记录</p></div><span>{money(group.items.reduce((sum,order)=>sum+order.amount,0))}</span></div><div className="mt-4 space-y-2">{group.items.map((order)=><div key={order.id} className="border-t pt-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><code className="text-xs">{order.order_no}</code><span>{money(order.amount)}</span><span>{labels[order.status]??order.status}</span></div><div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2"><span>{order.payment_method==='manual'?'人工收款码':'支付宝'}</span><span>{date(order.created_at)}</span>{order.payment_reference&&<span>备注码：{order.payment_reference}</span>}{order.proof_submitted_at&&<span className="text-emerald-600">付款凭证已提交</span>}</div>{order.status==='pending'&&<Button className="mt-3" size="sm" onClick={()=>prepare(order)}>审核到账</Button>}</div>)}</div></section>)}</div>
    {!orders.isLoading&&grouped.length===0&&<p className="py-8 text-center text-sm text-muted-foreground">暂无充值订单。</p>}
  </div>
}
