import { useState } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Key = {
  id: number
  name: string
  keyPrefix: string
  status: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

type Usage = {
  total_requests: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  monthly_used_tokens: number
  monthly_token_limit: number
  monthly_remaining_tokens: number
}

type ChangePasswordResponse = {
  success: boolean
  message: string
}

export default function UserCenterPage() {
  const client = useQueryClient()

  // ============================================================
  // API Key
  // ============================================================

  const [name, setName] = useState('')
  const [newKey, setNewKey] = useState('')

  // ============================================================
  // Change password
  // ============================================================

  const [
    currentPassword,
    setCurrentPassword,
  ] = useState('')

  const [
    newPassword,
    setNewPassword,
  ] = useState('')

  const [
    confirmPassword,
    setConfirmPassword,
  ] = useState('')

  const [
    passwordError,
    setPasswordError,
  ] = useState('')

  const [
    passwordMessage,
    setPasswordMessage,
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

    queryFn: () =>
      apiFetch('/api/user/usage'),
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
          name,
        }),
      }),

    onSuccess: (response) => {
      setNewKey(response.key)
      setName('')

      client.invalidateQueries({
        queryKey: ['consumer-keys'],
      })
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
      client.invalidateQueries({
        queryKey: ['consumer-keys'],
      })
    },
  })

  // ============================================================
  // Change password
  // ============================================================

  const changePassword = useMutation({
    mutationFn: () =>
      apiFetch<ChangePasswordResponse>(
        '/api/user/password',
        {
          method: 'POST',

          body: JSON.stringify({
            currentPassword,
            newPassword,
          }),
        },
      ),

    onSuccess: (response) => {
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPasswordError('')

      setPasswordMessage(
        response.message ||
          'Password changed successfully.',
      )
    },

    onError: (error) => {
      setPasswordMessage('')

      setPasswordError(
        (error as Error).message,
      )
    },
  })

  function submitPasswordChange(
    event: React.FormEvent,
  ) {
    event.preventDefault()

    setPasswordError('')
    setPasswordMessage('')

    if (!currentPassword) {
      setPasswordError(
        'Please enter your current password.',
      )

      return
    }

    if (newPassword.length < 8) {
      setPasswordError(
        'New password must be at least 8 characters.',
      )

      return
    }

    if (
      newPassword !==
      confirmPassword
    ) {
      setPasswordError(
        'The new passwords do not match.',
      )

      return
    }

    if (
      currentPassword ===
      newPassword
    ) {
      setPasswordError(
        'New password must be different from current password.',
      )

      return
    }

    changePassword.mutate()
  }

  const monthlyUsed =
    usage.data?.monthly_used_tokens ?? 0

  const monthlyLimit =
    usage.data?.monthly_token_limit ??
    1_000_000

  const monthlyPercent =
    Math.min(
      100,
      (monthlyUsed /
        (monthlyLimit || 1)) *
        100,
    )

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold">
        User center
      </h1>

      <p className="mt-1 text-sm text-muted-foreground">
        Manage your account, usage and API keys.
      </p>

      {/* ======================================================
          Usage
      ====================================================== */}

      <div className="mt-6 rounded-3xl border bg-card p-6">
        <h2 className="font-medium">
          Usage
        </h2>

        <div className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <div className="text-muted-foreground">
              Requests
            </div>

            <div className="mt-1 text-lg font-semibold">
              {usage.data?.total_requests ??
                0}
            </div>
          </div>

          <div>
            <div className="text-muted-foreground">
              Input Tokens
            </div>

            <div className="mt-1 text-lg font-semibold">
              {usage.data?.prompt_tokens ??
                0}
            </div>
          </div>

          <div>
            <div className="text-muted-foreground">
              Output Tokens
            </div>

            <div className="mt-1 text-lg font-semibold">
              {usage.data
                ?.completion_tokens ?? 0}
            </div>
          </div>

          <div>
            <div className="text-muted-foreground">
              Total Tokens
            </div>

            <div className="mt-1 text-lg font-semibold">
              {usage.data?.total_tokens ??
                0}
            </div>
          </div>
        </div>

        <div className="mt-5 text-sm">
          <div className="flex justify-between">
            <span>
              This month
            </span>

            <span>
              {monthlyUsed} /{' '}
              {monthlyLimit}
            </span>
          </div>

          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-foreground"
              style={{
                width: `${monthlyPercent}%`,
              }}
            />
          </div>

          <div className="mt-2 text-muted-foreground">
            Remaining:{' '}
            {usage.data
              ?.monthly_remaining_tokens ??
              monthlyLimit}
          </div>
        </div>
      </div>

      {/* ======================================================
          API Keys
      ====================================================== */}

      <div className="mt-6 rounded-3xl border bg-card p-6">
        <h2 className="font-medium">
          My API Keys
        </h2>

        <div className="mt-4 flex gap-2">
          <Input
            value={name}
            onChange={(event) =>
              setName(
                event.target.value,
              )
            }
            placeholder="Key name"
          />

          <Button
            disabled={
              !name.trim() ||
              create.isPending
            }
            onClick={() =>
              create.mutate()
            }
          >
            {create.isPending
              ? 'Creating...'
              : 'Create'}
          </Button>
        </div>

        {create.isError && (
          <p className="mt-3 text-xs text-destructive">
            {
              (
                create.error as Error
              ).message
            }
          </p>
        )}

        {newKey && (
          <div className="mt-4 rounded-lg border border-green-500/40 bg-green-500/10 p-3 text-sm">
            <div>
              Copy this key now:
            </div>

            <code className="mt-2 block break-all">
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
              Copy
            </Button>
          </div>
        )}

        <div className="mt-6 space-y-3">
          {keys.data?.keys.map(
            (key) => (
              <div
                key={key.id}
                className="flex items-center justify-between border-b py-3 text-sm"
              >
                <div>
                  <div className="font-medium">
                    {key.name}
                  </div>

                  <code className="text-muted-foreground">
                    {key.keyPrefix}...
                  </code>

                  <div className="text-xs text-muted-foreground">
                    {key.status}
                  </div>
                </div>

                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    key.status ===
                      'revoked' ||
                    revoke.isPending
                  }
                  onClick={() =>
                    revoke.mutate(
                      key.id,
                    )
                  }
                >
                  Revoke
                </Button>
              </div>
            ),
          )}

          {keys.data?.keys.length ===
            0 && (
            <p className="py-4 text-sm text-muted-foreground">
              No API keys yet.
            </p>
          )}
        </div>
      </div>

      {/* ======================================================
          Account Settings
      ====================================================== */}

      <div className="mt-6 rounded-3xl border bg-card p-6">
        <h2 className="font-medium">
          Account settings
        </h2>

        <p className="mt-1 text-xs text-muted-foreground">
          Change your account password.
          Other logged-in devices will be
          signed out automatically.
        </p>

        <form
          onSubmit={
            submitPasswordChange
          }
          className="mt-5 space-y-4"
        >
          <div className="space-y-1.5">
            <Label
              htmlFor="current-password"
              className="text-xs"
            >
              Current password
            </Label>

            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) =>
                setCurrentPassword(
                  event.target.value,
                )
              }
              placeholder="Enter current password"
            />
          </div>

          <div className="space-y-1.5">
            <Label
              htmlFor="new-password"
              className="text-xs"
            >
              New password
            </Label>

            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) =>
                setNewPassword(
                  event.target.value,
                )
              }
              placeholder="At least 8 characters"
            />
          </div>

          <div className="space-y-1.5">
            <Label
              htmlFor="confirm-password"
              className="text-xs"
            >
              Confirm new password
            </Label>

            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) =>
                setConfirmPassword(
                  event.target.value,
                )
              }
              placeholder="Enter new password again"
            />
          </div>

          {passwordError && (
            <p className="text-xs text-destructive">
              {passwordError}
            </p>
          )}

          {passwordMessage && (
            <p className="text-xs text-muted-foreground">
              {passwordMessage}
            </p>
          )}

          <Button
            type="submit"
            disabled={
              changePassword.isPending
            }
          >
            {changePassword.isPending
              ? 'Changing...'
              : 'Change password'}
          </Button>
        </form>
      </div>
    </div>
  )
}