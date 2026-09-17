export type Provider = 'openai' | 'anthropic';

export type Citation = { url: string; title: string };

export type Block =
  | { type: 'text'; text: string; citations?: Citation[] }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; name: string; input: any };

/** Provider-neutral transcript, same shape as the desktop app:
 *  `blocks` is what the UI draws, `raw` is the provider's own payload replayed
 *  verbatim on the next request so tool calls and reasoning items stay valid. */
export type Message =
  | { role: 'user'; ts: number; text: string; scheduled?: boolean }
  | { role: 'assistant'; ts: number; provider: Provider; blocks: Block[]; raw: any }
  | { role: 'tool'; ts: number; provider: Provider; raw: any };

export type Agent = {
  id: string;
  name: string;
  description: string;
  avatar: { kind: 'art' | 'emoji'; seed?: string };
  emoji?: string;
  color?: string;
  provider: Provider;
  model: string;
  tools: { web: boolean; browser: boolean; apps: boolean; tasks: boolean; confirm: boolean };
  createdAt: number;
  messages: Message[];
  draft?: string;
  lastReadTs?: number;
};

export type TaskKind = 'in' | 'once' | 'daily' | 'weekdays' | 'weekly' | 'interval';

export type Task = {
  id: string;
  agentId: string;
  instruction: string;
  kind: TaskKind;
  time: string; // "HH:MM"
  date: string; // "YYYY-MM-DD" for once
  weekday: number; // 0-6 for weekly
  everyMinutes: number; // for interval
  inMinutes: number; // for "in"
  enabled: boolean;
  createdAt: number;
  lastRun: number | null;
  nextRun: number | null;
  notificationId?: string | null;
};

export type MiniApp = { id: string; agentId: string; title: string; createdAt: number };

/** Transient state for the turn currently being generated. */
export type Live = {
  agentId: string;
  text: string;
  thinking: string;
  steps: { name: string; input: any }[];
  status: string;
  startedAt: number;
} | null;

export type Confirm = {
  id: string;
  agentId: string;
  title: string;
  detail: string;
  resolve: (ok: boolean) => void;
} | null;
