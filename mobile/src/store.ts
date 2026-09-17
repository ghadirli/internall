import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Agent, Confirm, Live, MiniApp, Message, Provider, Task } from './types';

const KEY = 'internall.state.v1';
const SECURE_KEYS: Record<Provider, string> = { openai: 'internall_openai_key', anthropic: 'internall_anthropic_key' };

export type State = {
  agents: Agent[];
  activeId: string | null;
  tasks: Task[];
  apps: MiniApp[];
  theme: 'system' | 'light' | 'dark';
  ready: boolean;
  live: Live;
  confirm: Confirm;
  running: string[]; // agent ids mid-turn
  openApp: string | null; // mini-app id being shown
};

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function defaultAgent(): Agent {
  return {
    id: newId(),
    name: 'Research Assistant',
    description:
      'A meticulous research assistant. Searches the web for current information, reads the ' +
      'sources it finds, and answers with short, well-organised summaries. Always cites where a ' +
      'fact came from.',
    avatar: { kind: 'art', seed: newId() },
    provider: 'openai',
    model: '',
    tools: { web: true, browser: true, apps: true, tasks: true, confirm: true },
    createdAt: Date.now(),
    messages: [],
    lastReadTs: Date.now(),
  };
}

class Store {
  state: State = {
    agents: [],
    activeId: null,
    tasks: [],
    apps: [],
    theme: 'system',
    ready: false,
    live: null,
    confirm: null,
    running: [],
    openApp: null,
  };

  private listeners = new Set<() => void>();
  private keys: Partial<Record<Provider, string>> = {};
  private saveTimer: any = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.state;

  /** Replaces state and notifies; keep updates immutable at the top level. */
  set(patch: Partial<State>, persist = true) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
    if (persist) this.save();
  }

  /** Mutating helper for deep edits (messages etc.) — bumps identity for React. */
  touchAgents(persist = true) {
    this.set({ agents: [...this.state.agents] }, persist);
  }

  async load() {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        this.state = { ...this.state, ...saved, live: null, confirm: null, running: [], openApp: null, ready: true };
      }
    } catch (e) {
      console.warn('load failed', e);
    }
    if (!this.state.agents.length) {
      const a = defaultAgent();
      this.state.agents = [a];
      this.state.activeId = a.id;
    }
    for (const p of ['openai', 'anthropic'] as Provider[]) {
      try {
        const k = await SecureStore.getItemAsync(SECURE_KEYS[p]);
        if (k) this.keys[p] = k;
      } catch {}
    }
    this.state.ready = true;
    this.listeners.forEach((fn) => fn());
  }

  private save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      const { agents, activeId, tasks, apps, theme } = this.state;
      try {
        await AsyncStorage.setItem(KEY, JSON.stringify({ agents, activeId, tasks, apps, theme }));
      } catch (e) {
        console.warn('save failed', e);
      }
    }, 250);
  }

  // ---- keys -------------------------------------------------------------
  getKey(p: Provider) {
    return this.keys[p] || null;
  }
  hasKey(p: Provider) {
    return Boolean(this.keys[p]);
  }
  async setKey(p: Provider, value: string) {
    this.keys[p] = value;
    try {
      await SecureStore.setItemAsync(SECURE_KEYS[p], value);
    } catch (e) {
      console.warn('secure store failed', e);
    }
    this.listeners.forEach((fn) => fn());
  }

  // ---- agents -----------------------------------------------------------
  agent(id: string | null) {
    return this.state.agents.find((a) => a.id === id) || null;
  }

  saveAgent(partial: Partial<Agent> & { name: string }) {
    const existing = partial.id ? this.agent(partial.id) : null;
    if (existing) {
      Object.assign(existing, partial);
      this.touchAgents();
      return existing;
    }
    const agent: Agent = {
      id: newId(),
      description: '',
      avatar: { kind: 'art', seed: newId() },
      provider: 'openai',
      model: '',
      tools: { web: true, browser: true, apps: true, tasks: true, confirm: true },
      createdAt: Date.now(),
      messages: [],
      lastReadTs: Date.now(),
      ...partial,
    } as Agent;
    this.set({ agents: [agent, ...this.state.agents], activeId: agent.id });
    return agent;
  }

  deleteAgent(id: string) {
    const agents = this.state.agents.filter((a) => a.id !== id);
    this.set({
      agents,
      tasks: this.state.tasks.filter((t) => t.agentId !== id),
      activeId: this.state.activeId === id ? agents[0]?.id ?? null : this.state.activeId,
    });
  }

  pushMessage(agentId: string, msg: Message) {
    const a = this.agent(agentId);
    if (!a) return;
    a.messages.push(msg);
    this.touchAgents();
  }

  setDraft(agentId: string, text: string) {
    const a = this.agent(agentId);
    if (!a || a.draft === text) return;
    a.draft = text;
    this.touchAgents();
  }

  markRead(agentId: string) {
    const a = this.agent(agentId);
    if (!a || !unreadCount(a)) return;
    a.lastReadTs = Date.now();
    this.touchAgents();
  }

  setRunning(agentId: string, on: boolean) {
    const running = on
      ? [...new Set([...this.state.running, agentId])]
      : this.state.running.filter((x) => x !== agentId);
    this.set({ running }, false);
  }

  isRunning(agentId: string) {
    return this.state.running.includes(agentId);
  }
}

export const store = new Store();

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getSnapshot()),
    () => select(store.getSnapshot())
  );
}

export const unreadCount = (a: Agent) =>
  a.messages.filter((m) => m.role === 'assistant' && m.ts > (a.lastReadTs || 0)).length;

export const lastActivity = (a: Agent) =>
  a.messages.length ? a.messages[a.messages.length - 1].ts : a.createdAt;

export const plainText = (m: Message) =>
  m.role === 'user'
    ? m.text
    : m.role === 'assistant'
      ? m.blocks
          .filter((b) => b.type === 'text')
          .map((b: any) => b.text)
          .join(' ')
          .trim()
      : '';
