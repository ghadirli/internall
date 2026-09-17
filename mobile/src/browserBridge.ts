/**
 * Drives the app's WebView from the agent runtime.
 *
 * The WebView is mounted once at the root and stays alive (hidden when not in
 * use), so page state and logins survive. Tools call `evaluate()`, which
 * injects JS and waits for the page to post the result back.
 */
import { newId } from './store';

type Pending = { resolve: (v: any) => void; reject: (e: any) => void; timer: any };

export const PAGE_HELPERS = `
(function () {
  if (window.__slava) return;
  var S = (window.__slava = {});

  S.visible = function (el) {
    if (!el.getClientRects().length) return false;
    var st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };

  S.label = function (el) {
    var byFor = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    var text =
      (el.labels && el.labels[0] && el.labels[0].innerText) ||
      (byFor && byFor.innerText) ||
      el.getAttribute('aria-label') ||
      el.placeholder ||
      (el.closest('label') && el.closest('label').innerText) ||
      el.title || el.name || el.id ||
      ((el.tagName === 'BUTTON' || el.tagName === 'A') ? el.innerText : '') || '';
    return String(text).replace(/\\s+/g, ' ').trim().slice(0, 70);
  };

  S.kind = function (el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      var t = (el.type || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'image') return 'button';
      return 'input:' + t;
    }
    if (el.isContentEditable) return 'editable';
    return 'button';
  };

  S.tag = function () {
    document.querySelectorAll('[data-slava-id]').forEach(function (e) { e.removeAttribute('data-slava-id'); });
    var sel = 'input:not([type=hidden]), textarea, select, button, a[href], [role=button], [contenteditable=true]';
    var out = [], n = 0;
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!S.visible(el) || el.disabled) continue;
      el.setAttribute('data-slava-id', String(++n));
      var kind = S.kind(el);
      var row = { i: n, kind: kind, label: S.label(el) };
      if (kind === 'select') {
        row.options = Array.prototype.map.call(el.options, function (o) { return o.text.trim(); }).slice(0, 40);
        row.value = el.value;
      } else if (/checkbox|radio/.test(kind)) {
        row.checked = el.checked;
      } else if (kind === 'link') {
        row.href = el.href;
      } else if (el.value !== undefined && kind !== 'button') {
        row.value = /password/.test(kind) ? (el.value ? '\\u2022\\u2022\\u2022' : '') : String(el.value).slice(0, 60);
      }
      if (el.required) row.required = true;
      out.push(row);
      if (n >= 120) break;
    }
    return out;
  };

  S.el = function (id) { return document.querySelector('[data-slava-id="' + Number(id) + '"]'); };

  S.flash = function (el, text) {
    try {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      var r = el.getBoundingClientRect();
      var box = document.createElement('div');
      box.style.cssText =
        'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #d32f2f;' +
        'border-radius:6px;box-shadow:0 0 0 4px rgba(211,47,47,.25);transition:opacity .4s;' +
        'left:' + (r.left - 3) + 'px;top:' + (r.top - 3) + 'px;width:' + (r.width + 6) + 'px;height:' + (r.height + 6) + 'px;';
      var tip = document.createElement('div');
      tip.textContent = text;
      tip.style.cssText =
        'position:absolute;left:0;top:-24px;background:#d32f2f;color:#fff;' +
        'font:600 11px/16px -apple-system,sans-serif;padding:2px 7px;border-radius:5px;white-space:nowrap;';
      box.appendChild(tip);
      document.documentElement.appendChild(box);
      setTimeout(function () { box.style.opacity = '0'; setTimeout(function () { box.remove(); }, 400); }, 1100);
    } catch (e) {}
  };

  S.setValue = function (el, value) {
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
  };

  S.fill = function (id, value) {
    var el = S.el(id);
    if (!el) return { ok: false, error: 'No element numbered ' + id + '. Call browser_fields again.' };
    var kind = S.kind(el);
    S.flash(el, 'typing...');
    el.focus();
    if (/checkbox|radio/.test(kind)) {
      var want = !/^(false|no|0|off|unchecked)$/i.test(String(value).trim());
      if (el.checked !== want) el.click();
      return { ok: true, kind: kind, label: S.label(el), checked: el.checked };
    }
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
      return { ok: true, kind: kind, label: S.label(el) };
    }
    S.setValue(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    S.setValue(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, kind: kind, label: S.label(el), value: /password/.test(kind) ? '***' : el.value };
  };

  S.select = function (id, option) {
    var el = S.el(id);
    if (!el || el.tagName !== 'SELECT') return { ok: false, error: 'Element ' + id + ' is not a dropdown.' };
    var want = String(option).trim().toLowerCase();
    var opts = Array.prototype.slice.call(el.options);
    var hit = opts.filter(function (o) { return o.text.trim().toLowerCase() === want; })[0] ||
              opts.filter(function (o) { return o.value.toLowerCase() === want; })[0] ||
              opts.filter(function (o) { return o.text.trim().toLowerCase().indexOf(want) >= 0; })[0];
    if (!hit) return { ok: false, error: 'No such option. Available: ' + opts.map(function (o) { return o.text.trim(); }).join(' | ') };
    S.flash(el, 'choosing...');
    el.value = hit.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, label: S.label(el), chosen: hit.text.trim() };
  };

  S.describe = function (id) {
    var el = S.el(id);
    if (!el) return null;
    var inForm = Boolean(el.form || el.closest('form'));
    var type = (el.getAttribute('type') || '').toLowerCase();
    return {
      label: S.label(el),
      kind: S.kind(el),
      submitish: inForm && (type === 'submit' || el.tagName === 'BUTTON') && el.type !== 'button',
      text: (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 70)
    };
  };

  S.click = function (id) {
    var el = S.el(id);
    if (!el) return { ok: false, error: 'No element numbered ' + id + '. Call browser_fields again.' };
    var label = S.label(el) || (el.innerText || '').trim().slice(0, 60);
    S.flash(el, 'clicking...');
    if (el.focus) el.focus();
    el.click();
    return { ok: true, label: label };
  };

  S.press = function (key) {
    var el = document.activeElement || document.body;
    var opts = { bubbles: true, cancelable: true, key: key, code: key };
    S.flash(el, key);
    var down = el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    if (key === 'Enter' && down) {
      var form = el.form || (el.closest && el.closest('form'));
      if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return { ok: true, submitted: true }; }
    }
    return { ok: true, submitted: false };
  };

  S.inForm = function () {
    var el = document.activeElement;
    return Boolean(el && (el.form || (el.closest && el.closest('form'))));
  };

  S.readText = function () {
    var el = document.querySelector('main, article') || document.body;
    return (el.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 8000);
  };

  S.links = function (q) {
    q = String(q || '').toLowerCase();
    return Array.prototype.slice.call(document.querySelectorAll('a[href]'))
      .map(function (a) { return { text: (a.innerText || '').trim().slice(0, 120), href: a.href }; })
      .filter(function (l) { return l.text && l.href.indexOf('http') === 0; })
      .filter(function (l) { return !q || (l.text + ' ' + l.href).toLowerCase().indexOf(q) >= 0; })
      .slice(0, 60);
  };
})();
true;
`;

class BrowserBridge {
  private webview: any = null;
  private pending = new Map<string, Pending>();
  private onVisible: ((visible: boolean) => void) | null = null;
  private onNavigate: ((url: string) => void) | null = null;

  url = 'https://duckduckgo.com';
  title = '';
  visible = false;

  attach(ref: any) {
    this.webview = ref;
  }
  setCallbacks(onVisible: (v: boolean) => void, onNavigate: (u: string) => void) {
    this.onVisible = onVisible;
    this.onNavigate = onNavigate;
  }

  show() {
    this.visible = true;
    this.onVisible?.(true);
  }
  hide() {
    this.visible = false;
    this.onVisible?.(false);
  }

  noteNavigation(url: string, title: string) {
    this.url = url;
    this.title = title;
  }

  /** Called by the WebView's onMessage. Returns true if it was ours. */
  handleMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!msg || !msg.__slava) return false;
    const p = this.pending.get(msg.__slava);
    if (!p) return true;
    clearTimeout(p.timer);
    this.pending.delete(msg.__slava);
    msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error || 'Page script failed'));
    return true;
  }

  /** Runs an expression in the page and resolves with its (JSON-safe) value. */
  evaluate(expression: string, timeoutMs = 15000): Promise<any> {
    if (!this.webview) return Promise.reject(new Error('The browser is not ready yet.'));
    const id = newId();
    const js = `
      (function () {
        try {
          ${PAGE_HELPERS}
          var v = (function () { return (${expression}); })();
          window.ReactNativeWebView.postMessage(JSON.stringify({ __slava: ${JSON.stringify(id)}, ok: true, value: v === undefined ? null : v }));
        } catch (e) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ __slava: ${JSON.stringify(id)}, ok: false, error: String(e && e.message || e) }));
        }
      })();
      true;
    `;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The page did not respond in time.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.webview.injectJavaScript(js);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /** Navigates and waits for the page to settle. */
  async open(url: string) {
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    this.show();
    this.url = url;
    this.onNavigate?.(url);
    await new Promise((r) => setTimeout(r, 1800)); // let the load and first paint happen
    try {
      const info = await this.evaluate('({ url: location.href, title: document.title })', 8000);
      this.noteNavigation(info.url, info.title);
      return info;
    } catch {
      return { url, title: '' };
    }
  }
}

export const browser = new BrowserBridge();
