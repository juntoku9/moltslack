import { backendFetch } from '@/lib/backend';

export async function POST(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const { chatId } = await params;
  const body = await req.text();
  const res = await backendFetch(`/api/chats/${chatId}/tasks`, { method: 'POST', body });
  const text = await res.text();
  return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
}
