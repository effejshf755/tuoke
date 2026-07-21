import UserWalletPanel from '@/components/UserWalletPanel'

export default function MyPage() {
  return <div className="max-w-5xl"><h1 className="text-2xl font-semibold">我的</h1><p className="mt-1 text-sm text-muted-foreground">管理钱包、充值记录和账单。</p><UserWalletPanel /></div>
}
