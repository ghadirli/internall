import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, BackHandler, Platform, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { browser } from './src/browserBridge';
import { deliverUserMessage } from './src/runtime';
import { rearmNotifications, runDueTasks } from './src/scheduler';
import { store, useStore } from './src/store';
import { useTheme } from './src/theme';
import { ChatList } from './src/ui/ChatList';
import { ChatScreen } from './src/ui/ChatScreen';
import { AgentEditor, Settings, TasksSheet } from './src/ui/Modals';
import { AppZoom } from './src/ui/AppPreview';
import { BrowserOverlay } from './src/ui/Overlays';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export default function App() {
  const ready = useStore((s) => s.ready);
  const themePref = useStore((s) => s.theme);
  const theme = useTheme(themePref);

  const [screen, setScreen] = useState<'list' | 'chat'>('list');
  const [chatId, setChatId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ open: boolean; id: string | null }>({ open: false, id: null });
  const [settings, setSettings] = useState(false);
  const [tasksFor, setTasksFor] = useState<string | null>(null);
  const tickRef = useRef<any>(null);

  useEffect(() => {
    store.load().then(async () => {
      // Notification permission is asked for when the first task is scheduled,
      // not on launch — nobody wants a permission sheet before they have used
      // the app once.
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('slava', {
          name: 'Scheduled tasks',
          importance: Notifications.AndroidImportance.DEFAULT,
        });
      }
      await rearmNotifications();
      runDueTasks(deliverUserMessage);
    });
  }, []);

  // Due work runs when the app is open: on foreground, and on a timer.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') runDueTasks(deliverUserMessage);
    });
    tickRef.current = setInterval(() => runDueTasks(deliverUserMessage), 20000);
    return () => {
      sub.remove();
      clearInterval(tickRef.current);
    };
  }, []);

  // Tapping a task notification opens that chat and runs what is due.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((res) => {
      const agentId = (res.notification.request.content.data as any)?.agentId;
      if (agentId && store.agent(agentId)) {
        setChatId(agentId);
        setScreen('chat');
        store.set({ activeId: agentId });
      }
      runDueTasks(deliverUserMessage);
    });
    return () => sub.remove();
  }, []);

  // Android back button: close the browser, then leave the chat.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (browser.visible) {
        browser.hide();
        return true;
      }
      if (screen === 'chat') {
        setScreen('list');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [screen]);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style={theme.isDark ? 'light' : 'dark'} />
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        {screen === 'list' || !chatId ? (
          <ChatList
            theme={theme}
            onOpen={(id) => {
              setChatId(id);
              setScreen('chat');
              store.set({ activeId: id });
            }}
            onNew={() => setEditing({ open: true, id: null })}
            onSettings={() => setSettings(true)}
          />
        ) : (
          <ChatScreen
            key={chatId}
            agentId={chatId}
            theme={theme}
            onBack={() => setScreen('list')}
            onEdit={() => setEditing({ open: true, id: chatId })}
            onTasks={() => setTasksFor(chatId)}
            onOpenApp={(id) => store.set({ openApp: id }, false)}
          />
        )}

        <BrowserOverlay theme={theme} />
        <AppZoom theme={theme} />

        <AgentEditor
          visible={editing.open}
          agentId={editing.id}
          theme={theme}
          onClose={(savedId) => {
            setEditing({ open: false, id: null });
            if (savedId && !store.agent(chatId)) {
              setChatId(savedId);
              setScreen('chat');
            }
          }}
        />
        <Settings visible={settings} theme={theme} onClose={() => setSettings(false)} />
        <TasksSheet visible={Boolean(tasksFor)} agentId={tasksFor} theme={theme} onClose={() => setTasksFor(null)} />
      </View>
    </SafeAreaProvider>
  );
}
