import { Agent } from '../types';

export type ToolDef = { name: string; description: string; parameters: any };

const obj = (properties: Record<string, any>, required?: string[]) => ({
  type: 'object',
  properties,
  required: required ?? Object.keys(properties),
  additionalProperties: false,
});

export const BROWSER_TOOLS: ToolDef[] = [
  {
    name: 'browser_open',
    description:
      "Open a URL in the app's built-in browser, which slides up so the user can watch. Returns " +
      'the final URL and page title after loading.',
    parameters: obj({ url: { type: 'string', description: 'Absolute URL including https://' } }),
  },
  {
    name: 'browser_read',
    description:
      'Read the visible text of the page currently open in the built-in browser. Works on pages ' +
      'needing JavaScript or a logged-in session.',
    parameters: obj({}, []),
  },
  {
    name: 'browser_links',
    description: 'List links on the current page, optionally filtered by a case-insensitive substring.',
    parameters: obj({ query: { type: 'string', description: 'Substring filter; empty string for all' } }),
  },
  {
    name: 'browser_images',
    description:
      'List the images on the current page with alt text, size and absolute URL, largest first. ' +
      "Use it to find a real picture — a person's photo, a product shot, a chart — that you can " +
      'show the user by putting its URL in your reply as markdown: ![short description](https://…). ' +
      'Optionally filter by a case-insensitive substring.',
    parameters: obj({ query: { type: 'string', description: 'Substring filter; empty for all' } }),
  },
  {
    name: 'browser_fields',
    description:
      'Inspect the interactive elements on the current page — inputs, checkboxes, dropdowns, ' +
      'buttons, links — with labels and values. Each gets a number for browser_fill / ' +
      'browser_click / browser_select. Call it again after the page changes; numbers are reassigned.',
    parameters: obj({}, []),
  },
  {
    name: 'browser_fill',
    description:
      'Type a value into the numbered field. For a checkbox or radio pass "true"/"false". Fires ' +
      'the events a real keystroke does, so JavaScript forms react normally.',
    parameters: obj({
      field: { type: 'number', description: 'Field number from browser_fields' },
      value: { type: 'string', description: 'Text to enter' },
    }),
  },
  {
    name: 'browser_select',
    description: 'Choose an option in a dropdown by visible text or value.',
    parameters: obj({
      field: { type: 'number', description: 'Dropdown number from browser_fields' },
      option: { type: 'string', description: 'Visible text (or value) of the option' },
    }),
  },
  {
    name: 'browser_click',
    description:
      'Click the numbered element. The user sees it highlighted first. Consequential clicks may ' +
      'ask the user to approve them.',
    parameters: obj({ field: { type: 'number', description: 'Element number from browser_fields' } }),
  },
  {
    name: 'browser_press',
    description: 'Press a key in the focused field — "Enter" to submit a form, "Tab", or "Escape".',
    parameters: obj({ key: { type: 'string', description: '"Enter", "Tab" or "Escape"' } }),
  },
];

export const APP_TOOL: ToolDef = {
  name: 'show_app',
  description:
    'Build a small interactive app and open it full-screen on the phone. Use it instead of a long ' +
    'text list whenever the answer is a set of things the user will compare, filter, sort or pick ' +
    'from — listings, results, options, schedules, budgets. Build it from what you actually found; ' +
    'do not invent data.\n\n' +
    'Write ONE complete self-contained HTML document in `html`:\n' +
    '- Inline all CSS and JavaScript. No external stylesheets, CDNs or frameworks — they will not ' +
    'load. Remote <img> URLs do work.\n' +
    '- Design it for a PHONE: single column, large touch targets (44px+), system font stack, ' +
    '`<meta name="viewport" content="width=device-width, initial-scale=1">`, and support light and ' +
    'dark via prefers-color-scheme.\n' +
    '- Make it interactive: filters, sorting, search, expandable detail.\n' +
    '- The user can act on it: `window.internall.send("...")` sends a message back into the chat ' +
    '(e.g. an "Ask about this one" button) and `window.internall.close()` closes it.\n\n' +
    'Calling this again with the same title replaces that app. Afterwards tell the user in one ' +
    'short line what they can do in it — do not repeat its contents.',
  parameters: obj({
    title: { type: 'string', description: 'Title, e.g. "Pet-friendly rentals in Burnaby"' },
    html: { type: 'string', description: 'The complete self-contained HTML document' },
  }),
};

export const TASK_TOOLS: ToolDef[] = [
  {
    name: 'schedule_task',
    description:
      'Remember a job and run it later without the user asking again — "every morning", "each ' +
      'Monday", "in an hour". The task survives closing the app and repeats until cancelled.\n' +
      'Write `instruction` as a complete instruction to your future self; the original request will ' +
      'not be there to read. Confirm the exact time back to the user.',
    parameters: obj({
      instruction: { type: 'string', description: 'What to do when it fires' },
      kind: {
        type: 'string',
        enum: ['in', 'once', 'daily', 'weekdays', 'weekly', 'interval'],
        description:
          'in = once, N minutes from now (use for "in 2 minutes" — never compute a clock time ' +
          'yourself); once = a single future clock time; weekdays = Mon–Fri; interval = every N minutes',
      },
      time: { type: 'string', description: 'Local 24h "HH:MM" for once/daily/weekdays/weekly; "" otherwise' },
      date: { type: 'string', description: 'For kind=once: "YYYY-MM-DD"; "" otherwise' },
      weekday: { type: 'number', description: 'For kind=weekly: 0=Sunday … 6=Saturday; -1 otherwise' },
      every_minutes: { type: 'number', description: 'For kind=interval: minutes between runs (min 15); 0 otherwise' },
      in_minutes: { type: 'number', description: 'For kind=in: minutes from now (min 1); 0 otherwise' },
    }),
  },
  {
    name: 'list_tasks',
    description: 'List the scheduled tasks for this chat with their ids and next run times.',
    parameters: obj({}, []),
  },
  {
    name: 'cancel_task',
    description: 'Cancel a scheduled task by id (from list_tasks).',
    parameters: obj({ id: { type: 'string', description: 'The task id' } }),
  },
];

export function clientTools(agent: Agent): ToolDef[] {
  return [
    ...(agent.tools.browser ? BROWSER_TOOLS : []),
    ...(agent.tools.apps ? [APP_TOOL] : []),
    ...(agent.tools.tasks ? TASK_TOOLS : []),
  ];
}

export function systemPrompt(agent: Agent) {
  const parts = [
    `You are "${agent.name}", an agent inside Internall, a chat app on the user's phone.`,
    '',
    'Your role, as defined by the user:',
    agent.description || '(no description given — be a helpful, concise assistant)',
    '',
    'Stay in this role. Reply in the style of a messaging app: short paragraphs, no headings ' +
      'unless the answer needs them, markdown for emphasis, lists and code. Keep it tight — this ' +
      'is a phone screen.',
  ];

  if (agent.tools.web) {
    parts.push(
      '',
      'You can search the web. Do so whenever the answer depends on current or verifiable ' +
        'information, and say where a fact came from.'
    );
  }

  if (agent.tools.browser) {
    parts.push(
      '',
      'You can drive a real browser that slides up in front of the user, so they watch you work.',
      'How to work a page: browser_open → browser_fields → browser_fill / browser_select → ' +
        'browser_fields again to check → browser_click (or browser_press Enter) to submit.',
      'The numbers change every time you call browser_fields, so re-read them after the page ' +
        'changes. Never invent personal data: if a field needs something the user has not given ' +
        'you, stop and ask in the chat. If they decline a click, do not retry — ask what they want.',
      '',
      'You can show pictures in the chat: any image URL written as markdown — ' +
        '![short description](https://…) — is rendered inline. When a photo genuinely helps, find ' +
        'one with browser_images on a relevant page and include it. Direct image URLs only, never ' +
        'a link to a page, and one or two pictures rather than a wall of them.'
    );
  }

  if (agent.tools.apps) {
    parts.push(
      '',
      'You can build a small interactive app with show_app when the answer is a set of things to ' +
        'compare, filter or choose from. Put the detail in the app and keep the chat to a sentence.'
    );
  }

  if (agent.tools.tasks) {
    parts.push(
      '',
      'You can schedule work with schedule_task and manage it with list_tasks / cancel_task. Use ' +
        'kind="in" with in_minutes for anything relative ("in 2 minutes"); never compute a clock ' +
        'time yourself. Repeat back the exact time the tool reports. A fired task arrives as a ' +
        'message starting with ⏰ — just do the job and report the result plainly.'
    );
  }

  const now = new Date();
  parts.push(
    '',
    `Right now it is ${now.toLocaleString()} in the user's timezone ` +
      `(${Intl.DateTimeFormat().resolvedOptions().timeZone}). That clock is accurate as of the ` +
      'start of this turn.'
  );
  return parts.join('\n');
}
