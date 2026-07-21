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

type BillingModel = {
  id: number
  platform: string
  model_id: string
  display_name: string
  model_enabled: boolean

  billing_configured: boolean

  input_price_per_million: number
  output_price_per_million: number

  multiplier: number
  billing_enabled: boolean

  request_count: number
  input_tokens: number
  output_tokens: number
  revenue: number
}

type EditableBillingModel =
  BillingModel & {
    editInputPrice: string
    editOutputPrice: string
    editMultiplier: string
    editBillingEnabled: boolean
  }

type BillingFilter =
  | 'all'
  | 'configured'
  | 'enabled'
  | 'disabled'
  | 'unconfigured'

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

export default function AdminBillingPage() {
  const queryClient =
    useQueryClient()

  const [
    search,
    setSearch,
  ] = useState('')

  const [
    billingFilter,
    setBillingFilter,
  ] = useState<BillingFilter>('all')

  const [
    edits,
    setEdits,
  ] = useState<
    Record<
      number,
      Partial<EditableBillingModel>
    >
  >({})

  const [
    message,
    setMessage,
  ] = useState('')

  const [
    error,
    setError,
  ] = useState('')

  const [expandedId, setExpandedId] = useState<number | null>(null)

  const modelsQuery =
    useQuery<{
      models: BillingModel[]
    }>({
      queryKey: [
        'admin-billing-models',
      ],

      queryFn: () =>
        apiFetch(
          '/api/admin/billing/models',
        ),
    })

  const models =
    useMemo(() => {
      return (
        modelsQuery.data?.models ??
        []
      ).map(
        (
          model,
        ): EditableBillingModel => {
          const edit =
            edits[model.id] ?? {}

          return {
            ...model,

            editInputPrice:
              edit.editInputPrice ??
              String(
                model.input_price_per_million,
              ),

            editOutputPrice:
              edit.editOutputPrice ??
              String(
                model.output_price_per_million,
              ),

            editMultiplier:
              edit.editMultiplier ??
              String(
                model.multiplier,
              ),

            editBillingEnabled:
              edit.editBillingEnabled ??
              model.billing_enabled,
          }
        },
      )
    }, [
      modelsQuery.data,
      edits,
    ])

  const filteredModels =
    useMemo(() => {
      const q =
        search
          .trim()
          .toLowerCase()

      return models.filter(
        (model) => {
          const matchesSearch =
            !q ||
            model.display_name
              .toLowerCase()
              .includes(q) ||
            model.model_id
              .toLowerCase()
              .includes(q) ||
            model.platform
              .toLowerCase()
              .includes(q)

          const matchesFilter =
            billingFilter === 'all' ||
            (billingFilter === 'configured' && model.billing_configured) ||
            (billingFilter === 'enabled' && model.billing_enabled) ||
            (billingFilter === 'disabled' && model.billing_configured && !model.billing_enabled) ||
            (billingFilter === 'unconfigured' && !model.billing_configured)

          return matchesSearch && matchesFilter
        },
      )
    }, [
      models,
      search,
      billingFilter,
    ])

  function updateEdit(
    id: number,
    patch:
      Partial<EditableBillingModel>,
  ) {
    setEdits(
      (
        current,
      ) => ({
        ...current,

        [id]: {
          ...(current[id] ??
            {}),

          ...patch,
        },
      }),
    )
  }

  const saveBilling =
    useMutation({
      mutationFn: (
        model:
          EditableBillingModel,
      ) => {
        const inputPrice =
          Number(
            model.editInputPrice,
          )

        const outputPrice =
          Number(
            model.editOutputPrice,
          )

        const multiplier =
          Number(
            model.editMultiplier,
          )

        if (
          !Number.isFinite(
            inputPrice,
          ) ||
          inputPrice < 0
        ) {
          throw new Error(
            'Input price must be 0 or greater.',
          )
        }

        if (
          !Number.isFinite(
            outputPrice,
          ) ||
          outputPrice < 0
        ) {
          throw new Error(
            'Output price must be 0 or greater.',
          )
        }

        if (
          !Number.isFinite(
            multiplier,
          ) ||
          multiplier < 0
        ) {
          throw new Error(
            'Multiplier must be 0 or greater.',
          )
        }

        return apiFetch(
          `/api/admin/billing/models/${model.id}`,
          {
            method: 'PUT',

            body:
              JSON.stringify({
                input_price_per_million:
                  inputPrice,

                output_price_per_million:
                  outputPrice,

                multiplier,

                billing_enabled:
                  model.editBillingEnabled,
              }),
          },
        )
      },

      onSuccess: () => {
        setError('')

        setMessage(
          'Billing configuration saved.',
        )

        setEdits({})

        queryClient.invalidateQueries({
          queryKey: [
            'admin-billing-models',
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

  const configuredCount =
    models.filter(
      (model) =>
        model.billing_configured,
    ).length

  const enabledBillingCount =
    models.filter(
      (model) =>
        model.billing_enabled,
    ).length

  const totalRevenue =
    models.reduce(
      (
        total,
        model,
      ) =>
        total +
        Number(
          model.revenue || 0,
        ),

      0,
    )

  return (
    <div className="max-w-[1700px]">
      <h1 className="text-xl font-semibold">
        Model Billing
      </h1>

      <p className="mt-1 text-sm text-muted-foreground">
        Set token prices and billing multipliers for each model.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border bg-card p-4">
          <div className="text-xs text-muted-foreground">
            Configured models
          </div>

          <div className="mt-1 text-2xl font-semibold">
            {configuredCount}
            {' / '}
            {models.length}
          </div>
        </div>

        <div className="rounded-2xl border bg-card p-4">
          <div className="text-xs text-muted-foreground">
            Billing enabled
          </div>

          <div className="mt-1 text-2xl font-semibold">
            {enabledBillingCount}
          </div>
        </div>

        <div className="rounded-2xl border bg-card p-4">
          <div className="text-xs text-muted-foreground">
            Total billed revenue
          </div>

          <div className="mt-1 text-2xl font-semibold">
            {formatMoney(
              totalRevenue,
            )}
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={(
            event,
          ) =>
            setSearch(
              event.target.value,
            )
          }
          placeholder="Search model, model ID or provider..."
          className="max-w-lg"
        />

        <select
          value={billingFilter}
          onChange={(event) =>
            setBillingFilter(
              event.target.value as BillingFilter,
            )
          }
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm text-foreground"
          aria-label="Billing model filter"
        >
          <option value="all">All models</option>
          <option value="configured">Billing configured</option>
          <option value="enabled">Billing enabled</option>
          <option value="disabled">Billing disabled</option>
          <option value="unconfigured">Not configured</option>
        </select>

        <span className="text-xs text-muted-foreground">
          {filteredModels.length} / {models.length}
        </span>
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

      <div className="mt-6 grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filteredModels.map((model) => {
          const expanded = expandedId === model.id
          return (
            <article key={model.id} className="relative h-fit self-start rounded-2xl border bg-card p-5 transition-shadow hover:shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{model.display_name}</div>
                  <code className="mt-1 block truncate text-xs text-muted-foreground">{model.model_id}</code>
                  <div className="mt-2 text-xs text-muted-foreground">Provider：{model.platform}</div>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-1 text-xs ${model.billing_configured ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'}`}>
                  {model.billing_configured ? '已配置' : '未配置'}
                </span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2 text-xs">
                <span className="rounded-full border px-2.5 py-1">请求 {formatNumber(model.request_count)}</span>
                <span className="rounded-full border px-2.5 py-1">Token {formatNumber(model.input_tokens + model.output_tokens)}</span>
                <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-emerald-600">收入 {formatMoney(model.revenue)}</span>
              </div>
              {!model.model_enabled && <div className="mt-3 text-xs text-muted-foreground">模型已停用</div>}
              <Button type="button" size="sm" variant="outline" className="mt-4" onClick={() => setExpandedId(expanded ? null : model.id)}>
                {expanded ? '收起编辑' : '编辑收费'}
              </Button>
              {expanded && (
                <div className="absolute left-0 right-0 top-full z-30 mt-2 grid gap-3 rounded-2xl border bg-card p-5 shadow-xl">
                  <label className="grid gap-1 text-xs text-muted-foreground">输入价格 / 1M<Input type="number" min="0" step="0.000001" value={model.editInputPrice} onChange={(event) => updateEdit(model.id, { editInputPrice: event.target.value })} /></label>
                  <label className="grid gap-1 text-xs text-muted-foreground">输出价格 / 1M<Input type="number" min="0" step="0.000001" value={model.editOutputPrice} onChange={(event) => updateEdit(model.id, { editOutputPrice: event.target.value })} /></label>
                  <label className="grid gap-1 text-xs text-muted-foreground">倍率<Input type="number" min="0" step="0.001" value={model.editMultiplier} onChange={(event) => updateEdit(model.id, { editMultiplier: event.target.value })} /></label>
                  <label className="grid gap-1 text-xs text-muted-foreground">计费状态<select className="h-9 rounded-md border border-input bg-transparent px-3 text-sm text-foreground" value={model.editBillingEnabled ? 'enabled' : 'disabled'} onChange={(event) => updateEdit(model.id, { editBillingEnabled: event.target.value === 'enabled' })}><option value="enabled">启用计费</option><option value="disabled">停用计费</option></select></label>
                  <Button disabled={saveBilling.isPending} onClick={() => saveBilling.mutate(model)}>{saveBilling.isPending ? '保存中...' : '保存收费设置'}</Button>
                </div>
              )}
            </article>
          )
        })}
        {!modelsQuery.isLoading && filteredModels.length === 0 && <div className="rounded-2xl border p-8 text-center text-muted-foreground md:col-span-2 xl:col-span-3">暂无模型</div>}
      </div>

      <div className="mt-6 hidden overflow-x-auto rounded-2xl border">
        <table className="min-w-[1200px] w-full text-xs">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3">
                Model
              </th>

              <th className="p-3">
                Provider
              </th>

              <th className="p-3">
                Input $ / 1M
              </th>

              <th className="p-3">
                Output $ / 1M
              </th>

              <th className="p-3">
                Multiplier
              </th>

              <th className="p-3">
                Billing
              </th>

              <th className="p-3">
                Requests
              </th>

              <th className="p-3">
                Tokens
              </th>

              <th className="p-3">
                Revenue
              </th>

              <th className="p-3">
                Action
              </th>
            </tr>
          </thead>

          <tbody>
            {filteredModels.map(
              (model) => (
                <tr
                  key={model.id}
                  className="border-b last:border-b-0 align-top"
                >
                  <td className="p-3">
                    <button type="button" className="mb-2 rounded border px-2 py-1 text-xs text-muted-foreground" onClick={() => setExpandedId(expandedId === model.id ? null : model.id)}>
                      {expandedId === model.id ? '收起编辑' : '展开编辑'}
                    </button>
                    <div className="font-medium">
                      {
                        model.display_name
                      }
                    </div>

                    <code className="mt-1 block max-w-[330px] break-all text-xs text-muted-foreground">
                      {model.model_id}
                    </code>

                    {!model.model_enabled && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        Model disabled
                      </div>
                    )}
                  </td>

                  <td className="p-3">
                    {model.platform}
                  </td>

                  <td className={`p-3 ${expandedId === model.id ? '' : 'hidden'}`}>
                    <Input
                      type="number"
                      min="0"
                      step="0.000001"
                      className="w-36"
                      value={
                        model.editInputPrice
                      }
                      onChange={(
                        event,
                      ) =>
                        updateEdit(
                          model.id,
                          {
                            editInputPrice:
                              event
                                .target
                                .value,
                          },
                        )
                      }
                    />
                  </td>

                  <td className={`p-3 ${expandedId === model.id ? '' : 'hidden'}`}>
                    <Input
                      type="number"
                      min="0"
                      step="0.000001"
                      className="w-36"
                      value={
                        model.editOutputPrice
                      }
                      onChange={(
                        event,
                      ) =>
                        updateEdit(
                          model.id,
                          {
                            editOutputPrice:
                              event
                                .target
                                .value,
                          },
                        )
                      }
                    />
                  </td>

                  <td className={`p-3 ${expandedId === model.id ? '' : 'hidden'}`}>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min="0"
                        step="0.001"
                        className="w-28"
                        value={
                          model.editMultiplier
                        }
                        onChange={(
                          event,
                        ) =>
                          updateEdit(
                            model.id,
                            {
                              editMultiplier:
                                event
                                  .target
                                  .value,
                            },
                          )
                        }
                      />

                      <span>
                        ×
                      </span>
                    </div>
                  </td>

                  <td className={`p-3 ${expandedId === model.id ? '' : 'hidden'}`}>
                    <select
                      className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                      value={
                        model.editBillingEnabled
                          ? 'enabled'
                          : 'disabled'
                      }
                      onChange={(
                        event,
                      ) =>
                        updateEdit(
                          model.id,
                          {
                            editBillingEnabled:
                              event
                                .target
                                .value ===
                              'enabled',
                          },
                        )
                      }
                    >
                      <option value="enabled">
                        Enabled
                      </option>

                      <option value="disabled">
                        Disabled
                      </option>
                    </select>

                    <div className="mt-1 text-xs text-muted-foreground">
                      {model.billing_configured
                        ? 'Configured'
                        : 'Not configured'}
                    </div>
                  </td>

                  <td className="p-3">
                    {formatNumber(
                      model.request_count,
                    )}
                  </td>

                  <td className="p-3">
                    <div>
                      {formatNumber(
                        model.input_tokens +
                          model.output_tokens,
                      )}
                    </div>

                    <div className="mt-1 text-xs text-muted-foreground">
                      In:{' '}
                      {formatNumber(
                        model.input_tokens,
                      )}
                      {' · Out: '}
                      {formatNumber(
                        model.output_tokens,
                      )}
                    </div>
                  </td>

                  <td className="p-3 font-medium">
                    {formatMoney(
                      model.revenue,
                    )}
                  </td>

                  <td className={`p-3 ${expandedId === model.id ? '' : 'hidden'}`}>
                    <Button
                      size="sm"
                      disabled={
                        saveBilling.isPending
                      }
                      onClick={() =>
                        saveBilling.mutate(
                          model,
                        )
                      }
                    >
                      {saveBilling.isPending
                        ? 'Saving...'
                        : 'Save'}
                    </Button>
                  </td>
                </tr>
              ),
            )}

            {!modelsQuery.isLoading &&
              filteredModels.length ===
                0 && (
                <tr>
                  <td
                    colSpan={10}
                    className="p-8 text-center text-muted-foreground"
                  >
                    No models found.
                  </td>
                </tr>
              )}
          </tbody>
        </table>
      </div>

      {modelsQuery.isLoading && (
        <p className="mt-4 text-sm text-muted-foreground">
          Loading models...
        </p>
      )}

      <div className="mt-5 rounded-2xl border bg-muted/20 p-4 text-sm">
        <div className="font-medium">
          Billing formula
        </div>

        <div className="mt-2 text-muted-foreground">
          Charge = (
          Input Tokens × Input Price
          + Output Tokens × Output Price
          ) ÷ 1,000,000 × Multiplier
        </div>
      </div>
    </div>
  )
}
