export type ViewMode = 'terminal' | 'chat' | 'activity';

export type ChatSummary = {
  id: string;
  title: string;
  alive: boolean;
  created_at: number;
  root_path?: string;
};

export type ChatMessage = {
  role: 'user' | 'assistant' | 'system';
  text: string;
  provider?: string;
  ts: number;
};

export type ActivityItem = {
  provider: string;
  stage: string;
  detail: string;
  ts: number;
};
