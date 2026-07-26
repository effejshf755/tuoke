import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy } from 'lucide-react'
import { apiFetch, type ApiError } from '@/lib/api'
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
  const [copied, setCopied] = useState<string | number | null>(null)

  const keys = useQuery<{ keys: Key[] }>({
    queryKey: ['consumer-keys'],
    queryFn: () => apiFetch('/api/consumer-keys'),
  })
  const create = useMutation<{ key: string }>({
    mutationFn: () => apiFetch('/api/consumer-keys', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim(), expiration: 'never', key_type: keyType }),
    }),
    onSuccess: () => {
      setName('')
      setKeyType('universal')
      setError('密钥已创建，可随时使用下方复制按钮。')
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
  const copyKey = useMutation({
    mutationFn: async (id: number) => {
      const response = await apiFetch<{ key: string }>(`/api/consumer-keys/${id}/secret`)
      await navigator.clipboard.writeText(response.key)
      return id
    },
    onSuccess: id => {
      setError('')
      setCopied(id)
      window.setTimeout(() => setCopied(current => current === id ? null : current), 1600)
    },
    onError: (copyError: ApiError) => {
      setError(copyError.code === 'consumer_key_not_recoverable'
        ? '这是旧密钥，无法恢复完整内容，请撤销后重新创建。'
        : copyError.message)
    },
  })
  const baseUrl = `${window.location.origin}/v1`

  const copyBaseUrl = async () => {
    await navigator.clipboard.writeText(baseUrl)
    setCopied('base-url')
    window.setTimeout(() => setCopied(current => current === 'base-url' ? null : current), 1600)
  }

  return <div className="rounded-3xl border bg-card p-6">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <h1 className="text-2xl font-semibold">API 密钥</h1>
      <div className="flex min-w-0 items-center gap-1 rounded-lg border bg-muted/20 py-1 pl-3 pr-1">
        <code className="min-w-0 flex-1 truncate text-xs sm:max-w-64">{baseUrl}</code>
        <Button size="icon" variant="ghost" title="复制调用地址" aria-label="复制调用地址" onClick={copyBaseUrl}>
          {copied === 'base-url' ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </div>
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
        setError(''); create.mutate()
      }}>{create.isPending ? '创建中...' : '创建 API 密钥'}</Button>
    </div>
    {error && <p className="mt-3 text-sm text-muted-foreground">{error}</p>}

    <div className="mt-6 space-y-2">{keys.data?.keys.map(key => <div key={key.id} className="rounded-xl border p-3 text-sm">
      <div className="grid items-center gap-3 md:grid-cols-[minmax(7rem,.7fr)_auto_auto_minmax(12rem,1.4fr)]">
        <span className="truncate font-medium">{key.name}</span>
        <span className="text-xs text-muted-foreground">{key.keyType === 'resource_subpool' ? 'Codex 拼单' : key.keyType === 'codex_pool' ? 'Codex 账号池' : '普通模型'}</span>
        <span className="text-xs">{key.status === 'revoked' ? '已撤销' : key.enabled ? '启用' : '已暂停'}</span>
        <div className="flex min-w-0 items-center gap-1 rounded-lg border bg-muted/20 py-1 pl-3 pr-1">
        <code className="min-w-0 flex-1 truncate text-xs">{key.keyPrefix}••••••••••••</code>
        <Button
          size="icon"
          variant="ghost"
          title="复制完整密钥"
          aria-label="复制完整密钥"
          disabled={copyKey.isPending}
          onClick={() => copyKey.mutate(key.id)}
        >{copied === key.id ? <Check className="size-4" /> : <Copy className="size-4" />}</Button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span>请求数：{key.requestCount}</span><span>Token：{key.inputTokens + key.outputTokens}</span>
        <span>创建时间：{formatBeijingDateTime(key.createdAt)}</span><span>最后使用：{key.lastUsedAt ? formatBeijingDateTime(key.lastUsedAt) : '从未使用'}</span>
        <span>过期时间：{key.expiresAt ? formatBeijingDateTime(key.expiresAt) : '永不过期'}</span>
      </div>
      <div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={() => toggle.mutate(key)} disabled={key.status === 'revoked'}>{key.enabled ? '暂停' : '恢复'}</Button><Button size="sm" variant="outline" onClick={() => revoke.mutate(key.id)} disabled={key.status === 'revoked'}>撤销</Button></div>
    </div>)}</div>
  </div>
}
