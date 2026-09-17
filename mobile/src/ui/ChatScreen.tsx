import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { browser } from '../browserBridge';
import { deliverUserMessage, resolveConfirm, stopAgent } from '../runtime';
import { store, unreadCount, useStore } from '../store';
import { Theme } from '../theme';
import { Block, Message } from '../types';
import { AppPreviewCard } from './AppPreview';
import { ActivityRow, Avatar, Bubble } from './bits';

/** Groups a run of activity blocks so they collapse into one row, the way the
 *  desktop app does: activity → message → activity → message. */
type Item =
  | { kind: 'activity'; blocks: Block[]; ts: number; seconds: number }
  | { kind: 'bubble'; mine: boolean; text: string; ts: number; citations?: any[] }
  | { kind: 'scheduled'; text: string; ts: number }
  | { kind: 'unread' }
  | { kind: 'app'; id: string; title: string; ts: number };

function buildItems(messages: Message[], readMark: number, appTitles: Record<string, string>): Item[] {
  const items: Item[] = [];
  let group: Block[] = [];
  let groupStart = 0;
  let unreadShown = false;

  const flush = (ts: number) => {
    if (group.length) {
      items.push({ kind: 'activity', blocks: group, ts, seconds: Math.max(0, Math.round((ts - groupStart) / 1000)) });
      group = [];
    }
  };

  for (const m of messages) {
    if (m.role === 'tool') continue;

    if (!unreadShown && m.role === 'assistant' && m.ts > readMark) {
      unreadShown = true;
      flush(m.ts);
      items.push({ kind: 'unread' });
    }

    if (m.role === 'user') {
      flush(m.ts);
      if (m.scheduled) {
        const lines = m.text.split('\n');
        items.push({ kind: 'scheduled', text: lines.slice(1).join(' ').trim() || lines[0], ts: m.ts });
      } else {
        items.push({ kind: 'bubble', mine: true, text: m.text, ts: m.ts });
      }
      continue;
    }

    let text = '';
    const citations: any[] = [];
    for (const b of m.blocks) {
      if (b.type === 'text') {
        text += b.text;
        (b.citations || []).forEach((c) => citations.push(c));
      } else {
        if (!group.length) groupStart = m.ts;
        group.push(b);
        if (b.type === 'tool' && b.name === 'show_app') {
          const title = b.input?.title || 'App';
          const id = Object.keys(appTitles).find((k) => appTitles[k] === title);
          if (id) items.push({ kind: 'app', id, title, ts: m.ts });
        }
      }
    }
    if (text.trim()) {
      flush(m.ts);
      items.push({ kind: 'bubble', mine: false, text, ts: m.ts, citations });
    }
  }
  flush(Date.now());
  return items;
}

export function ChatScreen({
  agentId,
  theme,
  onBack,
  onEdit,
  onTasks,
  onOpenApp,
}: {
  agentId: string;
  theme: Theme;
  onBack: () => void;
  onEdit: () => void;
  onTasks: () => void;
  onOpenApp: (id: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const agents = useStore((s) => s.agents);
  const live = useStore((s) => s.live);
  const confirm = useStore((s) => s.confirm);
  const tasks = useStore((s) => s.tasks);
  const apps = useStore((s) => s.apps);
  const running = useStore((s) => s.running);

  const agent = agents.find((a) => a.id === agentId)!;
  const busy = running.includes(agentId);
  const [draft, setDraft] = useState(agent?.draft || '');
  const scrollRef = useRef<ScrollView>(null);
  const readMark = useRef<number>(agent?.lastReadTs || 0).current;

  const appTitles = useMemo(() => {
    const map: Record<string, string> = {};
    apps.filter((a) => a.agentId === agentId).forEach((a) => (map[a.id] = a.title));
    return map;
  }, [apps, agentId]);

  // Opening the chat marks it read; the divider still shows where you stopped.
  useEffect(() => {
    store.markRead(agentId);
  }, [agentId, agent?.messages.length]);

  // Park the draft when leaving.
  useEffect(() => () => store.setDraft(agentId, draft), [agentId, draft]);

  const items = useMemo(
    () => buildItems(agent?.messages || [], readMark, appTitles),
    [agent?.messages, agent?.messages.length, readMark, appTitles]
  );

  const hasTasks = tasks.some((t) => t.agentId === agentId && t.enabled);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    store.setDraft(agentId, '');
    await deliverUserMessage(agentId, text);
  };

  if (!agent) return null;

  const liveHere = live?.agentId === agentId ? live : null;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={[styles.header, { paddingTop: insets.top + 6, backgroundColor: theme.panel, borderBottomColor: theme.line }]}>
        <Pressable onPress={onBack} hitSlop={12} style={{ paddingRight: 6 }}>
          <Text style={{ color: theme.accent, fontSize: 17 }}>‹ Chats</Text>
        </Pressable>
        <Avatar agent={agent} size={34} />
        <View style={{ flex: 1, marginLeft: 9 }}>
          <Text numberOfLines={1} style={{ color: theme.text, fontSize: 15.5, fontWeight: '600' }}>
            {agent.name}
          </Text>
          {busy && (
            <Text numberOfLines={1} style={{ color: theme.accent, fontSize: 12 }}>
              {liveHere?.status || 'typing…'}
            </Text>
          )}
        </View>
        <Pressable onPress={onTasks} hitSlop={10} style={{ padding: 5 }}>
          <Text style={{ fontSize: 17 }}>⏰</Text>
          {hasTasks && <View style={[styles.dot, { backgroundColor: theme.good, borderColor: theme.panel }]} />}
        </Pressable>
        <Pressable onPress={() => browser.show()} hitSlop={10} style={{ padding: 5 }}>
          <Text style={{ fontSize: 17 }}>🌐</Text>
        </Pressable>
        <Pressable onPress={onEdit} hitSlop={10} style={{ padding: 5 }}>
          <Text style={{ fontSize: 17 }}>✎</Text>
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingVertical: 14 }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        keyboardDismissMode="interactive"
      >
        {items.length === 0 && (
          <View style={{ alignItems: 'center', padding: 30, gap: 10 }}>
            <Avatar agent={agent} size={80} />
            <Text style={{ color: theme.text, fontSize: 17, fontWeight: '700' }}>{agent.name}</Text>
            <Text style={{ color: theme.dim, textAlign: 'center', fontSize: 14 }}>{agent.description}</Text>
          </View>
        )}

        {items.map((it, i) => {
          if (it.kind === 'activity') return <ActivityRow key={i} blocks={it.blocks} theme={theme} seconds={it.seconds} />;
          if (it.kind === 'unread')
            return (
              <View key={i} style={styles.unreadWrap}>
                <View style={{ flex: 1, height: 1, backgroundColor: theme.accent, opacity: 0.35 }} />
                <Text style={{ color: theme.accent, fontSize: 11.5, fontWeight: '700', marginHorizontal: 8 }}>
                  Unread messages
                </Text>
                <View style={{ flex: 1, height: 1, backgroundColor: theme.accent, opacity: 0.35 }} />
              </View>
            );
          if (it.kind === 'scheduled')
            return (
              <View key={i} style={{ alignItems: 'center', marginVertical: 8 }}>
                <Text
                  numberOfLines={1}
                  style={{
                    color: theme.dim,
                    fontSize: 11.5,
                    backgroundColor: theme.panel,
                    paddingHorizontal: 12,
                    paddingVertical: 4,
                    borderRadius: 20,
                    maxWidth: '85%',
                  }}
                >
                  ⏰ {it.text}
                </Text>
              </View>
            );
          if (it.kind === 'app')
            return (
              <AppPreviewCard key={i} appId={it.id} title={it.title} theme={theme} onOpen={onOpenApp} />
            );
          return (
            <Bubble key={i} mine={it.mine} text={it.text} time={it.ts} citations={it.citations} theme={theme} />
          );
        })}

        {liveHere && (
          <>
            <ActivityRow
              blocks={[
                ...(liveHere.thinking ? [{ type: 'thinking', text: liveHere.thinking } as Block] : []),
                ...liveHere.steps.map((s) => ({ type: 'tool', name: s.name, input: s.input }) as Block),
              ]}
              theme={theme}
              live
              status={liveHere.status}
            />
            {!!liveHere.text && <Bubble mine={false} text={liveHere.text} theme={theme} streaming />}
          </>
        )}

        {confirm?.agentId === agentId && (
          <View style={[styles.confirm, { backgroundColor: theme.panel, borderColor: '#f5a524' }]}>
            <Text style={{ color: theme.text, fontWeight: '700', fontSize: 14 }}>🔒 {confirm.title}</Text>
            <Text style={{ color: theme.dim, fontSize: 12.5, marginTop: 2 }}>{confirm.detail}</Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
              <Pressable onPress={() => resolveConfirm(true)} style={[styles.btn, { backgroundColor: theme.accentFill }]}>
                <Text style={{ color: '#fff', fontWeight: '600' }}>Allow</Text>
              </Pressable>
              <Pressable onPress={() => resolveConfirm(false)} style={[styles.btn, { backgroundColor: theme.hover }]}>
                <Text style={{ color: theme.text }}>Not now</Text>
              </Pressable>
            </View>
          </View>
        )}
      </ScrollView>

      <View style={[styles.composer, { paddingBottom: insets.bottom || 10, backgroundColor: theme.panel, borderTopColor: theme.line }]}>
        <TextInput
          value={draft}
          onChangeText={(t) => {
            setDraft(t);
            store.setDraft(agentId, t);
          }}
          placeholder="Message"
          placeholderTextColor={theme.faint}
          multiline
          style={[styles.input, { color: theme.text, backgroundColor: theme.panel2, borderColor: theme.line }]}
        />
        <Pressable
          onPress={busy ? () => stopAgent(agentId) : send}
          style={[styles.send, { backgroundColor: busy ? theme.danger : theme.accentFill }]}
        >
          <Text style={{ color: '#fff', fontSize: 16 }}>{busy ? '■' : '➤'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  dot: { position: 'absolute', top: 2, right: 2, width: 8, height: 8, borderRadius: 4, borderWidth: 1.5 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 10, paddingTop: 8, gap: 8, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, minHeight: 40, maxHeight: 130, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 15, paddingTop: 10, paddingBottom: 10, fontSize: 16 },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  unreadWrap: { flexDirection: 'row', alignItems: 'center', marginVertical: 10, paddingHorizontal: 16 },
  confirm: { marginHorizontal: 14, marginBottom: 10, padding: 13, borderRadius: 14, borderWidth: 1 },
  btn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10 },
});
