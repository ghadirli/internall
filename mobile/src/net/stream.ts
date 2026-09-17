/**
 * Server-sent-event streaming for React Native.
 *
 * RN's built-in `fetch` cannot stream a response body (no `body.getReader()`),
 * so this prefers `expo/fetch`, which can, and falls back to XMLHttpRequest —
 * whose `onprogress` exposes the partial `responseText` — everywhere else.
 */

export type SSEEvent = { data: string };

type Options = {
  url: string;
  headers: Record<string, string>;
  body: any;
  signal?: { aborted: boolean };
  onEvent: (data: any) => void;
};

async function viaExpoFetch(o: Options): Promise<boolean> {
  let expoFetch: any;
  try {
    // Optional dependency: present in Expo SDK 52+, absent in bare RN.
    expoFetch = require('expo/fetch').fetch;
  } catch {
    return false;
  }
  if (!expoFetch) return false;

  const res = await expoFetch(o.url, {
    method: 'POST',
    headers: o.headers,
    body: JSON.stringify(o.body),
  });

  if (!res.ok) throw await httpError(res);
  if (!res.body?.getReader) return false;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    if (o.signal?.aborted) {
      try {
        await reader.cancel();
      } catch {}
      return true;
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = drain(buffer, o.onEvent);
  }
  return true;
}

function viaXHR(o: Options): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let seen = 0;
    let buffer = '';

    xhr.open('POST', o.url);
    Object.entries(o.headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));

    xhr.onprogress = () => {
      if (o.signal?.aborted) {
        xhr.abort();
        return resolve();
      }
      const chunk = xhr.responseText.slice(seen);
      seen = xhr.responseText.length;
      buffer += chunk;
      buffer = drain(buffer, o.onEvent);
    };
    xhr.onload = () => {
      if (xhr.status >= 400) {
        reject(errorFromBody(xhr.status, xhr.responseText));
        return;
      }
      buffer += xhr.responseText.slice(seen);
      drain(buffer, o.onEvent);
      resolve();
    };
    xhr.onerror = () => reject(new Error('Network request failed'));
    xhr.onabort = () => resolve();
    xhr.send(JSON.stringify(o.body));
  });
}

/** Pulls whole `data:` lines out of the buffer, leaving any partial tail. */
function drain(buffer: string, onEvent: (data: any) => void): string {
  const parts = buffer.split('\n\n');
  const tail = parts.pop() ?? '';
  for (const part of parts) {
    for (const line of part.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        onEvent(JSON.parse(payload));
      } catch {
        // partial or non-JSON keep-alive — ignore
      }
    }
  }
  return tail;
}

async function httpError(res: any) {
  let text = '';
  try {
    text = await res.text();
  } catch {}
  return errorFromBody(res.status, text);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function errorFromBody(status: number, text: string) {
  let message = text?.slice(0, 400) || `HTTP ${status}`;
  try {
    const json = JSON.parse(text);
    message = json?.error?.message || json?.message || message;
  } catch {}
  return new ApiError(status, message);
}

export async function streamSSE(o: Options): Promise<void> {
  try {
    const handled = await viaExpoFetch(o);
    if (handled) return;
  } catch (err: any) {
    if (err instanceof ApiError) throw err; // a real API error, not a capability gap
    console.warn('expo/fetch streaming unavailable, falling back to XHR:', err?.message);
  }
  await viaXHR(o);
}

/** Plain JSON request (model lists, key checks). */
export async function getJSON(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) throw errorFromBody(res.status, text);
  return JSON.parse(text);
}
