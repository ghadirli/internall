import { getJSON, streamSSE } from '../net/stream';
import { Agent, Block, Message } from '../types';
import { ToolDef } from '../tools/defs';

const BASE = 'https://api.openai.com/v1';

export const FALLBACK_MODELS = ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.1', 'gpt-4.1'];
const SKIP = /(embedding|tts|whisper|dall-e|moderation|audio|realtime|image|transcribe|instruct|davinci|babbage)/;

export async function listModels(key: string) {
  const json = await getJSON(`${BASE}/models`, { Authorization: `Bearer ${key}` });
  return (json.data || [])
    .filter((m: any) => /^(gpt-|o[1345]|chatgpt-|codex)/.test(m.id) && !SKIP.test(m.id))
    .sort((a: any, b: any) => (b.created || 0) - (a.created || 0))
    .map((m: any) => ({ id: m.id, label: m.id }));
}

export function pickDefaultModel(ids: string[]) {
  const prefer = [/^gpt-5\.6/, /^gpt-5\.5/, /^gpt-5\.\d/, /^gpt-5$/, /^gpt-4\.1$/];
  for (const re of prefer) {
    const hit = ids.find((id) => re.test(id));
    if (hit) return hit;
  }
  return ids[0] || FALLBACK_MODELS[0];
}

const isReasoning = (m: string) => /^(gpt-5|o[1345])/.test(m) && !/chat-latest/.test(m);

export const safeParse = (s: string) => {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
};

/** The SDK adds `parsed_arguments` / `parsed`; those are not valid request input. */
export function cleanOutput(output: any[]): any[] {
  return (output || []).map((item) => {
    const { parsed_arguments, ...rest } = item;
    if (Array.isArray(rest.content)) rest.content = rest.content.map(({ parsed, ...c }: any) => c);
    return rest;
  });
}

export function blocksFrom(output: any[]): Block[] {
  const blocks: Block[] = [];
  for (const item of output || []) {
    if (item.type === 'reasoning') {
      const text = (item.summary || []).map((s: any) => s.text).join('\n').trim();
      if (text) blocks.push({ type: 'thinking', text });
    } else if (item.type === 'message') {
      for (const c of item.content || []) {
        if (c.type !== 'output_text') continue;
        const citations = (c.annotations || [])
          .filter((a: any) => a.type === 'url_citation' && a.url)
          .map((a: any) => ({ url: a.url, title: a.title || a.url }));
        blocks.push({ type: 'text', text: c.text, citations });
      }
    } else if (item.type === 'web_search_call') {
      blocks.push({ type: 'tool', name: 'web_search', input: { query: item.action?.query || '' } });
    } else if (item.type === 'function_call') {
      blocks.push({ type: 'tool', name: item.name, input: safeParse(item.arguments) });
    }
  }
  return blocks;
}


/* Every turn resends the whole conversation, so a long chat with page text in it
   can exceed a per-minute token budget on its own. Stale tool output becomes a
   stub, and the oldest whole rounds are dropped once the request is too big —
   cut at user messages so a tool call is never split from its result. */
const HISTORY_BUDGET = 60000; // characters ≈ 15k tokens
const KEEP_VERBATIM = 3;

const stub = (len: number) =>
  `[trimmed: ${len} characters of tool output from an earlier step — ask again if you need it]`;

export function trimInput(items: any[]): any[] {
  const outputs = items.map((it, i) => (it.type === 'function_call_output' ? i : -1)).filter((i) => i >= 0);
  const cutoff = outputs.length > KEEP_VERBATIM ? outputs[outputs.length - KEEP_VERBATIM] : -1;
  let out = items.map((it, i) =>
    it.type === 'function_call_output' && i < cutoff && typeof it.output === 'string' && it.output.length > 400
      ? { ...it, output: stub(it.output.length) }
      : it
  );
  while (JSON.stringify(out).length > HISTORY_BUDGET) {
    const next = out.findIndex((it, i) => i > 0 && it.role === 'user' && typeof it.content === 'string');
    if (next <= 0) break;
    out = out.slice(next);
  }
  return out;
}

export function buildInput(agent: Agent) {
  const out: any[] = [];
  for (const m of agent.messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      if (m.provider === 'openai' && m.raw?.output) out.push(...cleanOutput(m.raw.output));
      else {
        const text = m.blocks.filter((b) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
        if (text) out.push({ role: 'assistant', content: text });
      }
    } else if (m.role === 'tool' && m.provider === 'openai' && m.raw?.items) {
      out.push(...m.raw.items);
    }
  }
  return trimInput(out);
}

export type StreamHandlers = {
  onText: (delta: string) => void;
  onThinking: (delta: string) => void;
  onTool: (name: string, input: any) => void;
};

export async function runTurn(opts: {
  key: string;
  agent: Agent;
  system: string;
  tools: ToolDef[];
  webSearch: boolean;
  useReasoning: boolean;
  signal: { aborted: boolean };
  handlers: StreamHandlers;
}): Promise<any> {
  const model = opts.agent.model || FALLBACK_MODELS[0];
  const tools: any[] = [];
  if (opts.webSearch) tools.push({ type: 'web_search' });
  for (const t of opts.tools) {
    tools.push({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: true });
  }

  const body: any = {
    model,
    instructions: opts.system,
    input: buildInput(opts.agent),
    max_output_tokens: 8000,
    store: false,
    stream: true,
  };
  if (tools.length) body.tools = tools;
  if (opts.useReasoning && isReasoning(model)) body.reasoning = { effort: 'medium', summary: 'auto' };

  let final: any = null;
  let sawText = false;

  await streamSSE({
    url: `${BASE}/responses`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.key}` },
    body,
    signal: opts.signal,
    onEvent: (ev: any) => {
      switch (ev.type) {
        case 'response.output_text.delta':
          sawText = true;
          opts.handlers.onText(ev.delta || '');
          break;
        case 'response.reasoning_summary_text.delta':
          opts.handlers.onThinking(ev.delta || '');
          break;
        case 'response.output_item.added':
          if (ev.item?.type === 'web_search_call') {
            opts.handlers.onTool('web_search', { query: ev.item.action?.query });
          }
          break;
        case 'response.output_item.done':
          if (ev.item?.type === 'function_call') {
            opts.handlers.onTool(ev.item.name, safeParse(ev.item.arguments));
          }
          break;
        case 'response.completed':
          final = ev.response;
          break;
        case 'response.failed':
        case 'response.incomplete':
          final = ev.response;
          break;
      }
    },
  });

  if (!final) throw new Error('The response ended without completing.');
  void sawText;
  return final;
}

export function toolCallsFrom(output: any[]) {
  return (output || [])
    .filter((i) => i.type === 'function_call')
    .map((i) => ({ callId: i.call_id, name: i.name, args: safeParse(i.arguments) }));
}

export const toolResultItems = (results: { callId: string; output: string }[]) =>
  results.map((r) => ({ type: 'function_call_output', call_id: r.callId, output: r.output }));

export function assistantMessage(output: any[]): Message {
  return { role: 'assistant', ts: Date.now(), provider: 'openai', blocks: blocksFrom(output), raw: { output } };
}
