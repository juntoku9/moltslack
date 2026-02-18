'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import 'xterm/css/xterm.css';
import { useMoltStore } from '@/store/useMoltStore';
import type { ChatSummary } from '@/lib/types';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://127.0.0.1:8081/ws';

type WSEvent = {
  type: 'event';
  event: string;
  payload: Record<string, unknown>;
};

type Agent = 'claude' | 'chatgpt';
const AGENT_META: Record<Agent, { label: string; chip: string; glyph: string }> = {
  claude: { label: 'Claude', chip: 'chip-claude', glyph: 'C' },
  chatgpt: { label: 'ChatGPT', chip: 'chip-chatgpt', glyph: 'G' },
};

export default function HomePage() {
  const { chats, selectedChatId, setChats, addChat, selectChat } = useMoltStore();

  const [input, setInput] = useState('');
  const [wsConnected, setWsConnected] = useState(false);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [chatAgentMap, setChatAgentMap] = useState<Record<string, Agent>>({});
  const termMountRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const currentAgent = useMemo<Agent>(() => {
    if (!selectedChatId) return 'claude';
    return chatAgentMap[selectedChatId] ?? 'claude';
  }, [selectedChatId, chatAgentMap]);

  function inferAgentFromTitle(title: string): Agent {
    const t = title.toLowerCase();
    if (t.includes('gpt') || t.includes('chatgpt')) return 'chatgpt';
    return 'claude';
  }

  function persistAgentMap(next: Record<string, Agent>) {
    setChatAgentMap(next);
    try {
      localStorage.setItem('moltslack.agentMap.v1', JSON.stringify(next));
    } catch {}
  }

  useEffect(() => {
    try {
      const raw = localStorage.getItem('moltslack.agentMap.v1');
      if (raw) setChatAgentMap(JSON.parse(raw) as Record<string, Agent>);
    } catch {}

    fetch('/api/chats')
      .then((r) => r.json())
      .then((d: { chats: ChatSummary[] }) => {
        setChats(d.chats || []);
        const inferred: Record<string, Agent> = {};
        for (const c of d.chats || []) inferred[c.id] = inferAgentFromTitle(c.title);
        persistAgentMap({ ...inferred, ...chatAgentMap });
        if (!selectedChatId) {
          if (d.chats?.length) selectChat(d.chats[0].id);
          else setShowAgentPicker(true);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      if (selectedChatId) ws.send(JSON.stringify({ type: 'subscribe', chatId: selectedChatId }));
    };
    ws.onclose = () => setWsConnected(false);
    ws.onerror = () => setWsConnected(false);

    ws.onmessage = (m) => {
      let data: WSEvent;
      try {
        data = JSON.parse(m.data as string) as WSEvent;
      } catch {
        return;
      }
      if (data.type !== 'event') return;
      if (data.event !== 'output') return;
      termRef.current?.write(String(data.payload.text ?? ''));
    };

    return () => ws.close();
  }, [selectedChatId]);

  useEffect(() => {
    if (!selectedChatId || !wsRef.current) return;
    if (wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'subscribe', chatId: selectedChatId }));
    }
  }, [selectedChatId]);

  useEffect(() => {
    if (!selectedChatId) return;

    let term: any = null;
    let onDataDisposable: { dispose: () => void } | null = null;
    let disposed = false;

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('xterm'), import('xterm-addon-fit')]);
      if (disposed || !termMountRef.current) return;

      term = new Terminal({
        cursorBlink: true,
        convertEol: false,
        fontFamily: "JetBrains Mono, Menlo, Monaco, 'Courier New', monospace",
        fontSize: 14,
        lineHeight: 1.35,
        theme: {
          background: '#091228',
          foreground: '#d2f7ef',
          cursor: '#66e3c4',
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(termMountRef.current);
      requestAnimationFrame(() => fit.fit());

      termRef.current = term;
      fitRef.current = fit;

      onDataDisposable = term.onData((data: string) => {
        fetch(`/api/chats/${selectedChatId}/input`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: data }),
        }).catch(() => {});
      });

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'subscribe', chatId: selectedChatId }));
      }

      fetch(`/api/chats/${selectedChatId}/resize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: term.cols, rows: term.rows }),
      }).catch(() => {});
    })();

    const onResize = () => {
      if (!selectedChatId || !fitRef.current || !termRef.current || !termMountRef.current) return;
      if (termMountRef.current.clientWidth < 40 || termMountRef.current.clientHeight < 40) return;
      fitRef.current.fit();
      fetch(`/api/chats/${selectedChatId}/resize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: termRef.current.cols, rows: termRef.current.rows }),
      }).catch(() => {});
    };

    window.addEventListener('resize', onResize);
    return () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      onDataDisposable?.dispose();
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [selectedChatId]);

  async function createChat(agent: Agent) {
    const suffix = Date.now().toString().slice(-4);
    const title = `${agent === 'claude' ? 'claude' : 'chatgpt'}-${suffix}`;
    const res = await fetch('/api/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const d = (await res.json()) as { chat: ChatSummary };
    addChat(d.chat);
    selectChat(d.chat.id);
    const next = { ...chatAgentMap, [d.chat.id]: agent };
    persistAgentMap(next);
    setShowAgentPicker(false);

    // Boot the selected agent for faster first interaction.
    const bootCmd = agent === 'claude' ? 'claude\r' : 'codex\r';
    await fetch(`/api/chats/${d.chat.id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: bootCmd }),
    });
  }

  async function send() {
    const text = input.trim();
    if (!selectedChatId || !text) return;
    setInput('');

    await fetch(`/api/chats/${selectedChatId}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    await fetch(`/api/chats/${selectedChatId}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '\r' }),
    });
  }

  return (
    <div className='slack-shell'>
      <nav className='workspace-rail'>
        <div className='workspace-mark'>MS</div>
        <button className='rail-btn active'>T</button>
        <button className='rail-btn'>A</button>
      </nav>

      <aside className='channel-sidebar'>
        <div className='sidebar-head'>
          <h1>MoltSlack</h1>
          <p>Terminal Workspace</p>
        </div>

        <button onClick={() => setShowAgentPicker(true)} className='new-session-btn'>
          + New Terminal
        </button>

        <div className='session-list'>
          {chats.map((c) => (
            <button
              key={c.id}
              onClick={() => selectChat(c.id)}
              className={`session-item ${c.id === selectedChatId ? 'active' : ''}`}
            >
              <span className={`agent-glyph ${AGENT_META[chatAgentMap[c.id] ?? inferAgentFromTitle(c.title)].chip}`}>
                {AGENT_META[chatAgentMap[c.id] ?? inferAgentFromTitle(c.title)].glyph}
              </span>
              <div className='session-main'>
                <span className='session-title'>{c.title}</span>
                <span className={`session-status ${c.alive ? 'alive' : ''}`}>{c.alive ? 'live' : 'stopped'}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className='main-pane'>
        <header className='main-topbar'>
          <div className='top-left'>
            <strong>{selectedChatId || 'No session selected'}</strong>
            <span className='top-caption'>One shell per session. Slack-like terminal management.</span>
            <span className={`agent-chip ${AGENT_META[currentAgent].chip}`}>{AGENT_META[currentAgent].label}</span>
          </div>
          <div className={`ws-pill ${wsConnected ? 'ok' : 'bad'}`}>WS {wsConnected ? 'connected' : 'disconnected'}</div>
        </header>

        <section className='terminal-card'>
          <div ref={termMountRef} className='terminal-host' />
        </section>

        <footer className='composer'>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder='Type shell command/input for this terminal session...'
          />
          <button onClick={() => void send()}>Send</button>
        </footer>
      </main>

      {showAgentPicker && (
        <div className='picker-backdrop'>
          <div className='picker-card'>
            <h2>Start a new terminal</h2>
            <p>Select default agent for this session.</p>
            <div className='picker-options'>
              <button onClick={() => void createChat('claude')} className='picker-btn'>
                <span className='agent-glyph chip-claude'>C</span>
                <span>Claude</span>
              </button>
              <button onClick={() => void createChat('chatgpt')} className='picker-btn'>
                <span className='agent-glyph chip-chatgpt'>G</span>
                <span>ChatGPT</span>
              </button>
            </div>
            <button onClick={() => setShowAgentPicker(false)} className='picker-cancel'>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
