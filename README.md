# MoltSlack

Slack-like workspace for managing multiple AI coding terminal sessions (Claude/Codex style), with project-scoped roots.
<img width="1726" height="1039" alt="Screenshot 2026-02-19 at 12 15 17 PM" src="https://github.com/user-attachments/assets/b6026dd3-6063-4f86-938f-2a5855125583" />

## Architecture
- `backend/server.py`: Python PTY runtime + REST/SSE APIs
- `app/`: Next.js App Router frontend (primary UI)
- `server/ws-gateway.js`: WebSocket bridge for live terminal events
- `store/`, `lib/`: frontend state + shared client utilities

## Run
1. Start backend:
```bash
python3 backend/server.py
```
2. Start frontend + WS gateway:
```bash
npm install
npm run dev
```

## Endpoints
- Next app: `http://127.0.0.1:3000`
- WS gateway: `ws://127.0.0.1:8081/ws`
- Python backend: `http://127.0.0.1:8080`

## Notes
- In-memory session store (no DB yet)
- Project folder picker hides dot-directories
- Terminal/session history survives UI session switching; resets on backend restart
