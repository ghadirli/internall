import React, { useEffect, useMemo, useState } from 'react';
import { Image as RNImage, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { avatarSVG } from '../avatar';
import { Theme } from '../theme';
import { Agent, Block, Citation } from '../types';

export function Avatar({ agent, size = 48 }: { agent: Agent; size?: number }) {
  const seed = agent.avatar?.seed || agent.id;
  const xml = useMemo(() => avatarSVG(seed), [seed]);
  if (agent.avatar?.kind === 'emoji') {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: agent.color || '#c62828',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontSize: size * 0.45 }}>{agent.emoji || '🤖'}</Text>
      </View>
    );
  }
  return <SvgXml xml={xml} width={size} height={size} />;
}

/* ── Markdown ──────────────────────────────────────────────────────────
   A small renderer: paragraphs, bullet/numbered lists, headings, code
   blocks, and inline bold / italic / code / links. */

type Seg = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string };

function inline(src: string): Seg[] {
  const out: Seg[] = [];
  const re = /(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)|(`([^`\n]+)`)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ text: src.slice(last, m.index) });
    if (m[2]) out.push({ text: m[2], bold: true });
    else if (m[4]) out.push({ text: m[4], italic: true });
    else if (m[6]) out.push({ text: m[6], code: true });
    else if (m[8]) out.push({ text: m[8], href: m[9] });
    else if (m[10]) out.push({ text: m[10], href: m[10] });
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out;
}

function Inline({ src, color, theme, size = 15.5 }: { src: string; color: string; theme: Theme; size?: number }) {
  return (
    <Text style={{ color, fontSize: size, lineHeight: size * 1.38 }}>
      {inline(src).map((s, i) => (
        <Text
          key={i}
          onPress={s.href ? () => Linking.openURL(s.href!).catch(() => {}) : undefined}
          style={[
            s.bold && { fontWeight: '700' },
            s.italic && { fontStyle: 'italic' },
            s.code && {
              fontFamily: 'Menlo',
              fontSize: size - 2,
              backgroundColor: theme.hover,
            },
            s.href && { color: theme.accent, textDecorationLine: 'underline' },
          ]}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

export function Markdown({ text, color, theme }: { text: string; color: string; theme: Theme }) {
  const blocks = useMemo(() => {
    const parts: { kind: 'p' | 'li' | 'ol' | 'h' | 'code' | 'img'; text: string; alt?: string }[] = [];
    const lines = (text || '').split('\n');
    let code: string[] | null = null;
    let para: string[] = [];

    const flush = () => {
      if (para.length) {
        parts.push({ kind: 'p', text: para.join('\n') });
        para = [];
      }
    };

    for (const line of lines) {
      if (/^```/.test(line.trim())) {
        if (code) {
          parts.push({ kind: 'code', text: code.join('\n') });
          code = null;
        } else {
          flush();
          code = [];
        }
        continue;
      }
      if (code) {
        code.push(line);
        continue;
      }
      const img = /^\s*!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)\s*$/.exec(line);
      if (img) {
        flush();
        parts.push({ kind: 'img', text: img[2], alt: img[1] });
      } else if (/^\s*[-*+]\s+/.test(line)) {
        flush();
        parts.push({ kind: 'li', text: line.replace(/^\s*[-*+]\s+/, '') });
      } else if (/^\s*\d+\.\s+/.test(line)) {
        flush();
        parts.push({ kind: 'ol', text: line.replace(/^\s*\d+\.\s+/, '') });
      } else if (/^#{1,3}\s+/.test(line)) {
        flush();
        parts.push({ kind: 'h', text: line.replace(/^#{1,3}\s+/, '') });
      } else if (!line.trim()) {
        flush();
      } else {
        para.push(line);
      }
    }
    if (code) parts.push({ kind: 'code', text: code.join('\n') });
    flush();
    return parts;
  }, [text]);

  return (
    <View>
      {blocks.map((b, i) => {
        if (b.kind === 'code') {
          return (
            <View key={i} style={{ backgroundColor: theme.hover, borderRadius: 10, padding: 10, marginVertical: 5 }}>
              <Text style={{ fontFamily: 'Menlo', fontSize: 12.5, color, lineHeight: 18 }}>{b.text}</Text>
            </View>
          );
        }
        if (b.kind === 'img') {
          return <ChatImage key={i} uri={b.text} theme={theme} />;
        }
        if (b.kind === 'h') {
          return (
            <Text key={i} style={{ color, fontSize: 16, fontWeight: '700', marginTop: i ? 8 : 0, marginBottom: 3 }}>
              {b.text}
            </Text>
          );
        }
        if (b.kind === 'li' || b.kind === 'ol') {
          return (
            <View key={i} style={{ flexDirection: 'row', marginBottom: 3, paddingRight: 6 }}>
              <Text style={{ color, fontSize: 15.5, lineHeight: 21, marginRight: 6 }}>•</Text>
              <View style={{ flex: 1 }}>
                <Inline src={b.text} color={color} theme={theme} />
              </View>
            </View>
          );
        }
        return (
          <View key={i} style={{ marginBottom: i === blocks.length - 1 ? 0 : 8 }}>
            <Inline src={b.text} color={color} theme={theme} />
          </View>
        );
      })}
    </View>
  );
}

/* ── Chat bits ─────────────────────────────────────────────────────── */

/** An image the agent embedded with markdown. Sized from the real aspect ratio,
 *  quietly dropped if the URL turns out not to be an image. */
function ChatImage({ uri, theme }: { uri: string; theme: Theme }) {
  const [ratio, setRatio] = useState(1.4);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    RNImage.getSize(
      uri,
      (w, h) => alive && w && h && setRatio(w / h),
      () => alive && setFailed(true)
    );
    return () => {
      alive = false;
    };
  }, [uri]);

  if (failed) return null;
  return (
    <Pressable onPress={() => Linking.openURL(uri).catch(() => {})}>
      <RNImage
        source={{ uri }}
        onError={() => setFailed(true)}
        resizeMode="cover"
        style={{
          width: '100%',
          aspectRatio: Math.max(0.6, Math.min(ratio, 2.2)),
          maxHeight: 320,
          borderRadius: 12,
          marginVertical: 6,
          backgroundColor: theme.hover,
        }}
      />
    </Pressable>
  );
}

export function Bubble({
  mine,
  text,
  time,
  citations,
  theme,
  streaming,
}: {
  mine: boolean;
  text: string;
  time?: number;
  citations?: Citation[];
  theme: Theme;
  streaming?: boolean;
}) {
  const color = mine ? '#fff' : theme.text;
  const uniq = (citations || []).filter((c, i, a) => a.findIndex((x) => x.url === c.url) === i).slice(0, 6);
  return (
    <View style={[styles.row, { justifyContent: mine ? 'flex-end' : 'flex-start' }]}>
      <View
        style={[
          styles.bubble,
          mine
            ? { backgroundColor: theme.accentFill, borderBottomRightRadius: 6 }
            : { backgroundColor: theme.bubbleIn, borderBottomLeftRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.line },
        ]}
      >
        <Markdown text={text + (streaming ? '▍' : '')} color={color} theme={theme} />
        {uniq.length > 0 && (
          <View style={{ marginTop: 8, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }}>
            {uniq.map((c) => (
              <Text
                key={c.url}
                numberOfLines={1}
                onPress={() => Linking.openURL(c.url).catch(() => {})}
                style={{ color: theme.accent, fontSize: 12.5, marginTop: 2 }}
              >
                {c.title}
              </Text>
            ))}
          </View>
        )}
        {time ? (
          <Text style={{ color: mine ? 'rgba(255,255,255,0.7)' : theme.faint, fontSize: 10.5, alignSelf: 'flex-end', marginTop: 4 }}>
            {new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const TOOL_LABEL: Record<string, (i: any) => string> = {
  web_search: (i) => `🔍 Searched — “${clip(i?.query)}”`,
  web_fetch: (i) => `📄 Read ${host(i?.url)}`,
  browser_open: (i) => `🧭 Opened ${host(i?.url)}`,
  browser_read: () => '👀 Read the page',
  browser_links: () => '🔗 Scanned links',
  browser_images: (i: any) => `🖼️ Looked for images${i?.query ? ` of “${clip(i.query)}”` : ''}`,
  browser_fields: () => "🧾 Inspected the page's fields",
  browser_fill: (i) => `⌨️ Filled #${i?.field} with “${clip(i?.value)}”`,
  browser_select: (i) => `🔽 Chose “${clip(i?.option)}”`,
  browser_click: (i) => `🖱️ Clicked #${i?.field}`,
  browser_press: (i) => `⏎ Pressed ${i?.key || 'Enter'}`,
  show_app: (i) => `🧩 Built an app — “${clip(i?.title)}”`,
  schedule_task: (i) => `⏰ Scheduled — “${clip(i?.instruction)}”`,
  list_tasks: () => '📋 Checked its schedule',
  cancel_task: () => '🗑️ Cancelled a task',
};

const clip = (s: any, n = 30) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '…' : t;
};
const host = (u: any) => {
  const m = /^https?:\/\/([^/]+)/i.exec(String(u || ''));
  return m ? m[1].replace(/^www\./, '') : String(u || 'a page');
};
export const toolLabel = (name: string, input: any) =>
  (TOOL_LABEL[name] || (() => `⚙️ ${name}`))(input);

/** One collapsible row standing in for the reasoning + tool steps of a turn. */
export function ActivityRow({
  blocks,
  theme,
  live,
  status,
  seconds,
}: {
  blocks: Block[];
  theme: Theme;
  live?: boolean;
  status?: string;
  seconds?: number;
}) {
  const [open, setOpen] = useState(false);
  const tools = blocks.filter((b) => b.type === 'tool');
  const thoughts = blocks.filter((b) => b.type === 'thinking') as { type: 'thinking'; text: string }[];
  if (!tools.length && !thoughts.length && !live) return null;

  const summary = live
    ? status || 'Working…'
    : `${tools.length ? 'Worked' : 'Thought'}${seconds ? ` for ${seconds}s` : ''}` +
      (tools.length ? ` · ${tools.length} step${tools.length > 1 ? 's' : ''}` : '');

  return (
    <View style={{ paddingHorizontal: 14, marginBottom: 8 }}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={{
          alignSelf: 'flex-start',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 7,
          backgroundColor: theme.panel,
          borderColor: theme.line,
          borderWidth: StyleSheet.hairlineWidth,
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 20,
        }}
      >
        <Text style={{ color: theme.accent, fontSize: 12 }}>✳︎</Text>
        <Text style={{ color: theme.dim, fontSize: 12.5 }}>{summary}</Text>
        {(tools.length > 0 || thoughts.length > 0) && (
          <Text style={{ color: theme.faint, fontSize: 11 }}>{open ? '▾' : '▸'}</Text>
        )}
      </Pressable>

      {open && (
        <View style={{ marginTop: 6, marginLeft: 12, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: theme.line }}>
          {blocks.map((b, i) =>
            b.type === 'thinking' ? (
              <View key={i} style={{ backgroundColor: theme.panel, borderRadius: 10, padding: 10, marginBottom: 6 }}>
                <Text style={{ color: theme.dim, fontSize: 12.5, lineHeight: 18 }}>{b.text}</Text>
              </View>
            ) : b.type === 'tool' ? (
              <View
                key={i}
                style={{
                  backgroundColor: theme.panel,
                  borderRadius: 16,
                  paddingHorizontal: 11,
                  paddingVertical: 6,
                  marginBottom: 6,
                  alignSelf: 'flex-start',
                }}
              >
                <Text style={{ color: theme.dim, fontSize: 12.5 }}>{toolLabel(b.name, b.input)}</Text>
              </View>
            ) : null
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', paddingHorizontal: 12, marginBottom: 8 },
  bubble: { maxWidth: '86%', borderRadius: 18, paddingHorizontal: 13, paddingVertical: 9 },
});
