import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type Key = { id: number; name: string; keyPrefix: string; status: string; createdAt: string; lastUsedAt: string | null; expiresAt: string | null }
type Usage = { total_requests: number; prompt_tokens: number; completion_tokens: number; total_tokens: number; monthly_used_tokens: number; monthly_token_limit: number; monthly_remaining_tokens: number }

export default function UserCenterPage() {
  const client = useQueryClient(); const [name, setName] = useState(''); const [newKey, setNewKey] = useState('')
  const keys = useQuery<{ keys: Key[] }>({ queryKey: ['consumer-keys'], queryFn: () => apiFetch('/api/consumer-keys') })
  const usage = useQuery<Usage>({ queryKey: ['user-usage'], queryFn: () => apiFetch('/api/user/usage') })
  const create = useMutation({ mutationFn: () => apiFetch<{ key: string }>('/api/consumer-keys', { method: 'POST', body: JSON.stringify({ name }) }), onSuccess: r => { setNewKey(r.key); setName(''); client.invalidateQueries({ queryKey: ['consumer-keys'] }) } })
  const revoke = useMutation({ mutationFn: (id: number) => apiFetch(`/api/consumer-keys/${id}`, { method: 'DELETE' }), onSuccess: () => client.invalidateQueries({ queryKey: ['consumer-keys'] }) })
  return <div className="max-w-2xl"><h1 className="text-xl font-semibold">User center</h1><p className="mt-1 text-sm text-muted-foreground">Manage your API keys.</p>
    <div className="mt-6 rounded-3xl border bg-card p-6"><h2 className="font-medium">Usage</h2><div className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4"><div><div className="text-muted-foreground">Requests</div><div className="mt-1 text-lg font-semibold">{usage.data?.total_requests ?? 0}</div></div><div><div className="text-muted-foreground">Input Tokens</div><div className="mt-1 text-lg font-semibold">{usage.data?.prompt_tokens ?? 0}</div></div><div><div className="text-muted-foreground">Output Tokens</div><div className="mt-1 text-lg font-semibold">{usage.data?.completion_tokens ?? 0}</div></div><div><div className="text-muted-foreground">Total Tokens</div><div className="mt-1 text-lg font-semibold">{usage.data?.total_tokens ?? 0}</div></div></div><div className="mt-5 text-sm"><div className="flex justify-between"><span>This month</span><span>{usage.data?.monthly_used_tokens ?? 0} / {usage.data?.monthly_token_limit ?? 1000000}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-foreground" style={{ width: `${Math.min(100, ((usage.data?.monthly_used_tokens ?? 0) / (usage.data?.monthly_token_limit || 1)) * 100)}%` }} /></div><div className="mt-2 text-muted-foreground">Remaining: {usage.data?.monthly_remaining_tokens ?? 1000000}</div></div></div>
    <div className="mt-6 rounded-3xl border bg-card p-6"><h2 className="font-medium">My API Keys</h2><div className="mt-4 flex gap-2"><Input value={name} onChange={e => setName(e.target.value)} placeholder="Key name" /><Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Create</Button></div>
    {newKey && <div className="mt-4 rounded-lg border border-green-500/40 bg-green-500/10 p-3 text-sm">Copy this key now: <code className="break-all">{newKey}</code> <Button size="sm" variant="outline" className="ml-2" onClick={() => navigator.clipboard.writeText(newKey)}>Copy</Button></div>}
    <div className="mt-6 space-y-3">{keys.data?.keys.map(key => <div key={key.id} className="flex items-center justify-between border-b py-3 text-sm"><div><div className="font-medium">{key.name}</div><code className="text-muted-foreground">{key.keyPrefix}...</code><div className="text-xs text-muted-foreground">{key.status}</div></div><Button size="sm" variant="outline" disabled={key.status === 'revoked'} onClick={() => revoke.mutate(key.id)}>Revoke</Button></div>)}</div></div></div>
}
