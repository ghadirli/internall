/* Exercises the mobile app's real compiled logic in node, with the native
   modules stubbed out. Tests scheduling maths and both providers' transcript
   handling — the parts most likely to be wrong and hardest to eyeball. */
const Module = require('module');
const path = require('path');

const stubs = {
  'expo-notifications': {
    SchedulableTriggerInputTypes: { DATE: 'date' },
    AndroidImportance: { DEFAULT: 3, MAX: 5 },
    scheduleNotificationAsync: async () => 'notif-1',
    cancelScheduledNotificationAsync: async () => {},
    getPermissionsAsync: async () => ({ status: 'granted' }),
    requestPermissionsAsync: async () => ({ status: 'granted' }),
    setNotificationHandler: () => {},
    setNotificationChannelAsync: async () => {},
  },
  'expo-secure-store': { getItemAsync: async () => null, setItemAsync: async () => {} },
  '@react-native-async-storage/async-storage': {
    default: { getItem: async () => null, setItem: async () => {} },
  },
  react: { useSyncExternalStore: () => null },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (stubs[request]) return 'STUB:' + request;
  return origResolve.call(this, request, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (stubs[request]) return stubs[request];
  return origLoad.call(this, request, ...rest);
};

const B = '/tmp/slavatest';
const sched = require(path.join(B, 'scheduler.js'));
const openai = require(path.join(B, 'providers/openai.js'));
const anthropic = require(path.join(B, 'providers/anthropic.js'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};
const fmt = (ms) => new Date(ms).toLocaleString('en-CA', { hour12: false });

console.log('\nSCHEDULER');
{
  const now = new Date('2026-08-20T09:30:00').getTime();

  const inTask = { kind: 'in', inMinutes: 2, time: '', date: '', weekday: -1, everyMinutes: 0 };
  const inNext = sched.computeNext(inTask, now);
  ok('"in 2 minutes" lands 2 minutes out', inNext === now + 120000, fmt(inNext));

  const daily = { kind: 'daily', time: '07:00', date: '', weekday: -1, everyMinutes: 0, inMinutes: 0 };
  const d = new Date(sched.computeNext(daily, now));
  ok('daily 07:00 after 09:30 → tomorrow 07:00', d.getHours() === 7 && d.getDate() === 21, fmt(d.getTime()));

  const dailyLater = { ...daily, time: '18:00' };
  const dl = new Date(sched.computeNext(dailyLater, now));
  ok('daily 18:00 before 18:00 → today', dl.getHours() === 18 && dl.getDate() === 20, fmt(dl.getTime()));

  // 2026-08-20 is a Thursday; Friday 21st is a weekday, Saturday 22nd is not.
  const wd = new Date(sched.computeNext({ ...daily, kind: 'weekdays', time: '07:00' }, now));
  ok('weekdays skips to Friday', wd.getDay() === 5, fmt(wd.getTime()));

  const satNow = new Date('2026-08-22T09:00:00').getTime(); // Saturday
  const wd2 = new Date(sched.computeNext({ ...daily, kind: 'weekdays', time: '07:00' }, satNow));
  ok('weekdays from Saturday → Monday', wd2.getDay() === 1, fmt(wd2.getTime()));

  const weekly = new Date(sched.computeNext({ ...daily, kind: 'weekly', weekday: 1, time: '08:00' }, now));
  ok('weekly Monday → next Monday', weekly.getDay() === 1, fmt(weekly.getTime()));

  const iv = sched.computeNext({ ...daily, kind: 'interval', everyMinutes: 5 }, now);
  ok('interval clamps to 15 min minimum', iv === now + 15 * 60000, String((iv - now) / 60000));

  const onceDated = new Date(sched.computeNext({ ...daily, kind: 'once', date: '2026-09-01', time: '14:30' }, now));
  ok('once with a date honours it', onceDated.getMonth() === 8 && onceDated.getDate() === 1 && onceDated.getHours() === 14, fmt(onceDated.getTime()));

  ok('one-shot kinds', sched.isOneShot('in') && sched.isOneShot('once') && !sched.isOneShot('daily'));
  ok('label for "in"', sched.taskLabel({ ...inTask, nextRun: null }).includes('in 2 minutes'), sched.taskLabel({ ...inTask, nextRun: null }));
  ok('label for weekly', sched.taskLabel({ ...daily, kind: 'weekly', weekday: 1 }) === 'every Monday at 07:00', sched.taskLabel({ ...daily, kind: 'weekly', weekday: 1 }));
}

console.log('\nOPENAI TRANSCRIPT');
{
  const dirty = [
    { type: 'function_call', call_id: 'c1', name: 'show_app', arguments: '{"title":"T"}', parsed_arguments: null },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi', annotations: [], parsed: null }] },
  ];
  const clean = openai.cleanOutput(dirty);
  const s = JSON.stringify(clean);
  ok('strips parsed_arguments', !s.includes('parsed_arguments'));
  ok('strips content[].parsed', !/"parsed"/.test(s));
  ok('keeps the call itself', clean[0].call_id === 'c1' && clean[0].arguments === '{"title":"T"}');

  const blocks = openai.blocksFrom([
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking hard' }] },
    { type: 'web_search_call', action: { query: 'aapl' } },
    { type: 'function_call', name: 'browser_open', arguments: '{"url":"https://x.com"}' },
    { type: 'message', content: [{ type: 'output_text', text: 'done', annotations: [{ type: 'url_citation', url: 'https://a.b', title: 'A' }] }] },
  ]);
  ok('blocks: thinking + 2 tools + text', blocks.length === 4 && blocks[0].type === 'thinking' && blocks[3].type === 'text');
  ok('citations carried', blocks[3].citations[0].url === 'https://a.b');

  const agent = {
    messages: [
      { role: 'user', ts: 1, text: 'hello' },
      { role: 'assistant', ts: 2, provider: 'openai', blocks: [], raw: { output: [{ type: 'function_call', call_id: 'c1', name: 'x', arguments: '{}', parsed_arguments: null }] } },
      { role: 'tool', ts: 3, provider: 'openai', raw: { items: [{ type: 'function_call_output', call_id: 'c1', output: 'ok' }] } },
      // A turn from the other provider must degrade to plain text, not vanish.
      { role: 'assistant', ts: 4, provider: 'anthropic', blocks: [{ type: 'text', text: 'from claude' }], raw: { content: [] } },
    ],
  };
  const input = openai.buildInput(agent);
  const js = JSON.stringify(input);
  ok('replayed input drops parsed_arguments', !js.includes('parsed_arguments'));
  ok('tool result replayed', js.includes('function_call_output'));
  ok('cross-provider turn kept as text', js.includes('from claude'));
  ok('input order preserved', input[0].content === 'hello' && input.length === 4);
}

console.log('\nANTHROPIC TRANSCRIPT');
{
  const blocks = anthropic.blocksFrom([
    { type: 'thinking', thinking: 'hmm' },
    { type: 'tool_use', id: 't1', name: 'browser_open', input: { url: 'https://x' } },
    { type: 'text', text: 'hi', citations: [{ url: 'https://c', title: 'C' }] },
  ]);
  ok('blocks mapped', blocks.length === 3 && blocks[1].name === 'browser_open');
  ok('citation mapped', blocks[2].citations[0].title === 'C');

  const msgs = anthropic.buildMessages({
    messages: [
      { role: 'user', ts: 1, text: 'q' },
      { role: 'assistant', ts: 2, provider: 'anthropic', blocks: [], raw: { content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] } },
      { role: 'tool', ts: 3, provider: 'anthropic', raw: { results: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    ],
  });
  ok('tool_use followed immediately by tool_result', msgs[1].role === 'assistant' && msgs[2].role === 'user' && msgs[2].content[0].type === 'tool_result');
  ok('result id matches the call', msgs[2].content[0].tool_use_id === 't1');

  const r = anthropic.toolResultBlocks([{ callId: 'a', output: 'boom', isError: true }]);
  ok('errors flagged', r[0].is_error === true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
