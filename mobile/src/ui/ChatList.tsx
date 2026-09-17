import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { lastActivity, plainText, store, unreadCount, useStore } from '../store';
import { Theme } from '../theme';
import { Agent } from '../types';
import { Avatar } from './bits';

function preview(a: Agent) {
  const draft = (a.draft || '').trim();
  if (draft) return { draft: true, text: draft };
  for (let i = a.messages.length - 1; i >= 0; i--) {
    const t = plainText(a.messages[i]).replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
    if (t) return { draft: false, text: (a.messages[i].role === 'assistant' ? '' : 'You: ') + t };
  }
  return { draft: false, text: a.description.split('\n')[0] || 'No messages yet' };
}

export function ChatList({
  theme,
  onOpen,
  onNew,
  onSettings,
}: {
  theme: Theme;
  onOpen: (id: string) => void;
  onNew: () => void;
  onSettings: () => void;
}) {
  const insets = useSafeAreaInsets();
  const agents = useStore((s) => s.agents);
  const running = useStore((s) => s.running);

  const sorted = [...agents].sort((a, b) => lastActivity(b) - lastActivity(a));

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: theme.line, backgroundColor: theme.panel }]}>
        <Text style={{ color: theme.text, fontSize: 26, fontWeight: '700', flex: 1 }}>Internall</Text>
        <Pressable onPress={onSettings} hitSlop={10} style={{ padding: 6 }}>
          <Text style={{ fontSize: 19 }}>⚙️</Text>
        </Pressable>
        <Pressable onPress={onNew} hitSlop={10} style={{ padding: 6 }}>
          <Text style={{ color: theme.accent, fontSize: 28, marginTop: -4 }}>＋</Text>
        </Pressable>
      </View>

      <FlatList
        data={sorted}
        keyExtractor={(a) => a.id}
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
        renderItem={({ item }) => {
          const unread = unreadCount(item);
          const p = preview(item);
          const last = item.messages[item.messages.length - 1];
          const busy = running.includes(item.id);
          return (
            <Pressable
              onPress={() => onOpen(item.id)}
              style={({ pressed }) => [styles.item, { backgroundColor: pressed ? theme.hover : 'transparent' }]}
            >
              <Avatar agent={item} size={52} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text
                    numberOfLines={1}
                    style={{ color: theme.text, fontSize: 16, fontWeight: unread ? '700' : '600', flex: 1 }}
                  >
                    {item.name}
                  </Text>
                  {last ? (
                    <Text style={{ color: theme.faint, fontSize: 12 }}>
                      {new Date(last.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  ) : null}
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                  <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: unread ? theme.text : theme.dim }}>
                    {busy ? (
                      <Text style={{ color: theme.accent }}>typing…</Text>
                    ) : (
                      <>
                        {p.draft ? <Text style={{ color: theme.danger, fontWeight: '600' }}>Draft: </Text> : null}
                        {p.text}
                      </>
                    )}
                  </Text>
                  {unread > 0 && (
                    <View style={[styles.badge, { backgroundColor: theme.accentFill }]}>
                      <Text style={{ color: '#fff', fontSize: 11.5, fontWeight: '700' }}>
                        {unread > 99 ? '99+' : unread}
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <View style={{ padding: 40, alignItems: 'center' }}>
            <Text style={{ color: theme.dim, textAlign: 'center' }}>
              No agents yet. Tap ＋ to create one — give it a name and describe what it should do.
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10 },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
});
