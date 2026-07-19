import { useState } from 'react'
import { Button } from '@/components/ui/button'

const examples = {
  curl: `curl $BASE_URL/v1/chat/completions \\\n+  -H "Authorization: Bearer tuoke-xxxx" \\\n+  -H "Content-Type: application/json" \\\n+  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'`,
  python: `from openai import OpenAI\nclient = OpenAI(base_url="$BASE_URL/v1", api_key="tuoke-xxxx")\nresponse = client.chat.completions.create(model="auto", messages=[{"role":"user", "content":"Hello"}])`,
  node: `import OpenAI from "openai";\nconst client = new OpenAI({ baseURL: process.env.BASE_URL + "/v1", apiKey: "tuoke-xxxx" });\nconst response = await client.chat.completions.create({ model: "auto", messages: [{ role: "user", content: "Hello" }] });`,
}
export default function ApiDocsPage() {
  const [base] = useState(() => window.location.origin)
  return <div className="max-w-3xl"><h1 className="text-xl font-semibold">API Docs</h1><p className="mt-1 text-sm text-muted-foreground">OpenAI-compatible API quick start.</p><div className="mt-6 space-y-4"><div className="rounded-3xl border bg-card p-6"><div className="text-sm text-muted-foreground">Base URL</div><code className="mt-2 block">{base}</code><div className="mt-4 space-y-1 text-sm"><div>GET /v1/models</div><div>POST /v1/chat/completions</div><div>POST /v1/responses</div></div></div>{Object.entries(examples).map(([name, code]) => <div key={name} className="rounded-3xl border bg-card p-6"><div className="flex items-center justify-between text-sm font-medium"><span>{name}</span><Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(code.replaceAll('$BASE_URL', base))}>Copy</Button></div><pre className="mt-3 overflow-x-auto rounded-lg bg-muted p-4 text-xs">{code.replaceAll('$BASE_URL', base)}</pre></div>)}</div></div>
}
