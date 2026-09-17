/**
 * The agent loop: stream a turn, run whatever tools it asks for, feed the
 * results back, repeat until it stops asking. Provider-agnostic — the same
 * neutral transcript as the desktop app.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { browser } from './browserBridge';
import * as anthropic from './providers/anthropic';
import * as openai from './providers/openai';
import { addTask, cancelTask, taskLabel, tasksFor } from './scheduler';
import { store, newId } from './store';
import { clientTools, systemPrompt } from './tools/defs';
import { Agent, Message, Provider } from './types';

const SUBMITTY =
  /submit|send|pay|buy|order|checkout|confirm|delete|remove|sign ?up|sign ?in|log ?in|register|book|apply|subscribe|publish|post|continue|next|save/i;

const aborts = new Map<string, { aborted: boolean }>();
const queued = new Map<string, string[]>();

export function stopAgent(agentId: string) {
  const a = aborts.get(agentId);
  if (a) a.aborted = true;
}

export function friendlyError(err: any, provider: Provider) {
  const who = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
  const status = err?.status;
  const msg = String(err?.message || err);
  if (status === 401) return `${who} rejected the API key — ${msg}\n\nCheck it in Settings.`;
  if (status === 403) return `${who} says this key cannot use that model — ${msg}`;
  if (status === 404) return `Model not found on your account — ${msg}`;
  if (status === 429) return `Rate limited or out of quota — wait a moment and try again.`;
  if (status === 400) return `The API rejected the request: ${msg}`;
  if (status >= 500) return `${who} had a server error. Try again in a moment.`;
  return msg;
}

/** Bulky generated HTML never goes into the transcript — it is on disk already. */
function redactAppHtml(msg: Message) {
  if (msg.role !== 'assistant') return;
  const stub = (n: number) => `[${n} chars of HTML — already rendered in the app]`;
  for (const b of msg.blocks) {
    if (b.type === 'tool' && b.name === 'show_app' && typeof b.input?.html === 'string') {
      b.input = { ...b.input, html: stub(b.input.html.length) };
    }
  }
  for (const item of msg.raw?.output || []) {
    if (item.type === 'function_call' && item.name === 'show_app') {
      const args = openai.safeParse(item.arguments);
      if (typeof args.html === 'string') {
        args.html = stub(args.html.length);
        item.arguments = JSON.stringify(args);
      }
    }
  }
  for (const block of msg.raw?.content || []) {
    if (block.type === 'tool_use' && block.name === 'show_app' && typeof block.input?.html === 'string') {
      block.input = { ...block.input, html: stub(block.input.html.length) };
    }
  }
}

function askUser(agentId: string, title: string, detail: string): Promise<boolean> {
  return new Promise((resolve) => {
    store.set(
      { confirm: { id: newId(), agentId, title, detail, resolve } },
      false
    );
  });
}

export function resolveConfirm(ok: boolean) {
  const c = store.state.confirm;
  if (!c) return;
  store.set({ confirm: null }, false);
  c.resolve(ok);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

async function runBrowserTool(agent: Agent, name: string, input: any): Promise<string> {
  setStatus(agent.id, browserStatus(name, input));

  if (name === 'browser_open') {
    const info = await browser.open(String(input.url || ''));
    return `Opened ${info.url}\nTitle: ${info.title}`;
  }
  if (name === 'browser_read') {
    const text = await browser.evaluate('window.__slava.readText()');
    return `URL: ${browser.url}\nTitle: ${browser.title}\n\n${text || '(no readable text)'}`;
  }
  if (name === 'browser_links') {
    const links = await browser.evaluate(`window.__slava.links(${JSON.stringify(String(input.query || ''))})`);
    if (!links?.length) return 'No matching links found on this page.';
    return links.map((l: any) => `- ${l.text} → ${l.href}`).join('\n');
  }
  if (name === 'browser_images') {
    const q = JSON.stringify(String(input.query || '').toLowerCase());
    const images = await browser.evaluate(
      `(() => { const q = ${q}; const seen = new Set();
                return [...document.images]
                  .map(i => ({ src: i.currentSrc || i.src, alt: (i.alt || '').trim().slice(0, 120),
                               w: Math.round(i.naturalWidth || i.width), h: Math.round(i.naturalHeight || i.height) }))
                  .filter(i => /^https?:/.test(i.src) && i.w >= 80 && i.h >= 80)
                  .filter(i => !seen.has(i.src) && seen.add(i.src))
                  .filter(i => !q || (i.alt + ' ' + i.src).toLowerCase().includes(q))
                  .sort((a, b) => b.w * b.h - a.w * a.h)
                  .slice(0, 25); })()`
    );
    if (!images?.length) return 'No images of a usable size found on this page.';
    return (
      `Images on ${browser.url} (largest first):\n` +
      images.map((i: any) => `- ${i.w}x${i.h} "${i.alt || 'no alt text'}" → ${i.src}`).join('\n') +
      '\n\nShow one to the user with markdown: ![description](url)'
    );
  }

  if (name === 'browser_fields') {
    const rows = await browser.evaluate('window.__slava.tag()');
    if (!rows?.length) return 'No interactive elements found on this page.';
    const lines = rows.map((f: any) => {
      let s = `#${f.i} ${f.kind}${f.required ? ' (required)' : ''} "${f.label || '—'}"`;
      if (f.options) s += ` options=[${f.options.join(' | ')}] selected="${f.value}"`;
      else if (f.checked !== undefined) s += ` checked=${f.checked}`;
      else if (f.value) s += ` value="${f.value}"`;
      else if (f.href) s += ` → ${f.href}`;
      return s;
    });
    return `Page: ${browser.title} (${browser.url})\n${rows.length} elements:\n${lines.join('\n')}`;
  }
  if (name === 'browser_fill') {
    const res = await browser.evaluate(
      `window.__slava.fill(${Number(input.field)}, ${JSON.stringify(String(input.value ?? ''))})`
    );
    if (!res?.ok) throw new Error(res?.error || 'Could not fill that field.');
    return `Filled "${res.label}"${res.value !== undefined ? ` with "${res.value}"` : ''}${
      res.checked !== undefined ? ` → checked=${res.checked}` : ''
    }.`;
  }
  if (name === 'browser_select') {
    const res = await browser.evaluate(
      `window.__slava.select(${Number(input.field)}, ${JSON.stringify(String(input.option ?? ''))})`
    );
    if (!res?.ok) throw new Error(res?.error || 'Could not choose that option.');
    return `Chose "${res.chosen}" in "${res.label}".`;
  }
  if (name === 'browser_click') {
    const info = await browser.evaluate(`window.__slava.describe(${Number(input.field)})`);
    if (!info) throw new Error(`No element numbered ${input.field}. Call browser_fields again.`);
    const consequential = info.submitish || SUBMITTY.test(`${info.label} ${info.text}`);
    if (consequential && agent.tools.confirm) {
      const ok = await askUser(
        agent.id,
        `Click “${info.label || info.text || 'this button'}”?`,
        `on ${hostOf(browser.url)} — this looks like it submits something.`
      );
      if (!ok) return 'The user declined that click. Do not retry it; ask them what to do instead.';
    }
    const before = browser.url;
    const res = await browser.evaluate(`window.__slava.click(${Number(input.field)})`);
    if (!res?.ok) throw new Error(res?.error || 'Could not click that element.');
    await new Promise((r) => setTimeout(r, 1500));
    const after = await browser.evaluate('({ url: location.href, title: document.title })').catch(() => null);
    if (after) browser.noteNavigation(after.url, after.title);
    return `Clicked "${res.label}".${
      after && after.url !== before ? ` The page is now ${after.url}` : ' The URL did not change.'
    }`;
  }
  if (name === 'browser_press') {
    const key = String(input.key || 'Enter');
    if (key === 'Enter' && agent.tools.confirm) {
      const inForm = await browser.evaluate('window.__slava.inForm()').catch(() => false);
      if (inForm) {
        const ok = await askUser(agent.id, 'Press Enter to submit this form?', `on ${hostOf(browser.url)}`);
        if (!ok) return 'The user declined that submission. Do not retry it; ask them what to do instead.';
      }
    }
    const res = await browser.evaluate(`window.__slava.press(${JSON.stringify(key)})`);
    await new Promise((r) => setTimeout(r, key === 'Enter' ? 1500 : 200));
    return `Pressed ${key}.${res?.submitted ? ' The form was submitted.' : ''}`;
  }
  throw new Error(`Unknown tool: ${name}`);
}

function hostOf(url: string) {
  const m = /^https?:\/\/([^/]+)/i.exec(url || '');
  return m ? m[1].replace(/^www\./, '') : url || 'this page';
}

function browserStatus(name: string, input: any) {
  switch (name) {
    case 'browser_open':
      return `Opening ${hostOf(input?.url)}`;
    case 'browser_read':
      return 'Reading the page';
    case 'browser_links':
      return 'Scanning links';
    case 'browser_images':
      return 'Looking for images';
    case 'browser_fields':
      return 'Inspecting the form';
    case 'browser_fill':
      return 'Filling in a field';
    case 'browser_select':
      return 'Choosing an option';
    case 'browser_click':
      return 'Clicking';
    case 'browser_press':
      return 'Submitting';
    default:
      return 'Working';
  }
}

async function runAppTool(agent: Agent, input: any): Promise<string> {
  const title = String(input.title || 'App').slice(0, 80);
  const html = String(input.html || '');
  if (!/</.test(html)) throw new Error('The html parameter must contain a complete HTML document.');

  const existing = store.state.apps.find((a) => a.agentId === agent.id && a.title === title);
  const id = existing?.id || newId();
  await AsyncStorage.setItem(`slava.app.${id}`, html);
  if (!existing) {
    store.set({ apps: [...store.state.apps, { id, agentId: agent.id, title, createdAt: Date.now() }] });
  }
  return (
    `${existing ? 'Updated' : 'Built'} the app "${title}" (${(html.length / 1024).toFixed(1)} KB). ` +
    'A preview of it is now in the chat, and the user can tap it to open it full size. ' +
    'Describe in one line what they can do in it; do not repeat its contents.'
  );
}

async function runTaskTool(agent: Agent, name: string, input: any): Promise<string> {
  if (name === 'list_tasks') {
    const mine = tasksFor(agent.id);
    if (!mine.length) return 'No scheduled tasks for this chat.';
    return mine
      .map(
        (t) =>
          `- id ${t.id} · ${taskLabel(t)} · next: ${t.enabled && t.nextRun ? new Date(t.nextRun).toLocaleString() : 'paused'}\n  "${t.instruction}"`
      )
      .join('\n');
  }
  if (name === 'cancel_task') {
    const ok = await cancelTask(String(input.id));
    return ok ? `Cancelled task ${input.id}.` : `No task with id ${input.id}.`;
  }
  const instruction = String(input.instruction || '').trim();
  if (!instruction) throw new Error('instruction is required.');
  const task = await addTask({
    agentId: agent.id,
    instruction,
    kind: input.kind,
    time: input.time,
    date: input.date,
    weekday: input.weekday,
    everyMinutes: input.every_minutes,
    inMinutes: input.in_minutes,
  });
  return `Scheduled (id ${task.id}): ${taskLabel(task)}. First run ${new Date(task.nextRun!).toLocaleString()}. Tell the user that exact time.`;
}

async function execTool(agent: Agent, name: string, input: any): Promise<{ output: string; isError: boolean }> {
  addStep(agent.id, name, input);
  try {
    if (name === 'show_app') return { output: await runAppTool(agent, input), isError: false };
    if (name === 'schedule_task' || name === 'list_tasks' || name === 'cancel_task') {
      return { output: await runTaskTool(agent, name, input), isError: false };
    }
    return { output: await runBrowserTool(agent, name, input), isError: false };
  } catch (err: any) {
    return { output: `Error: ${err?.message || err}`, isError: true };
  }
}

// ---------------------------------------------------------------------------
// Live state helpers
// ---------------------------------------------------------------------------

function setStatus(agentId: string, status: string) {
  const live = store.state.live;
  if (live?.agentId === agentId) store.set({ live: { ...live, status } }, false);
}

function addStep(agentId: string, name: string, input: any) {
  const live = store.state.live;
  if (live?.agentId === agentId) {
    store.set({ live: { ...live, steps: [...live.steps, { name, input }] } }, false);
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export async function runAgent(agentId: string): Promise<void> {
  const agent = store.agent(agentId);
  if (!agent) return;

  const provider = agent.provider;
  const key = store.getKey(provider);
  if (!key) {
    store.pushMessage(agentId, {
      role: 'assistant',
      ts: Date.now(),
      provider,
      blocks: [
        {
          type: 'text',
          text: `⚠️ No ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key yet. Add one in Settings.`,
        },
      ],
      raw: null,
    });
    return;
  }

  const signal = { aborted: false };
  aborts.set(agentId, signal);
  store.setRunning(agentId, true);
  store.set(
    { live: { agentId, text: '', thinking: '', steps: [], status: 'Thinking', startedAt: Date.now() } },
    false
  );

  try {
    for (let turn = 0; turn < 16 && !signal.aborted; turn++) {
      const handlers = {
        onText: (d: string) => {
          const live = store.state.live;
          if (live?.agentId === agentId) store.set({ live: { ...live, text: live.text + d, status: 'Writing' } }, false);
        },
        onThinking: (d: string) => {
          const live = store.state.live;
          if (live?.agentId === agentId)
            store.set({ live: { ...live, thinking: live.thinking + d, status: 'Thinking' } }, false);
        },
        onTool: (name: string, input: any) => {
          addStep(agentId, name, input);
          if (name === 'web_search') setStatus(agentId, `Searching — “${input?.query || ''}”`);
        },
      };

      const tools = clientTools(agent);
      const system = systemPrompt(agent);

      if (provider === 'openai') {
        const final = await openai.runTurn({
          key,
          agent,
          system,
          tools,
          webSearch: agent.tools.web,
          useReasoning: true,
          signal,
          handlers,
        });
        if (signal.aborted) break;

        const output = openai.cleanOutput(final.output || []);
        const calls = openai.toolCallsFrom(output);
        const msg = openai.assistantMessage(output);
        redactAppHtml(msg);
        store.pushMessage(agentId, msg);
        resetLiveText(agentId);

        if (!calls.length) break;
        const results = [];
        for (const call of calls) {
          const r = await execTool(agent, call.name, call.args);
          results.push({ callId: call.callId, output: r.output });
        }
        store.pushMessage(agentId, {
          role: 'tool',
          ts: Date.now(),
          provider: 'openai',
          raw: { items: openai.toolResultItems(results) },
        });
      } else {
        const final = await anthropic.runTurn({
          key,
          agent,
          system,
          tools,
          webSearch: agent.tools.web,
          signal,
          handlers,
        });
        if (signal.aborted) break;

        const calls = anthropic.toolCallsFrom(final.content);
        const msg = anthropic.assistantMessage(final.content);
        redactAppHtml(msg);
        store.pushMessage(agentId, msg);
        resetLiveText(agentId);

        if (final.stop_reason === 'pause_turn') continue;
        if (!calls.length) break;

        const results = [];
        for (const call of calls) {
          const r = await execTool(agent, call.name, call.args);
          results.push({ callId: call.callId, output: r.output, isError: r.isError });
        }
        store.pushMessage(agentId, {
          role: 'tool',
          ts: Date.now(),
          provider: 'anthropic',
          raw: { results: anthropic.toolResultBlocks(results) },
        });
      }
    }
  } catch (err: any) {
    if (!signal.aborted) {
      store.pushMessage(agentId, {
        role: 'assistant',
        ts: Date.now(),
        provider,
        blocks: [{ type: 'text', text: `⚠️ ${friendlyError(err, provider)}` }],
        raw: null,
      });
    }
  } finally {
    aborts.delete(agentId);
    store.setRunning(agentId, false);
    store.set({ live: null }, false);

    const pending = queued.get(agentId);
    if (pending?.length) {
      queued.delete(agentId);
      await deliverUserMessage(agentId, pending.join('\n'));
    }
  }
}

function resetLiveText(agentId: string) {
  const live = store.state.live;
  if (live?.agentId === agentId) store.set({ live: { ...live, text: '', thinking: '' } }, false);
}

/** Sends a message as the user and runs the agent — used by the composer,
 *  scheduled tasks, and buttons inside generated apps. */
export async function deliverUserMessage(agentId: string, text: string, extra: { scheduled?: boolean } = {}) {
  const agent = store.agent(agentId);
  if (!agent || !text.trim()) return;

  if (store.isRunning(agentId)) {
    // Slotting a message between a tool call and its result would corrupt the
    // turn, so hold it until this one finishes.
    queued.set(agentId, [...(queued.get(agentId) || []), text]);
    return;
  }

  store.pushMessage(agentId, { role: 'user', ts: Date.now(), text, ...extra });
  await runAgent(agentId);
}
