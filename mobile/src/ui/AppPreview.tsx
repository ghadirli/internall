import React, { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { store, useStore } from '../store';
import { deliverUserMessage } from '../runtime';
import type { Theme } from '../theme';

/* A generated app appears in the conversation as a small live picture of
   itself. Tapping it grows that picture into the real, working app rather than
   throwing up a separate screen — same idea as the desktop app. */

const PREVIEW_H = 190;
/** The page is laid out at this multiple of the card, then shrunk to fit, so
    the preview reads as a whole screen rather than a cropped corner. */
const ZOOM_OUT = 2.4;

/** Where on screen the tapped card was, so the overlay can start from it. */
type Rect = { x: number; y: number; width: number; height: number };
let origin: Rect | null = null;

export function loadAppHtml(id: string) {
  return AsyncStorage.getItem(`slava.app.${id}`);
}

export function AppPreviewCard({
  appId,
  title,
  theme,
  onOpen,
}: {
  appId: string;
  title: string;
  theme: Theme;
  onOpen: (id: string) => void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const box = useRef<View>(null);

  useEffect(() => {
    let alive = true;
    loadAppHtml(appId).then((v) => alive && setHtml(v));
    return () => {
      alive = false;
    };
  }, [appId]);

  const press = () => {
    box.current?.measureInWindow((x, y, width, height) => {
      origin = { x, y, width, height };
      onOpen(appId);
    });
    // measureInWindow is async; without a fallback a missed callback would
    // swallow the tap entirely.
    setTimeout(() => {
      if (store.state.openApp !== appId) onOpen(appId);
    }, 120);
  };

  return (
    <Pressable onPress={press} style={{ marginHorizontal: 14, marginBottom: 10 }}>
      <View
        ref={box}
        style={[styles.card, { backgroundColor: theme.panel, borderColor: theme.line }]}
      >
        <View style={[styles.shot, { backgroundColor: theme.bg }]}>
          {html ? <ScaledPage html={html} /> : null}
          {/* Android ignores pointerEvents on a WebView often enough that a
              plain sheet over the top is what actually keeps the card one tap
              target rather than letting the preview take the touch. */}
          <View style={StyleSheet.absoluteFill} />
        </View>
        <View style={{ padding: 12 }}>
          <Text numberOfLines={1} style={{ color: theme.text, fontWeight: '700', fontSize: 15 }}>
            {title}
          </Text>
          <Text style={{ color: theme.dim, fontSize: 12, marginTop: 2 }}>tap to open</Text>
        </View>
      </View>
    </Pressable>
  );
}

/** The app's own page, laid out large and shrunk down to thumbnail size. */
function ScaledPage({ html }: { html: string }) {
  const [w, setW] = useState(0);
  const s = 1 / ZOOM_OUT;
  return (
    <View style={StyleSheet.absoluteFill} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {w > 0 && (
        <View
          style={{
            width: w * ZOOM_OUT,
            height: PREVIEW_H * ZOOM_OUT,
            transform: [
              { translateX: -((w * ZOOM_OUT - w) / 2) },
              { translateY: -((PREVIEW_H * ZOOM_OUT - PREVIEW_H) / 2) },
              { scale: s },
            ],
          }}
          pointerEvents="none"
        >
          <WebView
            source={{ html }}
            style={{ flex: 1, backgroundColor: 'transparent' }}
            scrollEnabled={false}
            javaScriptEnabled
            pointerEvents="none"
          />
        </View>
      )}
    </View>
  );
}

/** The expanded app. Starts on top of the card it came from and grows to fill
    the screen; the working WebView goes in once the motion has finished. */
export function AppZoom({ theme }: { theme: Theme }) {
  const insets = useSafeAreaInsets();
  const openApp = useStore((s) => s.openApp);
  const apps = useStore((s) => s.apps);
  const app = apps.find((a) => a.id === openApp);

  const [html, setHtml] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const t = useRef(new Animated.Value(0)).current;
  const screen = Dimensions.get('window');

  useEffect(() => {
    if (!openApp) {
      setHtml(null);
      setLive(false);
      t.setValue(0);
      return;
    }
    let alive = true;
    loadAppHtml(openApp).then((v) => {
      if (!alive) return;
      setHtml(v);
      Animated.timing(t, {
        toValue: 1,
        duration: 300,
        easing: Easing.bezier(0.22, 0.61, 0.36, 1),
        useNativeDriver: true,
      }).start(() => alive && setLive(true));
    });
    return () => {
      alive = false;
    };
  }, [openApp]);

  if (!openApp || !html) return null;

  const from = origin || {
    x: screen.width / 2 - 40,
    y: screen.height / 2 - 40,
    width: 80,
    height: 80,
  };
  const sx = from.width / screen.width;
  const sy = from.height / screen.height;
  const dx = from.x + from.width / 2 - screen.width / 2;
  const dy = from.y + from.height / 2 - screen.height / 2;

  const close = () => store.set({ openApp: null }, false);

  const bridge = `
    window.internall = {
      send: function (text) { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'send', text: String(text) })); },
      close: function () { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'close' })); }
    };
    window.slavaApp = window.internall;   // apps generated before the rename
    true;
  `;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: '#08060699', opacity: t }]}
        pointerEvents="none"
      />
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: theme.panel,
            opacity: t.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0.4, 1, 1] }),
            transform: [
              { translateX: t.interpolate({ inputRange: [0, 1], outputRange: [dx, 0] }) },
              { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [dy, 0] }) },
              { scaleX: t.interpolate({ inputRange: [0, 1], outputRange: [sx, 1] }) },
              { scaleY: t.interpolate({ inputRange: [0, 1], outputRange: [sy, 1] }) },
            ],
          },
        ]}
      >
        <View
          style={{
            paddingTop: insets.top + 8,
            paddingHorizontal: 14,
            paddingBottom: 10,
            flexDirection: 'row',
            alignItems: 'center',
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: theme.line,
          }}
        >
          <Text numberOfLines={1} style={{ flex: 1, color: theme.text, fontWeight: '700', fontSize: 16 }}>
            {app?.title || 'App'}
          </Text>
          <Pressable onPress={close} hitSlop={10}>
            <Text style={{ color: theme.accent, fontSize: 16 }}>Done</Text>
          </Pressable>
        </View>

        {live ? (
          <WebView
            source={{ html }}
            injectedJavaScriptBeforeContentLoaded={bridge}
            onMessage={(e) => {
              try {
                const msg = JSON.parse(e.nativeEvent.data);
                if (msg.type === 'close') close();
                if (msg.type === 'send' && app) {
                  close();
                  deliverUserMessage(app.agentId, msg.text);
                }
              } catch {}
            }}
            style={{ flex: 1, backgroundColor: theme.panel }}
            javaScriptEnabled
            domStorageEnabled
          />
        ) : (
          <View style={{ flex: 1 }} pointerEvents="none">
            <WebView source={{ html }} style={{ flex: 1, backgroundColor: theme.panel }} scrollEnabled={false} />
          </View>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  shot: {
    height: PREVIEW_H,
    overflow: 'hidden',
  },
});
