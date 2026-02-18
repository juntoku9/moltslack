const BACKEND_BASE = process.env.BACKEND_BASE_URL ?? 'http://127.0.0.1:8080';

export async function backendFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${BACKEND_BASE}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
      cache: 'no-store',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backend unavailable';
    return new Response(JSON.stringify({ error: message }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
}
