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
  servers: { local: { url: 'http://127.0.0.1', port: 8000 }, main: { url: 'https://pop-os.tail0a2432.ts.net' } },
  confirmBeforeSend: true,
  dynamicPages: [],
  dynamicDomains: [],
  listenOnStart: false,
  lang: 'ru-RU',
  theme: '',
  narrator: false,
  debug: false,
  volume: 1
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
  if (t.dataset.sec === 'log') loadLog();
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

/* ── Карточки-кнопки (заменяют <select> для темы / провайдера / языка) ──
   Общая функция: подсвечивает активную карточку в гриде(-ах), сохраняет
   значение в CFG[key] по клику, и опционально вызывает onChange(value) сразу
   же — используется для темы, чтобы перекрасить страницу вживую.
   Принимает один грид или массив гридов, если один и тот же CFG[key]
   выбирается из нескольких визуальных групп (например тёмные/светлые темы). */
function bindOptionGrid(gridEls, onChange) {
  const grids = Array.isArray(gridEls) ? gridEls : [gridEls];
  const key = grids[0].dataset.key;
  const allCards = grids.flatMap((g) => Array.from(g.querySelectorAll('.option-card')));
  function setActive(value) {
    allCards.forEach((c) => c.classList.toggle('active', c.dataset.value === value));
  }
  allCards.forEach((card) => {
    card.addEventListener('click', () => {
      const value = card.dataset.value;
      CFG[key] = value;
      setActive(value);
      if (onChange) onChange(value);
      save();
    });
  });
  setActive(CFG[key] ?? '');
  return setActive;
}

/* ── Voice ── */
function bindVoice() {
  bindOptionGrid($('#provider-grid'));

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
  $('#local-url').value = CFG.servers.local.url;
  $('#local-port').value = CFG.servers.local.port;
  $('#main-url').addEventListener('input', (e) => { CFG.servers.main.url = e.target.value.trim(); save(); });
  $('#main-port').addEventListener('input', (e) => { CFG.servers.main.port = +e.target.value || null; save(); });
  $('#local-url').addEventListener('input', (e) => { CFG.servers.local.url = e.target.value.trim(); save(); });
  $('#local-port').addEventListener('input', (e) => { CFG.servers.local.port = +e.target.value || null; save(); });

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

/* ── Sites ── */
function renderSites() {
  const list = $('#dynamic-list');
  list.innerHTML = '';
  if (!CFG.dynamicPages.length) {
    list.innerHTML = '<p class="hint url-empty">Пока не добавлено ни одной страницы.</p>';
    return;
  }
  CFG.dynamicPages.forEach((url, i) => {
    const item = document.createElement('div');
    item.className = 'url-item';

    const badge = document.createElement('span');
    badge.className = 'url-badge';
    badge.textContent = '#' + (i + 1);

    const input = document.createElement('input');
    input.type = 'text';
    input.value = url;
    input.spellcheck = false;
    input.addEventListener('input', (e) => { CFG.dynamicPages[i] = e.target.value.trim(); save(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#dynamic-new-input').focus(); } });

    const del = document.createElement('button');
    del.className = 'url-del';
    del.textContent = '✕';
    del.title = 'Удалить';
    del.addEventListener('click', () => { CFG.dynamicPages.splice(i, 1); save(); renderSites(); });

    item.appendChild(badge);
    item.appendChild(input);
    item.appendChild(del);
    list.appendChild(item);
  });
}
function bindSites() {
  // миграция со старого ключа dynamicSites, если он был
  const existing = (CFG.dynamicPages && CFG.dynamicPages.length) ? CFG.dynamicPages : (CFG.dynamicSites || []);
  CFG.dynamicPages = existing;
  renderSites();

  const newInput = $('#dynamic-new-input');
  const addPage = () => {
    const v = newInput.value.trim();
    if (!v) return;
    CFG.dynamicPages.push(v);
    newInput.value = '';
    save();
    renderSites();
    $('#dynamic-new-input').focus();
  };
  $('#dynamic-add-btn').addEventListener('click', addPage);
  newInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addPage(); } });
}

/* ── Domains (динамические САЙТЫ — совпадение по домену, путь не важен) ── */
function renderDomains() {
  const list = $('#domain-list');
  list.innerHTML = '';
  if (!CFG.dynamicDomains.length) {
    list.innerHTML = '<p class="hint url-empty">Пока не добавлено ни одного сайта.</p>';
    return;
  }
  CFG.dynamicDomains.forEach((domain, i) => {
    const item = document.createElement('div');
    item.className = 'url-item';

    const badge = document.createElement('span');
    badge.className = 'url-badge';
    badge.textContent = '#' + (i + 1);

    const input = document.createElement('input');
    input.type = 'text';
    input.value = domain;
    input.spellcheck = false;
    input.addEventListener('input', (e) => { CFG.dynamicDomains[i] = e.target.value.trim(); save(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#domain-new-input').focus(); } });

    const del = document.createElement('button');
    del.className = 'url-del';
    del.textContent = '✕';
    del.title = 'Удалить';
    del.addEventListener('click', () => { CFG.dynamicDomains.splice(i, 1); save(); renderDomains(); });

    item.appendChild(badge);
    item.appendChild(input);
    item.appendChild(del);
    list.appendChild(item);
  });
}
function bindDomains() {
  if (!CFG.dynamicDomains) CFG.dynamicDomains = [];
  renderDomains();

  const newInput = $('#domain-new-input');
  const addDomain = () => {
    const v = newInput.value.trim();
    if (!v) return;
    CFG.dynamicDomains.push(v);
    newInput.value = '';
    save();
    renderDomains();
    $('#domain-new-input').focus();
  };
  $('#domain-add-btn').addEventListener('click', addDomain);
  newInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addDomain(); } });
}

/* ── Appearance: тема применяется сразу и к самой странице настроек ──
   через атрибут data-theme на <body> (settings-theme.css содержит те же
   цвета акцента, что и панель на сайте — panel.css), а не только сохраняется
   в CFG для виджета. */
function applyTheme(value) {
  if (value) document.body.setAttribute('data-theme', value);
  else document.body.removeAttribute('data-theme');
}
function bindAppearance() {
  const grids = [$('#theme-grid'), $('#theme-grid-light')];
  // подставляем реальные цвета темы в мини-превью каждой карточки
  grids.forEach((grid) => {
    Array.from(grid.querySelectorAll('.option-card')).forEach((card) => {
      const preview = card.querySelector('.theme-preview');
      if (!preview) return;
      if (card.dataset.accent) preview.style.setProperty('--tp-accent', card.dataset.accent);
      if (card.dataset.dim) preview.style.setProperty('--tp-dim', card.dataset.dim);
      if (card.dataset.glow) preview.style.setProperty('--tp-glow', card.dataset.glow);
    });
  });
  applyTheme(CFG.theme || '');
  bindOptionGrid(grids, applyTheme);
}

/* ── Лог и отладка ───────────────────────────────────────────────────────
   Список живёт в chrome.storage.local. Держим локальную копию, чтобы фильтры
   и поиск работали без повторного чтения хранилища, а onChanged давал живое
   обновление, пока страница открыта вторым окном. */
const LOG_LEVELS = ['info', 'success', 'warn', 'error'];
let LOG_CACHE = [];
let logLevel = '';        // '' — все уровни
let logQuery = '';
let logLive = true;
const logOpen = new Set();   // какие записи раскрыты (переживает перерисовку)

function logKey(it) { return String(it.ts) + '|' + (it.title || ''); }

function loadLog() {
  chrome.storage.local.get(LOG_KEY, (store) => {
    LOG_CACHE = store[LOG_KEY] || [];
    renderLog();
  });
}

function renderLog() {
  // счётчики уровней считаем по всему логу, а не по отфильтрованному срезу
  const counts = { '': LOG_CACHE.length };
  LOG_LEVELS.forEach((l) => { counts[l] = 0; });
  LOG_CACHE.forEach((it) => {
    const k = it.kind || 'info';
    if (k in counts) counts[k]++;
  });
  $$('#log-levels .log-chip').forEach((c) => { c.querySelector('b').textContent = counts[c.dataset.level] || 0; });

  const items = LOG_CACHE.filter((it) => {
    if (logLevel && (it.kind || 'info') !== logLevel) return false;
    if (!logQuery) return true;
    return ((it.title || '') + ' ' + (it.text || '')).toLowerCase().includes(logQuery);
  }).reverse();   // новые сверху

  const list = $('#log-list');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<p class="hint">' + (LOG_CACHE.length ? 'Ничего не найдено.' : 'Пока пусто.') + '</p>';
    return;
  }
  items.forEach((it) => list.appendChild(logRow(it)));
}

function logRow(it) {
  const key = logKey(it);
  const div = document.createElement('div');
  div.className = 'log-item ' + (it.kind || 'info') + (logOpen.has(key) ? ' open' : '');

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'log-head';
  const peek = (it.text || '').split('\n')[0].slice(0, 90);
  head.innerHTML = `<span class="log-time">${esc(it.time || '')}</span>` +
    `<span class="log-title">${esc(it.title || '')}</span>` +
    `<span class="log-peek">${esc(peek)}</span>`;
  head.addEventListener('click', () => {
    if (logOpen.has(key)) logOpen.delete(key); else logOpen.add(key);
    div.classList.toggle('open');
  });
  div.appendChild(head);

  const body = document.createElement('div');
  body.className = 'log-body';
  body.innerHTML =
    (it.text ? `<pre class="log-text">${esc(it.text)}</pre>` : '<p class="hint">Без подробностей.</p>') +
    (it.url ? `<div class="log-meta">Страница: ${esc(it.url)}</div>` : '');
  div.appendChild(body);
  return div;
}

function bindLog() {
  const dbgToggle = $('#debug-mode');
  dbgToggle.checked = !!CFG.debug;
  dbgToggle.addEventListener('change', (e) => { CFG.debug = e.target.checked; save(); });

  const live = $('#log-live');
  live.checked = logLive;
  live.addEventListener('change', (e) => { logLive = e.target.checked; if (logLive) loadLog(); });

  $('#log-search').addEventListener('input', (e) => {
    logQuery = e.target.value.trim().toLowerCase();
    renderLog();
  });

  $$('#log-levels .log-chip').forEach((chip) => chip.addEventListener('click', () => {
    logLevel = chip.dataset.level;
    $$('#log-levels .log-chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderLog();
  }));

  $('#clear-log').addEventListener('click', () => {
    chrome.storage.local.set({ [LOG_KEY]: [] }, () => { LOG_CACHE = []; logOpen.clear(); renderLog(); });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[LOG_KEY] || !logLive) return;
    LOG_CACHE = changes[LOG_KEY].newValue || [];
    renderLog();
  });
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ── Init ── */
load().then(() => {
  renderWords();
  bindVoice();
  bindServers();
  bindSites();
  bindDomains();
  bindAppearance();
  bindLog();
  loadLog();
  // Убедимся, что дефолты записаны при первом запуске
  chrome.storage.local.set({ [CONFIG_KEY]: CFG });
});
