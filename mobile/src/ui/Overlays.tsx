import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { browser, PAGE_HELPERS } from '../browserBridge';
import { store, useStore } from '../store';
import { Theme } from '../theme';

/**
 * The agent's browser. Mounted once and kept alive for the whole session so
 * logins and page state survive; it slides into view whenever the agent (or
 * the user) opens it.
 */
export function BrowserOverlay({ theme }: { theme: Theme }) {
  const insets = useSafeAreaInsets();
  const ref = useRef<WebView>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState('https://duckduckgo.com');
  const [address, setAddress] = useState('https://duckduckgo.com');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const live = useStore((s) => s.live);

  useEffect(() => {
    browser.attach(ref.current);
  });

  useEffect(() => {
    browser.setCallbacks(
      (v) => setVisible(v),
      (u) => {
        setUrl(u);
        setAddress(u);
      }
    );
  }, []);

  // Mirror what the agent is doing onto a floating badge.
  useEffect(() => {
    if (!live) return setStatus(null);
    if (/Opening|Reading|Scanning|Inspecting|Filling|Choosing|Clicking|Submitting/.test(live.status)) {
      setStatus(live.status);
      const t = setTimeout(() => setStatus(null), 6000);
      return () => clearTimeout(t);
    }
  }, [live?.status]);

  const go = () => {
    const v = address.trim();
    if (!v) return;
    const isUrl = /^https?:\/\//i.test(v) || /^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(v);
    setUrl(isUrl ? (/^https?:\/\//i.test(v) ? v : 'https://' + v) : `https://duckduckgo.com/?q=${encodeURIComponent(v)}`);
  };

  return (
    <View
      style={
        visible
          ? [styles.fill, { backgroundColor: theme.panel, zIndex: 40 }]
          : { position: 'absolute', width: 1, height: 1, opacity: 0, left: -9999 }
      }
      pointerEvents={visible ? 'auto' : 'none'}
    >
      <View style={{ paddingTop: visible ? insets.top + 6 : 0, paddingHorizontal: 10, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line }}>
        <Pressable onPress={() => ref.current?.goBack()} hitSlop={8}>
          <Text style={{ color: theme.accent, fontSize: 20 }}>‹</Text>
        </Pressable>
        <Pressable onPress={() => ref.current?.goForward()} hitSlop={8}>
          <Text style={{ color: theme.accent, fontSize: 20 }}>›</Text>
        </Pressable>
        <TextInput
          value={address}
          onChangeText={setAddress}
          onSubmitEditing={go}
          autoCapitalize="none"
          autoCorrect={false}
          selectTextOnFocus
          style={{ flex: 1, backgroundColor: theme.panel2, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, color: theme.text, fontSize: 13 }}
        />
        <Pressable onPress={() => browser.hide()} hitSlop={8}>
          <Text style={{ color: theme.accent, fontSize: 15 }}>Done</Text>
        </Pressable>
      </View>

      {status && (
        <View style={[styles.badge, { backgroundColor: theme.accentFill }]}>
          <Text style={{ color: '#fff', fontSize: 12.5, fontWeight: '600' }}>🤖 {status}…</Text>
        </View>
      )}

      <WebView
        ref={ref}
        source={{ uri: url }}
        injectedJavaScript={PAGE_HELPERS}
        onMessage={(e) => browser.handleMessage(e.nativeEvent.data)}
        onLoadStart={() => setLoading(true)}
        onNavigationStateChange={(nav) => {
          browser.noteNavigation(nav.url, nav.title || '');
          if (!nav.loading) {
            setAddress(nav.url);
            setLoading(false);
          }
        }}
        style={{ flex: 1, backgroundColor: theme.panel }}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        domStorageEnabled
        javaScriptEnabled
        allowsBackForwardNavigationGestures
      />
      {loading && <View style={{ height: 2, backgroundColor: theme.accent, opacity: 0.6 }} />}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  badge: {
    position: 'absolute',
    top: 92,
    alignSelf: 'center',
    zIndex: 5,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
  },
});
