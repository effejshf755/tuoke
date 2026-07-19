import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { isEmail } from '@/lib/validate'

const PASSWORD_MIN = 8

interface ForgotPasswordFormProps {
  onBack: () => void
}

export function ForgotPasswordForm({
  onBack,
}: ForgotPasswordFormProps) {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')

  const [sendingCode, setSendingCode] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [countdown, setCountdown] = useState(0)

  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    if (countdown <= 0) {
      return
    }

    const timer = window.setTimeout(() => {
      setCountdown((current) =>
        Math.max(0, current - 1),
      )
    }, 1000)

    return () => {
      window.clearTimeout(timer)
    }
  }, [countdown])

  async function sendCode() {
    setError('')
    setMessage('')

    const normalizedEmail = email.trim()

    if (!normalizedEmail) {
      setError('请输入邮箱地址。')
      return
    }

    if (!isEmail(normalizedEmail)) {
      setError('请输入正确的邮箱地址。')
      return
    }

    if (sendingCode || countdown > 0) {
      return
    }

    setSendingCode(true)

    try {
      await apiFetch<{
        success: boolean
        message: string
      }>('/api/auth/send-reset-code', {
        method: 'POST',
        body: JSON.stringify({
          email: normalizedEmail,
        }),
      })

      setCountdown(60)

      setMessage(
        '如果该邮箱已注册，验证码已发送，请检查邮箱。',
      )
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSendingCode(false)
    }
  }

  async function resetPassword(
    event: React.FormEvent,
  ) {
    event.preventDefault()

    setError('')
    setMessage('')

    const normalizedEmail = email.trim()
    const normalizedCode = code.trim()

    if (
      !normalizedEmail ||
      !isEmail(normalizedEmail)
    ) {
      setError('请输入正确的邮箱地址。')
      return
    }

    if (!/^\d{6}$/.test(normalizedCode)) {
      setError('请输入6位邮箱验证码。')
      return
    }

    if (newPassword.length < PASSWORD_MIN) {
      setError(
        `新密码至少需要 ${PASSWORD_MIN} 个字符。`,
      )
      return
    }

    setResetting(true)

    try {
      await apiFetch<{
        success: boolean
        message: string
      }>('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({
          email: normalizedEmail,
          code: normalizedCode,
          newPassword,
        }),
      })

      setSuccess(true)
      setMessage(
        '密码修改成功，请使用新密码重新登录。',
      )
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setResetting(false)
    }
  }

  if (success) {
    return (
      <div className="rounded-3xl border bg-card p-6">
        <h1 className="text-base font-medium">
          密码重置成功
        </h1>

        <p className="mt-2 text-xs text-muted-foreground">
          {message}
        </p>

        <Button
          type="button"
          className="mt-5 w-full"
          onClick={onBack}
        >
          返回登录
        </Button>
      </div>
    )
  }

  return (
    <div className="rounded-3xl border bg-card p-6">
      <h1 className="text-base font-medium">
        找回密码
      </h1>

      <p className="mt-1 mb-4 text-xs text-muted-foreground">
        使用注册邮箱接收验证码，然后设置新密码。
      </p>

      <form
        onSubmit={resetPassword}
        className="space-y-3"
        noValidate
      >
        <div className="space-y-1.5">
          <Label
            className="text-xs"
            htmlFor="reset-email"
          >
            邮箱
          </Label>

          <div className="flex gap-2">
            <Input
              id="reset-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) =>
                setEmail(event.target.value)
              }
              placeholder="请输入注册邮箱"
            />

            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              disabled={
                sendingCode ||
                countdown > 0
              }
              onClick={sendCode}
            >
              {sendingCode
                ? '发送中...'
                : countdown > 0
                  ? `${countdown}s`
                  : '获取验证码'}
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label
            className="text-xs"
            htmlFor="reset-code"
          >
            邮箱验证码
          </Label>

          <Input
            id="reset-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => {
              const value =
                event.target.value
                  .replace(/\D/g, '')
                  .slice(0, 6)

              setCode(value)
            }}
            placeholder="请输入6位验证码"
          />

          <p className="text-xs text-muted-foreground">
            验证码5分钟内有效。
          </p>
        </div>

        <div className="space-y-1.5">
          <Label
            className="text-xs"
            htmlFor="reset-password"
          >
            新密码
          </Label>

          <Input
            id="reset-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) =>
              setNewPassword(
                event.target.value,
              )
            }
            placeholder="请输入新密码"
          />
        </div>

        {message && (
          <p className="text-xs text-muted-foreground">
            {message}
          </p>
        )}

        {error && (
          <p className="text-xs text-destructive">
            {error}
          </p>
        )}

        <Button
          type="submit"
          className="w-full"
          disabled={resetting}
        >
          {resetting
            ? '正在重置...'
            : '重置密码'}
        </Button>

        <button
          type="button"
          className="w-full text-xs text-muted-foreground hover:text-foreground"
          onClick={onBack}
        >
          返回登录
        </button>
      </form>
    </div>
  )
}