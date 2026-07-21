import {
  useMemo,
  useState,
} from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type AdminUser = {
  id: number
  email: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  created_at: string
  monthly_used_tokens: number
  monthly_token_limit: number
  api_key_count: number
  active_api_key_count: number
  last_request_at: string | null
  active_session_count: number
  api_keys: string | null
}

type AdminApiKey = { id: number; name: string; key_prefix: string; status: string; enabled: number; last_used_at: string | null; rate_limit_rpm: number | null; request_count: number; input_tokens: number; output_tokens: number }

type WalletUser = {
  id: number
  email: string
  role: string
  status: string
  balance: number
  total_added: number
  total_usage: number
  last_transaction_at: string | null
}

type WalletTransaction = {
  id: number
  type: string
  delta: number
  balance_after: number
  request_id: number | null
  platform: string | null
  model_id: string | null
  input_tokens: number
  output_tokens: number
  multiplier: number | null
  note: string | null
  created_at: string
}

type TransactionResponse = {
  user: {
    id: number
    email: string
    balance: number
  }

  transactions: WalletTransaction[]
}

function formatNumber(
  value: number,
) {
  return new Intl.NumberFormat().format(
    Number(value || 0),
  )
}

function formatMoney(
  value: number,
) {
  return `$${Number(value || 0).toFixed(2)}`
}

function formatDate(
  value: string | null,
) {
  if (!value) {
    return 'Never'
  }

  const date =
    new Date(value)

  if (
    Number.isNaN(
      date.getTime(),
    )
  ) {
    return value
  }

  return date.toLocaleString()
}

export default function AdminUsersPage() {
  const queryClient =
    useQueryClient()

  const [
    search,
    setSearch,
  ] = useState('')

  const [
    message,
    setMessage,
  ] = useState('')

  const [
    error,
    setError,
  ] = useState('')

  const [
    selectedWalletUser,
    setSelectedWalletUser,
  ] = useState<WalletUser | null>(
    null,
  )

  /*
   * 用户基本信息
   */
  const usersQuery =
    useQuery<{
      users: AdminUser[]
    }>({
      queryKey: [
        'admin-users',
      ],

      queryFn: () =>
        apiFetch(
          '/api/admin/users',
        ),
    })

  /*
   * 钱包信息
   */
  const walletQuery =
    useQuery<{
      users: WalletUser[]
    }>({
      queryKey: [
        'admin-wallet-users',
      ],

      queryFn: () =>
        apiFetch(
          '/api/admin/wallet/users',
        ),
    })

  /*
   * 当前选中用户资金流水
   */
  const transactionsQuery =
    useQuery<TransactionResponse>({
      queryKey: [
        'admin-wallet-transactions',
        selectedWalletUser?.id,
      ],

      enabled:
        Boolean(
          selectedWalletUser,
        ),

      queryFn: () =>
        apiFetch(
          `/api/admin/wallet/users/${selectedWalletUser!.id}/transactions`,
        ),
    })

  /*
   * 合并用户和钱包数据
   */
  const mergedUsers =
    useMemo(() => {
      const walletMap =
        new Map(
          (
            walletQuery.data?.users ??
            []
          ).map(
            (user) => [
              user.id,
              user,
            ],
          ),
        )

      return (
        usersQuery.data?.users ??
        []
      ).map(
        (user) => ({
          ...user,

          wallet:
            walletMap.get(
              user.id,
            ) ?? null,
        }),
      )
    }, [
      usersQuery.data,
      walletQuery.data,
    ])

  const filteredUsers =
    useMemo(() => {
      const q =
        search
          .trim()
          .toLowerCase()

      if (!q) {
        return mergedUsers
      }

      return mergedUsers.filter(
        (user) =>
          user.email
            .toLowerCase()
            .includes(q),
      )
    }, [
      mergedUsers,
      search,
    ])

  const [rpmValues, setRpmValues] = useState<Record<number, string>>({})
  const updateRpm = useMutation({
    mutationFn: ({ userId, keyId, value }: { userId: number; keyId: number; value: number | null }) => apiFetch(`/api/admin/users/${userId}/keys/${keyId}/rpm`, { method: 'PATCH', body: JSON.stringify({ rate_limit_rpm: value }) }),
    onSuccess: () => { setMessage('RPM 限额已更新。'); setError(''); queryClient.invalidateQueries({ queryKey: ['admin-users'] }) },
    onError: (mutationError) => { setMessage(''); setError((mutationError as Error).message) },
  })

  function parseKeys(value: string | null): AdminApiKey[] { if (!value) return []; try { return JSON.parse(value) as AdminApiKey[] } catch { return [] } }
  function saveRpm(userId: number, key: AdminApiKey, mode: string) { const raw = mode === 'default' ? null : mode === 'blocked' ? 0 : Number(rpmValues[key.id] ?? key.rate_limit_rpm ?? ''); if (raw !== null && (!Number.isInteger(raw) || raw < 1 || raw > 100000)) { setError('自定义 RPM 必须是 1～100000 的整数。'); return } updateRpm.mutate({ userId, keyId: key.id, value: raw }) }

  /*
   * 启用 / 禁用用户
   */
  const updateUser =
    useMutation({
      mutationFn: ({
        id,
        status,
      }: {
        id: number
        status:
          | 'active'
          | 'disabled'
      }) =>
        apiFetch(
          `/api/admin/users/${id}`,
          {
            method: 'PATCH',

            body: JSON.stringify({
              status,
            }),
          },
        ),

      onSuccess: () => {
        setError('')
        setMessage(
          'User status updated.',
        )

        queryClient.invalidateQueries({
          queryKey: [
            'admin-users',
          ],
        })

        queryClient.invalidateQueries({
          queryKey: [
            'admin-wallet-users',
          ],
        })
      },

      onError: (
        mutationError,
      ) => {
        setMessage('')

        setError(
          (
            mutationError as Error
          ).message,
        )
      },
    })

  /*
   * 强制退出全部设备
   */
  const logoutAll =
    useMutation({
      mutationFn: (
        id: number,
      ) =>
        apiFetch(
          `/api/admin/users/${id}/logout-all`,
          {
            method: 'POST',
          },
        ),

      onSuccess: () => {
        setError('')
        setMessage(
          'All user sessions have been logged out.',
        )

        queryClient.invalidateQueries({
          queryKey: [
            'admin-users',
          ],
        })
      },

      onError: (
        mutationError,
      ) => {
        setMessage('')

        setError(
          (
            mutationError as Error
          ).message,
        )
      },
    })

  /*
   * 钱包加款 / 扣款
   */
  const adjustWallet =
    useMutation({
      mutationFn: ({
        id,
        action,
        amount,
        note,
      }: {
        id: number
        action:
          | 'add'
          | 'subtract'
        amount: number
        note?: string
      }) =>
        apiFetch(
          `/api/admin/wallet/users/${id}/adjust`,
          {
            method: 'POST',

            body: JSON.stringify({
              action,
              amount,
              note,
            }),
          },
        ),

      onSuccess: () => {
        setError('')
        setMessage(
          '钱包余额更新成功。',
        )

        queryClient.invalidateQueries({
          queryKey: [
            'admin-wallet-users',
          ],
        })

        queryClient.invalidateQueries({
          queryKey: [
            'admin-wallet-transactions',
          ],
        })
      },

      onError: (
        mutationError,
      ) => {
        setMessage('')

        setError(
          (
            mutationError as Error
          ).message,
        )
      },
    })

  function handleWalletAdjust(
    user: AdminUser,
    action:
      | 'add'
      | 'subtract',
  ) {
    const label =
      action === 'add'
        ? '充值金额'
        : '扣款金额'

    const input =
      window.prompt(
        `${user.email}\n${label}（美元 $）：`,
      )

    if (input === null) {
      return
    }

    const amount =
      Number(input)

    if (
      !Number.isFinite(
        amount,
      ) ||
      amount <= 0
    ) {
      window.alert(
        '请输入大于 0 的正确金额。',
      )

      return
    }

    const note =
      window.prompt(
        '备注（可以留空）：',
      )

    if (
      action ===
      'subtract'
    ) {
      const confirmed =
        window.confirm(
          `确认从 ${user.email} 扣除 $${amount}？`,
        )

      if (!confirmed) {
        return
      }
    }

    adjustWallet.mutate({
      id: user.id,
      action,
      amount,
      note:
        note?.trim() ||
        undefined,
    })
  }

  const isLoading =
    usersQuery.isLoading ||
    walletQuery.isLoading

  return (
    <div className="max-w-[1600px]">
      <h1 className="text-xl font-semibold">
        用户管理
      </h1>

      <p className="mt-1 text-sm text-muted-foreground">
        管理用户、钱包余额、API 使用情况和登录会话。
      </p>

      <div className="mt-5">
        <Input
          value={search}
          onChange={(
            event,
          ) =>
            setSearch(
              event.target.value,
            )
          }
          placeholder="按邮箱搜索…"
          className="max-w-md"
        />
      </div>

      {message && (
        <div className="mt-4 rounded-xl border p-3 text-sm">
          {message}
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-xl border border-destructive/30 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mt-6 grid items-start gap-4 md:grid-cols-2">
        {filteredUsers.map((user) => {
          const wallet = user.wallet
          return (
            <details key={user.id} className="group relative h-fit self-start rounded-2xl border bg-card p-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="truncate font-medium">{user.email}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{user.role === 'admin' ? '管理员' : '普通用户'}</div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="rounded-full border px-2 py-1 text-xs">{user.status === 'active' ? '已启用' : user.status === 'disabled' ? '已禁用' : user.status}</span>
                  <span className="font-semibold">{formatMoney(wallet?.balance ?? 0)}</span>
                  <span className="text-muted-foreground transition-transform group-open:rotate-180">⌄</span>
                </div>
              </summary>

              <div className="absolute left-0 right-0 top-full z-30 mt-2 rounded-2xl border bg-card p-5 shadow-xl">
                <div className="grid gap-3 text-sm sm:grid-cols-3">
                  <div><div className="text-xs text-muted-foreground">累计充值</div><div className="mt-1 font-medium">{formatMoney(wallet?.total_added ?? 0)}</div></div>
                  <div><div className="text-xs text-muted-foreground">API 使用费用</div><div className="mt-1 font-medium">{formatMoney(wallet?.total_usage ?? 0)}</div></div>
                  <div><div className="text-xs text-muted-foreground">Token / 会话</div><div className="mt-1 font-medium">{formatNumber(user.monthly_used_tokens)} / {formatNumber(user.active_session_count)}</div></div>
                  <div><div className="text-xs text-muted-foreground">API Key</div><div className="mt-1 font-medium">{user.active_api_key_count} / {user.api_key_count} 活跃</div></div>
                  <div><div className="text-xs text-muted-foreground">最后调用</div><div className="mt-1">{formatDate(user.last_request_at)}</div></div>
                  <div><div className="text-xs text-muted-foreground">注册时间</div><div className="mt-1">{formatDate(user.created_at)}</div></div>
                </div>

                <div className="mt-5">
                  <div className="mb-2 text-sm font-medium">API Key 详情</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {parseKeys(user.api_keys).map((key) => {
                      const mode = key.rate_limit_rpm === null ? 'default' : key.rate_limit_rpm === 0 ? 'blocked' : 'custom'
                      const effective = key.rate_limit_rpm ?? 60
                      return <div key={key.id} className="rounded-xl border p-3 text-xs">
                        <div className="font-medium">{key.name}</div>
                        <div className="mt-1 font-mono text-muted-foreground">{key.key_prefix}...</div>
                        <div className="mt-1 text-muted-foreground">{key.status}{key.enabled ? '' : ' · 已暂停'} · 最近使用：{formatDate(key.last_used_at)}</div>
                        <div className="mt-1 text-muted-foreground">请求 {formatNumber(key.request_count)} · Token {formatNumber(key.input_tokens + key.output_tokens)}</div>
                        <select className="mt-2 h-8 rounded border bg-transparent px-2" value={mode} onChange={(e) => { if (e.target.value === 'custom') setRpmValues((current) => ({ ...current, [key.id]: String(key.rate_limit_rpm ?? effective) })); saveRpm(user.id, key, e.target.value) }}>
                          <option value="default">平台默认（{effective} RPM）</option><option value="blocked">禁止调用</option><option value="custom">自定义 RPM</option>
                        </select>
                        {mode === 'custom' && <div className="mt-2 flex gap-2"><Input className="h-8" type="number" min="1" max="100000" value={rpmValues[key.id] ?? String(key.rate_limit_rpm)} onChange={(e) => setRpmValues((current) => ({ ...current, [key.id]: e.target.value }))} /><Button size="xs" disabled={updateRpm.isPending} onClick={() => saveRpm(user.id, key, 'custom')}>保存</Button></div>}
                      </div>
                    })}
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => handleWalletAdjust(user, 'add')}>增加余额</Button>
                  <Button size="sm" variant="outline" onClick={() => handleWalletAdjust(user, 'subtract')}>扣除余额</Button>
                  {wallet && <Button size="sm" variant="outline" onClick={() => setSelectedWalletUser(wallet)}>交易记录</Button>}
                  {user.role === 'user' && <>
                    <Button size="sm" variant="outline" disabled={updateUser.isPending} onClick={() => updateUser.mutate({ id: user.id, status: user.status === 'active' ? 'disabled' : 'active' })}>{user.status === 'active' ? '禁用用户' : '启用用户'}</Button>
                    <Button size="sm" variant="outline" disabled={logoutAll.isPending} onClick={() => { if (window.confirm(`退出 ${user.email} 的全部会话？`)) logoutAll.mutate(user.id) }}>退出全部会话</Button>
                  </>}
                </div>
              </div>
            </details>
          )
        })}
        {!isLoading && filteredUsers.length === 0 && <div className="rounded-2xl border p-8 text-center text-muted-foreground md:col-span-2">暂无用户</div>}
      </div>

      <div className="mt-6 hidden overflow-x-auto rounded-2xl border">
        <table className="min-w-[1200px] w-full text-xs">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3">
                用户
              </th>

              <th className="p-3">
                状态
              </th>

              <th className="p-3">
                余额
              </th>

              <th className="p-3">
                累计充值
              </th>

              <th className="p-3">
                API 使用费用
              </th>

              <th className="p-3">
                API 密钥
              </th>

              <th className="p-3">
                Token 使用量
              </th>

              <th className="p-3">
                会话数
              </th>

              <th className="p-3">
                最后 API 调用
              </th>

              <th className="p-3">
                注册时间
              </th>

              <th className="p-3">
                操作
              </th>
            </tr>
          </thead>

          <tbody>
            {filteredUsers.map(
              (user) => {
                const wallet =
                  user.wallet

                return (
                  <tr
                    key={user.id}
                    className="border-b last:border-b-0 align-top"
                  >
                    <td className="p-3">
                      <div className="font-medium">
                        {user.email}
                      </div>

                      <div className="mt-1 text-xs text-muted-foreground">
                        {user.role}
                      </div>
                    </td>

                    <td className="p-3">
                      <span className="rounded-full border px-2 py-1 text-xs">
                        {user.status}
                      </span>
                    </td>

                    <td className="p-3">
                      <div className="font-semibold">
                        {formatMoney(
                          wallet?.balance ??
                            0,
                        )}
                      </div>
                    </td>

                    <td className="p-3">
                      {formatMoney(
                        wallet?.total_added ??
                          0,
                      )}
                    </td>

                    <td className="p-3">
                      {formatMoney(
                        wallet?.total_usage ??
                          0,
                      )}
                    </td>

                    <td className="p-3">
                      <div>
                        {user.active_api_key_count}
                        {' / '}
                        {user.api_key_count}
                      </div>

                      <div className="mt-1 text-xs text-muted-foreground">
                        active / total
                      </div>

                      <div className="mt-3 space-y-3">
                        {parseKeys(user.api_keys).map((key) => {
                          const mode = key.rate_limit_rpm === null ? 'default' : key.rate_limit_rpm === 0 ? 'blocked' : 'custom'
                          const effective = key.rate_limit_rpm ?? 60
                          return (
                            <div key={key.id} className="rounded-lg border p-2 text-xs">
                              <div className="font-medium">{key.name}</div>
                              <div className="mt-1 font-mono text-muted-foreground">{key.key_prefix}...</div>
                              <div className="mt-1 text-muted-foreground">{key.status}{key.enabled ? '' : ' · paused'} · Last Used: {formatDate(key.last_used_at)}</div>
                              <div className="mt-1 text-muted-foreground">Requests: {formatNumber(key.request_count)} · Tokens: {formatNumber(key.input_tokens + key.output_tokens)}</div>
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <select className="h-7 rounded border bg-transparent px-1" value={mode} onChange={(e) => { if (e.target.value === 'custom') setRpmValues((current) => ({ ...current, [key.id]: String(key.rate_limit_rpm ?? effective) })); saveRpm(user.id, key, e.target.value) }}>
                                  <option value="default">使用平台默认（{effective} RPM）</option>
                                  <option value="blocked">禁止调用</option>
                                  <option value="custom">自定义 RPM</option>
                                </select>
                                {mode === 'custom' && <><Input className="h-7 w-24" type="number" min="1" max="100000" value={rpmValues[key.id] ?? String(key.rate_limit_rpm)} onChange={(e) => setRpmValues((current) => ({ ...current, [key.id]: e.target.value }))} /><Button size="xs" disabled={updateRpm.isPending} onClick={() => saveRpm(user.id, key, 'custom')}>保存</Button></>}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </td>

                    <td className="p-3">
                      {formatNumber(
                        user.monthly_used_tokens,
                      )}
                    </td>

                    <td className="p-3">
                      {formatNumber(
                        user.active_session_count,
                      )}
                    </td>

                    <td className="p-3">
                      {formatDate(
                        user.last_request_at,
                      )}
                    </td>

                    <td className="p-3">
                      {formatDate(
                        user.created_at,
                      )}
                    </td>

                    <td className="p-3">
                      <div className="flex max-w-[260px] flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            handleWalletAdjust(
                              user,
                              'add',
                            )
                          }
                        >
                          Add balance
                        </Button>

                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            handleWalletAdjust(
                              user,
                              'subtract',
                            )
                          }
                        >
                          Deduct
                        </Button>

                        {wallet && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setSelectedWalletUser(
                                wallet,
                              )
                            }
                          >
                            Transactions
                          </Button>
                        )}

                        {user.role ===
                          'user' && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                updateUser.isPending
                              }
                              onClick={() =>
                                updateUser.mutate({
                                  id: user.id,

                                  status:
                                    user.status ===
                                    'active'
                                      ? 'disabled'
                                      : 'active',
                                })
                              }
                            >
                              {user.status ===
                              'active'
                                ? 'Disable'
                                : 'Enable'}
                            </Button>

                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                logoutAll.isPending
                              }
                              onClick={() => {
                                const confirmed =
                                  window.confirm(
                                    `Log out all sessions for ${user.email}?`,
                                  )

                                if (
                                  confirmed
                                ) {
                                  logoutAll.mutate(
                                    user.id,
                                  )
                                }
                              }}
                            >
                              Logout all
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              },
            )}

            {!isLoading &&
              filteredUsers.length ===
                0 && (
                <tr>
                  <td
                    colSpan={11}
                    className="p-8 text-center text-muted-foreground"
                  >
                    No users found.
                  </td>
                </tr>
              )}
          </tbody>
        </table>
      </div>

      {isLoading && (
        <p className="mt-4 text-sm text-muted-foreground">
          Loading users...
        </p>
      )}

      {/* ===========================================
          Wallet Transactions
      =========================================== */}

      {selectedWalletUser && (
        <div className="mt-6 rounded-2xl border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="font-medium">
                Wallet transactions
              </h2>

              <p className="mt-1 text-sm text-muted-foreground">
                {
                  selectedWalletUser.email
                }
              </p>

              <p className="mt-2 text-lg font-semibold">
                Balance:{' '}
                {formatMoney(
                  transactionsQuery
                    .data?.user
                    .balance ??
                    selectedWalletUser.balance,
                )}
              </p>
            </div>

            <Button
              variant="outline"
              onClick={() =>
                setSelectedWalletUser(
                  null,
                )
              }
            >
              Close
            </Button>
          </div>

          <div className="mt-5 overflow-x-auto rounded-xl border">
            <table className="min-w-[900px] w-full text-xs">
              <thead className="border-b bg-muted/40 text-left">
                <tr>
                  <th className="p-3">
                    Time
                  </th>

                  <th className="p-3">
                    Type
                  </th>

                  <th className="p-3">
                    Change
                  </th>

                  <th className="p-3">
                    Balance After
                  </th>

                  <th className="p-3">
                    Model
                  </th>

                  <th className="p-3">
                    Tokens
                  </th>

                  <th className="p-3">
                    Multiplier
                  </th>

                  <th className="p-3">
                    Note
                  </th>
                </tr>
              </thead>

              <tbody>
                {transactionsQuery
                  .data
                  ?.transactions
                  .map(
                    (
                      transaction,
                    ) => (
                      <tr
                        key={
                          transaction.id
                        }
                        className="border-b last:border-0"
                      >
                        <td className="p-3">
                          {formatDate(
                            transaction.created_at,
                          )}
                        </td>

                        <td className="p-3">
                          {
                            transaction.type
                          }
                        </td>

                        <td className="p-3 font-medium">
                          {transaction.delta >
                          0
                            ? '+'
                            : ''}
                          {formatMoney(
                            transaction.delta,
                          )}
                        </td>

                        <td className="p-3">
                          {formatMoney(
                            transaction.balance_after,
                          )}
                        </td>

                        <td className="p-3">
                          {transaction.platform &&
                          transaction.model_id
                            ? `${transaction.platform} / ${transaction.model_id}`
                            : '-'}
                        </td>

                        <td className="p-3">
                          {formatNumber(
                            transaction.input_tokens +
                              transaction.output_tokens,
                          )}
                        </td>

                        <td className="p-3">
                          {transaction.multiplier ===
                          null
                            ? '-'
                            : `${transaction.multiplier}x`}
                        </td>

                        <td className="p-3">
                          {transaction.note ??
                            '-'}
                        </td>
                      </tr>
                    ),
                  )}

                {!transactionsQuery
                  .isLoading &&
                  (
                    transactionsQuery
                      .data
                      ?.transactions
                      .length ?? 0
                  ) === 0 && (
                    <tr>
                      <td
                        colSpan={8}
                        className="p-8 text-center text-muted-foreground"
                      >
                        No wallet transactions yet.
                      </td>
                    </tr>
                  )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
