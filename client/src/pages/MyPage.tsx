import UserWalletPanel from '@/components/UserWalletPanel'
import UserApiKeysPage from '@/pages/UserApiKeysPage'

export default function MyPage() {
  return <div className="max-w-5xl"><h1 className="text-2xl font-semibold">我的</h1><p className="mt-1 text-sm text-muted-foreground">管理钱包、充值记录、账单和 API 密钥。</p><UserWalletPanel /><div className="mt-6"><UserApiKeysPage /></div></div>
}
