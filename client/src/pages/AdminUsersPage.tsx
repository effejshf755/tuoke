import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type User = { id: number; email: string; role: string; status: string; monthly_used_tokens: number; monthly_token_limit: number }
export default function AdminUsersPage() {
  const client = useQueryClient(); const [limits, setLimits] = useState<Record<number, string>>({})
  const query = useQuery<{ users: User[] }>({ queryKey: ['admin-users'], queryFn: () => apiFetch('/api/admin/users') })
  const update = useMutation({ mutationFn: ({ id, patch }: { id: number; patch: object }) => apiFetch(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }), onSuccess: () => client.invalidateQueries({ queryKey: ['admin-users'] }) })
  return <div><h1 className="text-xl font-semibold">Users</h1><div className="mt-6 overflow-x-auto rounded-3xl border bg-card"><table className="w-full text-left text-sm"><thead><tr className="border-b text-muted-foreground"><th className="p-4">Email</th><th className="p-4">Role</th><th className="p-4">Status</th><th className="p-4">Monthly usage / limit</th><th className="p-4">Actions</th></tr></thead><tbody>{query.data?.users.map(user => <tr key={user.id} className="border-b last:border-0"><td className="p-4">{user.email}</td><td className="p-4">{user.role}</td><td className="p-4">{user.status}</td><td className="p-4">{user.monthly_used_tokens} / <Input className="inline-flex w-28" value={limits[user.id] ?? user.monthly_token_limit} onChange={e => setLimits({ ...limits, [user.id]: e.target.value })} /></td><td className="space-x-2 p-4"><Button size="sm" variant="outline" onClick={() => update.mutate({ id: user.id, patch: { monthly_token_limit: Number(limits[user.id] ?? user.monthly_token_limit) } })}>Save</Button>{user.role === 'user' && <Button size="sm" variant="outline" onClick={() => update.mutate({ id: user.id, patch: { status: user.status === 'active' ? 'disabled' : 'active' } })}>{user.status === 'active' ? 'Disable' : 'Enable'}</Button>}</td></tr>)}</tbody></table></div></div>
}
