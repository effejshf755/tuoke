import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatBeijingDateTime } from '@/lib/utils'

type KeyType = 'universal' | 'codex_pool' | 'resource_subpool'
type Key = {
  id: number
  name: string
  keyPrefix: string
  keyType: KeyType
  status: string
  enabled: 0 | 1
  requestCount: number
  inputTokens: number
  outputTokens: number
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

export default function UserApiKeysPage() {
  const client = useQueryClient()
  const [name, setName] = useState('')
  const [keyType, setKeyType] = useState<KeyType>('universal')
  const [error, setError] = useState('')
  const [newKey, setNewKey] = useState('')

  const keys = useQuery<{ keys: Key[] }>({
    queryKey: ['consumer-keys'],
    queryFn: () => apiFetch('/api/consumer-keys'),
  })
  const create = useMutation<{ key: string }>({
    mutationFn: () => apiFetch('/api/consumer-keys', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim(), expiration: 'never', key_type: keyType }),
    }),
    onSuccess: response => {
      setName('')
      setKeyType('universal')
      setNewKey(response.key)
      client.invalidateQueries({ queryKey: ['consumer-keys'] })
    },
  })
  const toggle = useMutation({
    mutationFn: (key: Key) => apiFetch(`/api/consumer-keys/${key.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !key.enabled }),
    }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['consumer-keys'] }),
  })
  const revoke = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/consumer-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['consumer-keys'] }),
  })
  const baseUrl = `${window.location.origin}/v1`

  return <div className="rounded-3xl border bg-card p-6">
    <h1 className="text-2xl font-semibold">API 密钥</h1>
    <div className="mt-5 grid gap-4">
      <Input value={name} onChange={event => setName(event.target.value)} placeholder="API 密钥名称" />
      <fieldset className="grid gap-2 rounded-2xl border p-4">
        <legend className="px-2 text-sm font-medium">密钥类型</legend>
        <label className="flex cursor-pointer gap-3 rounded-xl border p-3">
          <input type="radio" name="key-type" value="universal" checked={keyType === 'universal'} onChange={() => setKeyType('universal')} />
          <span><span className="block font-medium">普通模型调用</span><span className="text-xs text-muted-foreground">可调用平台开放模型，不包含 Codex 账号池。</span></span>
        </label>
        <label className="flex cursor-pointer gap-3 rounded-xl border p-3">
          <input type="radio" name="key-type" value="codex_pool" checked={keyType === 'codex_pool'} onChange={() => setKeyType('codex_pool')} />
          <span><span className="block font-medium">Codex 账号池</span><span className="text-xs text-muted-foreground">使用 Codex OAuth 账号池资源。</span></span>
        </label>
        <label className="flex cursor-pointer gap-3 rounded-xl border p-3">
          <input type="radio" name="key-type" value="resource_subpool" checked={keyType === 'resource_subpool'} onChange={() => setKeyType('resource_subpool')} />
          <span><span className="block font-medium">Codex 拼单</span><span className="text-xs text-muted-foreground">仅使用已购买并激活的 Codex 拼单套餐额度。</span></span>
        </label>
      </fieldset>
      <Button disabled={create.isPending} onClick={() => {
        if (!name.trim()) { setError('请输入 API 密钥名称。'); return }
        setError(''); setNewKey(''); create.mutate()
      }}>{create.isPending ? '创建中…' : '创建 API 密钥'}</Button>
    </div>
    {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    {newKey && <div className="mt-4 rounded-2xl border bg-muted/30 p-4">
      <p className="font-medium">新创建的 API 密钥</p>
      <p className="mt-1 text-xs text-muted-foreground">完整 API 密钥只会显示一次，请立即复制保存。</p>
      <code className="mt-3 block break-all rounded-lg border bg-background p-3">{newKey}</code>
      <div className="mt-4 text-sm"><div className="text-xs text-muted-foreground">Base URL</div><code className="mt-1 block break-all rounded-lg border bg-background p-3">{baseUrl}</code></div>
      <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(newKey)}>复制 API 密钥</Button><Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(baseUrl)}>复制 Base URL</Button></div>
    </div>}
    <div className="mt-6 space-y-3">{keys.data?.keys.map(key => <div key={key.id} className="rounded-2xl border p-4 text-sm">
      <div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{key.name}</span><code>{key.keyPrefix}...</code><span>{key.keyType === 'resource_subpool' ? 'Codex 拼单' : key.keyType === 'codex_pool' ? 'Codex 账号池' : '普通模型'}</span><span>{key.status === 'revoked' ? '已撤销' : key.enabled ? '启用' : '已暂停'}</span></div>
      <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4"><span>请求数：{key.requestCount}</span><span>Token：{key.inputTokens + key.outputTokens}</span><span>创建时间：{formatBeijingDateTime(key.createdAt)}</span><span>最后使用：{key.lastUsedAt ? formatBeijingDateTime(key.lastUsedAt) : '从未使用'}</span><span>过期时间：{key.expiresAt ? formatBeijingDateTime(key.expiresAt) : '永不过期'}</span></div>
      <div className="mt-3 flex gap-2"><Button size="sm" variant="outline" onClick={() => toggle.mutate(key)} disabled={key.status === 'revoked'}>{key.enabled ? '暂停' : '恢复'}</Button><Button size="sm" variant="outline" onClick={() => revoke.mutate(key.id)} disabled={key.status === 'revoked'}>撤销</Button></div>
    </div>)}</div>
  </div>
}
