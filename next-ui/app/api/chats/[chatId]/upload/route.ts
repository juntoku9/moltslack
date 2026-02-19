const BACKEND_BASE = process.env.BACKEND_BASE_URL ?? 'http://127.0.0.1:8080';

export async function POST(req: Request, ctx: { params: Promise<{ chatId: string }> }) {
  const { chatId } = await ctx.params;
  const form = await req.formData();

  let res: Response;
  try {
    res = await fetch(`${BACKEND_BASE}/api/chats/${chatId}/upload`, {
      method: 'POST',
      body: form,
      cache: 'no-store',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backend unavailable';
    return new Response(JSON.stringify({ error: message }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }

  const text = await res.text();
  return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
}
