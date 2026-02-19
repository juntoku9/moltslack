const { WebSocketServer } = require('ws');

const BACKEND = process.env.BACKEND_BASE_URL || 'http://127.0.0.1:8080';
const PORT = Number(process.env.WS_PORT || 8081);
const HOST = process.env.WS_HOST || '127.0.0.1';

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

async function attachSSE(ws, chatId, replay = true) {
  const ctrl = new AbortController();
  if (!ws._streams) ws._streams = new Map();
  ws._streams.set(chatId, { ctrl, replay });
  try {
    const replayFlag = replay ? '1' : '0';
    const res = await fetch(`${BACKEND}/api/chats/${chatId}/events?replay=${replayFlag}`, { signal: ctrl.signal });
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
        ws.send(JSON.stringify({ type: 'event', chatId, event: evt.event, payload: evt.payload }));
      }
    }
  } catch {
    // ignore disconnects
  } finally {
    if (ws._streams) ws._streams.delete(chatId);
  }
}

const wss = new WebSocketServer({ host: HOST, port: PORT, path: '/ws' });

wss.on('connection', (ws) => {
  ws._streams = new Map();

  function subscribeMany(chatIds, replay = false) {
    const next = new Set((chatIds || []).filter(Boolean));
    for (const [existingChatId, stream] of ws._streams.entries()) {
      if (!next.has(existingChatId)) {
        stream.ctrl.abort();
        ws._streams.delete(existingChatId);
      }
    }
    for (const chatId of next) {
      if (ws._streams.has(chatId)) continue;
      attachSSE(ws, chatId, replay);
    }
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'subscribeMany' && Array.isArray(msg.chatIds)) {
      subscribeMany(msg.chatIds.map(String), Boolean(msg.replay));
      return;
    }
    if (msg.type === 'subscribe' && msg.chatId) {
      const chatId = String(msg.chatId);
      const existing = ws._streams.get(chatId);
      if (existing) {
        existing.ctrl.abort();
        ws._streams.delete(chatId);
      }
      attachSSE(ws, chatId, true);
      return;
    }
  });

  ws.on('close', () => {
    for (const [, stream] of ws._streams.entries()) {
      stream.ctrl.abort();
    }
    ws._streams.clear();
  });
});

console.log(`WS gateway listening on ws://${HOST}:${PORT}/ws`);
