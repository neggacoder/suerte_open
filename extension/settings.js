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

/* ── Log ── */
function renderLog() {
  chrome.storage.local.get(LOG_KEY, (store) => {
    const arr = (store[LOG_KEY] || []).slice().reverse();
    const list = $('#log-list');
    list.innerHTML = arr.length ? '' : '<p class="hint">Пока пусто.</p>';
    arr.forEach((it) => {
      const div = document.createElement('div');
      div.className = 'log-item ' + (it.kind || 'info');
      div.innerHTML = `<div class="log-time">${it.time} · ${esc(it.title)}</div>` + (it.text ? `<div class="log-text">${esc(it.text)}</div>` : '');
      list.appendChild(div);
    });
  });
}
$('#clear-log').addEventListener('click', () => { chrome.storage.local.set({ [LOG_KEY]: [] }, renderLog); });
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ── Init ── */
load().then(() => {
  renderWords();
  bindVoice();
  bindServers();
  bindSites();
  bindDomains();
  bindAppearance();
  // Убедимся, что дефолты записаны при первом запуске
  chrome.storage.local.set({ [CONFIG_KEY]: CFG });
});
