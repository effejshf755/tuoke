import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ForgotPasswordForm } from '@/components/forgot-password-form'

export default function AccountSettingsPage() {
  const navigate = useNavigate()
  const [reset, setReset] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(''); setMessage('')
    if (newPassword.length < 8) return setError('新密码至少需要 8 个字符。')
    if (newPassword !== confirmPassword) return setError('两次输入的新密码不一致。')
    try { const result = await apiFetch<{ message?: string }>('/api/user/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }); setMessage(result.message ?? '密码修改成功。'); setCurrentPassword(''); setNewPassword(''); setConfirmPassword('') } catch (e) { setError((e as Error).message) }
  }
  return <div className="mx-auto w-full max-w-xl"><div className="mb-6"><button className="text-sm text-muted-foreground hover:text-foreground" onClick={() => navigate('/user-center')}>← 返回控制台</button><h1 className="mt-4 text-2xl font-semibold">账户设置</h1><p className="mt-1 text-sm text-muted-foreground">管理密码和账户安全。</p></div>{reset ? <ForgotPasswordForm onBack={() => setReset(false)} /> : <div className="rounded-3xl border bg-card p-6"><h2 className="font-medium">修改密码</h2><form className="mt-5 space-y-4" onSubmit={submit}><div><Label htmlFor="settings-current">当前密码</Label><Input id="settings-current" className="mt-1.5" type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} /></div><div><Label htmlFor="settings-new">新密码</Label><Input id="settings-new" className="mt-1.5" type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} /></div><div><Label htmlFor="settings-confirm">确认新密码</Label><Input id="settings-confirm" className="mt-1.5" type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} /></div>{error && <p className="text-sm text-destructive">{error}</p>}{message && <p className="text-sm text-muted-foreground">{message}</p>}<div className="flex flex-wrap gap-2"><Button type="submit">保存密码</Button><Button type="button" variant="outline" onClick={() => setReset(true)}>忘记密码</Button></div></form></div>}</div>
}
