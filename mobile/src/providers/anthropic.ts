import { getJSON, streamSSE } from '../net/stream';
import { Agent, Block, Message } from '../types';
import { ToolDef } from '../tools/defs';

const BASE = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';

export const FALLBACK_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];

const headers = (key: string) => ({
  'Content-Type': 'application/json',
  'x-api-key': key,
  'anthropic-version': VERSION,
  // Required for direct calls from a client app; keys live in the device keychain.
  'anthropic-dangerous-direct-browser-access': 'true',
});

export async function listModels(key: string) {
  const json = await getJSON(`${BASE}/models`, headers(key) as any);
  return (json.data || []).map((m: any) => ({ id: m.id, label: m.display_name || m.id }));
}

export function pickDefaultModel(ids: string[]) {
  const prefer = [/^claude-opus-5$/, /^claude-sonnet-5$/, /^claude-opus/, /^claude/];
  for (const re of prefer) {
    const hit = ids.find((id) => re.test(id));
    if (hit) return hit;
  }
  return ids[0] || FALLBACK_MODELS[0];
}

const isCurrentGen = (m: string) => /^claude-(opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|fable-5)/.test(m || '');

export function blocksFrom(content: any[]): Block[] {
  const blocks: Block[] = [];
  for (const b of content || []) {
    if (b.type === 'thinking' && b.thinking) blocks.push({ type: 'thinking', text: b.thinking });
    else if (b.type === 'text') {
      const citations = (b.citations || [])
        .filter((c: any) => c.url)
        .map((c: any) => ({ url: c.url, title: c.title || c.url }));
      blocks.push({ type: 'text', text: b.text, citations });
    } else if (b.type === 'server_tool_use' || b.type === 'tool_use') {
      blocks.push({ type: 'tool', name: b.name, input: b.input || {} });
    }
  }
  return blocks;
}


const HISTORY_BUDGET = 60000;
const KEEP_VERBATIM = 3;
const stub = (len: number) =>
  `[trimmed: ${len} characters of tool output from an earlier step — ask again if you need it]`;

/** Same budget trimming as the OpenAI side; see the note there. */
export function trimMessages(messages: any[]): any[] {
  const toolTurns = messages
    .map((m, i) => (Array.isArray(m.content) && m.content[0]?.type === 'tool_result' ? i : -1))
    .filter((i) => i >= 0);
  const cutoff = toolTurns.length > KEEP_VERBATIM ? toolTurns[toolTurns.length - KEEP_VERBATIM] : -1;
  let out = messages.map((m, i) => {
    if (i >= cutoff || !Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((b: any) =>
        b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > 400
          ? { ...b, content: stub(b.content.length) }
          : b
      ),
    };
  });
  while (JSON.stringify(out).length > HISTORY_BUDGET) {
    const next = out.findIndex((m, i) => i > 0 && m.role === 'user' && typeof m.content === 'string');
    if (next <= 0) break;
    out = out.slice(next);
  }
  return out;
}

export function buildMessages(agent: Agent) {
  const out: any[] = [];
  for (const m of agent.messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      if (m.provider === 'anthropic' && m.raw?.content) out.push({ role: 'assistant', content: m.raw.content });
      else {
        const text = m.blocks.filter((b) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
        if (text) out.push({ role: 'assistant', content: text });
      }
    } else if (m.role === 'tool' && m.provider === 'anthropic' && m.raw?.results) {
      out.push({ role: 'user', content: m.raw.results });
    }
  }
  return trimMessages(out);
}

export async function runTurn(opts: {
  key: string;
  agent: Agent;
  system: string;
  tools: ToolDef[];
  webSearch: boolean;
  signal: { aborted: boolean };
  handlers: { onText: (d: string) => void; onThinking: (d: string) => void; onTool: (n: string, i: any) => void };
}): Promise<any> {
  const model = opts.agent.model || FALLBACK_MODELS[0];
  const modern = isCurrentGen(model);

  const tools: any[] = [];
  if (opts.webSearch) {
    tools.push({ type: modern ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 8 });
    tools.push({ type: modern ? 'web_fetch_20260209' : 'web_fetch_20250910', name: 'web_fetch', max_uses: 8 });
  }
  for (const t of opts.tools) tools.push({ name: t.name, description: t.description, input_schema: t.parameters });

  const body: any = {
    model,
    max_tokens: 8000,
    system: opts.system,
    messages: buildMessages(opts.agent),
    stream: true,
  };
  if (modern) body.thinking = { type: 'adaptive', display: 'summarized' };
  if (tools.length) body.tools = tools;

  // Assembled from the stream, since there is no SDK helper here.
  const content: any[] = [];
  let stopReason: string | null = null;
  let partialJson = '';

  await streamSSE({
    url: `${BASE}/messages`,
    headers: headers(opts.key),
    body,
    signal: opts.signal,
    onEvent: (ev: any) => {
      if (ev.type === 'content_block_start') {
        const b = ev.content_block;
        content[ev.index] = { ...b };
        partialJson = '';
        if (b.type === 'server_tool_use' || b.type === 'tool_use') opts.handlers.onTool(b.name, b.input);
      } else if (ev.type === 'content_block_delta') {
        const block = content[ev.index] || (content[ev.index] = {});
        const d = ev.delta;
        if (d.type === 'text_delta') {
          block.text = (block.text || '') + d.text;
          opts.handlers.onText(d.text);
        } else if (d.type === 'thinking_delta') {
          block.thinking = (block.thinking || '') + d.thinking;
          opts.handlers.onThinking(d.thinking);
        } else if (d.type === 'signature_delta') {
          block.signature = d.signature;
        } else if (d.type === 'input_json_delta') {
          partialJson += d.partial_json;
        } else if (d.type === 'citations_delta' && d.citation) {
          block.citations = [...(block.citations || []), d.citation];
        }
      } else if (ev.type === 'content_block_stop') {
        const block = content[ev.index];
        if (block && partialJson) {
          try {
            block.input = JSON.parse(partialJson);
          } catch {}
          partialJson = '';
        }
      } else if (ev.type === 'message_delta') {
        stopReason = ev.delta?.stop_reason ?? stopReason;
      } else if (ev.type === 'error') {
        throw new Error(ev.error?.message || 'Anthropic stream error');
      }
    },
  });

  return { content: content.filter(Boolean), stop_reason: stopReason };
}

export function assistantMessage(content: any[]): Message {
  return { role: 'assistant', ts: Date.now(), provider: 'anthropic', blocks: blocksFrom(content), raw: { content } };
}

export const toolCallsFrom = (content: any[]) =>
  (content || [])
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ callId: b.id, name: b.name, args: b.input || {} }));

export const toolResultBlocks = (results: { callId: string; output: string; isError?: boolean }[]) =>
  results.map((r) => ({
    type: 'tool_result',
    tool_use_id: r.callId,
    content: r.output,
    ...(r.isError ? { is_error: true } : {}),
  }));
