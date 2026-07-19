import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'

type Model = { model_id: string; display_name: string; platform: string; context_window: number | null }
export default function UserModelsPage() {
  const { data } = useQuery<{ models: Model[] }>({ queryKey: ['user-models'], queryFn: () => apiFetch('/api/user/models') })
  return <div><h1 className="text-xl font-semibold">Models</h1><p className="mt-1 text-sm text-muted-foreground">Models available for your API requests.</p><div className="mt-6 overflow-x-auto rounded-3xl border bg-card"><table className="w-full text-left text-sm"><thead><tr className="border-b text-muted-foreground"><th className="p-4">Name</th><th className="p-4">Model ID</th><th className="p-4">Provider</th><th className="p-4">Context</th><th className="p-4" /></tr></thead><tbody>{data?.models.map(model => <tr key={model.model_id} className="border-b last:border-0"><td className="p-4 font-medium">{model.display_name}</td><td className="p-4"><code>{model.model_id}</code></td><td className="p-4">{model.platform}</td><td className="p-4">{model.context_window ?? '—'}</td><td className="p-4"><Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(model.model_id)}>Copy</Button></td></tr>)}</tbody></table></div></div>
}
