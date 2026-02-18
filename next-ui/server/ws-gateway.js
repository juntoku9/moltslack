const { WebSocketServer } = require('ws');

const BACKEND = process.env.BACKEND_BASE_URL || 'http://127.0.0.1:8080';
const PORT = Number(process.env.WS_PORT || 8081);

function parseSSEFrames(buffer) {
  const frames = [];
  let idx;
  while ((idx = buffer.indexOf('\n\n')) !== -1) {
    const frame = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    frames.push(frame);
  }
  return { frames, buffer };
}

function parseFrame(frame) {
  const lines = frame.split('\n');
  let event = 'message';
  let data = '';
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  try {
    return { event, payload: JSON.parse(data) };
  } catch {
    return null;
  }
}

async function attachSSE(ws, chatId) {
  const ctrl = new AbortController();
  ws._abort = ctrl;
  try {
    const res = await fetch(`${BACKEND}/api/chats/${chatId}/events?replay=0`, { signal: ctrl.signal });
    if (!res.body) return;
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      const parsed = parseSSEFrames(buf);
      buf = parsed.buffer;
      for (const frame of parsed.frames) {
        const evt = parseFrame(frame);
        if (!evt) continue;
        ws.send(JSON.stringify({ type: 'event', event: evt.event, payload: evt.payload }));
      }
    }
  } catch {
    // ignore disconnects
  }
}

const wss = new WebSocketServer({ port: PORT, path: '/ws' });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'subscribe' && msg.chatId) {
      if (ws._abort) ws._abort.abort();
      attachSSE(ws, msg.chatId);
      return;
    }
  });

  ws.on('close', () => {
    if (ws._abort) ws._abort.abort();
  });
});

console.log(`WS gateway listening on ws://127.0.0.1:${PORT}/ws`);
