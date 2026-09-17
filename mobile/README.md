# Internall for iOS & Android

The phone version of the desktop app: the same agents, the same tools, one codebase
(React Native + Expo, TypeScript) that runs on both platforms.

## Running it

```bash
cd mobile
npm install          # already done
npm start            # then press i for the iOS simulator, a for Android,
                     # or scan the QR code with Expo Go on your own phone
```

On first launch, open **⚙️ Settings** and paste an OpenAI key (and/or an Anthropic one). Keys go
into the **iOS Keychain / Android Keystore** via `expo-secure-store` and are sent only to the
provider you picked — there is no server in between, because there is no server.

### Verifying a change

```bash
npm test             # typecheck + 25 logic tests (scheduling maths, both providers' transcripts)
npm run bundle-check # Metro bundles for iOS and Android
```

## What it does

Everything the desktop app does, adapted to a phone:

- **Agents** — a chat each, with a description that becomes its system prompt, a provider and
  model (fetched live from your account), and per-agent ability toggles. Every agent gets its own
  generated picture, drawn as an SVG from a seed — no image files, no downloads.
- **Streaming replies** with a collapsible activity row — *"✳︎ Worked for 8s · 3 steps"* — hiding
  the reasoning summary and every tool step behind one tap.
- **Internet access** — the hosted `web_search` tool on OpenAI, `web_search` + `web_fetch` on
  Anthropic, with sources listed under the reply.
- **Browser control** — a real WebView the agent drives: open, read, list links, inspect form
  fields, fill, select, tap, submit. It slides up so you watch it happen, elements are outlined in
  the page as they're used, and a badge says what it's doing. It keeps cookies and logins for the
  session.
- **Ask before submitting** — any tap that looks consequential pauses the agent and puts an
  Allow / Not now card in the chat.
- **Mini-apps** — `show_app` builds a self-contained HTML app and opens it full screen. It can talk
  back: `window.slavaApp.send("…")` posts into the chat, so an "Ask about this one" button
  continues the conversation. The HTML is stored on the device and kept out of the transcript so
  it is never re-sent to the model.
- **Scheduled tasks** — "every morning at 7, check the news". Relative times use `kind: "in"` so
  "in 2 minutes" needs no clock arithmetic.
- **Drafts per chat, unread badges, newest chat on top** — same as desktop.

## How mobile differs from the desktop app, on purpose

**Scheduled tasks can't run in the background.** iOS will not let an app make LLM calls while it is
closed. So a task is armed as a **local notification**: the OS fires it on time, and the work runs
when the app is in the foreground — immediately if it is already open, otherwise when you open it
(tapping the notification takes you straight to that chat). Stale runs are skipped: 6 hours' grace
for a daily briefing, 30 minutes for an "in N minutes" reminder.

**Streaming needs `expo/fetch`.** React Native's built-in `fetch` cannot stream a response body, so
`src/net/stream.ts` uses `expo/fetch` (which can) and falls back to `XMLHttpRequest`'s incremental
`responseText` anywhere it is missing.

**Notifications in Expo Go are limited.** Local scheduled notifications work, but for the full
behaviour use a development build (`npx expo run:ios` / `run:android`) — Expo Go prints a warning
about this at startup.

**API keys live on the device.** Anthropic requires an extra header for direct client calls, which
is set. If you would rather not have provider keys on a phone at all, the honest answer is that
this design needs a small proxy of your own, which this app does not have.

## Layout

```
mobile/
├─ App.tsx                  screens, notification wiring, task ticker
├─ src/
│  ├─ store.ts              persistence (AsyncStorage) + keys (SecureStore) + subscriptions
│  ├─ runtime.ts            the agent loop, tool dispatch, approval gate
│  ├─ scheduler.ts          task maths + local notifications
│  ├─ browserBridge.ts      injected page helpers, WebView control
│  ├─ avatar.ts             generated agent pictures
│  ├─ net/stream.ts         SSE streaming for RN
│  ├─ providers/            openai.ts (Responses API), anthropic.ts (Messages API)
│  ├─ tools/defs.ts         tool schemas + system prompt
│  └─ ui/                   ChatList, ChatScreen, Modals, Overlays, bits
└─ scripts/test-logic.js    the logic tests `npm test` runs
```

Transcripts use the same provider-neutral shape as the desktop app — `blocks` for what the UI
draws, `raw` for the provider's own payload replayed verbatim — so an agent can be switched between
OpenAI and Anthropic without losing its history.
