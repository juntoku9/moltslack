import { backendFetch } from '@/lib/backend';

export async function POST(req: Request, ctx: { params: Promise<{ chatId: string }> }) {
  const { chatId } = await ctx.params;
  const body = await req.text();
  const res = await backendFetch(`/api/chats/${chatId}/summarize`, { method: 'POST', body });
  const text = await res.text();
  return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
}
