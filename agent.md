# MoltSlack Agent Log

This file is the persistent AI-dev log for this project.
Use it as the single source of truth for:
- product goal
- current architecture
- key decisions and reasoning
- known issues
- next priorities
- session-by-session change log

## 1) Product Goal

Build a Slack-like workspace for managing many AI coding terminal sessions (Claude Code / Codex style), where:
- each chat maps to one PTY terminal session
- terminal remains first-class (full flexibility preserved)
- UX is significantly cleaner than raw terminal tab management

Current product direction: **terminal-first multi-session manager** (chat parsing is optional/secondary).

## 2) Current Architecture

### Backend
- `backend/server.py`
- Python HTTP + PTY orchestration
- One session per chat id
- Endpoints for:
  - create/list chats
  - send input to PTY
  - resize PTY
  - stream events/output

### Frontend
- `app/` + root Next.js config (Next.js + React)
- `xterm.js` for terminal rendering
- Zustand store for client state
- WS gateway in `server/ws-gateway.js` forwarding backend events to browser

### Runtime Ports
- Backend: `127.0.0.1:8080`
- WS Gateway: `127.0.0.1:8081`
- Next UI: `127.0.0.1:3000`

## 3) UX Principles

- Terminal is the source of truth.
- Do not break or over-parse terminal output.
- Keep rectangular terminal viewport with stable sizing.
- Session management should be fast: create, switch, identify provider quickly.
- Sidebar should show agent identity per session (Claude/ChatGPT).

## 4) Key Decisions + Reasoning

1. Terminal-first over chat-first
- Reason: user requires full Claude/Codex CLI behavior and intermediate states.

2. xterm.js instead of plain text rendering
- Reason: ANSI/TUI compatibility and fewer formatting artifacts.

3. Slack-like shell layout
- Reason: improve operator experience for multi-session workflows.

4. New session agent picker (Claude / ChatGPT)
- Reason: user wants provider identity visible and selectable at creation.

5. Keep chat parsing optional
- Reason: aggressive parsing caused duplicated/messy output and broken fidelity.

## 5) Current State (as of latest update)

- Slack-like UI redesign is implemented.
- New Terminal button opens agent picker.
- Sidebar includes per-session agent badge.
- Terminal container made rectangular to avoid clipped box borders.
- Repo pushed to public GitHub:
  - `https://github.com/juntoku9/moltslack`

## 6) Known Issues / Risks

- PTY behavior varies by provider CLI interactive mode.
- If chat-mode parsing is reintroduced, it must never distort terminal fidelity.
- Background process management in local env can be flaky; use persistent sessions.

## 7) Best-Practice Working Rules (for AI agent)

1. Before large changes:
- update this file with intent and expected impact.

2. After each meaningful change:
- append an entry in Session Log with:
  - what changed
  - why
  - files touched
  - validation result

3. Never degrade terminal fidelity:
- if uncertain, preserve raw terminal behavior and reduce parsing.

4. Keep UI changes incremental and testable:
- build frontend after edits
- verify ports/services and runtime behavior

5. Keep repo clean:
- avoid committing build artifacts/logs
- keep `.gitignore` up to date

## 8) Next Priorities

1. Provider launch reliability (Claude/Codex bootstrap behaviors).
2. Session metadata persistence (agent, title, last active).
3. Better terminal lifecycle controls (restart/kill/duplicate session).
4. Optional split-view (terminal + activity) without altering terminal stream.

## 9) Session Log

### 2026-02-18
- Intent: introduce explicit project switcher in left rail so sessions are grouped/scoped by project root path.
- Expected impact: cleaner multi-repo workflow where each project shares one root folder and one session list.
- Intent: replace manual root-path text entry with a GUI folder picker in New Terminal flow.
- Expected impact: faster and less error-prone project-root selection for Claude/Codex sessions.
- Intent: add root-folder selection during new terminal creation so Claude/Codex sessions can start in user-selected project paths.
- Expected impact: improve provider usability for file-path-centric workflows without changing terminal stream fidelity.
- Added root-path-aware session creation (`root_path` in create/list chat payloads) and PTY launch from selected directory.
- Updated provider task execution to run inside the session root path (Claude/Codex command context matches selected folder).
- Added New Terminal modal root-folder input and surfaced root path in sidebar/topbar for active session context.
- Replaced manual path entry with GUI folder browser in New Terminal modal (navigate directories, go up, and select current folder).
- Added filesystem directory-list API for the picker (`GET /api/fs/dirs`) plus Next.js proxy route.
- Fixed terminal context loss when switching sessions by enabling replay on WS SSE bridge and deduplicating client subscribe calls.
- Added project model in frontend with persistent project list/selection, project-to-chat mapping, and left-rail project switcher.
- Updated New Terminal flow to always create sessions under selected project root instead of ad-hoc per-session path entry.
- Session list is now project-scoped, and switching projects switches visible sessions/work context.
- Added right-side metadata panel with session facts and provider-based terminal history summarization controls.
- Added backend summarize endpoint (`POST /api/chats/{id}/summarize`) using Claude/Codex CLIs with timeout guard.
- Why: Claude Code and Codex workflows are project-path centric, so session root must be explicit and selectable at creation.
- Files touched: `backend/server.py`, `app/page.tsx`, `app/globals.css`, `lib/types.ts`, `app/api/fs/dirs/route.ts`, `app/api/chats/[chatId]/upload/route.ts`, `app/api/chats/[chatId]/summarize/route.ts`, `server/ws-gateway.js`, `agent.md`.
- Validation: `python3 -m py_compile backend/server.py` passed; `npm run build` passed; summarize route returns provider validation errors as expected; frontend/backend restarted successfully with metadata sidebar UI.
- Established terminal-first product direction.
- Migrated UI architecture to Next.js + xterm.js + WS gateway + Zustand.
- Implemented Slack-like layout and styling refresh.
- Added new-session agent picker (Claude/ChatGPT) and sidebar identity badges.
- Fixed terminal frame shape to rectangular and adjusted container spacing.
- Initialized git repo, cleaned tracked build artifacts, pushed public `main`.
