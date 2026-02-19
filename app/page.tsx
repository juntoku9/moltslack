'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import 'xterm/css/xterm.css';
import { useMoltStore } from '@/store/useMoltStore';
import type { ChatSummary } from '@/lib/types';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://127.0.0.1:8081/ws';
const PROJECTS_KEY = 'moltslack.projects.v1';
const SELECTED_PROJECT_KEY = 'moltslack.selectedProjectId.v1';
const CHAT_PROJECT_MAP_KEY = 'moltslack.chatProjectMap.v1';

type WSEvent = {
  type: 'event';
  chatId?: string;
  event: string;
  payload: Record<string, unknown>;
};

type DirEntry = { name: string; path: string };
type DirBrowseResponse = { path: string; parent: string | null; dirs: DirEntry[]; error?: string };
type Project = { id: string; name: string; rootPath: string };

type Agent = 'claude' | 'chatgpt';

const AGENT_META: Record<Agent, { label: string; chip: string; logo: string }> = {
  claude: { label: 'Claude', chip: 'chip-claude', logo: 'https://claude.ai/favicon.ico' },
  chatgpt: { label: 'OpenAI', chip: 'chip-chatgpt', logo: 'https://chatgpt.com/favicon.ico' },
};

export default function HomePage() {
  const { chats, selectedChatId, setChats, addChat, selectChat } = useMoltStore();

  const [input, setInput] = useState('');
  const [wsConnected, setWsConnected] = useState(false);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [projectNameInput, setProjectNameInput] = useState('');
  const [sessionNameInput, setSessionNameInput] = useState('');
  const [browsePath, setBrowsePath] = useState('');
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const [browseDirs, setBrowseDirs] = useState<DirEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState('');

  const [chatAgentMap, setChatAgentMap] = useState<Record<string, Agent>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [chatProjectMap, setChatProjectMap] = useState<Record<string, string>>({});

  const [dragActive, setDragActive] = useState(false);
  const [terminalTextMap, setTerminalTextMap] = useState<Record<string, string>>({});
  const [chatUnreadMap, setChatUnreadMap] = useState<Record<string, boolean>>({});
  const [chatBusyUntilMap, setChatBusyUntilMap] = useState<Record<string, number>>({});
  const [uiNowMs, setUiNowMs] = useState(Date.now());

  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const [summaryText, setSummaryText] = useState('');

  const termMountRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const effectiveSelectedChatIdRef = useRef<string | null>(null);
  const projectChatIdsRef = useRef<string[]>([]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const projectChats = useMemo(
    () => chats.filter((c) => chatProjectMap[c.id] === selectedProjectId),
    [chats, chatProjectMap, selectedProjectId],
  );

  const effectiveSelectedChatId = useMemo(() => {
    if (!selectedChatId) return null;
    return projectChats.some((c) => c.id === selectedChatId) ? selectedChatId : null;
  }, [selectedChatId, projectChats]);

  const currentAgent = useMemo<Agent>(() => {
    if (!effectiveSelectedChatId) return 'claude';
    return chatAgentMap[effectiveSelectedChatId] ?? 'claude';
  }, [effectiveSelectedChatId, chatAgentMap]);

  const selectedChat = useMemo(
    () => chats.find((c) => c.id === effectiveSelectedChatId) ?? null,
    [chats, effectiveSelectedChatId],
  );

  const selectedOutputText = useMemo(() => {
    if (!effectiveSelectedChatId) return '';
    return terminalTextMap[effectiveSelectedChatId] ?? '';
  }, [effectiveSelectedChatId, terminalTextMap]);

  const autoSummaryProvider = useMemo<'claude' | 'codex'>(() => {
    return currentAgent === 'claude' ? 'claude' : 'codex';
  }, [currentAgent]);

  function inferAgentFromTitle(title: string): Agent {
    const t = title.toLowerCase();
    if (t.includes('gpt') || t.includes('chatgpt')) return 'chatgpt';
    return 'claude';
  }

  function projectInitial(name: string): string {
    const clean = name.trim();
    if (!clean) return 'P';
    return clean.slice(0, 1).toUpperCase();
  }

  function persistAgentMap(next: Record<string, Agent>) {
    setChatAgentMap(next);
    try {
      localStorage.setItem('moltslack.agentMap.v1', JSON.stringify(next));
    } catch {}
  }

  function persistProjects(next: Project[]) {
    setProjects(next);
    try {
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(next));
    } catch {}
  }

  function persistSelectedProject(next: string | null) {
    setSelectedProjectId(next);
    try {
      if (next) localStorage.setItem(SELECTED_PROJECT_KEY, next);
      else localStorage.removeItem(SELECTED_PROJECT_KEY);
    } catch {}
  }

  function persistChatProjectMap(next: Record<string, string>) {
    setChatProjectMap(next);
    try {
      localStorage.setItem(CHAT_PROJECT_MAP_KEY, JSON.stringify(next));
    } catch {}
  }

  function appendTerminalChunk(chatId: string, chunk: string) {
    setTerminalTextMap((prev) => {
      const next = (prev[chatId] ?? '') + chunk;
      const capped = next.length > 300_000 ? next.slice(-300_000) : next;
      return { ...prev, [chatId]: capped };
    });
  }

  function pulseChatBusy(chatId: string, ms = 2500) {
    const until = Date.now() + ms;
    setChatBusyUntilMap((prev) => ({ ...prev, [chatId]: until }));
  }

  function subscribeToChat(chatId: string | null, replay = true) {
    if (!chatId || !wsRef.current) return;
    if (wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'subscribe', chatId, replay }));
  }

  function subscribeToProjectChats(chatIds: string[]) {
    if (!wsRef.current) return;
    if (wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'subscribeMany', chatIds, replay: false }));
  }

  async function loadDirs(path?: string) {
    setBrowseLoading(true);
    setBrowseError('');
    const qs = path ? `?path=${encodeURIComponent(path)}` : '';
    try {
      const res = await fetch(`/api/fs/dirs${qs}`);
      const data = (await res.json()) as DirBrowseResponse;
      if (!res.ok) {
        setBrowseError(data.error ?? 'Failed to load folders');
        return;
      }
      setBrowsePath(data.path);
      setBrowseParent(data.parent);
      setBrowseDirs(data.dirs ?? []);
      if (!projectNameInput) {
        const parts = data.path.split('/').filter(Boolean);
        setProjectNameInput(parts[parts.length - 1] || 'Project');
      }
    } catch {
      setBrowseError('Failed to load folders');
    } finally {
      setBrowseLoading(false);
    }
  }

  function openProjectPicker() {
    setShowProjectPicker(true);
    setShowAgentPicker(false);
    if (selectedProject?.rootPath) {
      void loadDirs(selectedProject.rootPath);
      return;
    }
    if (!browsePath) void loadDirs();
  }

  function openAgentPicker() {
    if (!selectedProject) {
      openProjectPicker();
      return;
    }
    setShowAgentPicker(true);
    setShowProjectPicker(false);
    setSessionNameInput('');
  }

  function switchProject(projectId: string) {
    persistSelectedProject(projectId);
    const scoped = chats.filter((c) => chatProjectMap[c.id] === projectId);
    if (scoped.length > 0) selectChat(scoped[0].id);
  }

  async function createProject() {
    const name = projectNameInput.trim();
    if (!name || !browsePath) return;
    const id = `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const nextProject: Project = { id, name, rootPath: browsePath };
    persistProjects([...projects, nextProject]);
    persistSelectedProject(id);
    setShowProjectPicker(false);
    setProjectNameInput('');
  }

  useEffect(() => {
    effectiveSelectedChatIdRef.current = effectiveSelectedChatId;
  }, [effectiveSelectedChatId]);

  useEffect(() => {
    const timer = window.setInterval(() => setUiNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!effectiveSelectedChatId) return;
    setChatUnreadMap((prev) => ({ ...prev, [effectiveSelectedChatId]: false }));
  }, [effectiveSelectedChatId]);

  useEffect(() => {
    setSummaryError('');
    setSummaryText('');
  }, [effectiveSelectedChatId]);

  useEffect(() => {
    let loadedProjects: Project[] = [];
    let loadedSelectedProjectId: string | null = null;
    let loadedChatProjectMap: Record<string, string> = {};
    let loadedAgentMap: Record<string, Agent> = {};

    try {
      const rawProjects = localStorage.getItem(PROJECTS_KEY);
      if (rawProjects) loadedProjects = JSON.parse(rawProjects) as Project[];
    } catch {}
    try {
      loadedSelectedProjectId = localStorage.getItem(SELECTED_PROJECT_KEY);
    } catch {}
    try {
      const rawChatProjectMap = localStorage.getItem(CHAT_PROJECT_MAP_KEY);
      if (rawChatProjectMap) loadedChatProjectMap = JSON.parse(rawChatProjectMap) as Record<string, string>;
    } catch {}
    try {
      const rawAgentMap = localStorage.getItem('moltslack.agentMap.v1');
      if (rawAgentMap) loadedAgentMap = JSON.parse(rawAgentMap) as Record<string, Agent>;
    } catch {}

    persistProjects(loadedProjects);
    persistSelectedProject(loadedSelectedProjectId);
    persistChatProjectMap(loadedChatProjectMap);
    persistAgentMap(loadedAgentMap);

    fetch('/api/chats')
      .then((r) => r.json())
      .then((d: { chats: ChatSummary[] }) => {
        const nextChats = d.chats || [];
        setChats(nextChats);

        const inferredAgents: Record<string, Agent> = {};
        for (const c of nextChats) inferredAgents[c.id] = inferAgentFromTitle(c.title);
        persistAgentMap({ ...inferredAgents, ...loadedAgentMap });

        const nextChatProjectMap: Record<string, string> = { ...loadedChatProjectMap };
        for (const c of nextChats) {
          if (nextChatProjectMap[c.id]) continue;
          const matchedProject = loadedProjects.find((p) => p.rootPath === c.root_path);
          if (matchedProject) nextChatProjectMap[c.id] = matchedProject.id;
        }
        persistChatProjectMap(nextChatProjectMap);

        let nextSelectedProject = loadedSelectedProjectId;
        if (!nextSelectedProject || !loadedProjects.some((p) => p.id === nextSelectedProject)) {
          nextSelectedProject = loadedProjects[0]?.id ?? null;
          persistSelectedProject(nextSelectedProject);
        }

        if (!nextSelectedProject) {
          openProjectPicker();
          return;
        }

        const scoped = nextChats.filter((c) => nextChatProjectMap[c.id] === nextSelectedProject);
        if (scoped.length > 0) selectChat(scoped[0].id);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      subscribeToProjectChats(projectChatIdsRef.current);
      subscribeToChat(effectiveSelectedChatIdRef.current, true);
    };
    ws.onclose = () => {
      setWsConnected(false);
    };
    ws.onerror = () => setWsConnected(false);

    ws.onmessage = (m) => {
      let data: WSEvent;
      try {
        data = JSON.parse(m.data as string) as WSEvent;
      } catch {
        return;
      }
      if (data.type !== 'event') return;
      const chatId = data.chatId || effectiveSelectedChatIdRef.current;
      if (!chatId) return;

      if (data.event === 'output') {
        const chunk = String(data.payload.text ?? '');
        appendTerminalChunk(chatId, chunk);
        pulseChatBusy(chatId);
        if (chatId === effectiveSelectedChatIdRef.current) {
          termRef.current?.write(chunk);
        } else {
          setChatUnreadMap((prev) => ({ ...prev, [chatId]: true }));
        }
        return;
      }
    };

    return () => ws.close();
  }, []);

  useEffect(() => {
    const ids = projectChats.map((c) => c.id).filter((id) => id !== effectiveSelectedChatId);
    projectChatIdsRef.current = ids;
    subscribeToProjectChats(ids);
    subscribeToChat(effectiveSelectedChatId, true);
  }, [projectChats, effectiveSelectedChatId]);

  useEffect(() => {
    if (!effectiveSelectedChatId) return;

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
          background: '#0e0e0e',
          foreground: '#d4d4d4',
          cursor: '#a0a0a0',
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(termMountRef.current);
      requestAnimationFrame(() => fit.fit());

      termRef.current = term;
      fitRef.current = fit;

      onDataDisposable = term.onData((data: string) => {
        fetch(`/api/chats/${effectiveSelectedChatId}/input`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: data }),
        }).catch(() => {});
      });

      fetch(`/api/chats/${effectiveSelectedChatId}/resize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: term.cols, rows: term.rows }),
      }).catch(() => {});
    })();

    const onResize = () => {
      if (!effectiveSelectedChatId || !fitRef.current || !termRef.current || !termMountRef.current) return;
      if (termMountRef.current.clientWidth < 40 || termMountRef.current.clientHeight < 40) return;
      fitRef.current.fit();
      fetch(`/api/chats/${effectiveSelectedChatId}/resize`, {
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
  }, [effectiveSelectedChatId]);

  async function createChat(agent: Agent) {
    if (!selectedProject) {
      openProjectPicker();
      return;
    }
    const suffix = Date.now().toString().slice(-4);
    const fallbackTitle = `${agent === 'claude' ? 'claude' : 'chatgpt'}-${suffix}`;
    const title = sessionNameInput.trim() || fallbackTitle;

    const res = await fetch('/api/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, root_path: selectedProject.rootPath }),
    });
    if (!res.ok) {
      const fail = await res.json().catch(() => ({ error: 'Failed to create chat' }));
      alert(String(fail?.error ?? 'Failed to create chat'));
      return;
    }

    const d = (await res.json()) as { chat: ChatSummary };
    addChat(d.chat);
    selectChat(d.chat.id);
    persistAgentMap({ ...chatAgentMap, [d.chat.id]: agent });
    persistChatProjectMap({ ...chatProjectMap, [d.chat.id]: selectedProject.id });
    setShowAgentPicker(false);
    setSessionNameInput('');

    const bootCmd = agent === 'claude' ? 'claude\r' : 'codex\r';
    await fetch(`/api/chats/${d.chat.id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: bootCmd }),
    });
  }

  async function send() {
    const text = input.trim();
    if (!effectiveSelectedChatId || !text) return;
    setInput('');

    await fetch(`/api/chats/${effectiveSelectedChatId}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    await fetch(`/api/chats/${effectiveSelectedChatId}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '\r' }),
    });
  }

  function quotePath(path: string): string {
    return `'${path.replace(/'/g, `'\\''`)}'`;
  }

  async function handleFileDrop(fileList: FileList | null) {
    if (!effectiveSelectedChatId || !fileList || fileList.length === 0) return;
    const form = new FormData();
    for (const file of Array.from(fileList)) {
      const withRel = file as File & { webkitRelativePath?: string };
      form.append('files', file, withRel.webkitRelativePath || file.name);
    }

    const res = await fetch(`/api/chats/${effectiveSelectedChatId}/upload`, {
      method: 'POST',
      body: form,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; files?: string[] };
    if (!res.ok) {
      alert(data.error || 'Failed to upload files');
      return;
    }

    const files = (data.files ?? []).map((p) => `./${p}`);
    if (files.length > 0) {
      const insertion = files.map(quotePath).join(' ');
      setInput((prev) => (prev.trim() ? `${prev} ${insertion}` : insertion));
    }
  }

  async function summarizeHistory() {
    if (!effectiveSelectedChatId) return;
    setSummaryLoading(true);
    setSummaryError('');
    try {
      const res = await fetch(`/api/chats/${effectiveSelectedChatId}/summarize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: autoSummaryProvider, max_chars: 12000 }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; summary?: string };
      if (!res.ok) {
        setSummaryError(data.error || 'Failed to summarize');
        return;
      }
      setSummaryText(data.summary || '(No summary returned)');
    } catch {
      setSummaryError('Failed to summarize');
    } finally {
      setSummaryLoading(false);
    }
  }

  const outputChars = selectedOutputText.length;
  const outputLines = selectedOutputText ? selectedOutputText.split('\n').length : 0;

  function renderSummaryMarkdown(md: string): string {
    const escaped = md
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const lines = escaped.split('\n');
    const out: string[] = [];
    let inList = false;

    const inline = (s: string) =>
      s
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        if (inList) {
          out.push('</ul>');
          inList = false;
        }
        continue;
      }
      if (line.startsWith('- ')) {
        if (!inList) {
          out.push('<ul>');
          inList = true;
        }
        out.push(`<li>${inline(line.slice(2))}</li>`);
        continue;
      }
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      if (line.startsWith('### ')) {
        out.push(`<h3>${inline(line.slice(4))}</h3>`);
      } else if (line.startsWith('## ')) {
        out.push(`<h2>${inline(line.slice(3))}</h2>`);
      } else if (line.startsWith('# ')) {
        out.push(`<h1>${inline(line.slice(2))}</h1>`);
      } else if (line.startsWith('> ')) {
        out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
      } else {
        out.push(`<p>${inline(line)}</p>`);
      }
    }
    if (inList) out.push('</ul>');
    return out.join('');
  }

  return (
    <div className='slack-shell'>
      <nav className='workspace-rail'>
        <div className='workspace-mark'>MS</div>
        <div className='project-rail-list'>
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => switchProject(p.id)}
              className={`project-rail-btn ${p.id === selectedProjectId ? 'active' : ''}`}
              title={`${p.name} (${p.rootPath})`}
            >
              {projectInitial(p.name)}
            </button>
          ))}
        </div>
        <button className='project-add-btn' onClick={() => openProjectPicker()} title='New project' aria-label='New project'>
          +
        </button>
      </nav>

      <aside className='channel-sidebar'>
        <div className='sidebar-head'>
          <h1>MoltSlack</h1>
          <p>{selectedProject ? `${selectedProject.name} project` : 'Pick a project to start'}</p>
        </div>

        <button onClick={() => openAgentPicker()} className='new-session-btn' disabled={!selectedProject}>
          + New Terminal
        </button>

        <div className='session-list'>
          {projectChats.length === 0 && <div className='session-empty'>No sessions in this project yet.</div>}
          {projectChats.map((c) => (
            (() => {
              const isWorking = c.alive && (chatBusyUntilMap[c.id] ?? 0) > uiNowMs;
              const isUnread = Boolean(chatUnreadMap[c.id]) && c.id !== effectiveSelectedChatId;
              const statusClass = !c.alive ? 'stopped' : isWorking ? 'working' : 'alive';
              const statusText = !c.alive ? 'stopped' : isWorking ? 'working' : 'live';
              return (
            <button
              key={c.id}
              onClick={() => selectChat(c.id)}
              className={`session-item ${c.id === effectiveSelectedChatId ? 'active' : ''}`}
            >
              <span className={`agent-glyph ${AGENT_META[chatAgentMap[c.id] ?? inferAgentFromTitle(c.title)].chip}`}>
                <img
                  className='agent-logo'
                  src={AGENT_META[chatAgentMap[c.id] ?? inferAgentFromTitle(c.title)].logo}
                  alt={AGENT_META[chatAgentMap[c.id] ?? inferAgentFromTitle(c.title)].label}
                />
              </span>
              <div className='session-main'>
                <span className='session-title'>{c.title}</span>
                <div className='session-meta-row'>
                  <span className={`session-status ${statusClass}`}>
                    <span className='status-dot' />
                    {statusText}
                  </span>
                  {isUnread && <span className='session-unread'>unread</span>}
                </div>
              </div>
            </button>
              );
            })()
          ))}
        </div>
      </aside>

      <main className='main-pane'>
        <header className='main-topbar'>
          <div className='top-left'>
            <strong>{selectedChat?.title || effectiveSelectedChatId || 'No session selected'}</strong>
            <span className='top-caption'>Project-scoped terminal sessions.</span>
            <span className={`agent-chip ${AGENT_META[currentAgent].chip}`}>{AGENT_META[currentAgent].label}</span>
            <span className='top-path'>{selectedProject?.rootPath || '(no project selected)'}</span>
          </div>
          <div className={`ws-pill ${wsConnected ? 'ok' : 'bad'}`}>{wsConnected ? 'Connected' : 'Disconnected'}</div>
        </header>

        <section
          className={`terminal-card ${dragActive ? 'drag-active' : ''}`}
          onDragEnter={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setDragActive(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragActive(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            void handleFileDrop(e.dataTransfer.files);
          }}
        >
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
            placeholder='Send a command...'
            disabled={!effectiveSelectedChatId}
          />
          <button onClick={() => void send()} disabled={!effectiveSelectedChatId}>Send</button>
        </footer>
      </main>

      <aside className='meta-sidebar'>
        <div className='meta-header'>Details</div>
        <div className='meta-body'>
          <div className='meta-section'>
            <h3>Session Metadata</h3>
            <div className='meta-row'><span>ID</span><code>{effectiveSelectedChatId || '-'}</code></div>
            <div className='meta-row'><span>Project</span><strong>{selectedProject?.name || '-'}</strong></div>
            <div className='meta-row'><span>Root</span><code className='meta-code'>{selectedProject?.rootPath || '-'}</code></div>
            <div className='meta-row'><span>Status</span><strong>{selectedChat?.alive ? 'live' : 'stopped'}</strong></div>
            <div className='meta-row'><span>Created</span><strong>{selectedChat ? new Date(selectedChat.created_at).toLocaleString() : '-'}</strong></div>
            <div className='meta-row'><span>Output</span><strong>{outputLines} lines / {outputChars} chars</strong></div>
          </div>

          <div className='meta-section'>
            <h3>AI Summary</h3>
            <div className='summary-controls'>
              <span className='summary-provider'>Auto: {autoSummaryProvider === 'claude' ? 'Claude' : 'OpenAI Codex'}</span>
              <button onClick={() => void summarizeHistory()} disabled={!effectiveSelectedChatId || summaryLoading}>
                {summaryLoading ? 'Summarizing...' : 'Summarize'}
              </button>
            </div>
            {summaryError && <p className='summary-error'>{summaryError}</p>}
            <div className='summary-box summary-markdown' dangerouslySetInnerHTML={{ __html: renderSummaryMarkdown(summaryText || 'Run summary to capture what happened in this terminal.') }} />
          </div>
        </div>
      </aside>

      {showAgentPicker && selectedProject && (
        <div className='picker-backdrop'>
          <div className='picker-card'>
            <h2>Start a new terminal</h2>
            <p>Project: {selectedProject.name}</p>
            <div className='picker-field'>
              <span>Session name</span>
              <input
                value={sessionNameInput}
                onChange={(e) => setSessionNameInput(e.target.value)}
                className='picker-input'
                placeholder='e.g. backend bugfix, auth refactor, stripe webhook'
              />
            </div>
            <div className='picker-field'>
              <span>Root folder</span>
              <div className='picker-input-row'>
                <input value={selectedProject.rootPath} className='picker-input' readOnly />
                <button className='picker-browse-btn' onClick={() => openProjectPicker()}>
                  Switch Project
                </button>
              </div>
            </div>
            <div className='picker-options'>
              <button onClick={() => void createChat('claude')} className='picker-btn'>
                <span className='agent-glyph chip-claude'>
                  <img className='agent-logo' src={AGENT_META.claude.logo} alt='Claude' />
                </span>
                <span>Claude</span>
              </button>
              <button onClick={() => void createChat('chatgpt')} className='picker-btn'>
                <span className='agent-glyph chip-chatgpt'>
                  <img className='agent-logo' src={AGENT_META.chatgpt.logo} alt='OpenAI' />
                </span>
                <span>OpenAI</span>
              </button>
            </div>
            <button onClick={() => setShowAgentPicker(false)} className='picker-cancel'>
              Cancel
            </button>
          </div>
        </div>
      )}

      {showProjectPicker && (
        <div className='picker-backdrop'>
          <div className='picker-card'>
            <h2>Create or select project root</h2>
            <p>All sessions in this project will use the same folder.</p>
            <div className='picker-field'>
              <span>Project name</span>
              <input
                value={projectNameInput}
                onChange={(e) => setProjectNameInput(e.target.value)}
                className='picker-input'
                placeholder='My Project'
              />
            </div>
            <div className='picker-field'>
              <span>Root folder</span>
              <div className='picker-input-row'>
                <input value={browsePath} className='picker-input' readOnly />
                <button className='picker-browse-btn' onClick={() => void loadDirs(browsePath || undefined)}>
                  Refresh
                </button>
              </div>
            </div>
            <div className='folder-browser'>
              <div className='folder-browser-top'>
                <button
                  className='folder-up-btn'
                  onClick={() => browseParent && void loadDirs(browseParent)}
                  disabled={!browseParent || browseLoading}
                >
                  Up
                </button>
                <code className='folder-path'>{browsePath || '(loading...)'}</code>
                <button className='folder-use-btn' onClick={() => setBrowsePath(browsePath)} disabled={!browsePath || browseLoading}>
                  Use This Folder
                </button>
              </div>
              <div className='folder-list'>
                {browseLoading && <div className='folder-empty'>Loading folders...</div>}
                {!browseLoading && browseError && <div className='folder-error'>{browseError}</div>}
                {!browseLoading && !browseError && browseDirs.length === 0 && <div className='folder-empty'>No subfolders</div>}
                {!browseLoading &&
                  !browseError &&
                  browseDirs.map((d) => (
                    <button key={d.path} className='folder-row' onClick={() => void loadDirs(d.path)}>
                      <span className='folder-icon'>[DIR]</span>
                      <span className='folder-name'>{d.name}</span>
                    </button>
                  ))}
              </div>
            </div>
            <button onClick={() => void createProject()} className='new-session-btn' disabled={!browsePath || !projectNameInput.trim()}>
              Save Project
            </button>
            <button onClick={() => setShowProjectPicker(false)} className='picker-cancel'>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
