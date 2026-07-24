import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Search } from 'lucide-react'

import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field-error'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import type { Platform } from '../../../../shared/types'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { GetKeyLink, PLATFORMS } from './shared'

type AddResult = {
  success: number
  duplicate: number
  failed: number
  errors: string[]
}

export function AddKeyForm() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [platform, setPlatform] = useState<Platform | ''>('')
  const [apiKey, setApiKey] = useState('')
  const [batchKeys, setBatchKeys] = useState('')
  const [accountId, setAccountId] = useState('')
  const [label, setLabel] = useState('')
  const [mode, setMode] = useState<'single' | 'batch'>('single')
  const [providerOpen, setProviderOpen] = useState(false)
  const [providerSearch, setProviderSearch] = useState('')
  const [batchResult, setBatchResult] = useState<AddResult | null>(null)
  const [addAttempted, setAddAttempted] = useState(false)

  const addKey = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: { platform: string; key: string; label?: string }) =>
      apiFetch<{ notice?: string | null }>('/api/keys', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  })

  const needsAccountId = platform === 'cloudflare'
  const selectedProvider = PLATFORMS.find(provider => provider.value === platform)
  const isKeyless = selectedProvider?.keyless ?? false
  const keyInput = mode === 'batch' ? batchKeys : apiKey
  const platformError = !platform ? t('validation.required') : null
  const keyError = !isKeyless && !keyInput.trim() ? t('validation.required') : null
  const accountIdError = needsAccountId && !accountId.trim() ? t('validation.required') : null
  const filteredPlatforms = PLATFORMS.filter(provider =>
    `${provider.label} ${provider.value}`
      .toLowerCase()
      .includes(providerSearch.trim().toLowerCase()),
  )

  function refreshKeyData() {
    queryClient.invalidateQueries({ queryKey: ['keys'] })
    queryClient.invalidateQueries({ queryKey: ['health'] })
    queryClient.invalidateQueries({ queryKey: ['fallback'] })
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (platformError || keyError || accountIdError) {
      setAddAttempted(true)
      return
    }

    setAddAttempted(false)
    setBatchResult(null)

    if (mode === 'single' || isKeyless) {
      const key = isKeyless
        ? ''
        : needsAccountId
          ? `${accountId.trim()}:${apiKey.trim()}`
          : apiKey.trim()

      try {
        const data = await addKey.mutateAsync({
          platform,
          key,
          label: label.trim() || undefined,
        })
        refreshKeyData()
        setApiKey('')
        toast.success(`${t('keys.keyAdded')}（已保留当前平台，可继续添加）`)
        if (data?.notice) toast.info(data.notice)
      } catch {
        // Mutation error is displayed below.
      }
      return
    }

    const rows = batchKeys
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [keyPart, ...labelParts] = line.split('|')
        return {
          key: keyPart.trim(),
          label: labelParts.join('|').trim() || label.trim() || undefined,
        }
      })
      .filter(row => row.key)

    const uniqueRows = Array.from(new Map(rows.map(row => [row.key, row])).values())
    const result: AddResult = {
      success: 0,
      duplicate: rows.length - uniqueRows.length,
      failed: 0,
      errors: [],
    }

    // Add sequentially to avoid creating a burst of health checks upstream.
    for (const row of uniqueRows) {
      try {
        const key = needsAccountId ? `${accountId.trim()}:${row.key}` : row.key
        await addKey.mutateAsync({ platform, key, label: row.label })
        result.success += 1
      } catch (error) {
        const message = (error as Error).message || '添加失败'
        if (/duplicate|already|exists|已存在|重复/i.test(message)) {
          result.duplicate += 1
        } else {
          result.failed += 1
          if (result.errors.length < 3) result.errors.push(message)
        }
      }
    }

    refreshKeyData()
    setBatchResult(result)
    if (result.success > 0) setBatchKeys('')
  }

  return (
    <div>
      <div className="mb-4 inline-flex rounded-lg border border-foreground/10 bg-background/50 p-1">
        <button
          type="button"
          onClick={() => {
            setMode('single')
            setBatchResult(null)
          }}
          className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
            mode === 'single'
              ? 'bg-foreground text-background'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          单个添加
        </button>
        <button
          type="button"
          disabled={isKeyless}
          onClick={() => {
            setMode('batch')
            setBatchResult(null)
          }}
          className={`rounded-md px-3 py-1.5 text-xs transition-colors disabled:opacity-40 ${
            mode === 'batch'
              ? 'bg-foreground text-background'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          批量添加
        </button>
      </div>

      <form onSubmit={handleSubmit} className="grid gap-4">
        <div className="grid gap-3 md:grid-cols-[220px_1fr]">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('keys.platform')}</Label>
            <Popover open={providerOpen} onOpenChange={setProviderOpen}>
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-between font-normal"
                    aria-invalid={addAttempted && !!platformError}
                  />
                }
              >
                <span className={selectedProvider ? '' : 'text-muted-foreground'}>
                  {selectedProvider?.label ?? t('keys.selectPlatform')}
                </span>
                <ChevronDown className="size-4 opacity-60" />
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[320px] p-2">
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    autoFocus
                    value={providerSearch}
                    onChange={event => setProviderSearch(event.target.value)}
                    placeholder="搜索提供商名称或平台标识"
                    className="pl-8"
                  />
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {filteredPlatforms.map(provider => (
                    <button
                      type="button"
                      key={provider.value}
                      onClick={() => {
                        setPlatform(provider.value)
                        setProviderOpen(false)
                        setProviderSearch('')
                        if (provider.keyless) setMode('single')
                      }}
                      className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted"
                    >
                      <span>
                        <span className="block">{provider.label}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {provider.value}
                        </span>
                      </span>
                      {platform === provider.value && <Check className="size-4" />}
                    </button>
                  ))}
                  {filteredPlatforms.length === 0 && (
                    <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                      没有匹配的提供商
                    </p>
                  )}
                </div>
              </PopoverContent>
            </Popover>
            {addAttempted && <FieldError error={platformError} />}
            {selectedProvider?.url && (
              <div className="pt-0.5">
                <GetKeyLink url={selectedProvider.url} />
              </div>
            )}
          </div>

          {needsAccountId && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t('keys.accountId')}</Label>
              <Input
                value={accountId}
                onChange={event => setAccountId(event.target.value)}
                placeholder="Cloudflare Account ID"
                className="font-mono text-xs"
                aria-invalid={addAttempted && !!accountIdError}
              />
              {addAttempted && <FieldError error={accountIdError} />}
            </div>
          )}

          <div className={`space-y-1.5 ${needsAccountId ? 'md:col-span-2' : ''}`}>
            <Label className="text-xs">
              {needsAccountId ? t('keys.apiToken') : t('keys.customApiKey')}
            </Label>
            {mode === 'batch' && !isKeyless ? (
              <>
                <Textarea
                  value={batchKeys}
                  onChange={event => setBatchKeys(event.target.value)}
                  placeholder={'每行填写一个 API Key\n也可以使用：API Key | 标签'}
                  className="min-h-32 resize-y font-mono text-xs"
                  aria-invalid={addAttempted && !!keyError}
                />
                <p className="text-[11px] text-muted-foreground">
                  平台只需选择一次；重复 Key 会自动跳过。
                </p>
              </>
            ) : (
              <Input
                type="password"
                value={isKeyless ? '' : apiKey}
                onChange={event => setApiKey(event.target.value)}
                placeholder={
                  isKeyless
                    ? t('keys.noKeyNeededPlaceholder')
                    : needsAccountId
                      ? t('keys.bearerTokenPlaceholder')
                      : t('keys.pasteKeyPlaceholder')
                }
                className="font-mono text-xs"
                disabled={isKeyless}
                aria-invalid={addAttempted && !!keyError}
              />
            )}
            {addAttempted && <FieldError error={keyError} />}
            {isKeyless && (
              <p className="text-[11px] text-muted-foreground">{t('keys.keylessHint')}</p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label className="text-xs">{t('keys.label')}</Label>
            <Input
              value={label}
              onChange={event => setLabel(event.target.value)}
              placeholder={
                mode === 'batch'
                  ? '统一标签（可选；每行标签优先）'
                  : t('keys.customDisplayNameOptional')
              }
            />
          </div>
          <Button type="submit" size="sm" disabled={addKey.isPending}>
            {addKey.isPending
              ? t('keys.adding')
              : isKeyless
                ? t('keys.enable')
                : mode === 'batch'
                  ? '批量添加'
                  : t('keys.addKey')}
          </Button>
        </div>
      </form>

      {addKey.isError && mode === 'single' && (
        <p className="mt-2 text-xs text-destructive">{(addKey.error as Error).message}</p>
      )}
      {batchResult && (
        <div className="mt-3 rounded-xl border border-foreground/10 bg-background/50 p-3 text-xs">
          <p>
            添加完成：成功 {batchResult.success} 个，重复 {batchResult.duplicate} 个，失败{' '}
            {batchResult.failed} 个。
          </p>
          {batchResult.errors.map((message, index) => (
            <p key={`${message}-${index}`} className="mt-1 text-destructive">
              {message}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
