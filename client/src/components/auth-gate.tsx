import { useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import {
  apiFetch,
  setToken,
  UNAUTHORIZED_EVENT,
  type ApiError,
} from '@/lib/api'

import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field-error'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { isEmail } from '@/lib/validate'
import { useI18n } from '@/i18n'
import { ForgotPasswordForm } from '@/components/forgot-password-form'
import Waves from '@/components/Waves'

const PASSWORD_MIN = 8

export interface AuthStatus {
  needsSetup: boolean
  authenticated: boolean
  email: string | null
  role: 'admin' | 'user' | null
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_50%_42%,#172133_0%,#080b10_42%,#020304_78%)] px-4">
      <Waves
        className="opacity-75"
        lineColor="rgba(255, 255, 255, 0.3)"
        waveSpeedX={0.009}
        waveSpeedY={0.005}
        waveAmpX={28}
        waveAmpY={12}
        friction={0.92}
        tension={0.007}
        maxCursorMove={80}
        xGap={22}
        yGap={52}
      />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(2,3,4,.76)_0%,rgba(2,3,4,.42)_34%,transparent_72%)]" />
      <div className="relative z-10 w-full max-w-sm">
        {children}
      </div>
    </div>
  )
}

function AuthForm({
  mode,
  onAuthed,
  onForgot,
}: {
  mode: 'setup' | 'login' | 'register'
  onAuthed: () => void
  onForgot?: () => void
}) {
  const { t } = useI18n()
  const registrationSettings = useQuery<{ registration_enabled: boolean }>({
    queryKey: ['public-platform-settings'],
    queryFn: () => apiFetch('/api/public/settings'),
    enabled: mode === 'register',
    retry: false,
  })

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  // 普通用户注册邮箱验证码
  const [verificationCode, setVerificationCode] = useState('')
  const [sendingCode, setSendingCode] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [codeMessage, setCodeMessage] = useState('')

// 首次初始化管理员使用设置代码
  const [setupCode, setSetupCode] = useState('')
  const [codeRequired, setCodeRequired] = useState(false)

  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempted, setAttempted] = useState(false)

  const isSetup = mode === 'setup'
  const isRegister = mode === 'register'

  // ============================================================
// 验证码发送倒计时
// ============================================================

  useEffect(() => {
    if (countdown <= 0) {
      return
    }

    const timer = window.setTimeout(() => {
      setCountdown((current) => Math.max(0, current - 1))
    }, 1000)

    return () => {
      window.clearTimeout(timer)
    }
  }, [countdown])

  // ============================================================
  // 表单校验
  // ============================================================

  const emailError = !email.trim()
    ? t('validation.required')
    : !isEmail(email)
      ? t('validation.email')
      : null

  const passwordError = !password
    ? t('validation.required')
    : (isSetup || isRegister) && password.length < PASSWORD_MIN
      ? t('validation.passwordMin', { min: PASSWORD_MIN })
      : null

  const verificationCodeError = isRegister
    ? !verificationCode.trim()
      ? 'Please enter the verification code'
      : !/^\d{6}$/.test(verificationCode.trim())
        ? 'Verification code must be 6 digits'
        : null
    : null

  // ============================================================
  // 发送注册邮箱验证码
  // ============================================================

  async function sendVerificationCode() {
    if (isRegister && registrationSettings.data?.registration_enabled === false) {
      setError('当前暂未开放注册')
      return
    }
    setError('')
    setCodeMessage('')

    if (emailError) {
      setAttempted(true)
      return
    }

    if (sendingCode || countdown > 0) {
      return
    }

    setSendingCode(true)

    try {
      await apiFetch<{ success: boolean; message: string }>(
        '/api/auth/send-register-code',
        {
          method: 'POST',
          body: JSON.stringify({
            email: email.trim(),
          }),
        },
      )

      setCountdown(60)
      setCodeMessage('Verification code sent. Check your email.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSendingCode(false)
    }
  }

  // ============================================================
// 登录 / 注册 / 首次初始化
// ============================================================

  async function submit(e: React.FormEvent) {
    e.preventDefault()

    if (isRegister && registrationSettings.data?.registration_enabled === false) {
      setError('当前暂未开放注册')
      return
    }

    if (
      emailError ||
      passwordError ||
      (isRegister && verificationCodeError)
    ) {
      setAttempted(true)
      return
    }

    setBusy(true)
    setError('')

    try {
      const payload: Record<string, string> = {
        email: email.trim(),
        password,
      }

      // 普通用户注册必须提交邮箱验证码
      if (isRegister) {
        payload.code = verificationCode.trim()
      }

      // Remote first-run setup code.
      if (isSetup && setupCode) {
        payload.setupCode = setupCode.trim()
      }

      let endpoint = '/api/auth/login'

      if (isSetup) {
        endpoint = '/api/auth/setup'
      } else if (isRegister) {
        endpoint = '/api/auth/register'
      }

      const res = await apiFetch<{ token: string }>(
        endpoint,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      )

      setToken(res.token)
      onAuthed()
    } catch (err) {
      if (
        isSetup &&
        (err as ApiError).code === 'setup_code_required'
      ) {
        setCodeRequired(true)
      }

      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // ============================================================
  // 页面标题
  // ============================================================

  const title = isSetup
    ? t('auth.createYourAccount')
    : isRegister
      ? '创建 Tuoke API 账号'
      : t('auth.signIn')

  const description = isSetup
    ? t('auth.setupDescription')
    : isRegister
      ? '使用邮箱验证创建账号。'
      : t('auth.loginDescription')

  const submitText = busy
    ? isSetup
      ? t('auth.creating')
      : isRegister
        ? '注册中…'
        : t('auth.signingIn')
    : isSetup
      ? t('auth.createAccount')
      : isRegister
        ? '注册'
        : t('auth.signIn')

  return (
    <Centered>
      <div className="mb-6 flex items-center gap-2">
        <span className="inline-block size-2 rounded-full bg-foreground" />
        <span className="font-semibold tracking-tight text-sm">
          Tuoke API
        </span>
      </div>

      <div className="rounded-3xl border border-foreground/15 bg-transparent p-6 shadow-none">
        <h1 className="text-base font-medium">
          {title}
        </h1>

        <p className="text-xs text-muted-foreground mt-1 mb-4">
          {description}
        </p>

        <form
          onSubmit={submit}
          className="space-y-3"
          noValidate
        >
          {/* 邮箱 */}
          <div className="space-y-1.5">
            <Label
              className="text-xs"
              htmlFor="auth-email"
            >
              {t('auth.email')}
            </Label>

            <div className={isRegister ? 'flex gap-2' : ''}>
              <Input
                id="auth-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value)
                  setCodeMessage('')
                }}
                placeholder={t('auth.emailPlaceholder')}
                aria-invalid={
                  attempted && !!emailError
                }
              />

              {isRegister && (
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  disabled={
                    sendingCode ||
                    countdown > 0
                  }
                  onClick={sendVerificationCode}
                >
                  {sendingCode
                    ? '发送中...'
                    : countdown > 0
                      ? `${countdown}s`
                      : '发送验证码'}
                </Button>
              )}
            </div>

            {attempted && (
              <FieldError error={emailError} />
            )}

            {isRegister && codeMessage && (
              <p className="text-xs text-muted-foreground">
                {codeMessage}
              </p>
            )}
          </div>

          {/* 注册邮箱验证码 */}
          {isRegister && (
            <div className="space-y-1.5">
              <Label
                className="text-xs"
                htmlFor="auth-verification-code"
              >
                邮箱验证码
              </Label>

              <Input
                id="auth-verification-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={verificationCode}
                onChange={(e) => {
                  const value = e.target.value
                    .replace(/\D/g, '')
                    .slice(0, 6)

                  setVerificationCode(value)
                }}
                placeholder="请输入 6 位验证码"
                aria-invalid={
                  attempted &&
                  !!verificationCodeError
                }
              />

              {attempted && (
                <FieldError
                  error={verificationCodeError}
                />
              )}

              <p className="text-xs text-muted-foreground">
                验证码有效期为 10 分钟。
              </p>
            </div>
          )}

          {/* 密码 */}
          <div className="space-y-1.5">
            <Label
              className="text-xs"
              htmlFor="auth-password"
            >
              {t('auth.password')}
            </Label>

            <Input
              id="auth-password"
              type="password"
              autoComplete={
                isSetup || isRegister
                  ? 'new-password'
                  : 'current-password'
              }
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
              }}
              placeholder={
                isSetup || isRegister
                  ? t('auth.passwordPlaceholderSetup')
                  : t('auth.passwordPlaceholderLogin')
              }
              aria-invalid={
                attempted &&
                !!passwordError
              }
            />

            {attempted && (
              <FieldError error={passwordError} />
            )}
          </div>

          {/* 首次远程初始化管理员 Setup Code */}
          {isSetup && codeRequired && (
            <div className="space-y-1.5">
              <Label
                className="text-xs"
                htmlFor="auth-setup-code"
              >
                {t('auth.setupCode')}
              </Label>

              <Input
                id="auth-setup-code"
                type="text"
                autoComplete="off"
                value={setupCode}
                onChange={(e) => {
                  setSetupCode(e.target.value)
                }}
                placeholder={
                  t('auth.setupCodePlaceholder')
                }
              />

              <p className="text-xs text-muted-foreground">
                {t('auth.setupCodeHint')}
              </p>
            </div>
          )}

          {/* 全局错误 */}
          {error && (
            <p className="text-destructive text-xs">
              {error}
            </p>
          )}

          {isRegister && registrationSettings.data?.registration_enabled === false && (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              当前暂未开放注册
            </p>
          )}

          {/* 提交 */}
          <Button
            type="submit"
            className="w-full"
            disabled={busy || (isRegister && registrationSettings.data?.registration_enabled === false)}
          >
            {submitText}
          </Button>
        </form>

        {/* 登录 / 注册切换 */}
        {!isSetup && !isRegister && onForgot && (
          <button
            type="button"
            className="mt-4 w-full text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              setError('')
              setAttempted(false)
              onForgot()
            }}
          >
            忘记密码？</button>
        )}

        {!isSetup && (
          <button
            type="button"
            className="mt-4 w-full text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              setError('')
              setCodeMessage('')
              setAttempted(false)

              ;(window as any).__AUTH_MODE__ =
                isRegister
                  ? 'login'
                  : 'register'

              window.dispatchEvent(
                new Event('auth-mode'),
              )
            }}
          >
            {isRegister
              ? '已经有账号？立即登录'
              : '还没有账号？立即注册'}
          </button>
        )}
      </div>
    </Centered>
  )
}

export function AuthGate({
  children,
}: {
  children: ReactNode
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const location = useLocation()

  const {
    data,
    isLoading,
    isError,
    refetch,
  } = useQuery<AuthStatus>({
    queryKey: ['auth-status'],
    queryFn: () =>
      apiFetch('/api/auth/status'),
    retry: false,
  })

  useEffect(() => {
    const handler = () => {
      refetch()
    }

    window.addEventListener(
      UNAUTHORIZED_EVENT,
      handler,
    )

    return () => {
      window.removeEventListener(
        UNAUTHORIZED_EVENT,
        handler,
      )
    }
  }, [refetch])

  function onAuthed() {
    queryClient.invalidateQueries()
    refetch()
  }

  if (isLoading) {
    return (
      <Centered>
        <p className="text-sm text-muted-foreground text-center">
          {t('auth.loading')}
        </p>
      </Centered>
    )
  }

  if (isError || !data) {
    return (
      <Centered>
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          {t('auth.serverUnreachableBefore')}
          <code className="font-mono">
            npm run dev
          </code>
          {t('auth.serverUnreachableAfter')}
        </div>
      </Centered>
    )
  }

  // 首次初始化管理员
  if (
    data.needsSetup &&
    location.pathname !== '/'
  ) {
    return (
      <AuthForm
        mode="setup"
        onAuthed={onAuthed}
      />
    )
  }

// 普通登录 / 注册
  if (
    !data.authenticated &&
    location.pathname !== '/'
  ) {
    const mode = (
      (window as any).__AUTH_MODE__ ??
      'login'
    ) as 'login' | 'register'

    return (
      <AuthModeForm
        mode={mode}
        onAuthed={onAuthed}
      />
    )
  }

  return <>{children}</>
}

function AuthModeForm({
  mode,
  onAuthed,
}: {
  mode: 'login' | 'register'
  onAuthed: () => void
}) {
  const [currentMode, setCurrentMode] =
    useState(mode)

  const [
    forgotPassword,
    setForgotPassword,
  ] = useState(false)

  useEffect(() => {
    const handler = () => {
      setForgotPassword(false)

      setCurrentMode(
        (current) =>
          current === 'login'
            ? 'register'
            : 'login',
      )
    }

    window.addEventListener(
      'auth-mode',
      handler,
    )

    return () => {
      window.removeEventListener(
        'auth-mode',
        handler,
      )
    }
  }, [])

  if (forgotPassword) {
    return (
      <Centered>
        <div className="mb-6 flex items-center gap-2">
          <span className="inline-block size-2 rounded-full bg-foreground" />
          <span className="font-semibold tracking-tight text-sm">
            Tuoke API
          </span>
        </div>

        <ForgotPasswordForm
          onBack={() => {
            setForgotPassword(false)
            setCurrentMode('login')
          }}
        />
      </Centered>
    )
  }

  return (
    <AuthForm
      mode={currentMode}
      onAuthed={onAuthed}
      onForgot={() => {
        setForgotPassword(true)
      }}
    />
  )
}
