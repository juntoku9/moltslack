# MoltSlack (v1 sample)

Minimal Slack-like interface where each chat owns a terminal session.

## What this is
- No auth
- No database
- No background workers
- Local-only prototype
- Each chat == one PTY-backed shell process
- Live PTY output over Server-Sent Events (SSE)
- `xterm.js` terminal renderer (served locally)
- Three UI views: `Terminal`, `Chat`, `Activity`

## Run
```bash
python3 app/server.py
```
Then open: `http://127.0.0.1:8080`

## Next.js UI (new)
A new frontend migration scaffold is available in `next-ui/` using:
- Next.js + React
- xterm.js terminal panel
- Zustand state store
- WebSocket gateway (`ws`) for live backend event streaming

Run:
```bash
cd next-ui
npm install
npm run dev
```

Endpoints:
- Next app: `http://127.0.0.1:3000`
- WS gateway: `ws://127.0.0.1:8081/ws`
- Python runtime backend remains on `http://127.0.0.1:8080`

## Architecture (basic)
- `app/server.py`
: Threading HTTP server with in-memory `SessionStore`
: `POST /api/chats` creates a chat + shell session
: `POST /api/chats/{id}/input` writes to the session stdin
: `POST /api/chats/{id}/resize` updates PTY rows/cols from browser terminal size
: `POST /api/chats/{id}/tasks` runs provider jobs (`claude` or `codex`) and emits structured events
: `GET /api/chats/{id}/events` streams stdout/stderr + status via SSE

- `app/static/index.html`
: Slack-like UI with embedded `xterm.js`
: Chat list on left
: Right pane supports terminal/chat/activity views

## Why this structure
- Keeps the core abstraction clear: chat thread maps to runtime session.
- Lets you swap shell runtime with provider adapters (`codex`, `claude_code`) later.
- Keeps transport simple (SSE + HTTP input) while preserving live stream behavior.
- Avoids fragile TUI text parsing by using structured provider task events for chat/activity.

## Next upgrades
1. Add provider adapters (`/api/runs`) to execute Codex/Claude commands instead of raw shell input.
2. Persist chats/events in SQLite or Postgres.
3. Add command approval policy for risky operations.
4. Add artifact panel (changed files, test output, patches).
5. Add reconnect cursor replay and session lifecycle controls (pause/stop/resume).

## Caveats
- This runs shell commands locally with no sandboxing. Use in a trusted environment only.
- In-memory state resets when server restarts.
- `xterm.js` assets are loaded from jsDelivr CDN.
