'use strict';

/* ──────────────────────────  State  ────────────────────────── */

let agents = [];
let activeId = null;
let filter = '';
let streaming = new Set(); // agent ids currently generating
let editingId = null;

const EMOJIS = ['🤖', '🔎', '🧠', '💼', '📈', '✍️', '🧑‍💻', '🎓', '⚖️', '🩺', '🍳', '🎬', '🌍', '🧪', '📚', '🎨'];
const COLORS = ['#4a7dfc', '#7a6cf0', '#e5484d', '#f5a524', '#2f9e6a', '#e6689a', '#00b0c7', '#8b8f9c'];

const $ = (id) => document.getElementById(id);

/* ────────────────────  Generated avatars  ────────────────────
   Every agent gets its own picture: soft abstract art rendered as an SVG,
   generated from a seed string. Same seed → same picture, so it is stable
   across restarts without storing any image data. */

function seedHash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function avatarSVG(seed) {
  const r = mulberry32(seedHash(String(seed)));
  const pick = (min, max) => min + r() * (max - min);
  const base = Math.floor(r() * 360);
  const hue = (n) => ((Math.round(base + n) % 360) + 360) % 360;
  const bg1 = `hsl(${base} ${pick(60, 85) | 0}% ${pick(46, 60) | 0}%)`;
  const bg2 = `hsl(${hue(pick(70, 230))} ${pick(58, 85) | 0}% ${pick(26, 42) | 0}%)`;

  const shape = (soft) => {
    const fill = `hsl(${hue(pick(-150, 150))} ${pick(70, 98) | 0}% ${pick(45, 78) | 0}%)`;
    const op = (soft ? pick(0.45, 0.9) : pick(0.2, 0.45)).toFixed(2);
    const cx = pick(6, 94) | 0;
    const cy = pick(6, 94) | 0;
    const rad = (soft ? pick(20, 48) : pick(10, 30)) | 0;
    const kind = r();
    if (kind < 0.45) return `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="${fill}" opacity="${op}"/>`;
    if (kind < 0.75)
      return `<rect x="${cx - rad}" y="${cy - rad}" width="${rad * 2}" height="${rad * 2}" rx="${(rad * 0.3) | 0}" fill="${fill}" opacity="${op}" transform="rotate(${(r() * 90) | 0} ${cx} ${cy})"/>`;
    return `<path d="M${cx} ${cy - rad} L${cx + rad} ${cy + rad} L${cx - rad} ${cy + rad} Z" fill="${fill}" opacity="${op}" transform="rotate(${(r() * 360) | 0} ${cx} ${cy})"/>`;
  };

  let soft = '';
  for (let i = 0, n = 3 + Math.floor(r() * 3); i < n; i++) soft += shape(true);
  let crisp = '';
  for (let i = 0, n = 1 + Math.floor(r() * 2); i < n; i++) crisp += shape(false);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient>` +
    `<filter id="b" x="-30%" y="-30%" width="160%" height="160%">` +
    `<feGaussianBlur stdDeviation="5"/></filter>` +
    `<filter id="s" x="-20%" y="-20%" width="140%" height="140%">` +
    `<feGaussianBlur stdDeviation="1.2"/></filter></defs>` +
    `<rect width="100" height="100" fill="url(#g)"/>` +
    `<g filter="url(#b)">${soft}</g>` +
    `<g filter="url(#s)">${crisp}</g></svg>`
  );
}

// Single-quoted so the whole thing can live inside a double-quoted style="" attribute.
const avatarUrl = (seed) => `url('data:image/svg+xml,${encodeURIComponent(avatarSVG(seed))}')`;

// Returns { style, text } for an `.avatar`-styled element.
function avatarFace(agent) {
  if (!agent) return { style: '', text: '🤖' };
  if (agent.avatar?.kind === 'emoji') {
    return { style: `background:${agent.color || COLORS[0]}`, text: agent.emoji || '🤖' };
  }
  const seed = agent.avatar?.seed || agent.id || agent.name || 'internall';
  return { style: `background-image:${avatarUrl(seed)};background-size:cover;`, text: '' };
}

function paintAvatar(el, agent) {
  const face = avatarFace(agent);
  el.style.cssText = face.style;
  el.textContent = face.text;
}

const randomSeed = () => Math.random().toString(36).slice(2, 10);

/* ──────────────────────────  Boot  ────────────────────────── */

let providers = { openai: { hasKey: false }, anthropic: { hasKey: false } };

(async function init() {
  const state = await window.internall.getState();
  agents = state.agents || [];
  activeId = state.activeId || agents[0]?.id || null;
  applyProviders(state.providers);
  $('s-theme').value = state.theme || 'system';
  buildPickers();
  renderList();
  renderChat();
  refreshTasks();
  restoreDraft();
  if (!providers.openai.hasKey && !providers.anthropic.hasKey) openSettings();
})();

function applyProviders(p) {
  providers = p || providers;
  const on = Object.entries(providers).filter(([, v]) => v.hasKey).map(([k]) => PROVIDER_LABEL[k]);
  const badge = $('key-badge');
  badge.textContent = on.length ? on.join(' + ') : 'no key';
  badge.classList.toggle('ok', on.length > 0);
  for (const key of ['openai', 'anthropic']) {
    const el = $(`s-${key}-state`);
    if (!el) continue;
    const p = providers[key];
    el.textContent = p.fromEnv ? '· from environment' : p.hasKey ? '· saved' : p.stale ? '· paste it again' : '';
    el.classList.toggle('env', Boolean(p.fromEnv || p.stale));
    const hint = $(`s-${key}-hint`);
    if (p.stale && hint) {
      hint.className = 'hint bad';
      hint.textContent =
        'The app was renamed, and macOS ties the saved key to the old app name — paste it once more and it will stick.';
    }
  }
}

const PROVIDER_LABEL = { openai: 'OpenAI', anthropic: 'Anthropic' };

/* ──────────────────────────  Sidebar  ────────────────────────── */

function agentById(id) {
  return agents.find((a) => a.id === id);
}

const unreadCount = (agent) =>
  (agent.messages || []).filter((m) => m.role === 'assistant' && m.ts > (agent.lastReadTs || 0)).length;

const lastActivity = (agent) =>
  agent.messages?.length ? agent.messages[agent.messages.length - 1].ts : agent.createdAt || 0;

// Reading = this chat is open and the window is in front.
let windowFocused = document.hasFocus();

function markRead(agent) {
  if (!agent || !unreadCount(agent)) return;
  agent.lastReadTs = Date.now();
  window.internall.markRead(agent.id);
  renderList();
}

window.addEventListener('focus', () => {
  windowFocused = true;
  markRead(agentById(activeId));
});
window.addEventListener('blur', () => (windowFocused = false));

function lastTextOf(agent) {
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const m = agent.messages[i];
    const t = plainText(m).replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
    if (t) return (m.role === 'assistant' ? '' : 'You: ') + t;
  }
  return agent.description ? agent.description.split('\n')[0] : 'No messages yet';
}

function plainText(m) {
  if (m.role === 'user') return m.text || '';
  if (m.role !== 'assistant') return '';
  return (m.blocks || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim();
}

function renderList() {
  const list = $('chat-list');
  list.innerHTML = '';
  const q = filter.toLowerCase();

  agents
    .filter((a) => !q || a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q))
    .slice()
    .sort((a, b) => lastActivity(b) - lastActivity(a)) // most recent chat on top
    .forEach((a) => {
      const last = a.messages[a.messages.length - 1];
      const unread = unreadCount(a);
      const el = document.createElement('div');
      el.className = 'chat-item' + (a.id === activeId ? ' active' : '') + (unread ? ' unread' : '');
      el.title = a.name; // the only label there is when the rail is collapsed
      const face = avatarFace(a);
      el.innerHTML = `
        <div class="avatar-wrap">
          <div class="avatar" style="${face.style}">${face.text}</div>
          ${unread ? `<span class="avatar-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
        </div>
        <div class="ci-body">
          <div class="ci-line">
            <div class="ci-name"></div>
            <div class="ci-time">${last ? shortTime(last.ts) : ''}</div>
          </div>
          <div class="ci-line">
            <div class="ci-preview"></div>
            ${unread ? `<span class="ci-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
          </div>
        </div>`;
      el.querySelector('.ci-name').textContent = a.name;
      const preview = el.querySelector('.ci-preview');
      const draft = (a.id === activeId ? $('input').value : a.draft || '').trim();
      if (streaming.has(a.id)) preview.textContent = 'typing…';
      else if (draft) {
        preview.innerHTML = `<span class="draft">Draft:</span> `;
        preview.append(draft);
      } else preview.textContent = lastTextOf(a);
      el.onclick = () => selectAgent(a.id);
      list.appendChild(el);
    });

  if (!list.children.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<p>No agents match your search.</p>';
    list.appendChild(empty);
  }
}

/* Each chat keeps its own draft, like any messenger — switching away parks
   what you typed, coming back restores it. */
function stashDraft() {
  const agent = agentById(activeId);
  if (!agent) return;
  const text = $('input').value;
  if ((agent.draft || '') === text) return;
  agent.draft = text;
  window.internall.saveDraft(agent.id, text);
}

function restoreDraft() {
  const input = $('input');
  input.value = agentById(activeId)?.draft || '';
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 190) + 'px';
}

let draftTimer = null;
function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    stashDraft();
    renderList(); // keep the "Draft:" preview honest
  }, 600);
}

function selectAgent(id) {
  if (id === activeId) return;
  stashDraft();
  activeId = id;
  window.internall.activateAgent(id);
  renderList();
  renderChat();
  refreshTasks();
  restoreDraft();
  $('input').focus();
}

/* ──────────────────────────  Chat  ────────────────────────── */

function renderChat() {
  const agent = agentById(activeId);
  const box = $('messages');
  box.innerHTML = '';
  activeGroup = null; // the DOM it pointed at is gone

  if (!agent) {
    $('ch-name').textContent = 'Internall';
    $('ch-sub').textContent = 'no agent selected';
    box.innerHTML = `<div class="empty"><div class="big">💬</div><h3>No agents yet</h3>
      <p>Create your first agent — give it a name and describe what it should do. That description becomes its personality and job.</p></div>`;
    return;
  }

  paintAvatar($('ch-avatar'), agent);
  $('ch-name').textContent = agent.name;
  setSub(agent);

  if (!agent.messages.length) {
    const face = avatarFace(agent);
    box.innerHTML = `<div class="empty">
      <div class="avatar big-avatar" style="${face.style}">${face.text}</div>
      <h3>${escapeHtml(agent.name)}</h3>
      <p>${escapeHtml(agent.description || 'No description yet.')}</p>
      <p style="color:var(--text-faint);font-size:12.5px">${abilityLine(agent)}</p>
    </div>`;
    return;
  }

  const readMark = agent.lastReadTs || 0;
  let unreadShown = false;
  let lastDay = '';
  agent.messages.forEach((m) => {
    const day = dayLabel(m.ts);
    if (day !== lastDay) {
      lastDay = day;
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.innerHTML = `<span>${day}</span>`;
      box.appendChild(sep);
    }
    if (!unreadShown && m.role === 'assistant' && m.ts > readMark) {
      unreadShown = true;
      closeGroup(m.ts);
      const sep = document.createElement('div');
      sep.className = 'unread-sep';
      sep.innerHTML = `<span>Unread messages</span>`;
      box.appendChild(sep);
    }
    renderMessage(box, m);
  });

  scrollDown(true);
  if (windowFocused) markRead(agent);
}

function abilityLine(a) {
  const bits = [];
  if (a.tools?.web) bits.push('🌐 internet access');
  if (a.tools?.browser) bits.push('🧭 browser control');
  bits.push(a.model || PROVIDER_LABEL[a.provider] || '');
  return bits.filter(Boolean).join(' · ');
}

/* The header shows the agent's name and nothing else — the status line appears
   only while it is actually doing something, then gets out of the way. */
function setSub(agent) {
  const sub = $('ch-sub');
  const busy = streaming.has(agent.id);
  sub.className = busy ? 'ch-sub typing' : 'ch-sub';
  sub.textContent = busy ? 'typing…' : '';
  sub.classList.toggle('hidden', !busy);
}

/* ── Activity groups ────────────────────────────────────────────
   Reasoning summaries and tool steps are collapsed into a single row —
   "✻ Worked for 8s · 3 steps" — that expands on click. A group stays open
   for consecutive steps and closes as soon as the agent says something, so
   the transcript reads as message → message, with the work tucked behind it. */

let activeGroup = null;

function openGroup(box, ts) {
  if (activeGroup) return activeGroup;
  const el = document.createElement('details');
  el.className = 'activity';
  el.innerHTML = `<summary><span class="mark">✻</span><span class="label"></span></summary><div class="steps"></div>`;
  box.appendChild(el);
  activeGroup = { el, body: el.querySelector('.steps'), label: el.querySelector('.label'), start: ts || Date.now(), thinking: 0, tools: 0 };
  setGroupLabel('Working…', true);
  return activeGroup;
}

function setGroupLabel(text, live) {
  if (!activeGroup) return;
  activeGroup.label.textContent = text;
  activeGroup.el.classList.toggle('live', Boolean(live));
}

function addStep(box, el, kind, ts) {
  const g = openGroup(box, ts);
  if (kind === 'thinking') g.thinking++;
  else g.tools++;
  g.body.appendChild(el);
  return g;
}

function closeGroup(endTs) {
  const g = activeGroup;
  if (!g) return;
  activeGroup = null;
  if (!g.thinking && !g.tools) {
    g.el.remove(); // nothing happened after all
    return;
  }
  const secs = Math.round(((endTs || Date.now()) - g.start) / 1000);
  const verb = g.tools ? 'Worked' : 'Thought';
  const steps = g.tools ? ` · ${g.tools} step${g.tools > 1 ? 's' : ''}` : '';
  g.label.textContent = `${verb}${secs > 0 ? ` for ${secs}s` : ''}${steps}`;
  g.el.classList.remove('live');
}

function renderMessage(box, m) {
  if (m.role === 'tool') return; // tool results are internal
  if (m.role === 'user') {
    closeGroup(m.ts);
    if (m.scheduled) {
      const line = document.createElement('div');
      line.className = 'sched-line';
      line.innerHTML = `<span></span>`;
      const lines = String(m.text || '').split('\n');
      line.firstChild.textContent = `⏰ ${lines.slice(1).join(' ').trim() || lines[0].replace(/^⏰ /, '')}`;
      line.title = m.text || '';
      box.appendChild(line);
      return;
    }
    const row = document.createElement('div');
    row.className = 'row out tail';
    const b = document.createElement('div');
    b.className = 'bubble';
    b.innerHTML = markdown(m.text || '') + `<span class="meta-time">${shortTime(m.ts)}</span>`;
    row.appendChild(b);
    box.appendChild(row);
    return;
  }

  let text = '';
  const citations = [];

  (m.blocks || []).forEach((b) => {
    if (b.type === 'thinking' && b.text) addStep(box, thinkingEl(b.text), 'thinking', m.ts);
    else if (b.type === 'text') {
      text += b.text;
      (b.citations || []).forEach((c) => citations.push(c));
    } else if (b.type === 'tool') {
      addStep(box, toolChip(b.name, b.input), 'tool', m.ts);
    }
  });

  if (text.trim()) {
    closeGroup(m.ts);
    box.appendChild(bubbleEl(text, citations, m.ts));
  }
}

function bubbleEl(text, citations, ts) {
  const row = document.createElement('div');
  row.className = 'row in tail';
  const b = document.createElement('div');
  b.className = 'bubble';
  b.innerHTML = markdown(text);
  if (citations && citations.length) {
    const seen = new Set();
    const uniq = citations.filter((c) => !seen.has(c.url) && seen.add(c.url)).slice(0, 6);
    const s = document.createElement('div');
    s.className = 'sources';
    s.innerHTML = uniq.map((c) => `<a href="${escapeHtml(c.url)}">${escapeHtml(c.title)}</a>`).join('');
    b.appendChild(s);
  }
  if (ts) b.insertAdjacentHTML('beforeend', `<span class="meta-time">${shortTime(ts)}</span>`);
  row.appendChild(b);
  return row;
}

// A reasoning summary, shown inside an activity group (which does the collapsing).
function thinkingEl(text) {
  const d = document.createElement('div');
  d.className = 'thought';
  d.innerHTML = `<div class="body"></div>`;
  d.querySelector('.body').textContent = text;
  d.dataset.kind = 'thinking';
  return d;
}

const TOOL_LABEL = {
  web_search: (i) => `🔍 Searched the web — “${i?.query ?? ''}”`,
  web_fetch: (i) => `📄 Read ${hostOf(i?.url)}`,
  browser_open: (i) => `🧭 Opened ${hostOf(i?.url)} in the browser`,
  browser_read: () => `👀 Read the open browser page`,
  browser_links: (i) => `🔗 Scanned links${i?.query ? ` for “${i.query}”` : ''}`,
  browser_images: (i) => `🖼️ Looked for images${i?.query ? ` of “${clip(i.query)}”` : ''}`,
  browser_fields: () => `🧾 Inspected the page's fields and buttons`,
  browser_fill: (i) => `⌨️ Filled field #${i?.field ?? '?'} with “${clip(i?.value)}”`,
  browser_select: (i) => `🔽 Chose “${clip(i?.option)}” in field #${i?.field ?? '?'}`,
  browser_click: (i) => `🖱️ Clicked element #${i?.field ?? '?'}`,
  browser_press: (i) => `⏎ Pressed ${i?.key || 'Enter'}`,
  show_app: (i) => `🧩 Built an app — “${clip(i?.title) || 'untitled'}”`,
  schedule_task: (i) => `⏰ Scheduled — “${clip(i?.instruction)}”`,
  list_tasks: () => `📋 Checked its scheduled tasks`,
  cancel_task: () => `🗑️ Cancelled a scheduled task`,
};

// Present-tense status shown on the activity row while a step is running.
const TOOL_STATUS = {
  web_search: (i) => `Searching the web — “${clip(i?.query)}”`,
  web_fetch: (i) => `Reading ${hostOf(i?.url)}`,
  browser_open: (i) => `Opening ${hostOf(i?.url)}`,
  browser_read: () => 'Reading the page',
  browser_links: () => 'Scanning links',
  browser_images: () => 'Looking for images',
  browser_fields: () => 'Inspecting the form',
  browser_fill: () => 'Filling in a field',
  browser_select: () => 'Choosing an option',
  browser_click: () => 'Clicking',
  browser_press: () => 'Submitting',
  show_app: (i) => `Building “${clip(i?.title)}”`,
  schedule_task: () => 'Scheduling it',
  list_tasks: () => 'Checking its schedule',
  cancel_task: () => 'Cancelling a task',
};

const clip = (s) => {
  const t = String(s ?? '');
  return t.length > 32 ? t.slice(0, 32) + '…' : t;
};

function toolChip(name, input) {
  const el = document.createElement('div');
  el.className = 'chip';
  const label = TOOL_LABEL[name] ? TOOL_LABEL[name](input) : `⚙️ ${name}`;
  el.innerHTML = `<span class="dot"></span><span></span>`;
  el.lastElementChild.textContent = label;
  if (name.startsWith('browser_')) {
    el.classList.add('clickable');
    el.onclick = () => showBrowser();
  }
  return el;
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url || 'a page';
  }
}

/* ──────────────────────────  Sending  ────────────────────────── */

const input = $('input');

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 190) + 'px';
  scheduleDraftSave();
});
window.addEventListener('beforeunload', stashDraft);

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

$('send').onclick = sendMessage;
$('stop').onclick = () => window.internall.stop(activeId);

async function sendMessage() {
  const agent = agentById(activeId);
  const text = input.value.trim();
  if (!agent || !text || streaming.has(agent.id)) return;

  input.value = '';
  input.style.height = 'auto';
  clearTimeout(draftTimer);
  agent.draft = '';
  window.internall.saveDraft(agent.id, '');

  const msg = await window.internall.send(agent.id, text);
  if (!msg) return;
  agent.messages.push(msg);
  if (agent.messages.length === 1) renderChat();
  else {
    renderMessage($('messages'), msg);
    scrollDown();
  }
  renderList();
}

/* ──────────────────────────  Streaming  ────────────────────────── */

let live = null; // { wrap, textEl, thinkEl, raw, thinkRaw, shown, thinkShown }

function ensureLive() {
  if (live) return live;
  const wrap = document.createElement('div');
  wrap.id = 'live';
  $('messages').appendChild(wrap);
  live = { wrap, textEl: null, thinkEl: null, raw: '', thinkRaw: '', shown: 0, thinkShown: 0 };
  startTyping();
  return live;
}

function clearLive() {
  if (live) live.wrap.remove();
  live = null;
  stopTyping();
  // Live steps are re-rendered from the stored message, so drop them here and
  // give the group back its count.
  document.querySelectorAll('.live-step').forEach((el) => {
    if (activeGroup) {
      if (el.dataset.kind === 'thinking') activeGroup.thinking--;
      else activeGroup.tools--;
    }
    el.remove();
  });
}

/* Typewriter pacing. Deltas arrive in uneven bursts — a whole sentence can land
   in one event — so instead of painting each burst we reveal the buffered text
   at a steady rate, speeding up when we fall behind so we never lag the model. */

let typingRAF = null;
let lastTick = 0;

function startTyping() {
  if (typingRAF) return;
  lastTick = performance.now();
  const tick = (now) => {
    typingRAF = requestAnimationFrame(tick);
    if (!live) return;
    const dt = Math.min((now - lastTick) / 1000, 0.25);
    lastTick = now;

    let painted = false;
    if (live.textEl && live.shown < live.raw.length) {
      live.shown = advance(live.shown, live.raw.length, dt);
      live.textEl.innerHTML = markdown(live.raw.slice(0, live.shown));
      painted = true;
    }
    if (live.thinkEl && live.thinkShown < live.thinkRaw.length) {
      live.thinkShown = advance(live.thinkShown, live.thinkRaw.length, dt);
      live.thinkEl.textContent = live.thinkRaw.slice(0, live.thinkShown);
      painted = true;
    }
    if (painted) scrollDown();
  };
  typingRAF = requestAnimationFrame(tick);
}

function stopTyping() {
  if (typingRAF) cancelAnimationFrame(typingRAF);
  typingRAF = null;
}

// ~55 chars/s at rest, accelerating with the size of the backlog.
function advance(shown, target, dt) {
  const backlog = target - shown;
  const speed = Math.min(1600, 55 + backlog * 4);
  return Math.min(target, shown + Math.max(1, Math.round(speed * dt)));
}

// Reveal everything immediately (used when the turn finishes, so the swap to
// the stored message is invisible).
function flushTyping() {
  if (!live) return;
  if (live.textEl && live.shown < live.raw.length) {
    live.shown = live.raw.length;
    live.textEl.innerHTML = markdown(live.raw);
  }
  if (live.thinkEl) {
    live.thinkShown = live.thinkRaw.length;
    live.thinkEl.textContent = live.thinkRaw;
  }
}

window.internall.onStreamStart(({ agentId }) => {
  streaming.add(agentId);
  if (agentId === activeId) {
    openGroup($('messages'), Date.now());
    setSub(agentById(agentId));
    scrollDown();
  }
  renderList();
});

window.internall.onStreamBlock(({ agentId, kind }) => {
  if (agentId !== activeId) return;
  // Don't close the group here — the finalized message does that, so live steps
  // and re-rendered ones land in the same group instead of two.
  if (kind === 'text') setGroupLabel('Writing…', true);
  const l = ensureLive();
  if (kind === 'text') {
    l.raw = '';
    l.shown = 0;
    const row = bubbleEl('', null, null);
    l.textEl = row.querySelector('.bubble');
    l.textEl.classList.add('streaming');
    l.wrap.appendChild(row);
  } else if (kind === 'thinking') {
    l.thinkRaw = '';
    l.thinkShown = 0;
    const d = thinkingEl('');
    d.classList.add('live-step');
    l.thinkEl = d.querySelector('.body');
    addStep($('messages'), d, 'thinking', Date.now());
    setGroupLabel('Thinking…', true);
  }
  scrollDown();
});

window.internall.onStreamDelta(({ agentId, kind, text }) => {
  if (agentId !== activeId || !live) return;
  // Buffer only — the typewriter loop above decides when it appears.
  if (kind === 'text' && live.textEl) live.raw += text;
  else if (kind === 'thinking' && live.thinkEl) live.thinkRaw += text;
});

window.internall.onStreamTool(({ agentId, name, input, phase }) => {
  if (agentId !== activeId || phase === 'run') return; // 'run' is the execution echo
  const chip = toolChip(name, input);
  chip.classList.add('live-step');
  chip.dataset.kind = 'tool';
  addStep($('messages'), chip, 'tool', Date.now());
  setGroupLabel((TOOL_STATUS[name] || (() => 'Working…'))(input), true);
  scrollDown();
});

window.internall.onStreamMessage(({ agentId, message }) => {
  const agent = agentById(agentId);
  if (agent) agent.messages.push(message);
  if (agent && agentId === activeId && windowFocused) {
    agent.lastReadTs = Date.now(); // you're watching it arrive
    window.internall.markRead(agentId);
  }
  if (agentId === activeId) {
    flushTyping();
    clearLive();
    const box = $('messages');
    renderMessage(box, message);
    scrollDown();
  }
  renderList();
});

/* ──────────────────────  Scheduled tasks  ────────────────────── */

async function refreshTasks() {
  const tasks = await window.internall.listTasks();
  const mine = tasks.filter((t) => t.agentId === activeId);
  $('task-dot').classList.toggle('hidden', !mine.some((t) => t.enabled));
  $('tasks-btn').title = mine.length ? `${mine.length} scheduled task${mine.length > 1 ? 's' : ''}` : 'Scheduled tasks';
  return tasks;
}

async function openTasks() {
  const all = await refreshTasks();
  const tasks = all.filter((t) => t.agentId === activeId); // this chat only
  const elsewhere = all.length - tasks.length;
  const agent = agentById(activeId);
  const list = $('tasks-list');
  list.innerHTML = '';

  $('tasks-title').textContent = agent ? `Scheduled · ${agent.name}` : 'Scheduled tasks';
  $('tasks-elsewhere').textContent = elsewhere
    ? `${elsewhere} other task${elsewhere > 1 ? 's are' : ' is'} scheduled in your other chats.`
    : '';

  if (!tasks.length) {
    list.innerHTML = `<p class="hint">Nothing scheduled in this chat yet.</p>`;
  }

  tasks.forEach((t) => {
    const done = isOneShotKind(t.kind) && t.lastRun && !t.enabled;
    const row = document.createElement('div');
    row.className = 'task-row' + (t.enabled ? '' : ' off');
    row.innerHTML = `
      <div class="task-body"><b></b><small class="when"></small></div>
      ${done ? '' : '<button class="pill toggle"></button>'}
      <button class="pill del">Delete</button>`;

    row.querySelector('b').textContent = t.instruction;
    row.querySelector('.when').textContent =
      `${t.label}${
        t.enabled && t.nextRun
          ? ` · next ${new Date(t.nextRun).toLocaleString()}`
          : done
            ? ` · ran ${new Date(t.lastRun).toLocaleString()}`
            : ' · paused'
      }`;

    const toggle = row.querySelector('.toggle');
    if (toggle) {
      toggle.textContent = t.enabled ? 'Pause' : 'Resume';
      toggle.onclick = async () => {
        await window.internall.toggleTask(t.id);
        openTasks();
      };
    }
    row.querySelector('.del').onclick = async () => {
      await window.internall.deleteTask(t.id);
      openTasks();
    };
    list.appendChild(row);
  });

  $('tasks-modal').classList.remove('hidden');
}

const isOneShotKind = (kind) => kind === 'once' || kind === 'in';

$('tasks-btn').onclick = openTasks;
$('tasks-close').onclick = () => $('tasks-modal').classList.add('hidden');

window.internall.onTasksChanged(({ agentId, created }) => {
  refreshTasks();
  if (created && agentId === activeId) {
    const card = document.createElement('div');
    card.className = 'app-card task-card';
    card.innerHTML = `<div class="app-icon">⏰</div><div class="app-meta"><b></b><small></small></div>
      <button class="open">Manage</button>`;
    card.querySelector('b').textContent = created.instruction;
    card.querySelector('small').textContent = `${created.label} · next ${new Date(created.nextRun).toLocaleString()}`;
    card.querySelector('.open').onclick = openTasks;
    closeGroup();
    $('messages').appendChild(card);
    scrollDown();
  }
});

// Clicking a task's notification brings you to that chat.
window.internall.onAgentFocus(({ agentId }) => {
  if (agentById(agentId)) selectAgent(agentId);
});

// An agent-built app opened in its own window — leave a card to reopen it.
window.internall.onAppCreated(({ agentId, appId, title, thumb, updated }) => {
  // An app the user already has open was just rebuilt: refresh that tab in
  // place so they are not left looking at the previous version.
  if (updated && openTabs.some((t) => t.appId === appId)) {
    $('app-body').querySelector(`.app-view[data-app-id="${appId}"]`)?.reload();
  }
  if (agentId !== activeId) return;
  closeGroup(); // this is for the user to see — never fold it away
  $('messages').appendChild(appCard({ appId, title, thumb, updated }));
  scrollDown();
});

/* A preview of the app, rendered once when it was built. Tapping it expands
   the picture into the live app rather than throwing you into another window. */
function appCard({ appId, title, thumb, updated }) {
  const card = document.createElement('div');
  card.className = 'app-preview';
  card.dataset.appId = appId;
  card.innerHTML = `
    <div class="app-shot">
      <img alt="" />
      <span class="app-expand">Open</span>
    </div>
    <div class="app-caption"><b></b><small></small></div>`;
  card.querySelector('b').textContent = title;
  card.querySelector('small').textContent = updated ? 'updated just now' : 'tap to open';
  const img = card.querySelector('img');
  if (thumb) img.src = thumb;
  else {
    card.querySelector('.app-shot').classList.add('no-shot');
    window.internall.appThumb(appId).then((late) => {
      if (late) {
        img.src = late;
        card.querySelector('.app-shot').classList.remove('no-shot');
      }
    });
  }
  card.onclick = () => expandApp(card, appId, title);
  return card;
}

/* ── The app viewer ─────────────────────────────────────────────────────
   Opening the first app animates the overlay out of the card that was tapped,
   so the picture you touched becomes the app. After that the viewer stays put
   and further apps arrive as tabs beside it. Each tab keeps its own live
   webview mounted, so switching away and back does not lose what you had
   typed, filtered or scrolled to. */
let openAppId = null; // the tab currently on top
const openTabs = []; // [{ appId, title }], in the order they were opened

function tabsFor() {
  return $('app-tabs');
}

function renderTabs() {
  const strip = tabsFor();
  strip.innerHTML = '';
  strip.classList.toggle('single', openTabs.length < 2);

  for (const tab of openTabs) {
    const el = document.createElement('div');
    el.className = 'app-tab' + (tab.appId === openAppId ? ' active' : '');
    el.title = tab.title;

    const label = document.createElement('span');
    label.className = 'app-tab-label';
    label.textContent = tab.title;
    el.appendChild(label);

    // One tab on its own has nothing to switch to, so the stage's own ✕ is
    // enough; a per-tab close button would just be a second way to do it.
    if (openTabs.length > 1) {
      const x = document.createElement('button');
      x.className = 'app-tab-close';
      x.title = `Close ${tab.title}`;
      x.textContent = '✕';
      x.onclick = (e) => {
        e.stopPropagation();
        closeTab(tab.appId);
      };
      el.appendChild(x);
    }

    el.onclick = () => showTab(tab.appId);
    strip.appendChild(el);
  }
}

/** Brings one tab's webview to the front. */
function showTab(appId) {
  if (!openTabs.some((t) => t.appId === appId)) return;
  openAppId = appId;
  for (const view of $('app-body').querySelectorAll('.app-view')) {
    view.classList.toggle('hidden', view.dataset.appId !== appId);
  }
  renderTabs();
}

function closeTab(appId) {
  const i = openTabs.findIndex((t) => t.appId === appId);
  if (i < 0) return;

  // Closing the last one closes the whole viewer, animating back to its card.
  if (openTabs.length === 1) return collapseApp();

  openTabs.splice(i, 1);
  $('app-body').querySelector(`.app-view[data-app-id="${appId}"]`)?.remove();
  if (openAppId === appId) showTab(openTabs[Math.min(i, openTabs.length - 1)].appId);
  else renderTabs();
}

function expandApp(card, appId, title) {
  const overlay = $('app-overlay');
  const stage = $('app-stage');
  const body = $('app-body');

  // Already showing: this is just another tab, so no animation — the viewer is
  // where the user is already looking.
  if (!overlay.classList.contains('hidden')) {
    if (!openTabs.some((t) => t.appId === appId)) {
      openTabs.push({ appId, title });
      mountApp(appId);
    }
    return showTab(appId);
  }

  openAppId = appId;
  openTabs.length = 0;
  openTabs.push({ appId, title });
  renderTabs();

  // Start by showing the same picture, so nothing flashes.
  const shot = card.querySelector('img')?.src;
  body.innerHTML = shot ? `<img class="app-still" src="${shot}" alt="" />` : '';

  overlay.classList.remove('hidden');
  const from = card.querySelector('.app-shot').getBoundingClientRect();
  const to = stage.getBoundingClientRect();

  const scaleX = from.width / to.width;
  const scaleY = from.height / to.height;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    overlay.classList.add('open');
    mountApp(appId);
    return;
  }

  // The webview goes in when the motion ends. transitionend is the signal, but
  // it never arrives if the window is in the background or the motion is cut
  // short, so a timer mounts it anyway rather than leaving a frozen picture.
  let mounted = false;
  const mountOnce = () => {
    if (mounted) return;
    mounted = true;
    mountApp(appId);
  };

  stage.style.transition = 'none';
  stage.style.transformOrigin = 'center center';
  stage.style.transform = `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`;
  stage.style.opacity = '0.6';

  requestAnimationFrame(() => {
    stage.style.transition = 'transform .34s cubic-bezier(.22,.61,.36,1), opacity .2s ease';
    stage.style.transform = 'translate(0, 0) scale(1)';
    stage.style.opacity = '1';
    overlay.classList.add('open');
    stage.addEventListener('transitionend', function done(e) {
      if (e.propertyName !== 'transform') return;
      stage.removeEventListener('transitionend', done);
      mountOnce();
    });
  });
  setTimeout(mountOnce, 700);
}

async function mountApp(appId) {
  const info = await window.internall.appInfo(appId);
  if (!info || !openTabs.some((t) => t.appId === appId)) return;
  const body = $('app-body');
  if (body.querySelector(`.app-view[data-app-id="${appId}"]`)) return; // already mounted

  const view = document.createElement('webview');
  view.setAttribute('src', `file://${info.file}`);
  view.setAttribute('preload', `file://${info.preload}`);
  // Its own throwaway session: generated pages never touch the browsing one,
  // and main uses the partition to tell the two kinds of webview apart.
  view.setAttribute('partition', 'internall-apps');
  view.className = 'app-view' + (appId === openAppId ? '' : ' hidden');
  view.dataset.appId = appId;
  view.addEventListener('ipc-message', (e) => {
    if (e.channel !== 'app') return;
    const msg = e.args?.[0];
    if (!msg) return;
    // An app closes itself, or hands a message back — either way it is that one
    // app that is finished with, not every tab the user has open.
    if (msg.type === 'close') closeTab(appId);
    if (msg.type === 'send' && msg.text) {
      closeTab(appId);
      window.internall.appSend(info.agentId, msg.text);
    }
  });
  view.addEventListener('dom-ready', () => body.querySelector('.app-still')?.remove());
  body.appendChild(view);
}

function collapseApp() {
  const overlay = $('app-overlay');
  const stage = $('app-stage');
  if (overlay.classList.contains('hidden')) return;

  const card = [...document.querySelectorAll('.app-preview')].reverse().find((c) => c.dataset.appId === openAppId);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const finish = () => {
    overlay.classList.add('hidden');
    overlay.classList.remove('open');
    stage.style.transition = 'none';
    stage.style.transform = '';
    stage.style.opacity = '';
    $('app-body').innerHTML = '';
    openTabs.length = 0;
    renderTabs();
    openAppId = null;
  };

  if (!card || reduced) return finish();

  const from = card.querySelector('.app-shot').getBoundingClientRect();
  const to = stage.getBoundingClientRect();
  stage.style.transition = 'transform .28s cubic-bezier(.4,0,.6,1), opacity .24s ease';
  stage.style.transform =
    `translate(${from.left + from.width / 2 - (to.left + to.width / 2)}px, ` +
    `${from.top + from.height / 2 - (to.top + to.height / 2)}px) ` +
    `scale(${from.width / to.width}, ${from.height / to.height})`;
  stage.style.opacity = '0';
  overlay.classList.remove('open');
  setTimeout(finish, 280);
}

$('app-close').onclick = collapseApp;
$('app-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'app-overlay') collapseApp();
});

// A button inside a generated app sent a message back into the chat.
window.internall.onUserMessage(({ agentId, message }) => {
  const agent = agentById(agentId);
  if (agent) agent.messages.push(message);
  if (agentId === activeId) {
    renderMessage($('messages'), message);
    scrollDown(true);
  }
  renderList();
});

// The agent wants to click something consequential — ask before it happens.
window.internall.onConfirm(({ agentId, id, title, detail }) => {
  if (agentId !== activeId) {
    window.internall.respondConfirm(id, false);
    return;
  }
  const card = document.createElement('div');
  card.className = 'confirm-card';
  card.innerHTML = `<b></b><small></small>
    <div class="row-btns"><button class="allow">Allow</button><button class="block">Not now</button></div>`;
  card.querySelector('b').textContent = `🔒 ${title}`;
  card.querySelector('small').textContent = detail || '';

  const sub = $('ch-sub');
  sub.className = 'ch-sub typing';
  sub.textContent = 'waiting for your approval…';

  const answer = (ok) => {
    window.internall.respondConfirm(id, ok);
    card.classList.add('done');
    card.querySelector('.row-btns').remove();
    card.querySelector('small').textContent = ok ? 'You allowed this.' : 'You blocked this.';
    setSub(agentById(activeId));
  };
  card.querySelector('.allow').onclick = () => answer(true);
  card.querySelector('.block').onclick = () => answer(false);

  // Lives in the transcript, not the live buffer, so it survives the turn ending.
  closeGroup(); // an approval must be visible, not folded into the activity row
  $('messages').appendChild(card);
  scrollDown();
});

// A dropped stream chunk: the turn restarts, so throw away what was half-drawn.
window.internall.onStreamReset(({ agentId }) => {
  if (agentId !== activeId) return;
  clearLive();
  setGroupLabel('Reconnecting…', true);
});

window.internall.onStreamStatus(({ agentId, status }) => {
  if (agentId !== activeId) return;
  setGroupLabel(status, true);
  const sub = $('ch-sub');
  sub.className = 'ch-sub typing';
  sub.textContent = status;
});

window.internall.onStreamError(({ agentId, error }) => {
  if (agentId === activeId) {
    clearLive();
    const e = document.createElement('div');
    e.className = 'err';
    e.textContent = '⚠️ ' + error;
    $('messages').appendChild(e);
    scrollDown();
  }
});

window.internall.onStreamEnd(({ agentId }) => {
  streaming.delete(agentId);
  if (agentId === activeId) {
    clearLive();
    closeGroup();
    setSub(agentById(agentId));
  }
  updateSendState();
  renderList();
});

function updateSendState() {
  const busy = streaming.has(activeId);
  $('send').classList.toggle('hidden', busy);
  $('stop').classList.toggle('hidden', !busy);
}
setInterval(updateSendState, 250);

/* Stick-to-bottom. Measuring "am I near the bottom?" at paint time races the
   scroll animation — once it falls behind it never recovers — so the intent is
   tracked explicitly and only the user's own scrolling turns it off. */
let stick = true;

$('messages').addEventListener('scroll', () => {
  const box = $('messages');
  stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
});

function scrollDown(force) {
  const box = $('messages');
  if (force) stick = true;
  if (stick) box.scrollTop = box.scrollHeight;
}

/* ──────────────────────────  Agent editor  ────────────────────────── */

let pickedEmoji = '🤖';
let pickedColor = COLORS[0];
let pickedAvatar = { kind: 'art', seed: randomSeed() };

function buildPickers() {
  const er = $('emoji-row');
  EMOJIS.forEach((e) => {
    const b = document.createElement('button');
    b.textContent = e;
    b.onclick = () => {
      pickedEmoji = e;
      pickedAvatar = { kind: 'emoji' };
      syncPreview();
    };
    er.appendChild(b);
  });
  const cr = $('color-row');
  COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.style.background = c;
    b.onclick = () => {
      pickedColor = c;
      pickedAvatar = { kind: 'emoji' };
      syncPreview();
    };
    cr.appendChild(b);
  });
  $('shuffle-avatar').onclick = () => {
    pickedAvatar = { kind: 'art', seed: randomSeed() };
    syncPreview();
  };
}

function syncPreview() {
  paintAvatar($('avatar-preview'), {
    avatar: pickedAvatar,
    emoji: pickedEmoji,
    color: pickedColor,
    id: pickedAvatar.seed,
  });
  const art = pickedAvatar.kind === 'art';
  $('emoji-row').classList.toggle('dim', art);
  $('color-row').classList.toggle('dim', art);
  [...$('emoji-row').children].forEach((b) => b.classList.toggle('sel', !art && b.textContent === pickedEmoji));
  [...$('color-row').children].forEach((b) => b.classList.toggle('sel', !art && b.style.background === hexToRgb(pickedColor)));
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

async function fillModels(provider, selected) {
  const sel = $('f-model');
  sel.innerHTML = `<option value="">Loading…</option>`;
  if (!providers[provider]?.hasKey) {
    sel.innerHTML = `<option value="">No ${PROVIDER_LABEL[provider]} key — add one in Settings</option>`;
    return;
  }
  const { models, fallback } = await window.internall.listModels(provider);
  sel.innerHTML = '';
  const list = models.length ? models : [{ id: fallback, label: fallback }];
  list.forEach((m) => {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    sel.appendChild(o);
  });
  sel.value = list.some((m) => m.id === selected) ? selected : fallback || list[0].id;
}

$('f-provider').onchange = () => fillModels($('f-provider').value, '');

function openAgentModal(agent) {
  editingId = agent?.id || null;
  $('modal-title').textContent = agent ? 'Edit agent' : 'New agent';
  $('f-name').value = agent?.name || '';
  $('f-desc').value = agent?.description || '';
  const provider = agent?.provider || (providers.openai.hasKey ? 'openai' : 'anthropic');
  $('f-provider').value = provider;
  fillModels(provider, agent?.model || '');
  $('f-web').checked = agent ? Boolean(agent.tools?.web) : true;
  $('f-browser').checked = agent ? Boolean(agent.tools?.browser) : true;
  $('f-confirm').checked = agent ? agent.tools?.confirm !== false : true;
  $('f-apps').checked = agent ? agent.tools?.apps !== false : true;
  $('f-tasks').checked = agent ? agent.tools?.tasks !== false : true;
  pickedEmoji = agent?.emoji || EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  pickedColor = agent?.color || COLORS[Math.floor(Math.random() * COLORS.length)];
  // New agents get a fresh random picture; existing ones keep the face they have.
  pickedAvatar = agent?.avatar
    ? { ...agent.avatar, seed: agent.avatar.seed || agent.id }
    : { kind: 'art', seed: randomSeed() };
  $('f-delete').classList.toggle('hidden', !agent);
  syncPreview();
  $('agent-modal').classList.remove('hidden');
  setTimeout(() => $('f-name').focus(), 40);
}

$('new-agent').onclick = () => openAgentModal(null);
$('edit-agent').onclick = () => activeId && openAgentModal(agentById(activeId));
$('f-cancel').onclick = () => $('agent-modal').classList.add('hidden');

$('f-save').onclick = async () => {
  const name = $('f-name').value.trim();
  if (!name) return $('f-name').focus();
  const agent = {
    id: editingId || undefined,
    name,
    description: $('f-desc').value.trim(),
    emoji: pickedEmoji,
    color: pickedColor,
    avatar: pickedAvatar,
    provider: $('f-provider').value,
    model: $('f-model').value,
    tools: {
      web: $('f-web').checked,
      browser: $('f-browser').checked,
      confirm: $('f-confirm').checked,
      apps: $('f-apps').checked,
      tasks: $('f-tasks').checked,
    },
  };
  agents = await window.internall.saveAgent(agent);
  if (!editingId) activeId = agents[0].id;
  $('agent-modal').classList.add('hidden');
  renderList();
  renderChat();
};

$('f-delete').onclick = async () => {
  if (!editingId) return;
  const res = await window.internall.deleteAgent(editingId);
  agents = res.agents;
  activeId = res.activeId;
  $('agent-modal').classList.add('hidden');
  renderList();
  renderChat();
};

/* ──────────────────────────  Settings  ────────────────────────── */

const DEFAULT_HINTS = {
  openai: $('s-openai-hint').textContent,
  anthropic: $('s-anthropic-hint').textContent,
};

async function renderUsage() {
  const rows = await window.internall.listUsage();
  const list = $('usage-list');
  list.innerHTML = '';
  const total = rows.reduce((n, r) => n + (r.usage.cost || 0), 0);
  $('usage-total').textContent = rows.length ? `· $${total.toFixed(2)} total` : '';

  if (!rows.length) {
    list.innerHTML = `<p class="hint">Nothing yet — usage is recorded from the next message on.</p>`;
    return;
  }

  for (const r of rows) {
    const cachedPct = r.usage.in ? Math.round((r.usage.cached / r.usage.in) * 100) : 0;
    const row = document.createElement('div');
    row.className = 'usage-row';
    row.innerHTML = `
      <div class="usage-body"><b></b><small></small></div>
      <span class="usage-cost"></span>`;
    row.querySelector('b').textContent = r.name;
    row.querySelector('small').textContent =
      `${r.model || 'no model'} · ${r.usage.requests} request${r.usage.requests === 1 ? '' : 's'} · ` +
      `${fmtTokens(r.usage.in)} in (${cachedPct}% cached) · ${fmtTokens(r.usage.out)} out`;
    row.querySelector('.usage-cost').textContent = r.priced ? `$${(r.usage.cost || 0).toFixed(3)}` : '—';
    list.appendChild(row);
  }
}

const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

function openSettings() {
  $('s-openai').value = '';
  $('s-anthropic').value = '';
  for (const p of ['openai', 'anthropic']) {
    $(`s-${p}-hint`).className = 'hint';
    $(`s-${p}-hint`).textContent = DEFAULT_HINTS[p];
  }
  renderUsage();
  $('settings-modal').classList.remove('hidden');
  setTimeout(() => $('s-openai').focus(), 40);
}
document.querySelectorAll('.test').forEach((btn) => {
  btn.onclick = async () => {
    const p = btn.dataset.provider;
    const hint = $(`s-${p}-hint`);
    const typed = $(`s-${p}`).value.trim();
    btn.disabled = true;
    hint.className = 'hint';
    hint.textContent = 'Checking…';
    const res = await window.internall.testApiKey(p, typed || null);
    hint.className = `hint ${res.ok ? 'good' : 'bad'}`;
    hint.textContent = (res.ok ? '✓ ' : '✕ ') + res.message;
    btn.disabled = false;
  };
});

$('settings-btn').onclick = openSettings;
$('s-cancel').onclick = () => $('settings-modal').classList.add('hidden');
$('s-save').onclick = async () => {
  let status = null;
  for (const p of ['openai', 'anthropic']) {
    const key = $(`s-${p}`).value.trim();
    if (key) status = await window.internall.setApiKey(p, key);
  }
  if (status) applyProviders(status);
  await window.internall.setTheme($('s-theme').value);
  $('settings-modal').classList.add('hidden');
};

$('search').addEventListener('input', (e) => {
  filter = e.target.value;
  renderList();
});

/* ──────────────────────────  Browser pane  ────────────────────────── */

const wv = $('webview');

/* Sidebar collapsing. It folds to an avatar rail on its own whenever the browser
   takes the screen, and unfolds when the browser closes. A manual toggle wins
   until the browser opens or closes again, so the automatic behaviour never
   fights a deliberate choice. */
let sidebarManual = null;

function setSidebar(collapsed) {
  document.querySelector('.sidebar').classList.toggle('collapsed', collapsed);
  $('toggle-sidebar').title = collapsed ? 'Show agent list (⌘\\)' : 'Collapse agent list (⌘\\)';
}

const sidebarCollapsed = () => document.querySelector('.sidebar').classList.contains('collapsed');
const browserOpen = () => !$('browser-pane').classList.contains('hidden');

function autoSidebar() {
  sidebarManual = null;
  setSidebar(browserOpen());
}

function toggleSidebar() {
  sidebarManual = !sidebarCollapsed();
  setSidebar(sidebarManual);
}

$('toggle-sidebar').onclick = toggleSidebar;

// The browser docks next to the chat instead of replacing it.
function showBrowser() {
  if (browserOpen()) return;
  $('browser-pane').classList.remove('hidden');
  $('divider').classList.remove('hidden');
  autoSidebar();
}
function showChat() {
  if (!browserOpen()) return;
  $('browser-pane').classList.add('hidden');
  $('divider').classList.add('hidden');
  setDriving(false);
  autoSidebar();
}
function toggleBrowser() {
  $('browser-pane').classList.contains('hidden') ? showBrowser() : showChat();
}

/* Drag the divider to resize the browser panel. */
(function makeResizable() {
  const divider = $('divider');
  let dragging = false;
  divider.addEventListener('mousedown', (e) => {
    dragging = true;
    divider.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const app = document.querySelector('.app').getBoundingClientRect();
    const w = Math.min(Math.max(app.right - e.clientX, 340), app.width - 520);
    document.documentElement.style.setProperty('--browser-w', `${w}px`);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    document.body.style.cursor = '';
  });
})();

/* "Agent is working" state on the browser panel. */
let drivingTimer = null;
function setDriving(on, label) {
  const pane = $('browser-pane');
  const badge = $('agent-driving');
  clearTimeout(drivingTimer);
  pane.classList.toggle('busy', Boolean(on));
  badge.classList.toggle('hidden', !on);
  if (on) {
    $('agent-driving-text').textContent = label || 'agent is working…';
    drivingTimer = setTimeout(() => setDriving(false), 6000);
  }
}

const ACTION_LABEL = {
  browser_open: (d) => `opening ${d.host || 'a page'}…`,
  browser_read: () => 'reading the page…',
  browser_links: () => 'scanning links…',
  browser_fields: () => 'looking at the form…',
  browser_fill: (d) => (d.detail ? `typing into “${d.detail}”…` : 'typing…'),
  browser_select: () => 'choosing an option…',
  browser_click: () => 'clicking…',
  browser_press: () => 'pressing a key…',
};

$('open-browser').onclick = toggleBrowser;
$('b-close').onclick = showChat;
$('b-back').onclick = () => wv.canGoBack() && wv.goBack();
$('b-fwd').onclick = () => wv.canGoForward() && wv.goForward();
$('b-reload').onclick = () => wv.reload();
$('b-external').onclick = () => window.internall.openExternal(wv.getURL());

$('b-url').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const v = $('b-url').value.trim();
  if (!v) return;
  const isUrl = /^https?:\/\//i.test(v) || /^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(v);
  wv.loadURL(isUrl ? (/^https?:\/\//i.test(v) ? v : 'https://' + v) : 'https://duckduckgo.com/?q=' + encodeURIComponent(v));
  $('b-url').blur();
});

['did-navigate', 'did-navigate-in-page'].forEach((ev) =>
  wv.addEventListener(ev, () => {
    if (document.activeElement !== $('b-url')) $('b-url').value = wv.getURL();
    $('b-back').disabled = !wv.canGoBack();
    $('b-fwd').disabled = !wv.canGoForward();
  })
);

window.internall.onAgentNavigate(({ url }) => {
  $('b-url').value = url;
  showBrowser();
});

// Every page action the agent takes pops the panel open and shows what it's doing.
window.internall.onAgentAction((d) => {
  showBrowser();
  setDriving(true, (ACTION_LABEL[d.action] || (() => 'agent is working…'))(d));
});

/* ──────────────────────────  Menu  ────────────────────────── */

window.internall.onMenu(async (cmd) => {
  if (cmd === 'new-agent') openAgentModal(null);
  if (cmd === 'settings') openSettings();
  if (cmd === 'search') {
    if (sidebarCollapsed()) toggleSidebar(); // the search box lives in the expanded list
    $('search').focus();
  }
  if (cmd === 'browser') toggleBrowser();
  if (cmd === 'sidebar') toggleSidebar();
  if (cmd === 'clear' && activeId) {
    await window.internall.clearAgent(activeId);
    agentById(activeId).messages = [];
    renderChat();
    renderList();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('app-overlay').classList.contains('hidden')) return collapseApp();
    $('agent-modal').classList.add('hidden');
    $('settings-modal').classList.add('hidden');
    $('tasks-modal').classList.add('hidden');
  }
});

// Images the agent embedded: click to open full size, hide the ones that 404.
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (img && img.classList && img.classList.contains('chat-img')) img.classList.add('broken');
  },
  true
);

document.addEventListener('click', (e) => {
  const img = e.target.closest?.('img.chat-img');
  if (!img) return;
  e.preventDefault();
  wv.loadURL(img.src);
  showBrowser();
});

// Links inside bubbles open in the built-in browser.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="http"]');
  if (!a) return;
  e.preventDefault();
  wv.loadURL(a.href);
  showBrowser();
});

/* ──────────────────────────  Helpers  ────────────────────────── */

function shortTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'long', day: 'numeric' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Small, dependency-free markdown renderer. Escapes first, so it is XSS-safe. */
function markdown(src) {
  let s = escapeHtml(src || '');
  const codes = [];

  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, body) => {
    codes.push(`<pre><code data-lang="${lang}">${body.replace(/\n$/, '')}</code></pre>`);
    return `\0${codes.length - 1}\0`;
  });
  s = s.replace(/`([^`\n]+)`/g, (_m, c) => {
    codes.push(`<code>${c}</code>`);
    return `\0${codes.length - 1}\0`;
  });

  s = s.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.*)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.*)$/gm, '<h1>$1</h1>')
    .replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
      '<img class="chat-img" src="$2" alt="$1" title="$1" loading="lazy">')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s])(https?:\/\/[^\s<"]+)/g, '$1<a href="$2">$2</a>');

  // lists
  s = s.replace(/(?:^[-*+]\s+.*(?:\n|$))+/gm, (block) => {
    const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^[-*+]\s+/, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });
  s = s.replace(/(?:^\d+\.\s+.*(?:\n|$))+/gm, (block) => {
    const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^\d+\.\s+/, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // paragraphs
  s = s
    .split(/\n{2,}/)
    .map((p) => (/^\s*<(h\d|ul|ol|pre|blockquote)/.test(p) ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`))
    .join('');

  return s.replace(/\0(\d+)\0/g, (_m, i) => codes[+i]);
}
