# Internall

A Telegram-style macOS desktop app for talking to your own AI agents. Each agent is a chat in
the sidebar, has its own description (which becomes its system prompt), can search the web, and
can drive the app's built-in browser tab.

Works with **OpenAI** or **Anthropic** — per agent, so a GPT agent and a Claude agent can sit
side by side in the same sidebar.

## Running it

```bash
cd app
npm install     # already done
npm start
```

On first launch the Settings sheet opens. Paste an **OpenAI API key**
(platform.openai.com → API keys) and/or an Anthropic key. Keys are encrypted with the macOS
Keychain (`safeStorage`) and stored in `~/Library/Application Support/Internall/slava-data.json`.
`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` in your environment are used automatically and take
precedence.

### Installing it as a real Mac app

```bash
npm run dist        # draws the icon, then packages Internall.app + a .dmg into dist/
```

That produces `dist/mac-universal/Internall.app` and `dist/Internall-0.1.0-universal.dmg`.
Drag the app to **/Applications**, open it once, then right-click its Dock icon →
**Options → Keep in Dock**.

The packaged app reads the same `~/Library/Application Support/Internall` as `npm start`, so agents,
keys, chats and scheduled tasks carry straight over — and only one copy can run at a time, since
two would overwrite each other's store.

### Sending it to someone else

`dist/Internall-0.1.0-universal.dmg` is **universal** (Apple Silicon + Intel) and ad-hoc signed, so it
runs on any Mac from macOS 11 up. It contains no keys and no chat data — the recipient adds their
own API key on first launch.

What they will hit: the app is **not notarised** (that needs a paid Apple Developer ID, which this
build does not have), so macOS quarantines anything downloaded and refuses the first launch.
Verified by re-downloading the DMG's app with a quarantine flag: Gatekeeper rejects it. Tell them
to either

- **right-click the app → Open**, then confirm in the dialog (or System Settings → Privacy &
  Security → *Open Anyway*), or
- run `xattr -dr com.apple.quarantine /Applications/Internall.app` once.

Both are one-time. Sending it as a zip over AirDrop between your own Macs usually avoids the flag
entirely.

The build signs the app ad-hoc in an `afterPack` hook (`scripts/ad-hoc-sign.js`) rather than
leaving it unsigned — an unsigned app reports as *"damaged"* on Apple Silicon, which has no
click-through, while an ad-hoc signed one gets the ordinary "unidentified developer" dialog that
does. For a universal build the hook deliberately skips the per-architecture temp passes, because
the merge step requires their non-binary files to match byte for byte.

The icon is generated, not a checked-in binary: `npm run icon` redraws `build/icon.icns` by
rendering HTML in Electron and converting it with `sips`/`iconutil`.

## What's in it

**Agents** — ⌘N, or the `+` in the sidebar. Give it a name, a provider and model, and a
description. Every new agent gets its own generated picture — soft abstract art drawn as an
SVG from a random seed, so no two agents look alike and nothing is downloaded or stored as an
image file. 🎲 Shuffle re-rolls it; picking an emoji or colour switches the agent to an emoji
face instead. The description *is* the agent's brief: it's injected as the system
prompt, so "a blunt code reviewer who only comments on real bugs" behaves very differently from
"a patient tutor". Each agent keeps its own conversation. Edit or delete one with the pencil
icon in the chat header.

**Drafts** — what you type is kept per chat. Switch agents mid-sentence and the box clears for
the new chat; come back and your text is where you left it, with a red "Draft:" note in the chat
list. Drafts persist across restarts and clear on send.

**Unread & ordering** — chats sort by most recent activity, newest on top. A reply that arrives
while you're in another chat (or with the window in the background — a scheduled task firing, say)
marks that chat unread: bold row, a blue count badge, and a dock badge on the app icon. Opening
the chat clears it and drops an "Unread messages" divider above the first message you hadn't seen.
A reply you watch arrive is never marked unread.

**Activity rows** — everything the agent does between messages (reasoning summaries and tool
steps alike) collapses into a single row: *"✻ Worked for 8s · 3 steps"*. Click it to expand the
whole trail. While a turn is running the row shows live status ("Searching the web — …"), then
folds itself away when the reply arrives. Approval prompts and app cards are never folded — they
close the row so they stay visible.

Note the reasoning shown there is the provider's **summary** of its reasoning, not raw
chain-of-thought — neither OpenAI nor Anthropic returns the raw trace.

**Streaming** — replies stream in as they're generated. Because deltas arrive in uneven bursts
(a whole sentence can land in one event), the renderer buffers them and reveals the text at a
steady ~55 chars/s, accelerating when it falls behind, with a blinking caret — so it reads as
typing rather than jumping. The header and sidebar show "typing…", and the send button becomes
a stop button.

**Models** — the dropdown is fetched live from whichever provider you have a key for
(`/v1/models`), so new models show up without an app update; it falls back to a static list if
the call fails.

**Internet access** (per agent toggle) — OpenAI agents get the hosted `web_search` tool,
Anthropic agents get `web_search` + `web_fetch`. The chat shows what it did as chips
("🔍 Searched the web — …"), and cited sources are listed under the reply.

**Browser control** (per agent toggle) — the agent drives a real Chromium tab that **docks open
beside the chat the moment it touches it**, so you watch the work happen rather than reading a
summary of it. Elements it acts on are outlined in the page with a label ("typing…",
"clicking…"), a badge floats over the panel saying what it's doing, and the panel glows while
it's busy. Every action is also logged as a chip in the transcript.

| Tool | What it does |
| --- | --- |
| `browser_open` | Loads a URL into the panel |
| `browser_read` | Returns the visible text of the current page (works on JS-heavy or logged-in pages) |
| `browser_links` | Lists links on the page, optionally filtered |
| `browser_images` | Lists the page's images with alt text, size and URL, largest first |
| `browser_fields` | Numbers every input, dropdown, checkbox, button and link, with labels and current values |
| `browser_fill` | Types into a field by number — fires the real input/change events, so React and Vue forms react normally |
| `browser_select` | Picks a dropdown option by visible text |
| `browser_click` | Clicks a numbered element |
| `browser_press` | Presses Enter / Tab / Escape (Enter inside a form submits it) |

So "apply to that conference for me" works: the agent opens the page, reads the form, fills each
field, ticks the box, shows you the filled form, and asks before it submits.

**Pictures** — anything the agent writes as `![description](https://…)` renders inline in the
chat, so "find me a photo of X" works: it opens a relevant page, calls `browser_images` to get real
image URLs, and embeds one. Tap an image to open it full size in the browser panel; images that
fail to load are hidden rather than left as a broken box.

**Ask before submitting** (per agent toggle, on by default) — any click that looks
consequential (a form's submit button, or text matching *submit / pay / buy / order / delete /
sign up / book …*), and Enter inside a form, pauses the agent and puts an **Allow / Not now**
card in the chat. Decline and the click never happens; the agent is told you declined and to ask
you instead of retrying.

**Mini-apps** (per agent toggle, on by default) — instead of answering a "find me…" question
with a wall of text, the agent can call `show_app` and build a small interactive app that opens
in **its own desktop window** — cards, filters, sorting, whatever fits the data. It writes one
self-contained HTML document; Internall saves it under `apps/` in the app's data folder and opens it
in a sandboxed window (no node access, its own preload).

Two things make it more than a static report:

- **It talks back.** The page can call `window.slavaApp.send("…")` to post a message into the
  chat — so an "Ask about this one" button on a listing continues the conversation about that
  listing. (`window.slavaApp.close()` closes the window.) If the agent is mid-run, the message is
  queued and delivered when the turn finishes, so it can't break tool-call pairing.
- **It updates in place.** Calling `show_app` again with the same title replaces that window's
  contents instead of opening a second one.

The generated HTML is kept out of the transcript — it's stored on disk and replaced with a short
stub in the message history, so a 6 KB app isn't re-sent to the model on every later turn. A card
in the chat reopens the window if you close it.

Deliberately **not** Next.js/TypeScript: that would mean an `npm install`, a build and a dev
server per answer — tens of seconds each. A self-contained document in a real window is instant
and just as interactive.

**Scheduled tasks** (per agent toggle, on by default) — say *"every morning check the news and
tell me"* and the agent schedules itself with `schedule_task`. Tasks are stored on disk and
survive quitting; a ticker checks every 30s and fires them.

- **Kinds:** once, daily, weekdays (Mon–Fri), weekly (a given day), or every N minutes.
- **When it fires**, the instruction arrives in that chat as a ⏰ line, the agent does the job
  normally (web, browser, apps — all available), and a **native notification** shows the first
  lines of the answer; clicking it opens that chat.
- **Missed runs:** if the app was closed when a task was due, it runs on next launch if it's less
  than 6 hours late, otherwise it skips to the next slot. A task never fires while that agent is
  mid-reply — it waits for the next tick.
- **Manage them** with the clock icon in the chat header (a green dot means something is
  scheduled). The list is scoped to the chat you're in — only that agent's tasks, with a note if
  other chats have their own. Pause, resume or delete any of them. The agent can also list and
  cancel its own with `list_tasks` / `cancel_task`, so "move it to 8am" works in conversation.

**Voice** (per agent toggle, on by default) — hold the microphone button in the composer, or
hold **⌥** anywhere in the window, and talk. Releasing transcribes what you said and sends it.
The reply is read back aloud in the agent's own voice, picked from its id so two chats rarely
sound alike and changeable in the agent editor, where **Hear it** plays a sample.

- **It starts talking before the answer is finished.** Speech is requested a sentence at a time
  while the reply is still streaming — the opening clause goes out as soon as there is one, then
  longer chunks, fetched in parallel and played in order. Waiting for the whole answer would add
  several seconds of silence to anything long.
- **Interrupting works.** Holding the mic, sending a new message, pressing Stop or leaving the
  chat cuts the voice off mid-word, and the speaker icon in the header mutes it for good.
- **Only the chat you're looking at speaks** — a scheduled task finishing in another chat stays
  quiet rather than talking over the one in front of you.
- **Markdown is stripped before it is spoken**, so code fences, link URLs and emphasis markers
  don't get read out as punctuation.
- **Both halves go through OpenAI.** Anthropic publishes no audio API, so a Claude agent still
  needs an OpenAI key to be talked to; without one the composer says so instead of failing
  silently. Transcription falls back from `gpt-4o-transcribe` to `whisper-1`, and speech from
  `gpt-4o-mini-tts` to `tts-1`, if the account lacks the newer model.
- **The microphone is reachable from the chat window and nowhere else.** A permission handler
  grants it to the main window only and denies it to the browser panel and to mini-apps, so a
  site the agent visits cannot put a microphone prompt in front of you wearing the app's face.

**Browser panel** — ⌘B, or the globe icon in the chat header. Back / forward / reload, an
address bar (a non-URL is searched on DuckDuckGo), "open in Safari", and a draggable divider to
resize it. It keeps its own persistent session, so sites you log into stay logged in — which is
what makes reading and filling far more useful than plain fetching. Links inside messages open
here too. You can take over and use it yourself at any time.

## Shortcuts

| | |
| --- | --- |
| ⌘N | New agent |
| ⌘K | Search agents |
| ⌘\ | Collapse / expand the agent list |
| ⌘B | Toggle browser |
| ⌘, | Settings |
| ⌘⌫ | Clear the current conversation |
| ⏎ / ⇧⏎ | Send / newline |
| hold ⌥ | Talk to the agent |

## Layout

```
app/
├─ main.js              Electron main: window, store, both providers, browser tools
├─ preload.js           contextBridge surface (contextIsolation on, no node in renderer)
├─ renderer/
│  ├─ index.html        Sidebar, chat pane, browser pane, modals
│  ├─ styles.css        Theme tokens, light + dark, vibrancy sidebar
│  └─ app.js            Rendering, streaming, markdown, browser wiring
└─ package.json
```

`runAgent()` in `main.js` picks the provider and hands off to `runOpenAI()` (Responses API,
`client.responses.stream`) or `runAnthropic()` (Messages API, `client.messages.stream`). Both
stream deltas to the renderer over the same IPC events, execute browser tools, feed results
back, and loop until the model is done.

History is stored in a provider-neutral shape — `blocks` for what the UI renders, plus the
provider's own `raw` payload replayed verbatim on the next request so reasoning items and tool
calls stay valid. Switching an agent's provider mid-conversation keeps the transcript: the
other provider's turns are passed through as plain text.
