/* Suerte — settings.js : читает/пишет aqbobek_config в chrome.storage.local.
 * Схема ДОЛЖНА совпадать с DEFAULTS в content.js. */
'use strict';

const CONFIG_KEY = 'aqbobek_config';
const LOG_KEY = 'aqbobek_log';

const DEFAULTS = {
  triggers: {
    wake: ['алиса', 'агент', 'работник', 'ассистент'],
    sleep: ['спи', 'отдыхай', 'выключись'],
    send: ['отправь', 'отправить', 'готово'],
    stop: ['отмена', 'стоп', 'отмени'],
    settings: ['настройки', 'настройка']
  },
  silenceMs: 900,
  armTimeoutMs: 7000,
  provider: 'qwen',
  servers: { local: { url: 'http://127.0.0.1', port: 8000 }, main: { url: 'http://127.0.0.1', port: 8080, token: '' } },
  confirmBeforeSend: true,
  noScanPages: [],
  listenOnStart: false,
  lang: 'ru-RU',
  theme: '',
  narrator: false,
  volume: 1,
  devMode: false
};

let CFG = JSON.parse(JSON.stringify(DEFAULTS));
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function load() {
  return new Promise((res) => {
    chrome.storage.local.get(CONFIG_KEY, (store) => {
      const saved = store[CONFIG_KEY] || {};
      CFG = deepMerge(DEFAULTS, saved);
      res();
    });
  });
}
function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k in (over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') out[k] = deepMerge(base[k], over[k]);
    else if (over[k] !== undefined) out[k] = over[k];
  }
  return out;
}

let saveTimer = null;
function save() {
  $('#save-state').textContent = 'Сохранение...';
  $('#save-state').classList.add('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ [CONFIG_KEY]: CFG }, () => {
      $('#save-state').textContent = 'Сохранено';
      $('#save-state').classList.remove('dirty');
    });
  }, 250);
}

/* ── Tabs ── */
$$('#tabs .tab').forEach((t) => t.addEventListener('click', () => {
  $$('#tabs .tab').forEach((x) => x.classList.remove('active'));
  $$('.sec').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $(`.sec[data-sec="${t.dataset.sec}"]`).classList.add('active');
  if (t.dataset.sec === 'log') renderLog();
}));

/* ── Words ── */
function renderWords() {
  $$('.word-group').forEach((group) => {
    const key = group.dataset.key;
    const chips = group.querySelector('.chips');
    chips.innerHTML = '';
    (CFG.triggers[key] || []).forEach((word, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = word;
      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'Удалить';
      del.addEventListener('click', () => { CFG.triggers[key].splice(i, 1); save(); renderWords(); });
      chip.appendChild(del);
      chips.appendChild(chip);
    });
  });
}
$$('.word-group').forEach((group) => {
  const key = group.dataset.key;
  const input = group.querySelector('.add input');
  const addWord = () => {
    const w = input.value.trim().toLowerCase();
    if (!w) return;
    if (!CFG.triggers[key]) CFG.triggers[key] = [];
    if (!CFG.triggers[key].includes(w)) CFG.triggers[key].push(w);
    input.value = ''; save(); renderWords();
  };
  group.querySelector('.btn-add').addEventListener('click', addWord);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addWord(); });
});

/* ── Voice ── */
function bindVoice() {
  const selectProvider = (p) => {
    CFG.provider = p;
    $$('#provider-seg button').forEach((b) => b.classList.toggle('active', b.dataset.provider === p));
  };
  $$('#provider-seg button').forEach((b) =>
    b.addEventListener('click', () => { selectProvider(b.dataset.provider); save(); }));
  selectProvider(CFG.provider || 'qwen');

  $('#silence').value = CFG.silenceMs;
  $('#silence-val').textContent = (CFG.silenceMs / 1000).toFixed(2) + ' с';
  $('#silence').addEventListener('input', (e) => {
    CFG.silenceMs = +e.target.value;
    $('#silence-val').textContent = (CFG.silenceMs / 1000).toFixed(2) + ' с';
    save();
  });

  bindToggle('#confirm', 'confirmBeforeSend');
  bindToggle('#listenOnStart', 'listenOnStart');
  bindToggle('#narrator', 'narrator');
  bindToggle('#devMode', 'devMode');

  $('#lang').value = CFG.lang;
  $('#lang').addEventListener('change', (e) => { CFG.lang = e.target.value; save(); });
}
function bindToggle(sel, key) {
  const cb = $(sel);
  cb.checked = !!CFG[key];
  cb.addEventListener('change', (e) => { CFG[key] = e.target.checked; save(); });
}

/* ── Servers ── */
function bindServers() {
  $('#main-url').value = CFG.servers.main.url;
  $('#main-port').value = CFG.servers.main.port;
  $('#main-token').value = CFG.servers.main.token || '';
  $('#local-url').value = CFG.servers.local.url;
  $('#local-port').value = CFG.servers.local.port;
  $('#main-url').addEventListener('input', (e) => { CFG.servers.main.url = e.target.value.trim(); save(); });
  $('#main-port').addEventListener('input', (e) => { CFG.servers.main.port = +e.target.value || null; save(); });
  $('#main-token').addEventListener('input', (e) => { CFG.servers.main.token = e.target.value.trim(); save(); });
  $('#local-url').addEventListener('input', (e) => { CFG.servers.local.url = e.target.value.trim(); save(); });
  $('#local-port').addEventListener('input', (e) => { CFG.servers.local.port = +e.target.value || null; save(); });

  // Показать/скрыть токен (иконка «глаз»)
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-8-10-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
  $$('.token-eye').forEach((btn) => {
    btn.innerHTML = EYE;
    btn.addEventListener('click', () => {
      const inp = $('#' + btn.dataset.target);
      const reveal = inp.type === 'password';
      inp.type = reveal ? 'text' : 'password';
      btn.innerHTML = reveal ? EYE_OFF : EYE;
      btn.title = reveal ? 'Скрыть' : 'Показать';
      btn.classList.toggle('active', reveal);
    });
  });

  $('#ping-local').addEventListener('click', () => {
    const res = $('#ping-res');
    res.textContent = 'Проверяю...'; res.style.color = 'var(--t2)';
    chrome.runtime.sendMessage({ type: 'PING_LOCAL' }, (r) => {
      if (chrome.runtime.lastError) { res.textContent = 'Ошибка: ' + chrome.runtime.lastError.message; res.style.color = 'var(--red)'; return; }
      if (r && r.ok) { res.textContent = 'Локальный сервер отвечает'; res.style.color = 'var(--ok)'; }
      else { res.textContent = 'Нет ответа: ' + ((r && r.error) || '—'); res.style.color = 'var(--red)'; }
    });
  });
}

/* ── Sites (страницы-исключения, где скан НЕ нужен) ── */
function bindSites() {
  const ta = $('#noscan');
  const existing = CFG.noScanPages || [];
  CFG.noScanPages = existing;
  ta.value = existing.join('\n');
  ta.addEventListener('input', (e) => {
    CFG.noScanPages = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
    save();
  });
}

/* ── Appearance (визуальный выбор темы) ── */
// a = акцент, d = тёмный акцент (для градиента), rgb = для свечения, bg = превью-фон.
const THEMES = [
  { v: '',                n: 'Зелёная',  a: '#4ade80', d: '#16a34a', rgb: '74,222,128',  bg: '#111820', light: false },
  { v: 'teal-aurora',     n: 'Teal',     a: '#2dd4bf', d: '#0d9488', rgb: '45,212,191',  bg: '#111820', light: false },
  { v: 'cyan',            n: 'Cyan',     a: '#22d3ee', d: '#0891b2', rgb: '34,211,238',  bg: '#111820', light: false },
  { v: 'arctic',          n: 'Arctic',   a: '#38bdf8', d: '#0369a1', rgb: '56,189,248',  bg: '#111820', light: false },
  { v: 'indigo-night',    n: 'Indigo',   a: '#818cf8', d: '#4338ca', rgb: '129,140,248', bg: '#111820', light: false },
  { v: 'conic-violet',    n: 'Violet',   a: '#c084fc', d: '#7c3aed', rgb: '192,132,252', bg: '#111820', light: false },
  { v: 'void-bloom',      n: 'Magenta',  a: '#f472b6', d: '#be185d', rgb: '244,114,182', bg: '#111820', light: false },
  { v: 'obsidian-rose',   n: 'Rose',     a: '#f9a8d4', d: '#be185d', rgb: '249,168,212', bg: '#111820', light: false },
  { v: 'aurora-borealis', n: 'Aurora',   a: '#818cf8', d: '#0d9488', rgb: '129,140,248', bg: '#111820', light: false },
  { v: 'solar-flare',     n: 'Solar',    a: '#fb923c', d: '#ea580c', rgb: '251,146,60',  bg: '#111820', light: false },
  { v: 'slate',           n: 'Slate',    a: '#94a3b8', d: '#475569', rgb: '148,163,184', bg: '#111820', light: false },
  { v: 'zinc',            n: 'Zinc',     a: '#a1a1aa', d: '#52525b', rgb: '161,161,170', bg: '#111820', light: false },
  { v: 'paper',           n: 'Paper',    a: '#1d4ed8', d: '#1e3a8a', rgb: '29,78,216',   bg: '#f2efe8', light: true },
  { v: 'mint',            n: 'Mint',     a: '#10b981', d: '#047857', rgb: '16,185,129',  bg: '#e8f7f0', light: true },
  { v: 'lavender',        n: 'Lavender', a: '#a78bfa', d: '#6d28d9', rgb: '167,139,250', bg: '#f5f1ff', light: true },
  { v: 'sunrise',         n: 'Sunrise',  a: '#f59e0b', d: '#b45309', rgb: '245,158,11',  bg: '#fff7ed', light: true },
];
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

// Перекрасить акцент САМОЙ страницы настроек под выбранную тему (живой предпросмотр).
function applyPageAccent(theme) {
  const t = THEMES.find((x) => x.v === (theme || '')) || THEMES[0];
  const r = document.documentElement.style;
  r.setProperty('--accent', t.a);
  r.setProperty('--accent-dim', t.d);
  r.setProperty('--accent-rgb', t.rgb);
  r.setProperty('--glow', `rgba(${t.rgb},.18)`);
  r.setProperty('--border2', `rgba(${t.rgb},.30)`);
}

function bindAppearance() {
  const mk = (t) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-swatch' + (t.light ? ' light' : '');
    btn.dataset.v = t.v;
    btn.title = t.n + (t.light ? ' (светлая)' : '');
    btn.innerHTML =
      `<span class="tw-preview" style="background:${t.bg}"><span class="tw-dot" style="background:linear-gradient(135deg,${t.a},${t.d})"></span></span>` +
      `<span class="tw-name">${t.n}</span>` +
      `<span class="tw-check" style="background:${t.a}">${CHECK}</span>`;
    btn.addEventListener('click', () => {
      CFG.theme = t.v;
      save();
      applyPageAccent(t.v);
      markSelected();
    });
    return btn;
  };
  const dark = $('#theme-grid-dark'), light = $('#theme-grid-light');
  dark.innerHTML = ''; light.innerHTML = '';
  THEMES.forEach((t) => (t.light ? light : dark).appendChild(mk(t)));
  applyPageAccent(CFG.theme);
  markSelected();
}
function markSelected() {
  $$('.theme-swatch').forEach((b) => b.classList.toggle('selected', (b.dataset.v || '') === (CFG.theme || '')));
}

/* ── Log ── */
const LOG_BADGE = { success: 'OK', error: 'ОШИБКА', warn: 'ВНИМ', info: 'ИНФО', run: 'ШАГ', net: 'СЕТЬ' };
let logFilterS = 'all';
function renderLog() {
  chrome.storage.local.get(LOG_KEY, (store) => {
    const all = (store[LOG_KEY] || []).slice().reverse();
    const arr = all.filter((it) => {
      if (logFilterS === 'all') return true;
      if (logFilterS === 'error') return (it.kind || 'info') === 'error';
      return (it.cat || 'event') === logFilterS;
    });
    const list = $('#log-list');
    list.innerHTML = arr.length ? '' : '<p class="hint">Пусто — здесь появятся запросы к серверам и их полные ответы (раскрываются по клику).</p>';
    arr.forEach((it) => {
      const kind = it.kind || 'info';
      const div = document.createElement('div');
      div.className = 'log-item ' + kind;
      if (it.detail) div.classList.add('has-detail');
      const ms = it.ms != null ? `<span class="log-ms">${it.ms}ms</span>` : '';
      div.innerHTML =
        `<div class="log-head">` +
          `<span class="log-badge">${LOG_BADGE[kind] || 'ИНФО'}</span>` +
          `<span class="log-title">${esc(it.title)}</span>` +
          ms +
          `<span class="log-time">${esc(it.time)}</span>` +
        `</div>` +
        (it.text ? `<div class="log-text">${esc(it.text)}</div>` : '') +
        (it.detail ? `<pre class="log-detail">${esc(it.detail)}</pre>` +
          `<button class="log-copy1" type="button">Копировать</button>` : '');
      if (it.detail) {
        div.querySelector('.log-head').addEventListener('click', () => div.classList.toggle('open'));
        div.querySelector('.log-copy1').addEventListener('click', (e) => {
          e.stopPropagation();
          const b = e.currentTarget;
          if (navigator.clipboard) navigator.clipboard.writeText(it.detail).then(() => {
            const t = b.textContent; b.textContent = 'Скопировано'; setTimeout(() => { b.textContent = t; }, 900);
          });
        });
      }
      list.appendChild(div);
    });
  });
}
function downloadLog() {
  chrome.storage.local.get(LOG_KEY, (s) => {
    const blob = new Blob([JSON.stringify(s[LOG_KEY] || [], null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'suerte-devlog-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
}
$('#clear-log').addEventListener('click', () => { chrome.storage.local.set({ [LOG_KEY]: [] }, renderLog); });
$$('.log-filter').forEach((b) => b.addEventListener('click', () => {
  logFilterS = b.dataset.cat;
  $$('.log-filter').forEach((x) => x.classList.toggle('active', x === b));
  renderLog();
}));
const _copyAll = $('#log-copy-all');
if (_copyAll) _copyAll.addEventListener('click', () => {
  chrome.storage.local.get(LOG_KEY, (s) => {
    const txt = JSON.stringify(s[LOG_KEY] || [], null, 2);
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => {
      _copyAll.textContent = 'Скопировано'; setTimeout(() => { _copyAll.textContent = 'Копировать всё'; }, 900);
    });
  });
});
const _dlAll = $('#log-dl');
if (_dlAll) _dlAll.addEventListener('click', downloadLog);
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ── Init ── */
load().then(() => {
  renderWords();
  bindVoice();
  bindServers();
  bindSites();
  bindAppearance();
  // Убедимся, что дефолты записаны при первом запуске
  chrome.storage.local.set({ [CONFIG_KEY]: CFG });
});
