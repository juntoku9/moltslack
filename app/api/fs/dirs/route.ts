import { backendFetch } from '@/lib/backend';

export async function GET(req: Request) {
  const incoming = new URL(req.url);
  const path = incoming.searchParams.get('path') ?? '';
  const qs = path ? `?path=${encodeURIComponent(path)}` : '';
  const res = await backendFetch(`/api/fs/dirs${qs}`, { method: 'GET' });
  const text = await res.text();
  return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
}
