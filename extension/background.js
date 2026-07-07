/* Suerte / Aqbobek — background service worker (MV3)
 *
 * Единственная задача: быть сетевым маршрутизатором между content.js и двумя
 * серверами. Content-скрипт живёт на https-странице врача и НЕ может напрямую
 * стучаться на http://127.0.0.1:8000 (mixed-content) — поэтому все запросы к
 * локальному серверу (Windows врача) и к главному серверу (Linux VPS) идут
 * через этот воркер, у которого есть host_permissions и который свободен от
 * ограничений mixed-content страницы.
 *
 * Протокол сообщений (chrome.runtime.sendMessage из content.js):
 *   { type:'LOCAL_TRANSCRIBE', audioB64, mime, provider }   -> { text }
 *   { type:'LOCAL_SCAN',       html, values, url }          -> scan JSON
 *   { type:'LOCAL_MACRO',      value }                      -> { ok }
 *   { type:'LOCAL_OCR',        fileB64, name, mime, langs }  -> { text }
 *   { type:'MAIN_COMMAND',     text, provider, url, scan }  -> action | { steps:[...] }
 *   { type:'MAIN_OCR',         text, provider }             -> { id, data }
 *   { type:'PING_LOCAL' }                                   -> { ok }
 */

'use strict';

const CONFIG_KEY = 'aqbobek_config';

const FALLBACK = {
  provider: 'qwen',
  servers: {
    local: { url: 'http://127.0.0.1', port: 8000 },
    main:  { url: 'http://127.0.0.1', port: 8080 }
  }
};

async function getConfig() {
  try {
    const store = await chrome.storage.local.get(CONFIG_KEY);
    return store[CONFIG_KEY] || FALLBACK;
  } catch (_e) {
    return FALLBACK;
  }
}

function baseUrl(server) {
  // server = { url, port }; собираем корректный origin без двойного порта
  let url = (server && server.url ? server.url : '').replace(/\/+$/, '');
  const port = server && server.port;
  if (port && !/:\d+$/.test(url)) url += ':' + port;
  return url;
}

async function localBase(cfg) { return baseUrl((cfg.servers || {}).local || FALLBACK.servers.local); }
async function mainBase(cfg)  { return baseUrl((cfg.servers || {}).main  || FALLBACK.servers.main);  }

/* ── base64 <-> Blob ─────────────────────────────────────────────── */
function b64ToBlob(b64, mime) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

/* ── HTTP helpers ────────────────────────────────────────────────── */
async function postJSON(url, body, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (data.detail || text).toString().slice(0, 300));
    return data;
  } finally { clearTimeout(t); }
}

async function postForm(url, form, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', body: form, signal: ctrl.signal });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (data.detail || text).toString().slice(0, 300));
    return data;
  } finally { clearTimeout(t); }
}

/* ── Message handlers ────────────────────────────────────────────── */
const HANDLERS = {
  async LOCAL_TRANSCRIBE(msg, cfg) {
    const base = await localBase(cfg);
    const form = new FormData();
    form.append('file', b64ToBlob(msg.audioB64, msg.mime || 'audio/webm'), 'command.webm');
    form.append('provider', msg.provider || cfg.provider || 'qwen');
    return postForm(base + '/transcribe', form);
  },

  async LOCAL_SCAN(msg, cfg) {
    const base = await localBase(cfg);
    // /scan-dynamic — супернабор /scan: для известных страниц (doctor) отдаёт
    // спец-сканер, для остальных — тот же общий разбор, что и /scan.
    return postJSON(base + '/scan-dynamic', { html: msg.html, values: msg.values || {}, url: msg.url });
  },

  async LOCAL_MACRO(msg, cfg) {
    const base = await localBase(cfg);
    return postJSON(base + '/macro', { value: msg.value });
  },

  async LOCAL_OCR(msg, cfg) {
    const base = await localBase(cfg);
    const form = new FormData();
    form.append('file', b64ToBlob(msg.fileB64, msg.mime), msg.name || 'document');
    form.append('langs', msg.langs || 'kaz+rus+eng');
    return postForm(base + '/ocr', form);
  },

  async MAIN_COMMAND(msg, cfg) {
    const base = await mainBase(cfg);
    return postJSON(base + '/command', {
      text: msg.text,
      provider: msg.provider || cfg.provider || 'qwen',
      url: msg.url,
      scan: msg.scan || null
    });
  },

  async MAIN_OCR(msg, cfg) {
    const base = await mainBase(cfg);
    return postJSON(base + '/ocr-template', {
      text: msg.text,
      provider: msg.provider || cfg.provider || 'qwen'
    });
  },

  async PING_LOCAL(_msg, cfg) {
    const base = await localBase(cfg);
    return postJSON(base + '/ping', {}, 4000);
  },

  async OPEN_SETTINGS_TAB() {
    await chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
    return { opened: true };
  }
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = msg && HANDLERS[msg.type];
  if (!handler) return false;
  (async () => {
    try {
      const cfg = await getConfig();
      const data = await handler(msg, cfg);
      sendResponse({ ok: true, data });
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || String(e) });
    }
  })();
  return true; // async response
});

/* Клик по иконке расширения на панели браузера — открыть настройки в новой вкладке. */
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
});
