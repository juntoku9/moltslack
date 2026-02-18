#!/usr/bin/env python3
import json
import os
import pty
import queue
import select
import signal
import subprocess
import threading
import time
import uuid
import fcntl
import struct
import termios
from urllib.parse import parse_qs, urlparse
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
HOST = "127.0.0.1"
PORT = 8080


def now_ms() -> int:
    return int(time.time() * 1000)


def _extract_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = [_extract_text(v) for v in value]
        return "\n".join([p for p in parts if p])
    if isinstance(value, dict):
        for key in ("text", "content", "message", "result", "output"):
            if key in value:
                text = _extract_text(value.get(key))
                if text:
                    return text
    return ""


def _provider_command(provider: str, prompt: str) -> List[str]:
    if provider == "claude":
        return ["claude", "-p", prompt, "--no-session-persistence", "--output-format", "stream-json", "--verbose"]
    if provider == "codex":
        return ["codex", "exec", "--json", prompt]
    raise ValueError(f"Unsupported provider: {provider}")


def _normalize_provider_line(provider: str, line: str) -> Dict[str, Optional[str]]:
    line = line.strip()
    if not line:
        return {"activity": None, "chat": None}
    try:
        data = json.loads(line)
    except json.JSONDecodeError:
        return {"activity": line, "chat": None}

    evt_type = str(data.get("type", "event"))
    activity = f"{provider}:{evt_type}"
    chat = None
    thought = None
    snippet = _extract_text(data.get("message")) or _extract_text(data.get("item")) or _extract_text(data.get("result"))
    if snippet:
        snippet = " ".join(snippet.split())
        if len(snippet) > 140:
            snippet = snippet[:140] + "..."
        activity = f"{activity} | {snippet}"

    if provider == "claude":
        # Claude stream-json often emits both assistant and result with similar
        # text. Use only the final result message to avoid duplicates.
        if evt_type == "assistant":
            thought = _extract_text(data.get("message"))
        if evt_type == "result":
            chat = _extract_text(data.get("result"))
    else:
        if "error" in evt_type:
            chat = f"Error: {_extract_text(data)}"
        else:
            chat = _extract_text(data.get("item")) or _extract_text(data.get("message"))

    if chat:
        chat = chat.strip()
    if thought:
        thought = thought.strip()
    return {"activity": activity, "chat": chat, "thought": thought}


@dataclass
class Event:
    kind: str
    payload: dict


@dataclass
class ChatSession:
    chat_id: str
    title: str
    created_at: int = field(default_factory=now_ms)
    pid: int = 0
    fd: int = -1
    alive: bool = True
    history: List[Event] = field(default_factory=list)
    listeners: List[queue.Queue] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def start(self) -> None:
        pid, fd = pty.fork()
        if pid == 0:
            os.environ["TERM"] = "xterm-256color"
            os.environ["PROMPT"] = "moltslack% "
            os.environ["PS1"] = "moltslack$ "
            shell = os.environ.get("MOLTSLACK_SHELL", "/bin/zsh")
            # Use zsh without user startup scripts to prevent noisy prompt escape codes.
            os.execvp(shell, [shell, "-f", "-i"])
        self.pid = pid
        self.fd = fd
        threading.Thread(target=self._read_loop, daemon=True).start()
        self._publish("status", {"state": "started"})

    def _publish(self, kind: str, payload: dict) -> None:
        evt = Event(kind=kind, payload={**payload, "ts": now_ms()})
        with self.lock:
            self.history.append(evt)
            if len(self.history) > 2000:
                self.history = self.history[-2000:]
            for q in list(self.listeners):
                q.put(evt)

    def _read_loop(self) -> None:
        while self.alive:
            try:
                ready, _, _ = select.select([self.fd], [], [], 0.25)
                if not ready:
                    continue
                data = os.read(self.fd, 4096)
                if not data:
                    break
                self._publish("output", {"text": data.decode("utf-8", errors="replace")})
            except OSError:
                break
        self.alive = False
        self._publish("status", {"state": "stopped"})

    def write(self, text: str) -> None:
        if not self.alive:
            raise RuntimeError("Session is not running")
        os.write(self.fd, text.encode("utf-8"))
        self._publish("input", {"text": text})

    def resize(self, cols: int, rows: int) -> None:
        if not self.alive:
            raise RuntimeError("Session is not running")
        packed = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, packed)

    def run_task(self, provider: str, prompt: str) -> None:
        clean_prompt = prompt.strip()
        if not clean_prompt:
            raise RuntimeError("Prompt cannot be empty")
        cmd = _provider_command(provider, clean_prompt)

        def _task() -> None:
            self._publish("activity", {"provider": provider, "stage": "start", "detail": "task_started"})
            stderr_lines: List[str] = []
            assistant_emitted = False
            try:
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    bufsize=1,
                    cwd=os.getcwd(),
                )
            except FileNotFoundError:
                self._publish("chat", {"role": "system", "text": f"{provider} CLI not found in PATH.", "provider": provider})
                self._publish("activity", {"provider": provider, "stage": "error", "detail": "cli_not_found"})
                return
            except Exception as ex:
                self._publish("chat", {"role": "system", "text": f"Failed to start task: {ex}", "provider": provider})
                self._publish("activity", {"provider": provider, "stage": "error", "detail": str(ex)})
                return

            def _read_stderr() -> None:
                if not proc.stderr:
                    return
                for line in proc.stderr:
                    msg = line.strip()
                    if msg:
                        stderr_lines.append(msg)
                        self._publish("activity", {"provider": provider, "stage": "stderr", "detail": msg})

            threading.Thread(target=_read_stderr, daemon=True).start()

            if proc.stdout:
                for line in proc.stdout:
                    parsed = _normalize_provider_line(provider, line)
                    if parsed["activity"]:
                        self._publish("activity", {"provider": provider, "stage": "stream", "detail": parsed["activity"]})
                    if parsed.get("thought"):
                        self._publish("thought", {"provider": provider, "text": parsed["thought"]})
                    if parsed["chat"]:
                        assistant_emitted = True
                        self._publish("chat", {"role": "assistant", "text": parsed["chat"], "provider": provider})

            rc = proc.wait()
            if rc != 0 and not assistant_emitted:
                detail = stderr_lines[0] if stderr_lines else f"{provider} exited with code {rc}"
                self._publish("chat", {"role": "system", "text": detail, "provider": provider})
            self._publish("activity", {"provider": provider, "stage": "finish", "detail": f"exit_code={rc}"})

        threading.Thread(target=_task, daemon=True).start()

    def subscribe(self, replay: bool = True) -> queue.Queue:
        q: queue.Queue = queue.Queue()
        with self.lock:
            if replay:
                for evt in self.history[-500:]:
                    q.put(evt)
            self.listeners.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self.lock:
            if q in self.listeners:
                self.listeners.remove(q)

    def stop(self) -> None:
        if not self.alive:
            return
        self.alive = False
        try:
            os.kill(self.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass


class SessionStore:
    def __init__(self) -> None:
        self.sessions: Dict[str, ChatSession] = {}
        self.lock = threading.Lock()

    def create(self, title: str) -> ChatSession:
        chat_id = str(uuid.uuid4())[:8]
        session = ChatSession(chat_id=chat_id, title=title.strip() or f"chat-{chat_id}")
        session.start()
        with self.lock:
            self.sessions[chat_id] = session
        return session

    def list(self) -> List[dict]:
        with self.lock:
            data = [
                {
                    "id": s.chat_id,
                    "title": s.title,
                    "alive": s.alive,
                    "created_at": s.created_at,
                }
                for s in self.sessions.values()
            ]
        return sorted(data, key=lambda x: x["created_at"])

    def get(self, chat_id: str) -> ChatSession:
        with self.lock:
            if chat_id not in self.sessions:
                raise KeyError(chat_id)
            return self.sessions[chat_id]


STORE = SessionStore()


class Handler(BaseHTTPRequestHandler):
    server_version = "MoltSlack/0.1"

    def log_message(self, fmt: str, *args) -> None:
        return

    def _send_json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        req_path = parsed.path
        query = parse_qs(parsed.query)

        if req_path == "/":
            self._serve_file(STATIC_DIR / "index.html", "text/html; charset=utf-8")
            return

        if req_path == "/api/chats":
            self._send_json(HTTPStatus.OK, {"chats": STORE.list()})
            return

        if req_path.startswith("/api/chats/") and req_path.endswith("/events"):
            parts = req_path.split("/")
            if len(parts) < 5:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Bad path"})
                return
            chat_id = parts[3]
            try:
                session = STORE.get(chat_id)
            except KeyError:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Chat not found"})
                return

            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            replay = query.get("replay", ["1"])[0] not in ("0", "false", "False")
            q = session.subscribe(replay=replay)
            try:
                while True:
                    evt = q.get()
                    frame = f"event: {evt.kind}\ndata: {json.dumps(evt.payload)}\n\n".encode("utf-8")
                    self.wfile.write(frame)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                session.unsubscribe(q)
            return

        if self.path.startswith("/static/"):
            path = STATIC_DIR / self.path.removeprefix("/static/")
            if path.exists():
                content_type = "text/plain"
                if path.suffix == ".css":
                    content_type = "text/css"
                if path.suffix == ".js":
                    content_type = "application/javascript"
                self._serve_file(path, content_type)
                return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_POST(self) -> None:
        if self.path == "/api/chats":
            body = self._read_json_body()
            title = str(body.get("title", "")).strip()
            session = STORE.create(title=title or "New Chat")
            self._send_json(
                HTTPStatus.CREATED,
                {
                    "chat": {
                        "id": session.chat_id,
                        "title": session.title,
                        "alive": session.alive,
                        "created_at": session.created_at,
                    }
                },
            )
            return

        if self.path.startswith("/api/chats/") and self.path.endswith("/input"):
            parts = self.path.split("/")
            if len(parts) < 5:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Bad path"})
                return
            chat_id = parts[3]
            body = self._read_json_body()
            text = str(body.get("text", ""))
            try:
                session = STORE.get(chat_id)
                session.write(text)
                self._send_json(HTTPStatus.OK, {"ok": True})
            except KeyError:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Chat not found"})
            except RuntimeError as ex:
                self._send_json(HTTPStatus.CONFLICT, {"error": str(ex)})
            return

        if self.path.startswith("/api/chats/") and self.path.endswith("/resize"):
            parts = self.path.split("/")
            if len(parts) < 5:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Bad path"})
                return
            chat_id = parts[3]
            body = self._read_json_body()
            try:
                cols = int(body.get("cols", 80))
                rows = int(body.get("rows", 24))
            except (TypeError, ValueError):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid size"})
                return
            cols = max(20, min(cols, 400))
            rows = max(5, min(rows, 200))
            try:
                session = STORE.get(chat_id)
                session.resize(cols=cols, rows=rows)
                self._send_json(HTTPStatus.OK, {"ok": True, "cols": cols, "rows": rows})
            except KeyError:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Chat not found"})
            except RuntimeError as ex:
                self._send_json(HTTPStatus.CONFLICT, {"error": str(ex)})
            return

        if self.path.startswith("/api/chats/") and self.path.endswith("/tasks"):
            parts = self.path.split("/")
            if len(parts) < 5:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Bad path"})
                return
            chat_id = parts[3]
            body = self._read_json_body()
            provider = str(body.get("provider", "claude")).strip().lower()
            prompt = str(body.get("prompt", ""))
            try:
                session = STORE.get(chat_id)
                session.run_task(provider=provider, prompt=prompt)
                self._send_json(HTTPStatus.ACCEPTED, {"ok": True, "provider": provider})
            except KeyError:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Chat not found"})
            except ValueError as ex:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(ex)})
            except RuntimeError as ex:
                self._send_json(HTTPStatus.CONFLICT, {"error": str(ex)})
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def _serve_file(self, path: Path, content_type: str) -> None:
        if not path.exists() or not path.is_file():
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return
        data = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"MoltSlack v1 listening on http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        sessions = STORE.list()
        for s in sessions:
            try:
                STORE.get(s["id"]).stop()
            except KeyError:
                pass
        server.server_close()


if __name__ == "__main__":
    main()
