'use strict';

const { app, BrowserWindow, ipcMain, shell, safeStorage, nativeTheme, Menu, Notification, session } = require('electron');
const path = require('path');
const fs = require('fs');

const AnthropicModule = require('@anthropic-ai/sdk');
const Anthropic = AnthropicModule.default || AnthropicModule;
const OpenAIModule = require('openai');
const OpenAI = OpenAIModule.default || OpenAIModule;


/* The app used to be called Slava. Electron derives the data folder from the
   product name, so without this the rename would look like a factory reset —
   agents, chats, scheduled tasks and the browser's logins all live in there.
   Moving the folder keeps every one of them; only the API key has to be typed
   again, because macOS keys its encryption to the old app name. */
try {
  const support = app.getPath('appData');
  const before = path.join(support, 'Slava');
  const after = path.join(support, 'Internall');
  if (fs.existsSync(before) && !fs.existsSync(after)) {
    fs.renameSync(before, after);
    console.log(`migrated data folder: ${before} -> ${after}`);
  }
} catch (err) {
  console.error('could not migrate the old data folder:', err.message);
}

// ---------------------------------------------------------------------------
// Persistent store  (~/Library/Application Support/Internall/slava-data.json)
//
// Messages are stored in a provider-neutral shape so an agent can be moved
// between OpenAI and Anthropic without losing its history:
//
//   { role: 'user',      ts, text }
//   { role: 'assistant', ts, provider, blocks: [...], raw }
//   { role: 'tool',      ts, provider, raw }
//
// `blocks` is what the UI renders — { type: 'text' | 'thinking' | 'tool' }.
// `raw` is the provider's own payload, replayed verbatim on the next request
// so reasoning items and tool calls stay valid; it is ignored by other
// providers, which fall back to the plain text of `blocks`.
// ---------------------------------------------------------------------------

let dataFile = null;
let store = { agents: [], activeId: null, keys: {}, theme: 'system', tasks: [] };

function loadStore() {
  dataFile = path.join(app.getPath('userData'), 'internall-data.json');
  const legacy = path.join(app.getPath('userData'), 'slava-data.json');
  if (!fs.existsSync(dataFile) && fs.existsSync(legacy)) fs.renameSync(legacy, dataFile);
  try {
    Object.assign(store, JSON.parse(fs.readFileSync(dataFile, 'utf8')));
    migrate();
  } catch {
    store.agents = [defaultAgent()];
    store.activeId = store.agents[0].id;
  }
  saveStore();
}

function migrate() {
  if (store.apiKey && !store.keys?.anthropic) {
    store.keys = Object.assign({ anthropic: store.apiKey }, store.keys);
  }
  delete store.apiKey;
  store.keys = store.keys || {};
  store.tasks = store.tasks || [];

  for (const a of store.agents) {
    if (!a.provider) a.provider = /^claude/.test(a.model || '') ? 'anthropic' : 'openai';
    // Agents from before generated pictures keep the emoji face they had.
    if (!a.avatar) a.avatar = { kind: 'emoji' };
    // Existing history counts as already read — don't light up on upgrade.
    if (a.lastReadTs === undefined) a.lastReadTs = a.messages?.length ? a.messages[a.messages.length - 1].ts : Date.now();
    // Pre-neutral-format messages stored raw Anthropic content — convert or drop.
    a.messages = (a.messages || []).flatMap((m) => {
      if (m.text !== undefined || m.blocks || m.role === 'tool') return [m];
      if (m.role === 'user') return typeof m.content === 'string' ? [{ role: 'user', ts: m.ts, text: m.content }] : [];
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        return [{ role: 'assistant', ts: m.ts, provider: 'anthropic', blocks: anthropicBlocks(m.content), raw: null }];
      }
      return [];
    });
  }
}

let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(dataFile, JSON.stringify(store, null, 2));
    } catch (err) {
      console.error('Failed to save store:', err);
    }
  }, 120);
}

function defaultAgent() {
  return {
    id: newId(),
    name: 'Research Assistant',
    description:
      'A meticulous research assistant. Searches the web for current information, ' +
      'reads the sources it finds, and answers with short, well-organised summaries. ' +
      'Always cites where a fact came from.',
    emoji: '🔎',
    color: '#5a8dee',
    avatar: { kind: 'art', seed: newId() },
    provider: 'openai',
    model: '',
    tools: { web: true, browser: true, confirm: true, apps: true, tasks: true },
    lastReadTs: Date.now(),
    createdAt: Date.now(),
    messages: [],
  };
}

const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const unreadCount = (agent) =>
  (agent.messages || []).filter((m) => m.role === 'assistant' && m.ts > (agent.lastReadTs || 0)).length;

function updateBadge() {
  const total = store.agents.reduce((n, a) => n + unreadCount(a), 0);
  if (app.dock) app.setBadgeCount(total);
}
const findAgent = (id) => store.agents.find((a) => a.id === id);

// ---------------------------------------------------------------------------
// API keys — encrypted at rest with the macOS Keychain when available
// ---------------------------------------------------------------------------

const ENV_KEYS = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
const clients = {};

function setKey(provider, plain) {
  if (!plain) delete store.keys[provider];
  else if (safeStorage.isEncryptionAvailable()) {
    store.keys[provider] = { enc: true, v: safeStorage.encryptString(plain).toString('base64') };
  } else {
    store.keys[provider] = { enc: false, v: plain };
  }
  delete clients[provider];
  delete modelCache[provider];
  saveStore();
}

const undecryptable = new Set();

function getKey(provider) {
  const fromEnv = process.env[ENV_KEYS[provider]];
  if (fromEnv) return fromEnv;
  const entry = store.keys[provider];
  if (!entry) return null;
  if (!entry.enc) return entry.v;
  try {
    const key = safeStorage.decryptString(Buffer.from(entry.v, 'base64'));
    undecryptable.delete(provider);
    return key;
  } catch {
    undecryptable.add(provider);
    return null;
  }
}

function getClient(provider) {
  const key = getKey(provider);
  if (!key) return null;
  if (!clients[provider]) {
    clients[provider] = provider === 'openai' ? new OpenAI({ apiKey: key }) : new Anthropic({ apiKey: key });
  }
  return clients[provider];
}

// ---------------------------------------------------------------------------
// Model catalogue — fetched live, with a static fallback
// ---------------------------------------------------------------------------

const FALLBACK_MODELS = {
  openai: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.1', 'gpt-4.1'],
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
};

const OPENAI_SKIP = /(embedding|tts|whisper|dall-e|moderation|audio|realtime|image|transcribe|instruct|davinci|babbage|omni-moderation)/;
const modelCache = {};

async function listModels(provider) {
  if (modelCache[provider]) return modelCache[provider];
  const client = getClient(provider);
  if (!client) return [];
  try {
    const out = [];
    if (provider === 'openai') {
      const page = await client.models.list();
      for await (const m of page) {
        if (/^(gpt-|o[1345]|chatgpt-|codex)/.test(m.id) && !OPENAI_SKIP.test(m.id)) {
          out.push({ id: m.id, label: m.id, created: m.created || 0 });
        }
      }
    } else {
      const page = await client.models.list();
      for await (const m of page) {
        out.push({ id: m.id, label: m.display_name || m.id, created: Date.parse(m.created_at || 0) / 1000 || 0 });
      }
    }
    out.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
    modelCache[provider] = out;
    return out;
  } catch (err) {
    console.error(`Could not list ${provider} models:`, err.message);
    return FALLBACK_MODELS[provider].map((id) => ({ id, label: id, created: 0 }));
  }
}

async function defaultModel(provider) {
  const models = await listModels(provider);
  const prefer = provider === 'openai' ? [/^gpt-5\.6/, /^gpt-5\.5/, /^gpt-5\.\d/, /^gpt-5$/, /^gpt-4\.1$/] : [/^claude-opus-5$/, /^claude-sonnet-5$/, /^claude-opus/, /^claude/];
  for (const re of prefer) {
    const hit = models.find((m) => re.test(m.id));
    if (hit) return hit.id;
  }
  return models[0]?.id || FALLBACK_MODELS[provider][0];
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

let win = null;
/** The browser panel's session. Must match the partition in index.html. */
const BROWSER_PARTITION = 'persist:slava-browser';
let browserContents = null; // the browser panel's webContents, controlled by agent tools

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 880,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 22 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.on('closed', () => (win = null));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;

  // Generated apps run in a <webview> too, so identify the browser panel by its
  // partition rather than by being the newest webview — otherwise opening a
  // mini-app points the browser tools at the app, and closing the app leaves
  // them pointed at destroyed contents.
  if (contents.session !== session.fromPartition(BROWSER_PARTITION)) {
    // A generated app: it gets no navigation of its own, links go to the real browser.
    contents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
    return;
  }

  browserContents = contents;
  contents.setWindowOpenHandler(({ url }) => {
    contents.loadURL(url);
    return { action: 'deny' };
  });
});

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// Built-in browser tools (client-side tools, shared by both providers)
// ---------------------------------------------------------------------------

const obj = (properties, required) => ({
  type: 'object',
  properties,
  required: required || Object.keys(properties),
  additionalProperties: false,
});

const BROWSER_TOOLS = [
  {
    name: 'browser_open',
    description:
      "Open a URL in the app's built-in browser panel, which pops open beside the chat so the " +
      'user watches everything you do. Returns the final URL and page title after loading.',
    parameters: obj({ url: { type: 'string', description: 'Absolute URL, including https://' } }),
  },
  {
    name: 'browser_read',
    description:
      'Read the visible text of the page currently open in the browser panel. Works on pages ' +
      'that need JavaScript or a logged-in session, which plain fetching cannot reach.',
    parameters: obj({}, []),
  },
  {
    name: 'browser_links',
    description: 'List links on the current page, optionally filtered by a case-insensitive substring.',
    parameters: obj({ query: { type: 'string', description: 'Substring to filter by; empty string for all' } }),
  },
  {
    name: 'browser_images',
    description:
      'List the images on the page currently open in the built-in browser, with their alt text, ' +
      'displayed size and absolute URL, largest first. Use it to find a real picture — a ' +
      "person's photo, a product shot, a chart — that you can then show the user by putting its " +
      'URL in your reply as markdown: ![short description](https://…). Optionally filter by a ' +
      'case-insensitive substring matched against the alt text and URL.',
    parameters: obj({
      query: { type: 'string', description: 'Substring to filter by (e.g. a person\'s name); empty for all' },
    }),
  },
  {
    name: 'browser_fields',
    description:
      'Inspect the interactive elements on the current page — text inputs, checkboxes, radios, ' +
      'dropdowns, buttons and links — with their labels and current values. Each one gets a ' +
      'number you pass to browser_fill, browser_click and browser_select. ALWAYS call this ' +
      'before filling or clicking, and again after the page changes, because the numbers are ' +
      'reassigned on every call.',
    parameters: obj({}, []),
  },
  {
    name: 'browser_fill',
    description:
      'Type a value into the field with this number (from browser_fields). Works with text, ' +
      'email, number, date, textarea and contenteditable fields. For a checkbox or radio, pass ' +
      '"true" or "false". Fires the same events a real keystroke does, so JavaScript forms ' +
      'react normally.',
    parameters: obj({
      field: { type: 'number', description: 'The field number from browser_fields' },
      value: { type: 'string', description: 'The text to enter' },
    }),
  },
  {
    name: 'browser_select',
    description: 'Choose an option in a dropdown by its visible text or value.',
    parameters: obj({
      field: { type: 'number', description: 'The dropdown number from browser_fields' },
      option: { type: 'string', description: 'Visible text (or value) of the option to choose' },
    }),
  },
  {
    name: 'browser_click',
    description:
      'Click the element with this number (from browser_fields) — a button, link, checkbox or ' +
      'radio. The user sees it highlighted before it is clicked. If the click would submit a ' +
      'form or looks consequential, the user is asked to approve it first.',
    parameters: obj({ field: { type: 'number', description: 'The element number from browser_fields' } }),
  },
  {
    name: 'browser_press',
    description:
      'Press a key in the focused field — usually "Enter" to submit a form, or "Tab" to move on. ' +
      'Enter inside a form is treated as a submission and may ask the user to approve it.',
    parameters: obj({ key: { type: 'string', description: '"Enter", "Tab", or "Escape"' } }),
  },
];

// ---------------------------------------------------------------------------
// Scheduled tasks — "every morning, check the news and tell me"
// ---------------------------------------------------------------------------

const TASK_TOOLS = [
  {
    name: 'schedule_task',
    description:
      'Remember a job and run it later, on your own, without the user asking again. Use this ' +
      'whenever the user says something should happen on a schedule or at a future time — ' +
      '"every morning", "each Monday", "in an hour", "on the 3rd". The task survives quitting ' +
      'the app and repeats until the user cancels it.\n' +
      'Write `instruction` as a complete instruction to your future self, including everything ' +
      "you need — the user's request will not be there to look at. Confirm the exact time back " +
      'to the user in your reply. If they were vague ("every morning"), pick a sensible time ' +
      'and say which one you picked so they can correct it.',
    parameters: obj({
      instruction: { type: 'string', description: 'What to do when it fires, written as an instruction to yourself' },
      kind: {
        type: 'string',
        enum: ['in', 'once', 'daily', 'weekdays', 'weekly', 'interval'],
        description:
          'in = once, N minutes from now (use this for "in 2 minutes", "in an hour" — never ' +
          'compute a clock time yourself); once = a single future clock time; weekdays = Mon–Fri; ' +
          'interval = repeating every N minutes',
      },
      time: { type: 'string', description: 'Local 24h time "HH:MM" for once/daily/weekdays/weekly; "" for interval' },
      date: { type: 'string', description: 'For kind=once: "YYYY-MM-DD"; "" otherwise (empty means today/tomorrow)' },
      weekday: { type: 'number', description: 'For kind=weekly: 0=Sunday … 6=Saturday; use -1 otherwise' },
      every_minutes: { type: 'number', description: 'For kind=interval: minutes between runs (minimum 5); 0 otherwise' },
      in_minutes: { type: 'number', description: 'For kind=in: how many minutes from now to run it (minimum 1); 0 otherwise' },
    }),
  },
  {
    name: 'list_tasks',
    description: 'List the scheduled tasks you already have for this chat, with their ids and next run times.',
    parameters: obj({}, []),
  },
  {
    name: 'cancel_task',
    description: 'Cancel a scheduled task by its id (from list_tasks). Use this when the user wants it stopped or changed.',
    parameters: obj({ id: { type: 'string', description: 'The task id' } }),
  },
];

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MISSED_GRACE_MS = 6 * 60 * 60 * 1000; // run a missed task if it's less than this late

function parseHM(time, fallback = '08:00') {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim()) || /^(\d{1,2}):(\d{2})$/.exec(fallback);
  return { h: Math.min(23, Number(m[1])), min: Math.min(59, Number(m[2])) };
}

const isOneShot = (kind) => kind === 'once' || kind === 'in';

function computeNext(task, from = Date.now()) {
  const { h, min } = parseHM(task.time);
  const base = new Date(from);

  if (task.kind === 'in') {
    return from + Math.max(1, Number(task.in_minutes) || 1) * 60000;
  }

  if (task.kind === 'interval') {
    return from + Math.max(5, Number(task.every_minutes) || 60) * 60000;
  }

  if (task.kind === 'once') {
    const d = task.date ? new Date(`${task.date}T00:00:00`) : new Date(base);
    d.setHours(h, min, 0, 0);
    if (!task.date && d.getTime() <= from) d.setDate(d.getDate() + 1); // no date given → next occurrence
    return d.getTime();
  }

  const d = new Date(base);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);

  if (task.kind === 'weekdays') {
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  } else if (task.kind === 'weekly') {
    const want = ((Number(task.weekday) % 7) + 7) % 7;
    while (d.getDay() !== want) d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

function taskLabel(task) {
  const t = task.time || '';
  if (task.kind === 'in') {
    const n = Math.max(1, Number(task.in_minutes) || 1);
    const at = task.nextRun ? new Date(task.nextRun).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
    return at ? `once at ${at} (${n} min after it was set)` : `once, in ${n} minutes`;
  }
  if (task.kind === 'interval') return `every ${Math.max(5, Number(task.every_minutes) || 60)} minutes`;
  if (task.kind === 'daily') return `every day at ${t}`;
  if (task.kind === 'weekdays') return `weekdays at ${t}`;
  if (task.kind === 'weekly') return `every ${WEEKDAY_NAMES[((Number(task.weekday) % 7) + 7) % 7]} at ${t}`;
  return task.date ? `once on ${task.date} at ${t}` : `once at ${t}`;
}

function agentTasks(agentId) {
  return (store.tasks || []).filter((t) => t.agentId === agentId);
}

function describeTask(t) {
  const next = t.enabled ? new Date(t.nextRun).toLocaleString() : 'paused';
  return `- id ${t.id} · ${taskLabel(t)} · next: ${next}\n  "${t.instruction}"`;
}

async function runTaskTool(agent, name, input) {
  store.tasks = store.tasks || [];

  if (name === 'list_tasks') {
    const mine = agentTasks(agent.id);
    if (!mine.length) return 'No scheduled tasks for this chat.';
    return `${mine.length} scheduled task(s):\n${mine.map(describeTask).join('\n')}`;
  }

  if (name === 'cancel_task') {
    const before = store.tasks.length;
    store.tasks = store.tasks.filter((t) => !(t.id === input.id && t.agentId === agent.id));
    saveStore();
    send('tasks:changed', { agentId: agent.id });
    return before === store.tasks.length ? `No task with id ${input.id}.` : `Cancelled task ${input.id}.`;
  }

  // schedule_task
  const instruction = String(input.instruction || '').trim();
  if (!instruction) throw new Error('instruction is required.');
  const task = {
    id: newId(),
    agentId: agent.id,
    instruction,
    kind: ['in', 'once', 'daily', 'weekdays', 'weekly', 'interval'].includes(input.kind) ? input.kind : 'daily',
    time: /^\d{1,2}:\d{2}$/.test(String(input.time || '')) ? String(input.time) : '08:00',
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || '')) ? String(input.date) : '',
    weekday: Number(input.weekday ?? -1),
    every_minutes: Number(input.every_minutes ?? 0),
    in_minutes: Number(input.in_minutes ?? 0),
    enabled: true,
    createdAt: Date.now(),
    lastRun: null,
  };
  task.nextRun = computeNext(task);
  store.tasks.push(task);
  saveStore();
  send('tasks:changed', { agentId: agent.id, created: { ...task, label: taskLabel(task) } });

  return `Scheduled (id ${task.id}): ${taskLabel(task)}. First run ${new Date(task.nextRun).toLocaleString()}. Tell the user the exact time you picked.`;
}

// The ticker. Checks often enough to be punctual, cheap enough to ignore.
let taskTimer = null;

function startScheduler() {
  clearInterval(taskTimer);
  catchUpMissed();
  taskTimer = setInterval(tickTasks, 10000);
  tickTasks();
}

function catchUpMissed() {
  const now = Date.now();
  for (const t of store.tasks || []) {
    if (!t.enabled || !t.nextRun) continue;
    if (t.nextRun > now) continue;
    // Recent miss (app was closed) → let it run now. Stale → skip to the next slot.
    const grace = t.kind === 'in' ? 30 * 60000 : MISSED_GRACE_MS;
    if (now - t.nextRun > grace || t.kind === 'interval') {
      t.nextRun = isOneShot(t.kind) ? null : computeNext(t, now);
      if (!t.nextRun) t.enabled = false;
    }
  }
  saveStore();
}

function tickTasks() {
  const now = Date.now();
  for (const t of store.tasks || []) {
    if (!t.enabled || !t.nextRun || t.nextRun > now) continue;
    const agent = findAgent(t.agentId);
    if (!agent) continue;
    if (running.has(agent.id)) continue; // busy — try again on the next tick

    const label = taskLabel(t); // capture before nextRun is cleared below
    t.lastRun = now;
    if (isOneShot(t.kind)) {
      t.enabled = false;
      t.nextRun = null;
    } else {
      t.nextRun = computeNext(t, now);
    }
    saveStore();
    send('tasks:changed', { agentId: agent.id });

    const text = `⏰ Scheduled task (${label}):\n${t.instruction}`;
    deliverUserMessage(agent, text, { scheduled: true })
      .then(() => notifyTaskDone(agent, t))
      .catch((err) => console.error('Scheduled run failed:', err));
  }
}

function notifyTaskDone(agent, task) {
  const last = agent.messages[agent.messages.length - 1];
  const body = last?.role === 'assistant' ? (last.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').slice(0, 180) : '';
  if (!body) return;
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: `${agent.name} · ${taskLabel(task)}`, body, silent: false });
  n.on('click', () => {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      store.activeId = agent.id;
      saveStore();
      send('agent:focus', { agentId: agent.id });
    }
  });
  n.show();
}

ipcMain.handle('usage:list', () =>
  store.agents
    .map((a) => ({ id: a.id, name: a.name, model: a.model, usage: a.usage || null, priced: Boolean(priceOf(a.model)) }))
    .filter((a) => a.usage)
    .sort((x, y) => (y.usage.cost || 0) - (x.usage.cost || 0))
);

ipcMain.handle('usage:reset', (_e, id) => {
  const a = findAgent(id);
  if (a) delete a.usage;
  else store.agents.forEach((x) => delete x.usage);
  saveStore();
  return true;
});

ipcMain.handle('tasks:list', () => (store.tasks || []).map((t) => ({ ...t, label: taskLabel(t) })));

ipcMain.handle('tasks:delete', (_e, id) => {
  store.tasks = (store.tasks || []).filter((t) => t.id !== id);
  saveStore();
  return true;
});

ipcMain.handle('tasks:toggle', (_e, id) => {
  const t = (store.tasks || []).find((x) => x.id === id);
  if (!t) return false;
  t.enabled = !t.enabled;
  if (t.enabled) t.nextRun = computeNext(t);
  saveStore();
  return true;
});

const APP_TOOL = {
  name: 'show_app',
  description:
    'Build a small interactive app. A picture of it appears in the chat, and the user taps that ' +
    'to open it full size. Use this instead of a long text list whenever the answer is a set of ' +
    'things the user will compare, filter, sort, browse or pick from — listings, search results, ' +
    'options, schedules, budgets, comparisons, dashboards — or whenever an interactive view beats ' +
    'prose. Build it from what you already found; do not invent data.\n\n' +
    'Write ONE complete self-contained HTML document in `html`.\n\n' +
    'Hard constraints:\n' +
    '- Inline all CSS and JavaScript in <style> and <script>. No external stylesheets, no CDN ' +
    'scripts, no frameworks — they will not load. Plain DOM code is expected and fine. Remote ' +
    '<img> URLs do work, and so do inline SVG and <canvas>.\n' +
    '- Give it a real background colour rather than leaving it transparent, and make it readable ' +
    'in both light and dark via prefers-color-scheme.\n' +
    '- The user can act on it: `window.internall.send("...")` sends a message back into the chat ' +
    '(e.g. an "Ask about this one" button sending "Tell me more about 123 Main St"), and ' +
    '`window.internall.close()` closes it.\n\n' +
    'Design it for the subject rather than to a template. A transit schedule, a wine list, a ' +
    'budget and a set of house listings should not come out looking like the same grey cards with ' +
    'the labels swapped — let the layout, palette, typography and controls follow what the data ' +
    'actually is. Reach for the form that fits: a table when values want comparing, a calendar or ' +
    'timeline when they are dated, a map-like or spatial arrangement when they are placed, charts ' +
    'drawn in inline SVG or canvas when shape matters more than digits, a stack of cards only when ' +
    'that genuinely suits. Interactivity should earn its place too — filters, sort, search, ' +
    'expandable detail, running totals, a comparison tray, keyboard shortcuts — whatever the user ' +
    'would actually reach for. Small touches of motion and craft are welcome. Aim for something ' +
    'that looks made for this one question.\n\n' +
    'Calling this again with the same `title` replaces that app instead of making a second one. ' +
    'Afterwards, tell the user in one short line what they can do in it — do not repeat the whole ' +
    'list in the chat.',
  parameters: obj({
    title: { type: 'string', description: 'Window title, e.g. "Pet-friendly rentals in Burnaby"' },
    html: { type: 'string', description: 'The complete self-contained HTML document' },
  }),
};

function appDir() {
  const dir = path.join(app.getPath('userData'), 'apps');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function runShowApp(agent, input) {
  const title = String(input.title || 'App').slice(0, 80);
  const html = String(input.html || '');
  if (!/</.test(html)) throw new Error('The html parameter must contain a complete HTML document.');

  const existing = store.apps?.find((a) => a.agentId === agent.id && a.title === title);
  const id = existing?.id || newId();
  const file = path.join(appDir(), `${id}.html`);
  fs.writeFileSync(file, html);

  const thumb = await renderThumbnail(file);
  store.apps = [
    ...(store.apps || []).filter((a) => a.id !== id),
    { id, agentId: agent.id, title, createdAt: Date.now() },
  ];
  saveStore();

  send('app:created', { agentId: agent.id, appId: id, title, thumb, updated: Boolean(existing) });

  return (
    `${existing ? 'Updated' : 'Built'} the app "${title}" (${(html.length / 1024).toFixed(1)} KB). ` +
    'A preview of it is now in the chat, and the user can tap it to open it full size. ' +
    'Describe in one line what they can do in it; do not repeat its contents.'
  );
}

/* Renders the app once, off screen, purely to get a picture for the chat card.
   The window is never shown and is torn down immediately — the app itself is
   opened inside the conversation, not in a window of its own. */
async function renderThumbnail(file) {
  let shot = null;
  const w = new BrowserWindow({
    width: 900,
    height: 620,
    show: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await w.loadFile(file);
    await new Promise((r) => setTimeout(r, 450)); // let fonts and layout settle
    const image = await w.webContents.capturePage();
    shot = image.resize({ width: 640 }).toDataURL();
  } catch (err) {
    console.error('thumbnail failed:', err.message);
  } finally {
    if (!w.isDestroyed()) w.destroy();
  }
  return shot;
}

/** Everything the renderer needs to show an app inline. */
function appInfo(appId) {
  const file = path.join(appDir(), `${appId}.html`);
  if (!fs.existsSync(file)) return null;
  const meta = (store.apps || []).find((a) => a.id === appId);
  return {
    appId,
    file,
    preload: path.join(__dirname, 'app-preload.js'),
    title: meta?.title || 'App',
    agentId: meta?.agentId || store.activeId,
  };
}

ipcMain.handle('app:info', (_e, appId) => appInfo(appId));

ipcMain.handle('app:thumb', async (_e, appId) => {
  const info = appInfo(appId);
  return info ? await renderThumbnail(info.file) : null;
});

/** A button inside a generated app sent a message back into the chat. */
ipcMain.handle('app:send', (_e, { agentId, text }) => {
  const agent = findAgent(agentId);
  if (!agent || !String(text || '').trim()) return false;
  if (running.has(agent.id)) {
    const q = pendingFromApps.get(agent.id) || [];
    q.push(text);
    pendingFromApps.set(agent.id, q);
    return { queued: true };
  }
  deliverUserMessage(agent, text);
  return { queued: false };
});

const pendingFromApps = new Map();

function deliverUserMessage(agent, text, extra = {}) {
  const msg = { role: 'user', ts: Date.now(), text, ...extra };
  agent.messages.push(msg);
  saveStore();
  send('chat:user-message', { agentId: agent.id, message: msg });
  return runAgent(agent.id);
}

// Injected into the page. Idempotent — re-running it on the same document is a no-op.
const PAGE_HELPERS = `
(() => {
  if (window.__slava) return;
  const S = (window.__slava = {});

  S.visible = (el) => {
    if (!el.getClientRects().length) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };

  S.label = (el) => {
    const byFor = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    const text =
      (el.labels && el.labels[0] && el.labels[0].innerText) ||
      (byFor && byFor.innerText) ||
      el.getAttribute('aria-label') ||
      el.placeholder ||
      (el.closest('label') && el.closest('label').innerText) ||
      el.title || el.name || el.id ||
      (el.tagName === 'BUTTON' || el.tagName === 'A' ? el.innerText : '') || '';
    return String(text).replace(/\\s+/g, ' ').trim().slice(0, 70);
  };

  S.kind = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'image') return 'button';
      return 'input:' + t;
    }
    if (el.isContentEditable) return 'editable';
    return 'button';
  };

  S.tag = () => {
    document.querySelectorAll('[data-slava-id]').forEach((e) => e.removeAttribute('data-slava-id'));
    const sel = 'input:not([type=hidden]), textarea, select, button, a[href], [role=button], [contenteditable=true]';
    const out = [];
    let n = 0;
    for (const el of document.querySelectorAll(sel)) {
      if (!S.visible(el) || el.disabled) continue;
      el.setAttribute('data-slava-id', String(++n));
      const kind = S.kind(el);
      const row = { i: n, kind, label: S.label(el) };
      if (kind === 'select') {
        row.options = [...el.options].map((o) => o.text.trim()).slice(0, 40);
        row.value = el.value;
      } else if (/checkbox|radio/.test(kind)) {
        row.checked = el.checked;
      } else if (kind === 'link') {
        row.href = el.href;
      } else if (el.value !== undefined && kind !== 'button') {
        row.value = /password/.test(kind) ? (el.value ? '•••' : '') : String(el.value).slice(0, 60);
      }
      if (el.required) row.required = true;
      out.push(row);
      if (n >= 120) break;
    }
    return out;
  };

  S.el = (id) => document.querySelector('[data-slava-id="' + Number(id) + '"]');

  S.flash = (el, text) => {
    try {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const r = el.getBoundingClientRect();
      const box = document.createElement('div');
      box.style.cssText =
        'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #d32f2f;' +
        'border-radius:6px;box-shadow:0 0 0 4px rgba(211,47,47,.25);transition:opacity .4s;' +
        'left:' + (r.left - 3) + 'px;top:' + (r.top - 3) + 'px;width:' + (r.width + 6) + 'px;height:' + (r.height + 6) + 'px;';
      const tip = document.createElement('div');
      tip.textContent = text;
      tip.style.cssText =
        'position:absolute;left:0;top:-24px;background:#d32f2f;color:#fff;font:600 11px/16px ' +
        '-apple-system,sans-serif;padding:2px 7px;border-radius:5px;white-space:nowrap;';
      box.appendChild(tip);
      document.documentElement.appendChild(box);
      setTimeout(() => { box.style.opacity = '0'; setTimeout(() => box.remove(), 400); }, 1100);
    } catch {}
  };

  S.setValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
  };

  S.fill = (id, value) => {
    const el = S.el(id);
    if (!el) return { ok: false, error: 'No element numbered ' + id + '. Call browser_fields again.' };
    const kind = S.kind(el);
    S.flash(el, 'typing…');
    el.focus();
    if (/checkbox|radio/.test(kind)) {
      const want = !/^(false|no|0|off|unchecked)$/i.test(String(value).trim());
      if (el.checked !== want) el.click();
      return { ok: true, kind, label: S.label(el), checked: el.checked };
    }
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
      return { ok: true, kind, label: S.label(el) };
    }
    S.setValue(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    S.setValue(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value.slice(-1) || 'a' }));
    return { ok: true, kind, label: S.label(el), value: /password/.test(kind) ? '•••' : el.value };
  };

  S.select = (id, option) => {
    const el = S.el(id);
    if (!el || el.tagName !== 'SELECT') return { ok: false, error: 'Element ' + id + ' is not a dropdown.' };
    const want = String(option).trim().toLowerCase();
    const hit =
      [...el.options].find((o) => o.text.trim().toLowerCase() === want) ||
      [...el.options].find((o) => o.value.toLowerCase() === want) ||
      [...el.options].find((o) => o.text.trim().toLowerCase().includes(want));
    if (!hit) return { ok: false, error: 'No such option. Available: ' + [...el.options].map((o) => o.text.trim()).join(' | ') };
    S.flash(el, 'choosing…');
    el.value = hit.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, label: S.label(el), chosen: hit.text.trim() };
  };

  S.describe = (id) => {
    const el = S.el(id);
    if (!el) return null;
    const inForm = Boolean(el.form || el.closest('form'));
    const type = (el.getAttribute('type') || '').toLowerCase();
    return {
      label: S.label(el),
      kind: S.kind(el),
      submitish: inForm && (type === 'submit' || el.tagName === 'BUTTON') && el.type !== 'button',
      text: (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 70),
    };
  };

  S.click = (id) => {
    const el = S.el(id);
    if (!el) return { ok: false, error: 'No element numbered ' + id + '. Call browser_fields again.' };
    const label = S.label(el) || (el.innerText || '').trim().slice(0, 60);
    S.flash(el, 'clicking…');
    el.focus && el.focus();
    el.click();
    return { ok: true, label };
  };

  S.press = (key) => {
    const el = document.activeElement || document.body;
    const opts = { bubbles: true, cancelable: true, key, code: key };
    S.flash(el, key);
    const down = el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    if (key === 'Enter' && down) {
      const form = el.form || (el.closest && el.closest('form'));
      if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return { ok: true, submitted: true }; }
    }
    return { ok: true, submitted: false };
  };

  S.inForm = () => {
    const el = document.activeElement;
    return Boolean(el && (el.form || (el.closest && el.closest('form'))));
  };
})();
`;

const SUBMITTY = /submit|send|pay|buy|order|checkout|confirm|delete|remove|sign ?up|sign ?in|log ?in|register|book|apply|subscribe|publish|post|continue|next|save/i;

const run = (wc, expr) => wc.executeJavaScript(PAGE_HELPERS + '\n' + expr, true);

/* The panel's webview attaches when the window finishes loading, so a tool
   fired early — a scheduled task waking the app, the first message after a
   launch — can arrive before it exists. Waiting beats failing. */
async function waitForBrowser(ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (browserContents && !browserContents.isDestroyed()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function runBrowserTool(name, input, ctx = {}) {
  if (!(await waitForBrowser())) throw new Error('The built-in browser is not open yet.');
  const wc = browserContents;
  const host = () => {
    try {
      return new URL(wc.getURL()).host;
    } catch {
      return wc.getURL();
    }
  };

  // Anything the agent does to the page pops the panel open and flags it as busy.
  send('browser:agent-action', { action: name, host: host() });

  if (name === 'browser_open') {
    let url = String(input.url || '').trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    send('browser:agent-navigate', { url });
    try {
      await wc.loadURL(url);
    } catch (err) {
      // Redirects and cancelled sub-loads surface as ERR_ABORTED; the page is usually fine.
      if (!String(err.message).includes('ERR_ABORTED')) throw err;
    }
    await new Promise((r) => setTimeout(r, 600)); // let client-side rendering settle
    return `Opened ${wc.getURL()}\nTitle: ${wc.getTitle()}`;
  }

  if (name === 'browser_read') {
    const text = await run(
      wc,
      `(() => { const el = document.querySelector('main, article') || document.body;
                return (el.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 8000); })()`
    );
    return `URL: ${wc.getURL()}\nTitle: ${wc.getTitle()}\n\n${text || '(no readable text)'}`;
  }

  if (name === 'browser_links') {
    const q = JSON.stringify(String(input.query || '').toLowerCase());
    const links = await run(
      wc,
      `(() => { const q = ${q};
                return [...document.querySelectorAll('a[href]')]
                  .map(a => ({ text: (a.innerText || '').trim().slice(0, 120), href: a.href }))
                  .filter(l => l.text && l.href.startsWith('http'))
                  .filter(l => !q || (l.text + ' ' + l.href).toLowerCase().includes(q))
                  .slice(0, 60); })()`
    );
    if (!links.length) return 'No matching links found on this page.';
    return links.map((l) => `- ${l.text} → ${l.href}`).join('\n');
  }

  if (name === 'browser_images') {
    const q = JSON.stringify(String(input.query || '').toLowerCase());
    const images = await run(
      wc,
      `(() => { const q = ${q};
                const seen = new Set();
                return [...document.images]
                  .map(i => ({
                    src: i.currentSrc || i.src,
                    alt: (i.alt || '').trim().slice(0, 120),
                    w: Math.round(i.naturalWidth || i.width),
                    h: Math.round(i.naturalHeight || i.height),
                  }))
                  .filter(i => /^https?:/.test(i.src) && i.w >= 80 && i.h >= 80)
                  .filter(i => !seen.has(i.src) && seen.add(i.src))
                  .filter(i => !q || (i.alt + ' ' + i.src).toLowerCase().includes(q))
                  .sort((a, b) => b.w * b.h - a.w * a.h)
                  .slice(0, 25); })()`
    );
    if (!images.length) return 'No images of a usable size found on this page.';
    return (
      `Images on ${wc.getURL()} (largest first):\n` +
      images.map((i) => `- ${i.w}x${i.h} "${i.alt || 'no alt text'}" → ${i.src}`).join('\n') +
      '\n\nShow one to the user with markdown: ![description](url)'
    );
  }

  if (name === 'browser_fields') {
    const rows = await run(wc, 'window.__slava.tag()');
    if (!rows.length) return 'No interactive elements found on this page.';
    const lines = rows.map((f) => {
      let s = `#${f.i} ${f.kind}${f.required ? ' (required)' : ''} "${f.label || '—'}"`;
      if (f.options) s += ` options=[${f.options.join(' | ')}] selected="${f.value}"`;
      else if (f.checked !== undefined) s += ` checked=${f.checked}`;
      else if (f.value) s += ` value="${f.value}"`;
      else if (f.href) s += ` → ${f.href}`;
      return s;
    });
    return `Page: ${wc.getTitle()} (${wc.getURL()})\n${rows.length} elements:\n${lines.join('\n')}`;
  }

  if (name === 'browser_fill') {
    const res = await run(wc, `window.__slava.fill(${Number(input.field)}, ${JSON.stringify(String(input.value ?? ''))})`);
    if (!res?.ok) throw new Error(res?.error || 'Could not fill that field.');
    send('browser:agent-action', { action: name, host: host(), detail: res.label });
    return `Filled "${res.label}"${res.value !== undefined ? ` with "${res.value}"` : ''}${
      res.checked !== undefined ? ` → checked=${res.checked}` : ''
    }.`;
  }

  if (name === 'browser_select') {
    const res = await run(wc, `window.__slava.select(${Number(input.field)}, ${JSON.stringify(String(input.option ?? ''))})`);
    if (!res?.ok) throw new Error(res?.error || 'Could not choose that option.');
    return `Chose "${res.chosen}" in "${res.label}".`;
  }

  if (name === 'browser_click') {
    const info = await run(wc, `window.__slava.describe(${Number(input.field)})`);
    if (!info) throw new Error(`No element numbered ${input.field}. Call browser_fields again.`);

    const consequential = info.submitish || SUBMITTY.test(`${info.label} ${info.text}`);
    if (consequential && ctx.confirm) {
      const ok = await ctx.confirm({
        title: `Click “${info.label || info.text || 'this button'}”?`,
        detail: `on ${host()} — this looks like it submits something.`,
      });
      if (!ok) return 'The user declined that click. Do not retry it; ask them what to do instead.';
    }

    const before = wc.getURL();
    const res = await run(wc, `window.__slava.click(${Number(input.field)})`);
    if (!res?.ok) throw new Error(res?.error || 'Could not click that element.');
    await new Promise((r) => setTimeout(r, 1200)); // let navigation / validation happen
    const after = wc.getURL();
    return `Clicked "${res.label}".${after !== before ? ` The page is now ${after}` : ' The URL did not change.'}`;
  }

  if (name === 'browser_press') {
    const key = String(input.key || 'Enter');
    if (key === 'Enter' && ctx.confirm && (await run(wc, 'window.__slava.inForm()'))) {
      const ok = await ctx.confirm({ title: 'Press Enter to submit this form?', detail: `on ${host()}` });
      if (!ok) return 'The user declined that submission. Do not retry it; ask them what to do instead.';
    }
    const before = wc.getURL();
    const res = await run(wc, `window.__slava.press(${JSON.stringify(key)})`);
    await new Promise((r) => setTimeout(r, key === 'Enter' ? 1200 : 200));
    const after = wc.getURL();
    return `Pressed ${key}.${res?.submitted ? ' The form was submitted.' : ''}${
      after !== before ? ` The page is now ${after}` : ''
    }`;
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ---------------------------------------------------------------------------
// Asking the user to approve a consequential click
// ---------------------------------------------------------------------------

const pendingConfirms = new Map();

function askUser(agentId, question) {
  return new Promise((resolve) => {
    const id = newId();
    pendingConfirms.set(id, resolve);
    send('confirm:request', { agentId, id, ...question });
    setTimeout(() => {
      if (pendingConfirms.delete(id)) resolve(false); // never answered — treat as declined
    }, 5 * 60 * 1000);
  });
}

ipcMain.handle('confirm:respond', (_e, { id, ok }) => {
  const resolve = pendingConfirms.get(id);
  if (resolve) {
    pendingConfirms.delete(id);
    resolve(Boolean(ok));
  }
  return true;
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/* The current time changes on every request. Anywhere near the front of the
   prompt it destroys prompt caching — cached input is 10x cheaper than fresh —
   so OpenAI gets a stable prompt plus a trailing clock item instead. */
function clockLine() {
  return (
    `Right now it is ${new Date().toLocaleString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })} ` +
    `in the user's timezone (${Intl.DateTimeFormat().resolvedOptions().timeZone}). ` +
    'That clock is only accurate as of the start of this turn.'
  );
}

function systemPrompt(agent, withClock = true) {
  const parts = [
    `You are "${agent.name}", an agent inside Internall, a desktop chat app.`,
    '',
    'Your role, as defined by the user:',
    agent.description || '(no description given — be a helpful, concise assistant)',
    '',
    'Stay in this role, and text like a friend would. One to three sentences is the ' +
      'normal length of a reply. No preamble, no restating the question, no summary at the ' +
      'end, no headings, and no bullet lists unless the user asks for a list. Say the answer ' +
      'first; add detail only if they ask for it. If something genuinely needs length — a ' +
      'comparison, a set of results — put it in an app with show_app instead of writing it out.',
  ];
  if (agent.tools?.web) {
    parts.push(
      '',
      'You can search the web. Do so whenever the answer depends on current or verifiable ' +
        'information, and say where a fact came from.'
    );
  }
  if (agent.tools?.browser) {
    parts.push(
      '',
      "You can drive a real browser that opens beside the chat, where the user watches you work. " +
        'Use it for pages that need JavaScript or a logged-in session, and to fill things in on ' +
        "the user's behalf.",
      '',
      'How to work a page:',
      '1. browser_open the URL.',
      '2. browser_fields to see the numbered inputs, dropdowns and buttons.',
      '3. browser_fill / browser_select for each field, using the numbers from step 2.',
      '4. browser_fields again to check what you entered, then browser_click the button (or ' +
        'browser_press Enter) to submit.',
      'The numbers change every time you call browser_fields, so re-read them after the page ' +
        'changes — never reuse an old number.',
      '',
      '',
      'You can show pictures in the chat. Any image URL you write as markdown — ' +
        '![short description](https://…) — is rendered inline, so when a photo genuinely helps ' +
        '(what someone looks like, a product, a chart, a place) find one with browser_images on a ' +
        'relevant page and include it. Use direct image URLs, never a link to a page. One or two ' +
        'pictures, not a wall of them.',
      '',
      'Rules while operating a page: never invent personal data — if a required field needs ' +
        'information the user has not given you (name, address, card, password), stop and ask ' +
        'them in the chat. Say what you are about to do before consequential clicks; the user ' +
        'may be asked to approve them, and if they decline, do not retry — ask what they want ' +
        'instead. Tell the user plainly what you filled in and what happened after submitting.'
    );
  }
  if (agent.tools?.apps !== false) {
    parts.push(
      '',
      'You can also build a small interactive app with show_app; a picture of it lands in the ' +
        'chat and the user taps it to open. Reach for it whenever the answer is a set of things ' +
        'to compare, filter or choose from — search results, listings, options, a schedule, a ' +
        'comparison — rather than writing a long list in the chat. Design each one around its ' +
        'subject rather than to a house style, and give it the shape the data actually wants. ' +
        'Put the detail in the app and keep the chat message to a sentence about what they can ' +
        'do with it.'
    );
  }
  if (agent.tools?.tasks !== false) {
    parts.push(
      '',
      'You can schedule work for later with schedule_task, and see or cancel it with list_tasks ' +
        'and cancel_task. When the user asks for something recurring or in the future — "every ' +
        'morning", "each Monday", "remind me tomorrow" — set it up rather than promising to ' +
        'remember. For anything relative ("in 2 minutes", "in an hour"), use kind="in" with ' +
        'in_minutes rather than working out a clock time. The tool tells you the exact moment it ' +
        'will run — repeat that back to the user instead of paraphrasing what they asked for. ' +
        'When a scheduled task fires you will receive it as a message starting with ⏰; just do ' +
        'the job and report the result plainly, as if you had been asked right then.'
    );
  }
  if (withClock) parts.push('', clockLine());
  return parts.join('\n');
}

const textOf = (msg) =>
  (msg.blocks || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

// ---------------------------------------------------------------------------
// Provider: Anthropic
// ---------------------------------------------------------------------------

function isCurrentGenClaude(model) {
  return /^claude-(opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|fable-5|mythos-5)/.test(model || '');
}

function anthropicBlocks(content) {
  const blocks = [];
  for (const b of content) {
    if (b.type === 'thinking' && b.thinking) blocks.push({ type: 'thinking', text: b.thinking });
    else if (b.type === 'text') {
      const citations = (b.citations || []).filter((c) => c.url).map((c) => ({ url: c.url, title: c.title || c.url }));
      blocks.push({ type: 'text', text: b.text, citations });
    } else if (b.type === 'server_tool_use' || b.type === 'tool_use') {
      blocks.push({ type: 'tool', name: b.name, input: b.input || {} });
    }
  }
  return blocks;
}

function anthropicInput(agent) {
  const out = [];
  for (const m of agent.messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      if (m.provider === 'anthropic' && m.raw?.content) out.push({ role: 'assistant', content: m.raw.content });
      else if (textOf(m)) out.push({ role: 'assistant', content: textOf(m) });
    } else if (m.role === 'tool' && m.provider === 'anthropic' && m.raw?.results) {
      out.push({ role: 'user', content: m.raw.results });
    }
  }
  return trimAnthropicMessages(closeAnthropicPairs(out));
}

async function runAnthropic(agent, state) {
  const client = getClient('anthropic');
  const model = agent.model || (await defaultModel('anthropic'));
  const modern = isCurrentGenClaude(model);

  const tools = [];
  if (agent.tools?.web) {
    tools.push({ type: modern ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 8 });
    tools.push({ type: modern ? 'web_fetch_20260209' : 'web_fetch_20250910', name: 'web_fetch', max_uses: 8 });
  }
  if (agent.tools?.browser) {
    tools.push(...BROWSER_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })));
  }
  if (agent.tools?.apps !== false) {
    tools.push({ name: APP_TOOL.name, description: APP_TOOL.description, input_schema: APP_TOOL.parameters });
  }
  if (agent.tools?.tasks !== false) {
    tools.push(...TASK_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })));
  }

  for (let turn = 0; turn < 24 && !state.cancelled; turn++) {
    const stream = client.messages.stream({
      model,
      max_tokens: 32000,
      system: systemPrompt(agent),
      messages: anthropicInput(agent),
      ...(modern ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
      ...(tools.length ? { tools } : {}),
    });
    state.stream = stream;

    for await (const event of stream) {
      if (state.cancelled) {
        stream.abort();
        break;
      }
      if (event.type === 'content_block_start') {
        const b = event.content_block;
        if (b.type === 'thinking') emitBlock(agent.id, 'thinking');
        if (b.type === 'text') emitBlock(agent.id, 'text');
        if (b.type === 'server_tool_use' || b.type === 'tool_use') emitTool(agent.id, b.name, b.input);
      } else if (event.type === 'content_block_delta') {
        const d = event.delta;
        if (d.type === 'text_delta') emitDelta(agent.id, 'text', d.text);
        if (d.type === 'thinking_delta') emitDelta(agent.id, 'thinking', d.thinking);
      }
    }
    if (state.cancelled) break;

    const final = await stream.finalMessage();
    recordUsage(agent, {
      in: final.usage?.input_tokens || 0,
      cached: final.usage?.cache_read_input_tokens || 0,
      out: final.usage?.output_tokens || 0,
    });
    // Same as the OpenAI path: a turn cut off at the ceiling is unusable, so
    // discard it rather than committing half a generated app.
    if (final.stop_reason === 'max_tokens') {
      throw new Error(
        'The reply was cut off at the length limit. Ask for something smaller, or ask again in parts.'
      );
    }

    // Copy the call inputs before storing: pushAssistant redacts bulky tool
    // arguments (generated app HTML) out of the transcript in place.
    const calls = final.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: structuredClone(b.input || {}) }));

    pushAssistant(agent, 'anthropic', anthropicBlocks(final.content), { content: final.content });

    if (final.stop_reason === 'pause_turn') continue; // server tool hit its per-turn cap
    if (!calls.length) break;

    const results = [];
    for (const call of calls) {
      const { output, isError } = await execTool(agent, call.name, call.input);
      results.push({ type: 'tool_result', tool_use_id: call.id, content: output, ...(isError ? { is_error: true } : {}) });
    }
    pushTool(agent, 'anthropic', { results });
  }
}

// ---------------------------------------------------------------------------
// Provider: OpenAI (Responses API)
// ---------------------------------------------------------------------------

const isReasoningModel = (m) => /^(gpt-5|o[1345])/.test(m || '') && !/chat-latest/.test(m || '');

function openaiBlocks(output) {
  const blocks = [];
  for (const item of output || []) {
    if (item.type === 'reasoning') {
      const text = (item.summary || []).map((s) => s.text).join('\n').trim();
      if (text) blocks.push({ type: 'thinking', text });
    } else if (item.type === 'message') {
      for (const c of item.content || []) {
        if (c.type !== 'output_text') continue;
        const citations = (c.annotations || [])
          .filter((a) => a.type === 'url_citation' && a.url)
          .map((a) => ({ url: a.url, title: a.title || a.url }));
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

function safeParse(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

/* The SDK's stream helper decorates the response it hands back — `parsed_arguments`
   on function_call items, `parsed` on output_text parts. Those are client-side
   only: replaying them verbatim makes the API reject the next request with
   "Unknown parameter: input[N].parsed_arguments". Strip them before they are
   stored or re-sent. */
function cleanOutput(output) {
  return (output || []).map((item) => {
    const { parsed_arguments, ...rest } = item;
    if (Array.isArray(rest.content)) {
      rest.content = rest.content.map(({ parsed, ...part }) => part);
    }
    return rest;
  });
}


/* Every turn resends the whole conversation, so a long chat with browser output
   in it can exceed a per-minute token budget on its own. Two cheap measures:
   stale tool output is replaced with a stub (it mattered on the turn it was
   fetched, not forever), and the oldest complete rounds are dropped once the
   request gets too big. Rounds are cut at user messages so a tool call is never
   separated from its result. */
/* A cap, not a spend: you are only billed for what the model actually writes.
   It has to be roomy enough for a whole generated app plus the reply, or the
   HTML gets cut off mid-tag and the app arrives broken. */
const OUTPUT_BUDGET = 24000;
const RETRY_BUDGET = 32000; // one retry with more room when a turn is cut short

const HISTORY_BUDGET = 60000; // characters of serialised input, ≈ 15k tokens
const KEEP_VERBATIM = 3; // most recent tool results left untouched

function stub(len) {
  return `[trimmed: ${len} characters of tool output from an earlier step — ask again if you need it]`;
}

function trimRounds(items, isRoundStart) {
  let out = items;
  while (JSON.stringify(out).length > HISTORY_BUDGET) {
    const next = out.findIndex((it, i) => i > 0 && isRoundStart(it));
    if (next <= 0) break; // one round left; nothing safe to drop
    out = out.slice(next);
  }
  return out;
}

/* Both APIs reject a tool call that has no matching result, and a result that
   has no matching call. Normally the loop pairs them itself and a Stop closes
   whatever was open, but a quit, a crash or an abandoned confirmation can leave
   a call stranded — and once that is in the saved transcript, every later
   message in the chat is rejected. Repairing on the way out heals conversations
   that are already in that state instead of only preventing new ones. */
const ABANDONED = 'The app closed before this step finished, so it produced no result.';

function closeOpenAIPairs(items) {
  const answered = new Set(
    items.filter((it) => it.type === 'function_call_output').map((it) => it.call_id)
  );
  const called = new Set(items.filter((it) => it.type === 'function_call').map((it) => it.call_id));

  const out = [];
  for (const it of items) {
    if (it.type === 'function_call_output' && !called.has(it.call_id)) continue; // orphan result
    out.push(it);
    if (it.type === 'function_call' && !answered.has(it.call_id)) {
      out.push({ type: 'function_call_output', call_id: it.call_id, output: ABANDONED });
    }
  }
  return out;
}

function closeAnthropicPairs(messages) {
  const answered = new Set();
  const called = new Set();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') called.add(b.id);
      if (b.type === 'tool_result') answered.add(b.tool_use_id);
    }
  }

  const out = [];
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      const kept = m.content.filter((b) => b.type !== 'tool_result' || called.has(b.tool_use_id));
      if (!kept.length) continue; // the whole turn was orphan results
      out.push({ ...m, content: kept });

      const missing = kept.filter((b) => b.type === 'tool_use' && !answered.has(b.id));
      if (missing.length) {
        out.push({
          role: 'user',
          content: missing.map((b) => ({
            type: 'tool_result',
            tool_use_id: b.id,
            content: ABANDONED,
            is_error: true,
          })),
        });
      }
    } else {
      out.push(m);
    }
  }
  return out;
}

function trimOpenAIInput(items) {
  const outputs = items.map((it, i) => (it.type === 'function_call_output' ? i : -1)).filter((i) => i >= 0);
  const cutoff = outputs.length > KEEP_VERBATIM ? outputs[outputs.length - KEEP_VERBATIM] : -1;
  const shrunk = items.map((it, i) =>
    it.type === 'function_call_output' && i < cutoff && typeof it.output === 'string' && it.output.length > 400
      ? { ...it, output: stub(it.output.length) }
      : it
  );
  return trimRounds(shrunk, (it) => it.role === 'user' && typeof it.content === 'string');
}

function trimAnthropicMessages(messages) {
  const toolTurns = messages.map((m, i) => (Array.isArray(m.content) && m.content[0]?.type === 'tool_result' ? i : -1)).filter((i) => i >= 0);
  const cutoff = toolTurns.length > KEEP_VERBATIM ? toolTurns[toolTurns.length - KEEP_VERBATIM] : -1;
  const shrunk = messages.map((m, i) => {
    if (i >= cutoff || !Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((b) =>
        b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > 400
          ? { ...b, content: stub(b.content.length) }
          : b
      ),
    };
  });
  return trimRounds(shrunk, (m) => m.role === 'user' && typeof m.content === 'string');
}

function openaiInput(agent) {
  const out = [];
  for (const m of agent.messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      // Cleaned again on the way out so conversations saved before this fix still work.
      if (m.provider === 'openai' && m.raw?.output) out.push(...cleanOutput(m.raw.output));
      else if (textOf(m)) out.push({ role: 'assistant', content: textOf(m) });
    } else if (m.role === 'tool' && m.provider === 'openai' && m.raw?.items) {
      out.push(...m.raw.items);
    }
  }
  return trimOpenAIInput(closeOpenAIPairs(out));
}

async function runOpenAI(agent, state) {
  const client = getClient('openai');
  const model = agent.model || (await defaultModel('openai'));

  const tools = [];
  if (agent.tools?.web) tools.push({ type: 'web_search' });
  const fnTools = [
    ...(agent.tools?.browser ? BROWSER_TOOLS : []),
    ...(agent.tools?.apps !== false ? [APP_TOOL] : []),
    ...(agent.tools?.tasks !== false ? TASK_TOOLS : []),
  ];
  tools.push(
    ...fnTools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: true,
    }))
  );

  let useReasoning = isReasoningModel(model);
  let budget = OUTPUT_BUDGET;

  for (let turn = 0; turn < 24 && !state.cancelled; turn++) {
    const params = {
      model,
      instructions: systemPrompt(agent, false),
      input: [...openaiInput(agent), { role: 'system', content: clockLine() }],
      max_output_tokens: budget,
      store: false,
      ...(tools.length ? { tools } : {}),
      ...(useReasoning ? { reasoning: { effort: 'medium', summary: 'auto' } } : {}),
    };

    let stream;
    let attempt = 0;
    for (;;) {
      try {
        stream = client.responses.stream(params);
        state.stream = stream;
        await streamOpenAI(agent, stream, state);
        break;
      } catch (err) {
        // Some models reject reasoning summaries — drop them once and retry.
        if (useReasoning && err?.status === 400 && /reasoning|summary/i.test(err.message || '')) {
          useReasoning = false;
          delete params.reasoning;
          continue;
        }
        // A dropped or out-of-order SSE chunk makes the SDK's accumulator throw
        // ("missing output at index N"). Nothing has been written to the
        // transcript yet, so the safe fix is simply to run the turn again.
        if (err?.status === 429 && attempt < 6 && !state.cancelled) {
          attempt++;
          const wait = retryAfterMs(err);
          send('stream:reset', { agentId: agent.id });
          send('stream:status', { agentId: agent.id, status: `Rate limited — retrying in ${Math.ceil(wait / 1000)}s` });
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        if (isTransientStream(err) && attempt < 2 && !state.cancelled) {
          attempt++;
          send('stream:reset', { agentId: agent.id });
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }
        throw err;
      }
    }
    if (state.cancelled) break;

    const final = await stream.finalResponse();
    recordUsage(agent, {
      in: final.usage?.input_tokens || 0,
      cached: final.usage?.input_tokens_details?.cached_tokens || 0,
      out: final.usage?.output_tokens || 0,
    });
    /* Cut off at the token ceiling. Anything half-written is unusable — a
       generated app ends mid-tag — so nothing is committed to the transcript;
       the turn is simply rerun with more room. */
    if (final.status === 'incomplete' && final.incomplete_details?.reason === 'max_output_tokens') {
      if (budget < RETRY_BUDGET && !state.cancelled) {
        budget = RETRY_BUDGET;
        send('stream:reset', { agentId: agent.id });
        send('stream:status', { agentId: agent.id, status: 'That ran long — giving it more room' });
        continue;
      }
      throw new Error(
        'The reply was cut off at the length limit. Ask for something smaller, or ask again in parts.'
      );
    }

    const output = cleanOutput(final.output);
    // Parse the arguments before storing: pushAssistant redacts bulky tool
    // arguments (generated app HTML) out of the transcript in place.
    const calls = output
      .filter((i) => i.type === 'function_call')
      .map((i) => ({ call_id: i.call_id, name: i.name, args: safeParse(i.arguments) }));

    pushAssistant(agent, 'openai', openaiBlocks(output), { output });
    if (!calls.length) break;

    const items = [];
    for (const call of calls) {
      const res = await execTool(agent, call.name, call.args);
      items.push({ type: 'function_call_output', call_id: call.call_id, output: res.output });
    }
    pushTool(agent, 'openai', { items });
  }
}

async function streamOpenAI(agent, stream, state) {
  let inText = false;
  let inThinking = false;

  for await (const ev of stream) {
    if (state.cancelled) {
      stream.abort();
      return;
    }
    switch (ev.type) {
      case 'response.output_text.delta':
        if (!inText) {
          emitBlock(agent.id, 'text');
          inText = true;
          inThinking = false;
        }
        emitDelta(agent.id, 'text', ev.delta);
        break;
      case 'response.reasoning_summary_text.delta':
        if (!inThinking) {
          emitBlock(agent.id, 'thinking');
          inThinking = true;
          inText = false;
        }
        emitDelta(agent.id, 'thinking', ev.delta);
        break;
      case 'response.output_item.added':
        if (ev.item?.type === 'web_search_call') emitTool(agent.id, 'web_search', { query: ev.item.action?.query });
        inText = inThinking = false;
        break;
      case 'response.output_item.done':
        if (ev.item?.type === 'function_call') emitTool(agent.id, ev.item.name, safeParse(ev.item.arguments));
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Shared agent loop plumbing
// ---------------------------------------------------------------------------

const running = new Map(); // agentId -> { cancelled, stream }

const emitBlock = (agentId, kind) => send('stream:block', { agentId, kind });
const emitDelta = (agentId, kind, text) => send('stream:delta', { agentId, kind, text });
const emitTool = (agentId, name, input) => send('stream:tool', { agentId, name, input });

function pushAssistant(agent, provider, blocks, raw) {
  const msg = { role: 'assistant', ts: Date.now(), provider, blocks, raw };
  redactAppHtml(msg);
  agent.messages.push(msg);
  saveStore();
  updateBadge();
  send('stream:message', { agentId: agent.id, message: msg });
}

/* A generated app can be tens of KB of HTML. It has already been written to
   disk and rendered, so keep it out of the transcript — otherwise every later
   turn re-sends the whole source to the model. */
function redactAppHtml(msg) {
  const stub = (n) => `[${n} chars of HTML — already rendered in the app window]`;

  for (const b of msg.blocks || []) {
    if (b.type === 'tool' && b.name === 'show_app' && typeof b.input?.html === 'string') {
      b.input = { ...b.input, html: stub(b.input.html.length) };
    }
  }

  for (const item of msg.raw?.output || []) {
    if (item.type === 'function_call' && item.name === 'show_app') {
      const args = safeParse(item.arguments);
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

function pushTool(agent, provider, raw) {
  agent.messages.push({ role: 'tool', ts: Date.now(), provider, raw });
  saveStore();
}

async function execTool(agent, name, input) {
  send('stream:tool', { agentId: agent.id, name, input, phase: 'run' });
  const ctx = {};
  // Consequential clicks go past the user first, unless they turned that off.
  if (agent.tools?.confirm !== false) ctx.confirm = (q) => askUser(agent.id, q);
  try {
    const output =
      name === 'show_app'
        ? await runShowApp(agent, input)
        : TASK_TOOLS.some((t) => t.name === name)
          ? await runTaskTool(agent, name, input)
          : await runBrowserTool(name, input, ctx);
    return { output, isError: false };
  } catch (err) {
    return { output: `Error: ${err.message}`, isError: true };
  }
}

/* A half-delivered stream: the SDK's accumulator rejects an out-of-order or
   dropped SSE chunk, or the connection died mid-flight. Nothing has been
   committed to the transcript when this happens, so the turn can just be rerun. */
const TRANSIENT_STREAM =
  /missing (output|content part|item|text|refusal) at index|premature close|socket hang up|terminated|ECONNRESET|network error|aborted/i;

/* OpenAI tells you exactly how long to wait ("try again in 13.576s"); the
   header is authoritative when present. */
function retryAfterMs(err) {
  const header = Number(err?.headers?.['retry-after'] || err?.headers?.get?.('retry-after'));
  if (header > 0) return Math.min(header * 1000 + 250, 60000);
  const m = /try again in ([\d.]+)\s*(ms|s)/i.exec(String(err?.message || ''));
  if (m) {
    const value = Number(m[1]) * (m[2].toLowerCase() === 'ms' ? 1 : 1000);
    return Math.min(value + 500, 60000);
  }
  return 5000;
}

const isTransientStream = (err) =>
  !err?.status && TRANSIENT_STREAM.test(String(err?.message || ''));


/* What the providers charge, $ per 1M tokens: [input, cachedInput, output].
   Used only to turn recorded token counts into a rough running total — it is an
   estimate, not your invoice, and it does not include per-call web-search fees. */
const PRICES = {
  'gpt-5.6-luna': [0.2, 0.02, 1.2],
  'gpt-5.6-terra': [2, 0.2, 12],
  'gpt-5.6-sol': [5, 0.5, 30],
  'gpt-5.5': [5, 0.5, 30],
  'gpt-5.5-pro': [30, 30, 180],
  'gpt-5.4': [2.5, 0.25, 15],
  'gpt-5.4-mini': [0.75, 0.075, 4.5],
  'gpt-5.4-nano': [0.2, 0.02, 1.25],
  'gpt-5.4-pro': [30, 30, 180],
  'claude-opus-5': [5, 0.5, 25],
  'claude-sonnet-5': [3, 0.3, 15],
  'claude-haiku-4-5': [1, 0.1, 5],
};

function priceOf(model) {
  if (PRICES[model]) return PRICES[model];
  const hit = Object.keys(PRICES).find((k) => model?.startsWith(k));
  return hit ? PRICES[hit] : null;
}

function estimateCost(u, model) {
  const p = priceOf(model);
  if (!p || !u) return 0;
  const fresh = Math.max(0, (u.in || 0) - (u.cached || 0));
  return (fresh * p[0] + (u.cached || 0) * p[1] + (u.out || 0) * p[2]) / 1e6;
}

/** Adds one turn's usage to the agent's running total. */
function recordUsage(agent, usage) {
  if (!usage) return;
  const u = (agent.usage = agent.usage || { in: 0, cached: 0, out: 0, requests: 0, cost: 0 });
  u.in += usage.in || 0;
  u.cached += usage.cached || 0;
  u.out += usage.out || 0;
  u.requests += 1;
  u.cost += estimateCost(usage, agent.model);
  saveStore();
}

function friendlyError(err, provider) {
  const status = err?.status;
  const who = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
  if (status === 401) {
    const fromEnv = process.env[ENV_KEYS[provider]];
    return (
      `${who} rejected the API key — ${err.message}\n\n` +
      (fromEnv
        ? `Note: it is using ${ENV_KEYS[provider]} from your environment, which overrides anything saved in Settings. Unset it, or fix that value.`
        : 'Open Settings (⌘,) and press Test next to the key to check it.')
    );
  }
  if (status === 403) return 'That key is not allowed to use this model. Pick another model, or check your account.';
  if (status === 404) return `That model was not found on your account: ${err.message}`;
  if (status === 429) {
    return (
      `${who} rate limit — ${err.message}\n\n` +
      'This chat is long, so every message resends a lot of context. Start a new chat (⌘⌫ clears ' +
      'this one), or switch this agent to a non-"pro" model, which has a far larger per-minute budget.'
    );
  }
  if (status === 400) return `The API rejected the request: ${err.message}`;
  if (status >= 500) return 'The provider had a server error. Try again in a moment.';
  if (isTransientStream(err)) {
    return (
      'The reply stream arrived out of order and was dropped, twice in a row — nothing was saved. ' +
      `Send it again. (${err.message})`
    );
  }
  return err?.message || String(err);
}

async function runAgent(agentId) {
  const agent = findAgent(agentId);
  if (!agent) return;

  const provider = agent.provider || 'openai';
  if (!getClient(provider)) {
    send('stream:error', {
      agentId,
      error: `No ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key set. Open Settings (⌘,) to add one.`,
    });
    return;
  }

  const state = { cancelled: false, stream: null };
  running.set(agentId, state);
  send('stream:start', { agentId });

  try {
    if (provider === 'openai') await runOpenAI(agent, state);
    else await runAnthropic(agent, state);
  } catch (err) {
    const aborted = state.cancelled || err?.name === 'APIUserAbortError' || err?.name === 'AbortError';
    if (!aborted) {
      console.error(err);
      send('stream:error', { agentId, error: friendlyError(err, provider) });
    }
  } finally {
    closeDanglingToolCalls(agent);
    running.delete(agentId);
    send('stream:end', { agentId });

    // Messages sent from an app window while this run was in flight.
    const queued = pendingFromApps.get(agentId);
    if (queued?.length) {
      pendingFromApps.delete(agentId);
      deliverUserMessage(agent, queued.join('\n'));
    }
  }
}

// If we stopped right after the model asked for a tool, close the loop so the
// next request isn't rejected for a tool call with no matching result.
function closeDanglingToolCalls(agent) {
  const last = agent.messages[agent.messages.length - 1];
  if (last?.role !== 'assistant') return;

  if (last.provider === 'anthropic' && last.raw?.content) {
    const pending = last.raw.content.filter((b) => b.type === 'tool_use');
    if (!pending.length) return;
    pushTool(agent, 'anthropic', {
      results: pending.map((b) => ({
        type: 'tool_result',
        tool_use_id: b.id,
        content: 'Stopped by the user.',
        is_error: true,
      })),
    });
  } else if (last.provider === 'openai' && last.raw?.output) {
    const pending = last.raw.output.filter((i) => i.type === 'function_call');
    if (!pending.length) return;
    pushTool(agent, 'openai', {
      items: pending.map((i) => ({ type: 'function_call_output', call_id: i.call_id, output: 'Stopped by the user.' })),
    });
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function providerStatus() {
  const out = {};
  for (const p of ['openai', 'anthropic']) {
    const hasKey = Boolean(getKey(p));
    out[p] = { hasKey, fromEnv: Boolean(process.env[ENV_KEYS[p]]), stale: !hasKey && undecryptable.has(p) };
  }
  return out;
}

ipcMain.handle('state:get', () => ({
  agents: store.agents,
  activeId: store.activeId,
  providers: providerStatus(),
  theme: store.theme || 'system',
}));

ipcMain.handle('models:list', async (_e, provider) => ({
  models: await listModels(provider),
  fallback: await defaultModel(provider),
}));

ipcMain.handle('agent:save', async (_e, agent) => {
  if (!agent.model) agent.model = await defaultModel(agent.provider);
  const existing = findAgent(agent.id);
  if (existing) Object.assign(existing, agent, { messages: existing.messages });
  else store.agents.unshift(Object.assign({ createdAt: Date.now(), messages: [] }, agent, { id: agent.id || newId() }));
  saveStore();
  return store.agents;
});

ipcMain.handle('agent:delete', (_e, id) => {
  store.agents = store.agents.filter((a) => a.id !== id);
  if (store.activeId === id) store.activeId = store.agents[0]?.id || null;
  saveStore();
  return { agents: store.agents, activeId: store.activeId };
});

ipcMain.handle('agent:clear', (_e, id) => {
  const a = findAgent(id);
  if (a) a.messages = [];
  saveStore();
  return true;
});

ipcMain.handle('agent:draft', (_e, { id, text }) => {
  const a = findAgent(id);
  if (!a) return false;
  a.draft = text || '';
  saveStore();
  return true;
});

ipcMain.handle('agent:read', (_e, id) => {
  const a = findAgent(id);
  if (!a) return 0;
  a.lastReadTs = Date.now();
  saveStore();
  updateBadge();
  return 0;
});

ipcMain.handle('agent:activate', (_e, id) => {
  store.activeId = id;
  saveStore();
  return true;
});

ipcMain.handle('chat:send', (_e, { agentId, text }) => {
  const agent = findAgent(agentId);
  if (!agent) return null;
  const msg = { role: 'user', ts: Date.now(), text };
  agent.messages.push(msg);
  saveStore();
  runAgent(agentId);
  return msg;
});

ipcMain.handle('chat:stop', (_e, agentId) => {
  const state = running.get(agentId);
  if (state) {
    state.cancelled = true;
    try {
      state.stream?.abort();
    } catch {}
  }
  return true;
});

// Verify a key by listing models with it — the cheapest authenticated call there is.
ipcMain.handle('key:test', async (_e, { provider, key }) => {
  const useKey = key || getKey(provider);
  if (!useKey) return { ok: false, message: 'No key to test — paste one in the field first.' };

  const client =
    provider === 'openai' ? new OpenAI({ apiKey: useKey }) : new Anthropic({ apiKey: useKey });
  try {
    const page = await client.models.list();
    const ids = [];
    for await (const m of page) {
      ids.push(m.id);
      if (ids.length >= 4) break;
    }
    const envNote = process.env[ENV_KEYS[provider]] && !key
      ? ` (this is ${ENV_KEYS[provider]} from your environment)`
      : '';
    return { ok: true, message: `Key works${envNote}. Models available: ${ids.join(', ')}…` };
  } catch (err) {
    const hint =
      err?.status === 401
        ? ' — check for a stray space, a key that was revoked, or a key from the other provider.'
        : err?.status === 403
          ? ' — the key is valid but not allowed to use this endpoint. Check the project/org it belongs to.'
          : err?.status === 429
            ? ' — the key is valid but has no quota or is rate limited.'
            : '';
    // The SDK already prefixes the status in `message` — don't repeat it.
    const msg = String(err?.message || err);
    const status = err?.status && !msg.startsWith(String(err.status)) ? `${err.status} ` : '';
    return { ok: false, message: status + msg + hint };
  }
});

ipcMain.handle('key:set', (_e, { provider, key }) => {
  setKey(provider, key);
  return providerStatus();
});

ipcMain.handle('theme:set', (_e, theme) => {
  store.theme = theme;
  nativeTheme.themeSource = theme;
  saveStore();
  return theme;
});

ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('menu', 'settings') },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'File',
        submenu: [
          { label: 'New Agent', accelerator: 'Cmd+N', click: () => send('menu', 'new-agent') },
          { label: 'Clear Conversation', accelerator: 'Cmd+Backspace', click: () => send('menu', 'clear') },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { label: 'Search Agents', accelerator: 'Cmd+K', click: () => send('menu', 'search') },
          { label: 'Toggle Agent List', accelerator: 'Cmd+\\', click: () => send('menu', 'sidebar') },
          { label: 'Toggle Browser', accelerator: 'Cmd+B', click: () => send('menu', 'browser') },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ])
  );
}

// ---------------------------------------------------------------------------

/* One instance only. Two copies (say, the installed app and a dev run) share
   the same store file and would overwrite each other's agents and tasks. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

app.whenReady().then(() => {
  loadStore();
  nativeTheme.themeSource = store.theme || 'system';
  buildMenu();
  createWindow();
  startScheduler();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
