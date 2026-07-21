import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { apiFetch } from '@/lib/api'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import UserRequestHistory from '@/components/UserRequestHistory'

type Expiration =
  | 'never'
  | '7d'
  | '30d'
  | '90d'
  | 'custom'

type Key = {
  id: number
  userId: number
  name: string
  keyPrefix: string
  status: 'active' | 'revoked'
  enabled: 0 | 1
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  requestCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  rateLimitRpm: number | null
}

type Usage = {
  total_requests: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

type AuthStatus = {
  role: 'admin' | 'user' | null
  email?: string | null
}

type WalletResponse = {
  wallet?: {
    balance?: number
    available_balance?: number
  }
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(
    Number(value || 0),
  )
}

function formatDate(value: string | null) {
  if (!value) {
    return 'Never'
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString()
}

function getKeyDisplayStatus(key: Key) {
  if (key.status === 'revoked') {
    return 'Revoked'
  }

  if (
    key.expiresAt &&
    Date.parse(key.expiresAt) <= Date.now()
  ) {
    return 'Expired'
  }

  if (!key.enabled) {
    return 'Paused'
  }

  return 'Active'
}

export default function UserCenterPage() {
  const client = useQueryClient()
  const baseUrl = `${window.location.origin}/v1`

  // ============================================================
  // API Key create form
  // ============================================================

  const [name, setName] = useState('')
  const [newKey, setNewKey] = useState('')

  const [
    expiration,
    setExpiration,
  ] = useState<Expiration>('never')

  const [
    customExpiresAt,
    setCustomExpiresAt,
  ] = useState('')

  const [
    keyError,
    setKeyError,
  ] = useState('')

  const [
    keyMessage,
    setKeyMessage,
  ] = useState('')

  // ============================================================
  // Queries
  // ============================================================

  const keys = useQuery<{
    keys: Key[]
  }>({
    queryKey: ['consumer-keys'],

    queryFn: () =>
      apiFetch('/api/consumer-keys'),
  })

  const usage = useQuery<Usage>({
    queryKey: ['user-usage'],
    queryFn: () => apiFetch('/api/user/usage'),
  })

  const authStatus = useQuery<AuthStatus>({
    queryKey: ['auth-status'],
    queryFn: () => apiFetch('/api/auth/status'),
  })

  const wallet = useQuery<WalletResponse>({
    queryKey: ['user-wallet'],
    queryFn: () => apiFetch('/api/user/wallet'),
  })

  const platformSettings = useQuery<{ platform_notice: string }>({
    queryKey: ['public-platform-settings'],
    queryFn: () => apiFetch('/api/public/settings'),
  })

  // ============================================================
  // Create API Key
  // ============================================================

  const create = useMutation({
    mutationFn: () =>
      apiFetch<{
        key: string
      }>('/api/consumer-keys', {
        method: 'POST',

        body: JSON.stringify({
          name: name.trim(),
          expiration,

          ...(expiration === 'custom'
            ? {
                expiresAt:
                  new Date(
                    customExpiresAt,
                  ).toISOString(),
              }
            : {}),
        }),
      }),

    onSuccess: (response) => {
      setNewKey(response.key)
      setName('')
      setExpiration('never')
      setCustomExpiresAt('')
      setKeyError('')

      setKeyMessage(
        'API 密钥创建成功。完整密钥只会显示一次，请立即复制保存。',
      )

      client.invalidateQueries({
        queryKey: ['consumer-keys'],
      })
    },

    onError: (error) => {
      setKeyMessage('')

      setKeyError(
        (error as Error).message,
      )
    },
  })

  function createKey() {
    setKeyError('')
    setKeyMessage('')
    setNewKey('')

    if (!name.trim()) {
      setKeyError(
        '请输入 API 密钥名称。',
      )

      return
    }

    if (
      expiration === 'custom'
    ) {
      if (!customExpiresAt) {
        setKeyError(
          '请选择过期时间。',
        )

        return
      }

      const timestamp =
        Date.parse(customExpiresAt)

      if (
        !Number.isFinite(timestamp) ||
        timestamp <= Date.now()
      ) {
        setKeyError(
          '过期时间必须晚于当前时间。',
        )

        return
      }
    }

    create.mutate()
  }

  // ============================================================
  // Pause / Resume API Key
  // ============================================================

  const toggleKey = useMutation({
    mutationFn: ({
      id,
      enabled,
    }: {
      id: number
      enabled: boolean
    }) =>
      apiFetch(
        `/api/consumer-keys/${id}`,
        {
          method: 'PATCH',

          body: JSON.stringify({
            enabled,
          }),
        },
      ),

    onSuccess: () => {
      setKeyError('')
      setKeyMessage(
        'API 密钥状态已更新。',
      )

      client.invalidateQueries({
        queryKey: ['consumer-keys'],
      })
    },

    onError: (error) => {
      setKeyMessage('')

      setKeyError(
        (error as Error).message,
      )
    },
  })

  // ============================================================
  // Revoke API Key
  // ============================================================

  const revoke = useMutation({
    mutationFn: (id: number) =>
      apiFetch(
        `/api/consumer-keys/${id}`,
        {
          method: 'DELETE',
        },
      ),

    onSuccess: () => {
      setKeyError('')
      setKeyMessage(
        'API 密钥已永久撤销。',
      )

      client.invalidateQueries({
        queryKey: ['consumer-keys'],
      })
    },

    onError: (error) => {
      setKeyMessage('')

      setKeyError(
        (error as Error).message,
      )
    },
  })

  function revokeKey(key: Key) {
    const confirmed =
      window.confirm(
        `确定永久撤销“${key.name}”吗？\n\n此操作无法撤销。`,
      )

    if (!confirmed) {
      return
    }

    revoke.mutate(key.id)
  }

  // ============================================================
  // Usage
  // ============================================================

  return (
    <div className="max-w-5xl">
      <div className="rounded-3xl border bg-card p-6">
        <p className="text-sm text-muted-foreground">用户中心</p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">欢迎回来</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {authStatus.data?.email || 'Tuoke 用户'}
            </p>
          </div>
          <div className="text-xs text-muted-foreground">管理你的 API 使用情况</div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl border p-4">
            <div className="text-xs text-muted-foreground">当前余额</div>
            <div className="mt-2 text-xl font-semibold">
              ${Number(wallet.data?.wallet?.available_balance ?? wallet.data?.wallet?.balance ?? 0).toFixed(2)}
            </div>
          </div>
          <div className="rounded-2xl border p-4">
            <div className="text-xs text-muted-foreground">请求数量</div>
            <div className="mt-2 text-xl font-semibold">{formatNumber(usage.data?.total_requests ?? 0)}</div>
          </div>
          <div className="rounded-2xl border p-4">
            <div className="text-xs text-muted-foreground">Token 使用量</div>
            <div className="mt-2 text-sm font-semibold">输入 {formatNumber(usage.data?.prompt_tokens ?? 0)}</div>
            <div className="mt-1 text-sm font-semibold">输出 {formatNumber(usage.data?.completion_tokens ?? 0)}</div>
            <div className="mt-1 text-xs text-muted-foreground">总计 {formatNumber(usage.data?.total_tokens ?? 0)}</div>
          </div>
          <div className="rounded-2xl border p-4">
            <div className="text-xs text-muted-foreground">API Key 数量</div>
            <div className="mt-2 text-xl font-semibold">{formatNumber(keys.data?.keys.length ?? 0)}</div>
          </div>
        </div>

        <div className="hidden mt-5 flex flex-wrap gap-2">
          <Link className={buttonVariants()} to="/playground">进入试玩台</Link>
          <Link className={buttonVariants({ variant: 'outline' })} to="/models">浏览模型</Link>
          <Link className={buttonVariants({ variant: 'outline' })} to="/api-docs">API 文档</Link>
          <a className={buttonVariants({ variant: 'outline' })} href="#api-keys">管理 API Key</a>
        </div>
      </div>

      {!!platformSettings.data?.platform_notice?.trim() && (
        <div className="mt-5 rounded-2xl border bg-card p-4">
          <h2 className="font-medium">平台公告</h2>
          <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
            {platformSettings.data.platform_notice}
          </p>
        </div>
      )}

      {/* ======================================================
          使用情况
      ====================================================== */}
      <UserRequestHistory />


      {false && <div id="api-keys" className="mt-6 rounded-3xl border bg-card p-6">
        <h2 className="font-medium">
          使用情况
        </h2>

        <div className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <div className="text-muted-foreground">
              请求数
            </div>

            <div className="mt-1 text-lg font-semibold">
              {formatNumber(
                usage.data
                  ?.total_requests ?? 0,
              )}
            </div>
          </div>

          <div>
            <div className="text-muted-foreground">
              输入 Token
            </div>

            <div className="mt-1 text-lg font-semibold">
              {formatNumber(
                usage.data
                  ?.prompt_tokens ?? 0,
              )}
            </div>
          </div>

          <div>
            <div className="text-muted-foreground">
              输出 Token
            </div>

            <div className="mt-1 text-lg font-semibold">
              {formatNumber(
                usage.data
                  ?.completion_tokens ?? 0,
              )}
            </div>
          </div>

          <div>
            <div className="text-muted-foreground">
              总 Token
            </div>

            <div className="mt-1 text-lg font-semibold">
              {formatNumber(
                usage.data
                  ?.total_tokens ?? 0,
              )}
            </div>
          </div>
        </div>

      </div>}

      {/* ======================================================
          API Keys
      ====================================================== */}

      <div className="mt-6 rounded-3xl border bg-card p-6">
        <h2 className="font-medium">
          我的 API 密钥
        </h2>

        <p className="mt-1 text-xs text-muted-foreground">
          为不同应用创建独立密钥，可分别暂停或撤销。
        </p>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-xs">
              密钥名称
            </Label>

            <Input
              className="mt-1.5"
              value={name}
              onChange={(event) =>
                setName(
                  event.target.value,
                )
              }
              placeholder="例如：我的应用"
            />
          </div>

          <div>
            <Label className="text-xs">
              有效期
            </Label>

            <select
              className="mt-1.5 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none"
              value={expiration}
              onChange={(event) =>
                setExpiration(
                  event.target
                    .value as Expiration,
                )
              }
            >
              <option value="never">
                永不过期
              </option>

              <option value="7d">
                7 天
              </option>

              <option value="30d">
                30 天
              </option>

              <option value="90d">
                90 天
              </option>

              <option value="custom">
                自定义
              </option>
            </select>
          </div>
        </div>

        {expiration ===
          'custom' && (
          <div className="mt-3">
            <Label className="text-xs">
              Custom expiration
            </Label>

            <Input
              className="mt-1.5"
              type="datetime-local"
              value={customExpiresAt}
              onChange={(event) =>
                setCustomExpiresAt(
                  event.target.value,
                )
              }
            />
          </div>
        )}

        <Button
          className="mt-4"
          disabled={create.isPending}
          onClick={createKey}
        >
          {create.isPending
            ? '创建中…'
            : '创建 API 密钥'}
        </Button>

        <div className="mt-4 space-y-3">
          <div className="min-h-9">
            {keyError && (
              <p className="text-xs text-destructive">
                {keyError}
              </p>
            )}

            {keyMessage && (
              <p className="text-xs text-muted-foreground">
                {keyMessage}
              </p>
            )}
          </div>

          <div className="w-full rounded-xl border bg-muted/30 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">
                  Base URL
                </div>

                <code className="mt-1 block break-all text-xs text-foreground">
                  {baseUrl}
                </code>
              </div>

              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  navigator.clipboard.writeText(baseUrl)
                }
              >
                复制
              </Button>
            </div>
          </div>
        </div>

        {newKey && (
          <div className="mt-4 rounded-xl border bg-muted/30 p-4 text-sm">
            <div className="font-medium">
              新创建的 API 密钥
            </div>

            <p className="mt-1 text-xs text-muted-foreground">
              完整 API 密钥只会显示一次，请立即复制保存。
            </p>

            <code className="mt-3 block break-all rounded-lg border bg-background p-3">
              {newKey}
            </code>

            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() =>
                navigator.clipboard.writeText(
                  newKey,
                )
              }
            >
              复制 API 密钥
            </Button>
          </div>
        )}

        {/* Key list */}

        <div className="mt-6 space-y-4">
          {keys.data?.keys.map(
            (key) => {
              const displayStatus =
                getKeyDisplayStatus(
                  key,
                )

              const canToggle =
                key.status ===
                  'active' &&
                displayStatus !==
                  'Expired'

              return (
                <details
                  key={key.id}
                  className="rounded-xl border p-3"
                >
                  <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {key.name}
                        </span>

                        <span className="rounded-full border px-2 py-0.5 text-xs">
                          {
                            displayStatus
                          }
                        </span>
                      </div>

                      <code className="block text-xs text-muted-foreground">
                        {
                          key.keyPrefix
                        }
                        ...
                      </code>
                    </div></div><div className="flex flex-wrap gap-2">
                      {canToggle && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            toggleKey.isPending
                          }
                          onClick={() =>
                            toggleKey.mutate({
                              id: key.id,

                              enabled:
                                !key.enabled,
                            })
                          }
                        >
                          {key.enabled
                            ? '暂停'
                            : '恢复'}
                        </Button>
                      )}

                      {key.status !==
                        'revoked' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            revoke.isPending
                          }
                          onClick={() =>
                            revokeKey(
                              key,
                            )
                          }
                        >
                          撤销
                        </Button>
                      )}
                    </div></summary>

                  <div className="mt-5 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <div className="text-xs text-muted-foreground">
                        Requests
                      </div>

                      <div className="mt-1 font-medium">
                        {formatNumber(
                          key.requestCount,
                        )}
                      </div>
                    </div>

                    <div>
                      <div className="text-xs text-muted-foreground">
                        输入 Token
                      </div>

                      <div className="mt-1 font-medium">
                        {formatNumber(
                          key.inputTokens,
                        )}
                      </div>
                    </div>

                    <div>
                      <div className="text-xs text-muted-foreground">
                        输出 Token
                      </div>

                      <div className="mt-1 font-medium">
                        {formatNumber(
                          key.outputTokens,
                        )}
                      </div>
                    </div>

                    <div>
                      <div className="text-xs text-muted-foreground">
                        总 Token
                      </div>

                      <div className="mt-1 font-medium">
                        {formatNumber(
                          key.totalTokens,
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-3 border-t pt-4 text-xs text-muted-foreground sm:grid-cols-3">
                    <div>
                      <div>
                        创建时间
                      </div>

                    <div className="mt-1 text-foreground">
                        {formatDate(
                          key.createdAt,
                        )}
                      </div>
                    </div>

                    <div>
                      <div>
                        Last used
                      </div>

                      <div className="mt-1 text-foreground">
                        {formatDate(
                          key.lastUsedAt,
                        )}
                      </div>
                    </div>

                    <div>
                      <div>
                        Expires
                      </div>

                      <div className="mt-1 text-foreground">
                        {key.expiresAt
                          ? formatDate(
                              key.expiresAt,
                            )
                          : 'Never'}
                      </div>
                    </div>

                    <div>
                      <div>RPM 限额</div>
                      <div className="mt-1 text-foreground">
                        {key.rateLimitRpm === 0
                          ? '禁止调用'
                          : `使用平台默认：${key.rateLimitRpm ?? 60} RPM`}
                      </div>
                    </div>
                  </div>
                </details>
              )
            },
          )}

          {!keys.isLoading &&
            (keys.data?.keys.length ??
              0) === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No API keys yet.
              </p>
            )}
        </div>
      </div>
    </div>
  )
}
