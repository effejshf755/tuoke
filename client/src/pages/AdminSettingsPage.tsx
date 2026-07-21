import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Settings = { default_consumer_rpm:number; registration_enabled:boolean; new_user_bonus_micro:number; minimum_recharge_micro:number; maximum_recharge_micro:number; platform_notice:string; maintenance_mode:boolean }
const yuan = (micro:number) => (Number(micro || 0) / 1_000_000).toFixed(2)
export default function AdminSettingsPage() {
  const qc = useQueryClient(); const [form,setForm]=useState<Settings|null>(null)
  const query=useQuery<{settings:Settings}>({queryKey:['admin-settings'],queryFn:()=>apiFetch('/api/admin/settings')})
  useEffect(()=>{if(query.data) setForm(query.data.settings)},[query.data])
  const save=useMutation({mutationFn:()=>apiFetch('/api/admin/settings',{method:'PUT',body:JSON.stringify(form)}),onSuccess:()=>qc.invalidateQueries({queryKey:['admin-settings']})})
  if (!form) return <div>加载中…</div>
  const set=(key:keyof Settings,value:unknown)=>setForm({...form,[key]:value})
  return <div className="max-w-3xl"><h1 className="text-xl font-semibold">系统设置</h1><p className="mt-1 text-sm text-muted-foreground">平台级 API、注册、充值和运行状态配置。</p>
    <div className="mt-6 space-y-6 rounded-2xl border p-6"><section><h2 className="font-medium">API 设置</h2><Label className="mt-4 block">默认 API Key RPM</Label><Input className="mt-2" type="number" min="0" max="100000" value={form.default_consumer_rpm} onChange={e=>set('default_consumer_rpm',Number(e.target.value))}/></section>
    <section><h2 className="font-medium">用户注册</h2><label className="mt-4 flex items-center gap-2"><input type="checkbox" checked={form.registration_enabled} onChange={e=>set('registration_enabled',e.target.checked)}/>开放注册</label><Label className="mt-4 block">新用户赠送余额（元）</Label><Input className="mt-2" type="number" min="0" step="0.000001" value={yuan(form.new_user_bonus_micro)} onChange={e=>set('new_user_bonus_micro',Math.round(Number(e.target.value)*1_000_000))}/></section>
    <section><h2 className="font-medium">充值设置</h2><div className="grid gap-4 sm:grid-cols-2"><div><Label>最小充值金额（美元）</Label><Input className="mt-2" type="number" min="0" step="0.000001" value={yuan(form.minimum_recharge_micro)} onChange={e=>set('minimum_recharge_micro',Math.round(Number(e.target.value)*1_000_000))}/></div><div><Label>最大充值金额（美元）</Label><Input className="mt-2" type="number" min="0" step="0.000001" value={yuan(form.maximum_recharge_micro)} onChange={e=>set('maximum_recharge_micro',Math.round(Number(e.target.value)*1_000_000))}/></div></div></section>
    <section><h2 className="font-medium">平台状态</h2><Label className="mt-4 block">平台公告</Label><textarea className="mt-2 min-h-24 w-full rounded-md border bg-background p-3 text-sm" value={form.platform_notice} onChange={e=>set('platform_notice',e.target.value)}/><label className="mt-4 flex items-center gap-2"><input type="checkbox" checked={form.maintenance_mode} onChange={e=>set('maintenance_mode',e.target.checked)}/>维护模式</label></section>
    <Button disabled={save.isPending} onClick={()=>save.mutate()}>{save.isPending?'保存中…':'保存设置'}</Button>{save.isSuccess&&<span className="ml-3 text-sm text-green-600">已保存</span>}</div></div>
}
