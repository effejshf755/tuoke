import { useState } from 'react'
import { Button } from '@/components/ui/button'

const examples = {
  curl: `curl $BASE_URL/v1/chat/completions \\\n+  -H "Authorization: Bearer tuoke-xxxx" \\\n+  -H "Content-Type: application/json" \\\n+  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'`,
  python: `from openai import OpenAI\nclient = OpenAI(base_url="$BASE_URL/v1", api_key="tuoke-xxxx")\nresponse = client.chat.completions.create(model="auto", messages=[{"role":"user", "content":"Hello"}])`,
  node: `import OpenAI from "openai";\nconst client = new OpenAI({ baseURL: process.env.BASE_URL + "/v1", apiKey: "tuoke-xxxx" });\nconst response = await client.chat.completions.create({ model: "auto", messages: [{ role: "user", content: "Hello" }] });`,
}
export default function ApiDocsPage() {
  const [base] = useState(() => window.location.origin)
  return <div className="max-w-4xl"><h1 className="text-xl font-semibold">API 文档</h1><p className="mt-1 text-sm text-muted-foreground">Tuoke API 的 OpenAI-compatible 接口。</p><div className="mt-6 space-y-4"><div className="rounded-3xl border bg-card p-6"><h2 className="font-medium">Base URL 与认证</h2><code className="mt-2 block">{base}/v1</code><p className="mt-3 text-sm">使用 <code>Authorization: Bearer tuoke-xxxxxxxx</code>。完整 API Key 只在创建时显示一次，请勿提交到 GitHub 或公开到前端。</p><div className="mt-4 space-y-1 text-sm"><div>GET /v1/models</div><div>POST /v1/chat/completions</div><div>POST /v1/responses</div></div></div>{Object.entries(examples).map(([name, code]) => <div key={name} className="rounded-3xl border bg-card p-6"><div className="flex items-center justify-between text-sm font-medium"><span>{name === 'curl' ? 'curl' : name === 'python' ? 'Python OpenAI SDK' : 'JavaScript / Node SDK'}</span><Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(code.replaceAll('$BASE_URL', base))}>复制</Button></div><pre className="mt-3 overflow-x-auto rounded-lg bg-muted p-4 text-xs">{code.replaceAll('$BASE_URL', base)}</pre></div>)}<div className="rounded-3xl border bg-card p-6 text-sm"><h2 className="font-medium">流式、错误与计费</h2><p className="mt-2">Chat Completions 支持 <code>stream: true</code>。402 表示余额不足；401 未认证；403 无权限；404 资源不存在；429 请求过多；503 模型暂不可用或未配置计费（billing_not_configured）。</p><p className="mt-2">消费由 Input Tokens、Output Tokens、模型价格和倍率共同决定，按实际 Token 结算，使用预付费余额。</p></div></div></div>
}
