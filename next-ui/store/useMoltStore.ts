'use client';

import { create } from 'zustand';
import type { ActivityItem, ChatMessage, ChatSummary, ViewMode } from '@/lib/types';

type State = {
  chats: ChatSummary[];
  selectedChatId: string | null;
  viewMode: ViewMode;
  executionMode: 'interactive' | 'structured';
  defaultProvider: 'claude' | 'codex';
  messages: Record<string, ChatMessage[]>;
  activity: Record<string, ActivityItem[]>;
  terminalOutput: Record<string, string>;
  setChats: (chats: ChatSummary[]) => void;
  addChat: (chat: ChatSummary) => void;
  selectChat: (chatId: string) => void;
  setViewMode: (mode: ViewMode) => void;
  toggleExecutionMode: () => void;
  setDefaultProvider: (provider: 'claude' | 'codex') => void;
  appendMessage: (chatId: string, message: ChatMessage) => void;
  appendActivity: (chatId: string, item: ActivityItem) => void;
  appendTerminal: (chatId: string, chunk: string) => void;
  clearTerminal: (chatId: string) => void;
};

export const useMoltStore = create<State>((set, get) => ({
  chats: [],
  selectedChatId: null,
  viewMode: 'terminal',
  executionMode: 'interactive',
  defaultProvider: 'claude',
  messages: {},
  activity: {},
  terminalOutput: {},
  setChats: (chats) => set({ chats }),
  addChat: (chat) => set((s) => ({ chats: [...s.chats, chat] })),
  selectChat: (chatId) => set({ selectedChatId: chatId }),
  setViewMode: (mode) => set({ viewMode: mode }),
  toggleExecutionMode: () =>
    set((s) => ({ executionMode: s.executionMode === 'interactive' ? 'structured' : 'interactive' })),
  setDefaultProvider: (provider) => set({ defaultProvider: provider }),
  appendMessage: (chatId, message) =>
    set((s) => ({
      messages: {
        ...s.messages,
        [chatId]: [...(s.messages[chatId] ?? []), message].slice(-400),
      },
    })),
  appendActivity: (chatId, item) =>
    set((s) => ({
      activity: {
        ...s.activity,
        [chatId]: [...(s.activity[chatId] ?? []), item].slice(-1000),
      },
    })),
  appendTerminal: (chatId, chunk) =>
    set((s) => ({
      terminalOutput: {
        ...s.terminalOutput,
        [chatId]: (s.terminalOutput[chatId] ?? '') + chunk,
      },
    })),
  clearTerminal: (chatId) =>
    set((s) => ({ terminalOutput: { ...s.terminalOutput, [chatId]: '' } })),
}));

export function getSelectedMessages() {
  const s = useMoltStore.getState();
  const id = s.selectedChatId;
  return id ? s.messages[id] ?? [] : [];
}

export function getSelectedActivity() {
  const s = useMoltStore.getState();
  const id = s.selectedChatId;
  return id ? s.activity[id] ?? [] : [];
}

export function getSelectedTerminal() {
  const s = useMoltStore.getState();
  const id = s.selectedChatId;
  return id ? s.terminalOutput[id] ?? '' : '';
}
