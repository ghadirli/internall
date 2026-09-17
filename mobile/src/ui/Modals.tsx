import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { randomSeed } from '../avatar';
import * as anthropic from '../providers/anthropic';
import * as openai from '../providers/openai';
import { cancelTask, taskLabel, toggleTask } from '../scheduler';
import { store, useStore } from '../store';
import { Theme } from '../theme';
import { Agent, Provider } from '../types';
import { Avatar } from './bits';

function Sheet({
  visible,
  onClose,
  title,
  theme,
  children,
  footer,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  theme: Theme;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: 14 }}>
        <View style={[styles.sheetHead, { borderBottomColor: theme.line }]}>
          <Text style={{ color: theme.text, fontSize: 18, fontWeight: '700', flex: 1 }}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={{ color: theme.accent, fontSize: 16 }}>Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>{children}</ScrollView>
        {footer}
      </View>
    </Modal>
  );
}

function Field({ label, theme, children }: { label: string; theme: Theme; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={{ color: theme.dim, fontSize: 12.5, marginBottom: 6 }}>{label}</Text>
      {children}
    </View>
  );
}

function Toggle({
  label,
  hint,
  value,
  onChange,
  theme,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
  theme: Theme;
}) {
  return (
    <View style={[styles.toggle, { backgroundColor: theme.panel2, borderColor: theme.line }]}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.text, fontWeight: '600', fontSize: 14 }}>{label}</Text>
        <Text style={{ color: theme.dim, fontSize: 12 }}>{hint}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

/* ── Agent editor ──────────────────────────────────────────────────── */

export function AgentEditor({
  visible,
  agentId,
  theme,
  onClose,
}: {
  visible: boolean;
  agentId: string | null; // null = new
  theme: Theme;
  onClose: (savedId?: string) => void;
}) {
  const agents = useStore((s) => s.agents);
  const existing = agents.find((a) => a.id === agentId) || null;

  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [provider, setProvider] = useState<Provider>('openai');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [seed, setSeed] = useState(randomSeed());
  const [tools, setTools] = useState({ web: true, browser: true, apps: true, tasks: true, confirm: true });

  useEffect(() => {
    if (!visible) return;
    setName(existing?.name || '');
    setDesc(existing?.description || '');
    setProvider(existing?.provider || (store.hasKey('openai') ? 'openai' : 'anthropic'));
    setModel(existing?.model || '');
    setSeed(existing?.avatar?.seed || randomSeed());
    setTools(existing?.tools || { web: true, browser: true, apps: true, tasks: true, confirm: true });
  }, [visible, agentId]);

  useEffect(() => {
    if (!visible) return;
    const key = store.getKey(provider);
    if (!key) {
      setModels([]);
      return;
    }
    setLoadingModels(true);
    const load = provider === 'openai' ? openai.listModels : anthropic.listModels;
    load(key)
      .then((list) => {
        setModels(list);
        setModel((m) => (list.some((x: any) => x.id === m) ? m : pickDefault(provider, list.map((x: any) => x.id))));
      })
      .catch(() => {
        const fallback = (provider === 'openai' ? openai.FALLBACK_MODELS : anthropic.FALLBACK_MODELS).map((id) => ({
          id,
          label: id,
        }));
        setModels(fallback);
        setModel((m) => m || fallback[0].id);
      })
      .finally(() => setLoadingModels(false));
  }, [visible, provider]);

  const save = () => {
    if (!name.trim()) return;
    const saved = store.saveAgent({
      ...(existing ? { id: existing.id } : {}),
      name: name.trim(),
      description: desc.trim(),
      provider,
      model,
      avatar: { kind: 'art', seed },
      tools,
    } as any);
    onClose(saved.id);
  };

  const preview: Agent = {
    ...(existing || ({} as any)),
    id: existing?.id || 'preview',
    name,
    avatar: { kind: 'art', seed },
  };

  return (
    <Sheet visible={visible} onClose={() => onClose()} title={existing ? 'Edit agent' : 'New agent'} theme={theme}>
      <View style={{ alignItems: 'center', marginBottom: 18, gap: 10 }}>
        <Avatar agent={preview} size={78} />
        <Pressable onPress={() => setSeed(randomSeed())} style={[styles.pill, { backgroundColor: theme.panel2, borderColor: theme.line }]}>
          <Text style={{ color: theme.text, fontSize: 13 }}>🎲 Shuffle picture</Text>
        </Pressable>
      </View>

      <Field label="Name" theme={theme}>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="e.g. Market Analyst"
          placeholderTextColor={theme.faint}
          style={[styles.input, { color: theme.text, backgroundColor: theme.panel2, borderColor: theme.line }]}
        />
      </Field>

      <Field label="What does this agent do?" theme={theme}>
        <TextInput
          value={desc}
          onChangeText={setDesc}
          multiline
          placeholder="Describe its job, tone and rules. This becomes its system prompt."
          placeholderTextColor={theme.faint}
          style={[styles.input, { color: theme.text, backgroundColor: theme.panel2, borderColor: theme.line, height: 110, textAlignVertical: 'top' }]}
        />
      </Field>

      <Field label="Provider" theme={theme}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(['openai', 'anthropic'] as Provider[]).map((p) => (
            <Pressable
              key={p}
              onPress={() => setProvider(p)}
              style={[
                styles.choice,
                {
                  backgroundColor: provider === p ? theme.accentFill : theme.panel2,
                  borderColor: provider === p ? theme.accent : theme.line,
                },
              ]}
            >
              <Text style={{ color: provider === p ? '#fff' : theme.text, fontSize: 14 }}>
                {p === 'openai' ? 'OpenAI' : 'Anthropic'}
              </Text>
            </Pressable>
          ))}
        </View>
      </Field>

      <Field label="Model" theme={theme}>
        {loadingModels ? (
          <ActivityIndicator color={theme.accent} />
        ) : models.length === 0 ? (
          <Text style={{ color: theme.dim, fontSize: 13 }}>Add a {provider} key in Settings to pick a model.</Text>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {models.slice(0, 25).map((m) => (
              <Pressable
                key={m.id}
                onPress={() => setModel(m.id)}
                style={[
                  styles.choice,
                  { backgroundColor: model === m.id ? theme.accentFill : theme.panel2, borderColor: model === m.id ? theme.accentFill : theme.line },
                ]}
              >
                <Text style={{ color: model === m.id ? '#fff' : theme.text, fontSize: 13 }}>{m.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}
      </Field>

      <Text style={{ color: theme.dim, fontSize: 12.5, marginBottom: 8 }}>Abilities</Text>
      <Toggle label="Internet access" hint="Search the web and read pages" value={tools.web} onChange={(v) => setTools({ ...tools, web: v })} theme={theme} />
      <Toggle label="Browser control" hint="Open pages, fill forms and tap in the built-in browser" value={tools.browser} onChange={(v) => setTools({ ...tools, browser: v })} theme={theme} />
      <Toggle label="Build mini-apps" hint="Show results as an interactive app" value={tools.apps} onChange={(v) => setTools({ ...tools, apps: v })} theme={theme} />
      <Toggle label="Scheduled tasks" hint="Remember jobs and run them on a schedule" value={tools.tasks} onChange={(v) => setTools({ ...tools, tasks: v })} theme={theme} />
      <Toggle label="Ask before submitting" hint="Approve any tap that submits, buys or deletes" value={tools.confirm} onChange={(v) => setTools({ ...tools, confirm: v })} theme={theme} />

      <Pressable onPress={save} style={[styles.primary, { backgroundColor: theme.accentFill, opacity: name.trim() ? 1 : 0.4 }]}>
        <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>{existing ? 'Save' : 'Create agent'}</Text>
      </Pressable>

      {existing && (
        <Pressable
          onPress={() => {
            store.deleteAgent(existing.id);
            onClose();
          }}
          style={[styles.primary, { backgroundColor: 'transparent' }]}
        >
          <Text style={{ color: theme.danger, fontWeight: '600' }}>Delete agent</Text>
        </Pressable>
      )}
    </Sheet>
  );
}

function pickDefault(provider: Provider, ids: string[]) {
  return provider === 'openai' ? openai.pickDefaultModel(ids) : anthropic.pickDefaultModel(ids);
}

/* ── Settings ──────────────────────────────────────────────────────── */

export function Settings({ visible, theme, onClose }: { visible: boolean; theme: Theme; onClose: () => void }) {
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [status, setStatus] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setOpenaiKey('');
      setAnthropicKey('');
      setStatus({});
    }
  }, [visible]);

  const test = async (p: Provider, typed: string) => {
    const key = typed.trim() || store.getKey(p);
    if (!key) return setStatus((s) => ({ ...s, [p]: '✕ No key to test — paste one first.' }));
    setBusy(p);
    try {
      const list = p === 'openai' ? await openai.listModels(key) : await anthropic.listModels(key);
      setStatus((s) => ({ ...s, [p]: `✓ Key works — ${list.slice(0, 3).map((m: any) => m.id).join(', ')}…` }));
    } catch (e: any) {
      const hint = e?.status === 401 ? ' Check for a stray space or a revoked key.' : '';
      setStatus((s) => ({ ...s, [p]: `✕ ${e?.message || e}${hint}` }));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (openaiKey.trim()) await store.setKey('openai', openaiKey.trim());
    if (anthropicKey.trim()) await store.setKey('anthropic', anthropicKey.trim());
    onClose();
  };

  const row = (p: Provider, value: string, setValue: (v: string) => void, placeholder: string, hint: string) => (
    <Field label={`${p === 'openai' ? 'OpenAI' : 'Anthropic'} API key${store.hasKey(p) ? ' · saved' : ''}`} theme={theme}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput
          value={value}
          onChangeText={setValue}
          placeholder={placeholder}
          placeholderTextColor={theme.faint}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          style={[styles.input, { flex: 1, color: theme.text, backgroundColor: theme.panel2, borderColor: theme.line }]}
        />
        <Pressable onPress={() => test(p, value)} style={[styles.pill, { backgroundColor: theme.panel2, borderColor: theme.line, justifyContent: 'center' }]}>
          {busy === p ? <ActivityIndicator color={theme.accent} /> : <Text style={{ color: theme.text }}>Test</Text>}
        </Pressable>
      </View>
      <Text style={{ color: status[p]?.startsWith('✓') ? theme.good : status[p] ? theme.danger : theme.faint, fontSize: 11.5, marginTop: 6 }}>
        {status[p] || hint}
      </Text>
    </Field>
  );

  return (
    <Sheet visible={visible} onClose={onClose} title="Settings" theme={theme}>
      {row('openai', openaiKey, setOpenaiKey, 'sk-...', 'From platform.openai.com → API keys. Stored in the device keychain.')}
      {row('anthropic', anthropicKey, setAnthropicKey, 'sk-ant-...', 'Optional. From console.anthropic.com.')}
      <Pressable onPress={save} style={[styles.primary, { backgroundColor: theme.accentFill }]}>
        <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>Save keys</Text>
      </Pressable>
      <Text style={{ color: theme.faint, fontSize: 11.5, marginTop: 14, lineHeight: 17 }}>
        Keys are kept in the iOS Keychain / Android Keystore on this device and sent only to the provider you
        picked. Nothing goes through a server of ours — there isn't one.
      </Text>
    </Sheet>
  );
}

/* ── Tasks ─────────────────────────────────────────────────────────── */

export function TasksSheet({
  visible,
  agentId,
  theme,
  onClose,
}: {
  visible: boolean;
  agentId: string | null;
  theme: Theme;
  onClose: () => void;
}) {
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const agent = agents.find((a) => a.id === agentId);
  const mine = tasks.filter((t) => t.agentId === agentId);
  const elsewhere = tasks.length - mine.length;

  return (
    <Sheet visible={visible} onClose={onClose} title={agent ? `Scheduled · ${agent.name}` : 'Scheduled'} theme={theme}>
      {mine.length === 0 && <Text style={{ color: theme.dim, fontSize: 14 }}>Nothing scheduled in this chat yet.</Text>}

      {mine.map((t) => {
        const done = (t.kind === 'once' || t.kind === 'in') && t.lastRun && !t.enabled;
        return (
          <View key={t.id} style={[styles.taskRow, { backgroundColor: theme.panel2, borderColor: theme.line }]}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.text, fontWeight: '600', fontSize: 14 }}>{t.instruction}</Text>
              <Text style={{ color: theme.dim, fontSize: 11.5, marginTop: 2 }}>
                {taskLabel(t)}
                {t.enabled && t.nextRun
                  ? ` · next ${new Date(t.nextRun).toLocaleString()}`
                  : done
                    ? ` · ran ${new Date(t.lastRun!).toLocaleString()}`
                    : ' · paused'}
              </Text>
            </View>
            {!done && (
              <Pressable onPress={() => toggleTask(t.id)} style={[styles.pill, { backgroundColor: theme.hover, borderColor: 'transparent' }]}>
                <Text style={{ color: theme.dim, fontSize: 12.5 }}>{t.enabled ? 'Pause' : 'Resume'}</Text>
              </Pressable>
            )}
            <Pressable onPress={() => cancelTask(t.id)} style={[styles.pill, { backgroundColor: theme.hover, borderColor: 'transparent' }]}>
              <Text style={{ color: theme.danger, fontSize: 12.5 }}>Delete</Text>
            </Pressable>
          </View>
        );
      })}

      {elsewhere > 0 && (
        <Text style={{ color: theme.faint, fontSize: 12, marginTop: 10 }}>
          {elsewhere} other task{elsewhere > 1 ? 's are' : ' is'} scheduled in your other chats.
        </Text>
      )}

      <Text style={{ color: theme.faint, fontSize: 12, marginTop: 14, lineHeight: 18 }}>
        Ask in plain language — “every morning at 7, check the news and summarise it”. A phone can't run an
        agent in the background, so a task fires as a notification and the work runs when you open the app.
      </Text>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  sheetHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  input: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 13, paddingVertical: 11, fontSize: 15 },
  choice: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth },
  pill: { paddingHorizontal: 13, paddingVertical: 8, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, marginBottom: 8 },
  primary: { marginTop: 14, paddingVertical: 14, borderRadius: 14, alignItems: 'center' },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, marginBottom: 8 },
});
