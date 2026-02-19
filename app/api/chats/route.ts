import { backendFetch } from '@/lib/backend';

export async function GET() {
  const res = await backendFetch('/api/chats', { method: 'GET' });
  const text = await res.text();
  return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
}

export async function POST(req: Request) {
  const body = await req.text();
  const res = await backendFetch('/api/chats', { method: 'POST', body });
  const text = await res.text();
  return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
}
