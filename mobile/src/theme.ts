import { useColorScheme } from 'react-native';

export type Theme = ReturnType<typeof makeTheme>;

const light = {
  bg: '#f6f6f7',
  panel: '#ffffff',
  panel2: '#fafafa',
  text: '#16161a',
  dim: '#6c6c76',
  faint: '#9a9aa4',
  line: 'rgba(0,0,0,0.09)',
  accent: '#c62828',      // 5.2:1 as text on white, 5.6:1 behind white text
  accent2: '#e04b3f',
  bubbleIn: '#ffffff',
  hover: 'rgba(0,0,0,0.05)',
  danger: '#8f1d16',
  good: '#2f7d4f',
  onAccent: '#ffffff',
};

const dark: typeof light = {
  bg: '#0f1014',
  panel: '#17181d',
  panel2: '#1d1f26',
  text: '#eceef3',
  dim: '#8f95a3',
  faint: '#6c7180',
  line: 'rgba(255,255,255,0.09)',
  accent: '#5a86ff',
  accent2: '#8b7cf6',
  bubbleIn: '#1e2027',
  hover: 'rgba(255,255,255,0.07)',
  danger: '#ff6b6f',
  good: '#3fb884',
  onAccent: '#ffffff',
};

function makeTheme(scheme: 'light' | 'dark') {
  const c = scheme === 'dark' ? dark : light;
  // Filled surfaces carry white text, so they use a deeper red than the one
  // used for accent *text*, which needs to stay bright against a dark ground.
  const accentFill = scheme === 'dark' ? '#d32f2f' : c.accent;
  return { ...c, accentFill, isDark: scheme === 'dark', scheme };
}

export function useTheme(override?: 'light' | 'dark' | 'system') {
  const system = useColorScheme();
  const scheme = override && override !== 'system' ? override : system === 'dark' ? 'dark' : 'light';
  return makeTheme(scheme);
}
