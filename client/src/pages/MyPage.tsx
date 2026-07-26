import { useQuery } from '@tanstack/react-query'
import UserWalletPanel from '@/components/UserWalletPanel'
import UserApiKeysPage from '@/pages/UserApiKeysPage'
import { apiFetch } from '@/lib/api'

export default function MyPage() {
  const me = useQuery<{ email: string }>({ queryKey: ['auth-me'], queryFn: () => apiFetch('/api/auth/me') })
  return <div className="max-w-5xl"><h1 className="break-all text-2xl font-semibold">{me.data?.email ?? '个人中心'}</h1><p className="mt-1 text-sm text-muted-foreground">管理钱包、充值记录、账单和 API 密钥。</p><UserWalletPanel /><div className="mt-6"><UserApiKeysPage /></div></div>
}
