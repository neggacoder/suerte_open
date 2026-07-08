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
 *   { type:'SET_KENDO_VALUE',  marker, value }              -> { applied }
 *     (marker — временная метка data-aq-kendo-target, проставленная content.js
 *      на нужный элемент; выполняется в MAIN-мире страницы через
 *      chrome.scripting.executeScript, т.к. content.js не видит page-jQuery/Kendo)
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
    // iframe_html — HTML-снимок документа внутри iframe#editor_N (дневник):
    // серверный scan_diary читает из него текущий текст поля построчно.
    return postJSON(base + '/scan-dynamic', { html: msg.html, values: msg.values || {}, url: msg.url, iframe_html: msg.iframe_html || null });
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
  },

  // ─── SET_KENDO_VALUE ────────────────────────────────────────────────────
  // content.js работает в ИЗОЛИРОВАННОМ JS-мире страницы: он видит DOM, но не
  // видит её JS-объекты (window.jQuery там — не та jQuery, что использует
  // сама страница/Kendo). Поэтому применить значение через API kendo-виджета
  // (widget.value(x) + widget.trigger('change')) можно только выполнив код
  // в MAIN-мире страницы — это умеет только background через
  // chrome.scripting.executeScript({world:'MAIN'}).
  // content.js помечает нужный элемент временным атрибутом-меткой (msg.marker)
  // и просит найти/применить значение. allFrames:true — на случай, если поле
  // находится внутри iframe.
  //
  // ВАЖНО: элемент, найденный по селектору автоматизации, не всегда тот, на
  // котором Kendo реально хранит объект виджета. У NumericTextBox есть ДВА
  // input'а: видимый прокси без id (class="k-formatted-value", то, во что
  // реально кликает/печатает врач) и оригинальный скрытый input с id и
  // data-role="numerictextbox" (на нём и живёт jQuery.data('kendoNumericTextBox')).
  // Если селектор указывает не на тот элемент — просто расширяем поиск на
  // ближайшую обёртку .k-widget и все её потомки с data-role.
  //
  // Возвращаем { applied, reason } — reason всегда содержит человекочитаемое
  // объяснение (даже при неудаче), чтобы не гадать вслепую при следующем сбое.
  async SET_KENDO_VALUE(msg, _cfg, sender) {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId == null) throw new Error('Нет tabId отправителя для executeScript');

    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        func: (marker, rawValue) => {
          const node = document.querySelector('[data-aq-kendo-target="' + marker + '"]');
          if (!node) return null; // это не тот фрейм — в нём метки нет, это нормально

          try {
            const $ = window.jQuery || window.$;
            if (typeof $ !== 'function') {
              return { applied: false, reason: 'На странице (в этом фрейме) нет window.jQuery/$ — не удаётся достать виджет' };
            }

            // Кандидаты: сам элемент, ближайшая обёртка .k-widget, и все узлы с data-role внутри неё.
            const candidates = [node];
            const wrap = node.closest('.k-widget');
            if (wrap) {
              candidates.push(wrap);
              wrap.querySelectorAll('[data-role]').forEach((n) => { if (candidates.indexOf(n) === -1) candidates.push(n); });
            }

            const triedKeys = [];
            for (const cand of candidates) {
              let data;
              try { data = $(cand).data(); } catch (_e) { continue; }
              if (!data) continue;

              for (const key in data) {
                if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
                if (!/^kendo/.test(key)) continue;
                triedKeys.push(key);
                const widget = data[key];
                if (!widget || typeof widget.value !== 'function') continue;

                // Числовые виджеты (NumericTextBox, Slider) ждут Number, остальные — обычно строку.
                let val = rawValue;
                if (/NumericTextBox|Slider/i.test(key)) {
                  const num = Number(rawValue);
                  if (rawValue !== '' && !isNaN(num)) val = num;
                }

                widget.value(val);
                // trigger('change') — kendo-шный метод самого виджета (не DOM-событие),
                // именно он заставляет виджет уведомить внутренние обработчики/MVVM-биндинги.
                if (typeof widget.trigger === 'function') widget.trigger('change');

                // Дублируем нативными DOM-событиями на всякий случай — вдруг что-то на
                // странице слушает 'input'/'change' напрямую, а не через kendo bind().
                node.dispatchEvent(new Event('input', { bubbles: true }));
                node.dispatchEvent(new Event('change', { bubbles: true }));
                cand.dispatchEvent(new Event('input', { bubbles: true }));
                cand.dispatchEvent(new Event('change', { bubbles: true }));

                return { applied: true, reason: 'OK через ' + key + ' (элемент: ' + (cand.id || cand.className || cand.tagName) + ')' };
              }
            }

            return {
              applied: false,
              reason: 'jQuery есть, но kendo-виджет не найден среди ' + candidates.length +
                ' кандидатов (проверенные kendo*-ключи: ' + (triedKeys.join(', ') || 'нет ни одного') + ')'
            };
          } catch (e) {
            return { applied: false, reason: 'Ошибка в MAIN-мире: ' + (e && e.message) };
          }
        },
        args: [msg.marker, msg.value]
      });
    } catch (e) {
      // executeScript сам не смог выполниться (например, страница защищена/недоступна для скриптов)
      return { applied: false, reason: 'executeScript не сработал: ' + ((e && e.message) || String(e)) };
    }

    const perFrame = (results || []).map((r) => r && r.result).filter((r) => r != null);
    const hit = perFrame.find((r) => r && r.applied) || perFrame[0];
    if (!hit) return { applied: false, reason: 'Ни один фрейм не нашёл элемент с меткой (marker) — странно, элемент должен быть в DOM' };
    return { applied: !!hit.applied, reason: hit.reason };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && HANDLERS[msg.type];
  if (!handler) return false;
  (async () => {
    try {
      const cfg = await getConfig();
      const data = await handler(msg, cfg, sender);
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
