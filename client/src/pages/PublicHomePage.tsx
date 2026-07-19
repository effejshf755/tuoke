import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'

export default function PublicHomePage() {
  const navigate = useNavigate()
  const { data } = useQuery<{ role: 'admin' | 'user' | null }>({ queryKey: ['auth-status'] })
  const start = () => navigate(data?.role === 'admin' ? '/models/chat' : data?.role === 'user' ? '/user-center' : '/login')
  return <div className="flex min-h-[calc(100vh-9rem)] items-center justify-center"><div className="max-w-2xl text-center"><div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm font-semibold"><span className="size-2 rounded-full bg-foreground" />Tuoke API</div><h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">一个统一 API，连接多个 AI 模型</h1><p className="mx-auto mt-5 max-w-xl text-muted-foreground">使用一个简单、兼容 OpenAI 的 API，访问可用的 AI 模型。</p><div className="mt-8 flex flex-wrap justify-center gap-3"><Button onClick={start}>立即开始</Button><Link to="/user-models"><Button variant="outline">查看模型</Button></Link><Link to="/api-docs"><Button variant="outline">API 文档</Button></Link></div></div></div>
}
