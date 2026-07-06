/* Suerte / Aqbobek — content.js  (v11)
 * ─────────────────────────────────────────────────────────────────────────
 * Мини-виджет в углу страницы врача. Слушает wake-word (Web Speech API),
 * записывает голосовую команду (MediaRecorder), отправляет её на главный
 * сервер для транскрипции (Whisper) и за инструкциями,
 * и выполняет полученные действия на странице (click / write / writeByClick),
 * включая многошаговые и многостраничные сценарии.
 *
 * Дизайн DOM повторяет example.html; стили — panel.css.
 * Вся сеть идёт через background.js (mixed-content обход).
 * ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.__aqbobekInjected) return;
  window.__aqbobekInjected = true;
  try { console.info('%c[Suerte]%c content.js v11 injected → ' + location.host, 'color:#4ade80;font-weight:700', 'color:inherit'); } catch (_e) {}

  /* ════════════════════════════════════════════════════════════════════
   *  КОНФИГ
   * ════════════════════════════════════════════════════════════════════ */
  const CONFIG_KEY = 'aqbobek_config';
  const LOG_KEY = 'aqbobek_log';
  const PENDING_KEY = 'aqbobek_pending_plan';
  const LISTEN_KEY = 'aqbobek_listen';   // глобальное «слушать?» — синхронно во всех вкладках/сессиях

  const DEFAULTS = {
    triggers: {
      wake:     ['алиса', 'агент', 'работник', 'ассистент'],
      sleep:    ['спи', 'отдыхай', 'выключись'],
      send:     ['отправь', 'отправить', 'готово'],
      stop:     ['отмена', 'стоп', 'отмени'],
      settings: ['настройки', 'настройка']
    },
    silenceMs: 900,            // тишина перед авто-отправкой
    armTimeoutMs: 7000,        // сколько ждём голос после wake-word
    provider: 'qwen',          // qwen | openai | deepseek (LLM). Whisper: openai->whisper-1, иначе faster-whisper
    servers: {
      local: { url: 'http://127.0.0.1', port: 8000 },
      main:  { url: 'http://127.0.0.1', port: 8080, token: '' }
    },
    confirmBeforeSend: true,   // плашка «Отправить голосовое?» Да/Нет/Дозаписать
    noScanPages: [],           // СТРАНИЦЫ-ИСКЛЮЧЕНИЯ: здесь скан НЕ нужен. По умолчанию сканируем везде.
    listenOnStart: false,      // включать ли wake-word слушатель при загрузке
    lang: 'ru-RU',             // язык распознавания Web Speech
    theme: '',                 // тема панели (data-theme)
    narrator: false,           // озвучка ответов (TTS)
    volume: 1,
    devMode: false             // режим разработчика: подробный лог всего (сеть/события/ошибки/тайминги)
  };

  let CFG = Object.assign({}, DEFAULTS);

  function deepMerge(base, over) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    for (const k in (over || {})) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
        out[k] = deepMerge(base[k], over[k]);
      } else if (over[k] !== undefined) {
        out[k] = over[k];
      }
    }
    return out;
  }

  function loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get(CONFIG_KEY, (store) => {
        CFG = deepMerge(DEFAULTS, store[CONFIG_KEY] || {});
        resolve(CFG);
      });
    });
  }
  function saveConfig() {
    chrome.storage.local.set({ [CONFIG_KEY]: CFG });
  }

  // Реагируем на изменения конфига из страницы настроек
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[CONFIG_KEY]) {
      CFG = deepMerge(DEFAULTS, changes[CONFIG_KEY].newValue || {});
      applyConfigToUI();
    }
    // Глобальный тумблер «слушать» переключили в другой вкладке — применяем у себя.
    if (changes[LISTEN_KEY]) {
      const wanted = !!changes[LISTEN_KEY].newValue;
      if (wanted !== S.listenWanted) applyListen(wanted);
    }
  });

  /* ════════════════════════════════════════════════════════════════════
   *  СВЯЗЬ С BACKGROUND (сеть)
   * ════════════════════════════════════════════════════════════════════ */
  function _bgSend(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res) return reject(new Error('Нет ответа от background'));
        if (!res.ok) return reject(new Error(res.error || 'Ошибка сети'));
        resolve(res.data);
      });
    });
  }
  // Обёртка: в режиме разработчика пишет полный запрос/ответ/ошибку/тайминг в лог.
  function _now() { return (self.performance && performance.now()) || 0; }
  async function bg(type, payload) {
    const t0 = _now();
    try {
      const data = await _bgSend(type, payload);
      devCapture('net', '→ ' + type, { type, request: payload || null, response: data }, Math.round(_now() - t0), 'net');
      return data;
    } catch (e) {
      devCapture('error', '✕ ' + type, { type, request: payload || null, error: e.message }, Math.round(_now() - t0), 'net');
      throw e;
    }
  }

  /* ════════════════════════════════════════════════════════════════════
   *  DOM-ШАБЛОН  (повторяет example.html)
   * ════════════════════════════════════════════════════════════════════ */
  const ICON = {
    leaf: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>',
    logo: '<svg viewBox="0 0 349 341" fill="none"><g transform="translate(0,341) scale(0.1,-0.1)" fill="currentColor" stroke="none"><path d="M1350 2490 l0 -380 -380 0 -380 0 0 -400 0 -400 380 0 380 0 0 -380 0 -380 400 0 400 0 0 365 c0 237 -4 365 -10 365 -5 0 -10 -4 -10 -8 0 -4 -20 -18 -45 -30 l-45 -22 -2 -277 -3 -278 -285 0 -285 0 -3 378 -2 377 -380 0 -380 0 0 290 0 290 380 0 380 0 2 378 3 377 285 0 285 0 3 -271 2 -271 55 15 55 15 0 314 0 313 -400 0 -400 0 0 -380z"></path><path d="M2395 2369 c-11 -6 -30 -25 -43 -43 l-22 -33 2 -596 3 -597 31 -31 c59 -58 164 -48 199 21 23 44 23 1186 0 1230 -27 52 -113 77 -170 49z m83 -91 c9 -9 12 -149 12 -569 0 -487 -2 -560 -15 -573 -24 -23 -43 -9 -50 37 -9 61 -1 1090 8 1105 10 15 29 16 45 0z"></path><path d="M2079 2105 c-14 -8 -35 -27 -45 -42 -17 -26 -19 -53 -22 -325 -3 -240 -6 -299 -18 -309 -11 -9 -17 -9 -29 1 -12 10 -15 48 -15 222 0 220 -6 254 -48 291 -11 10 -39 21 -63 24 -79 11 -139 -44 -139 -129 0 -83 29 -78 -455 -80 l-430 -3 -3 -47 -3 -48 440 0 c247 0 450 4 464 9 40 16 70 67 76 134 4 41 11 63 23 71 37 23 43 -4 48 -242 3 -125 9 -235 14 -244 13 -27 70 -58 107 -58 19 0 49 9 67 20 58 36 62 57 62 373 0 245 2 286 16 297 12 11 18 11 29 -1 12 -11 15 -62 15 -258 1 -137 6 -253 11 -263 13 -25 65 -24 79 1 6 12 10 115 10 266 0 210 -3 252 -17 282 -30 65 -112 92 -174 58z"></path></g></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
    mic: '<svg viewBox="0 0 32 32" fill="none"><rect x="11" y="3" width="10" height="16" rx="5" fill="currentColor" opacity=".15" stroke="currentColor" stroke-width="1.8"></rect><path d="M16 19a6 6 0 0 0 6-6V9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path><path d="M10 13v0a6 6 0 0 0 12 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path><line x1="16" y1="25" x2="16" y2="29" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></line><line x1="12" y1="29" x2="20" y2="29" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></line></svg>',
    send: '<svg viewBox="0 0 32 32" fill="none"><path d="M28 4L4 14l9 4 4 9 11-23Z" fill="currentColor" opacity=".18" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"></path><line x1="13" y1="18" x2="28" y2="4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></line></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor"></rect></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>',
    shrink: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="10" y1="14" x2="3" y2="21"></line><line x1="21" y1="3" x2="14" y2="10"></line></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>',
    reqTab: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
    scanTab: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"></path><rect x="7" y="7" width="10" height="10" rx="1"></rect></svg>',
    logTab: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
    wave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>'
  };

  function template() {
    return `
<div id="aq-bubble"><div id="aq-bubble-ring"></div><div id="aq-bubble-logo">${ICON.logo}</div></div>
<div id="aq-corner"><div id="aq-corner-logo">${ICON.logo}</div><div id="aq-corner-reply"></div><div id="aq-corner-dot"></div></div>
<div id="aq-corner-hear" style="display:none"></div>
<div id="aq-chain-badge" style="display:none"><span id="aq-chain-badge-dot"></span><span id="aq-chain-badge-name"></span></div>
<div id="aq-panel">
  <div id="aq-head">
    <div id="aq-drag-dots"><em></em><em></em></div>
    <button id="aq-settings-btn" title="Настройки"><span class="aq-js-btn-icon">${ICON.gear}</span></button>
    <div id="aq-head-logo">${ICON.logo}</div>
    <span id="aq-head-title">Suerte</span>
    <div id="aq-dot"></div>
    <button id="aq-toggle-size" title="Развернуть / свернуть"><span class="ico-exp">${ICON.expand}</span><span class="ico-shr">${ICON.shrink}</span></button>
    <button id="aq-panel-close" title="Свернуть в угол">${ICON.close}</button>
    <div id="aq-pos-popup" style="display:none">
      <button class="aq-pos-opt" data-pos="bottom-right">↘ Правый нижний</button>
      <button class="aq-pos-opt" data-pos="bottom-left">↙ Левый нижний</button>
      <button class="aq-pos-opt" data-pos="top-right">↗ Правый верхний</button>
      <button class="aq-pos-opt" data-pos="top-left">↖ Левый верхний</button>
    </div>
  </div>
  <div id="aq-compact-zone">
    <div id="aq-input-wrap">
      <textarea id="aq-text" placeholder="Введите команду или нажмите микрофон..."></textarea>
      <div id="aq-right-btns">
        <button id="aq-mic-btn" title="Голосовой ввод">${ICON.mic}</button>
        <button id="aq-send-btn" title="Отправить">${ICON.send}<span>Отпр.</span></button>
      </div>
      <button id="aq-cancel-btn" title="Отменить" style="display:none">${ICON.stop}</button>
    </div>
    <div id="aq-ocr-drop" data-state="idle" title="OCR: перетащите файл или нажмите">
      <span class="aq-ocr-drop-ic">${ICON.scanTab}</span>
      <span class="aq-ocr-drop-label">Перетащите файл или нажмите — OCR</span>
      <span class="aq-ocr-drop-spin"></span>
    </div>
    <div id="aq-voice-bar" style="display:none">
      <div id="aq-voice-bar-row">
        <span id="aq-voice-rec"><span id="aq-voice-rec-dot"></span>REC</span>
        <div id="aq-voice-waves"></div>
        <span id="aq-voice-timer">0:00</span>
      </div>
      <span id="aq-voice-interim"></span>
    </div>
    <div id="aq-mic-denied-bar" style="display:none">Нет доступа к микрофону — проверь настройки браузера</div>
    <div id="aq-listen-off-bar" style="display:none">Wake-word выключен — нажми СПИТ или Alt+M чтобы включить</div>
    <div id="aq-run-progress" style="display:none">
      <div id="aq-run-progress-header"><span id="aq-run-step-label"></span><span id="aq-run-step-count"></span></div>
      <div id="aq-run-progress-track"><div id="aq-run-progress-bar"></div></div>
      <div id="aq-run-route-summary"></div>
    </div>
    <div id="aq-last-reply" style="display:none">
      <div id="aq-last-reply-icon">${ICON.check}</div>
      <span id="aq-last-reply-text"></span>
    </div>
  </div>
  <div id="aq-expanded-zone">
    <div id="aq-tabs">
      <button class="aq-tab active" data-tab="request">${ICON.reqTab} Ответ</button>
      <button class="aq-tab" data-tab="scan">${ICON.scanTab} Сканер</button>
      <button class="aq-tab" data-tab="log">${ICON.logTab} Лог</button>
      <button class="aq-tab" data-tab="ocr">${ICON.scanTab} OCR</button>
    </div>
    <div id="aq-tab-body">
      <div class="aq-tab-panel active" id="tab-request"><div id="aq-chat"></div></div>
      <div class="aq-tab-panel" id="tab-scan">
        <div id="aq-stats">
          <div class="aq-stat"><span id="stat-fields">0</span><small>Поля</small></div>
          <div class="aq-stat"><span id="stat-btns">0</span><small>Кнопки</small></div>
          <div class="aq-stat"><span id="stat-all">0</span><small>Всего</small></div>
        </div>
        <button id="aq-scan-btn" class="aq-btn-green">${ICON.bolt} Сканировать страницу</button>
        <div id="aq-dom-list"></div>
      </div>
      <div class="aq-tab-panel" id="tab-log">
        <div id="aq-log-toolbar">
          <div id="aq-log-filters">
            <button class="aq-log-filter active" data-cat="all">Все</button>
            <button class="aq-log-filter" data-cat="net">Сеть</button>
            <button class="aq-log-filter" data-cat="event">События</button>
            <button class="aq-log-filter" data-cat="error">Ошибки</button>
          </div>
          <div id="aq-log-tools">
            <button id="aq-log-copy" title="Копировать весь лог">${ICON.copy}<span>Копир.</span></button>
            <button id="aq-log-dl" title="Скачать лог .json">${ICON.download}<span>.json</span></button>
            <button id="aq-log-clear" title="Очистить лог">${ICON.trash}</button>
          </div>
        </div>
        <div id="aq-log-list"></div>
      </div>
      <div class="aq-tab-panel" id="tab-ocr">
        <div id="aq-ocr-inner">
          <button id="aq-ocr-pick" class="aq-btn-green">${ICON.scanTab} <span class="aq-ocr-pick-label">Загрузить PDF / DOCX / фото</span></button>
          <input id="aq-ocr-file" type="file" accept=".pdf,.docx,.png,.jpg,.jpeg,.tif,.tiff,.bmp" style="display:none">
          <div id="aq-ocr-file-info">
            <span class="aq-ocr-fi-ic">${ICON.logTab}</span>
            <span class="aq-ocr-fi-name"></span>
            <span class="aq-ocr-fi-size"></span>
          </div>
          <div id="aq-ocr-steps">
            <div class="aq-ocr-step" data-stage="read"><span class="aq-ocr-st-ic"></span><span class="aq-ocr-st-label">Чтение файла</span><span class="aq-ocr-st-detail"></span></div>
            <div class="aq-ocr-step" data-stage="ocr"><span class="aq-ocr-st-ic"></span><span class="aq-ocr-st-label">Распознавание текста</span><span class="aq-ocr-st-detail"></span></div>
            <div class="aq-ocr-step" data-stage="tpl"><span class="aq-ocr-st-ic"></span><span class="aq-ocr-st-label">Подбор шаблона</span><span class="aq-ocr-st-detail"></span></div>
            <div class="aq-ocr-step" data-stage="fill"><span class="aq-ocr-st-ic"></span><span class="aq-ocr-st-label">Заполнение формы</span><span class="aq-ocr-st-detail"></span></div>
          </div>
          <div id="aq-ocr-result"></div>
        </div>
      </div>
    </div>
  </div>
  <div id="aq-footer">
    <span id="aq-status">Готов</span>
    <div id="aq-footer-right">
      <button id="aq-provider-chip" title="Провайдер ИИ — открыть настройки">—</button>
      <button id="aq-clear-ctx" title="Очистить память диалога">ctx</button>
      <span id="aq-wake-badge" style="display:none" title="Wake-word активен">${ICON.wave}</span>
      <button id="aq-listen-btn" title="Включить прослушку wake-word">
        <span id="aq-listen-icon">${ICON.leaf}</span><span id="aq-listen-dot"></span><span id="aq-listen-label">СПИТ</span>
      </button>
    </div>
  </div>
</div>
<div id="aq-rec-hud" data-phase="armed" data-corner="top-left" style="display:none">
  <div id="aq-rec-hud-head">
    <span id="aq-rec-hud-dot"></span>
    <span id="aq-rec-hud-label">Слушаю…</span>
    <span id="aq-rec-hud-timer">0:00</span>
  </div>
  <div id="aq-rec-hud-wave"></div>
  <div id="aq-rec-hud-interim"></div>
  <div id="aq-rec-hud-btns">
    <button id="aq-rec-hud-stop" title="Остановить и подтвердить">${ICON.stop}<span>Стоп</span></button>
    <button id="aq-rec-hud-cancel" title="Отмена">${ICON.close}</button>
  </div>
</div>
<div id="aq-confirm-card" class="aq-confirm-popup" data-corner="top-left" style="display:none"></div>
<div id="aq-resize-handle"></div>`;
  }

  /* ════════════════════════════════════════════════════════════════════
   *  ИНЪЕКЦИЯ
   * ════════════════════════════════════════════════════════════════════ */
  const root = document.createElement('div');
  root.id = 'aqbobek-root';
  root.setAttribute('data-state', 'corner');
  root.setAttribute('data-size', 'compact');
  root.setAttribute('data-wake-indicator', 'on');
  root.setAttribute('data-listen', 'off');
  root.setAttribute('data-corner-pos', 'bottom-right');
  root.setAttribute('data-wake', '');
  root.innerHTML = template();

  // Внедряем в <html> (устойчивее к SPA, которые перерисовывают <body>)
  // и держим на плаву watchdog-ом, если фреймворк снесёт узел.
  function mount() {
    const host = document.documentElement || document.body;
    if (host && !host.contains(root)) host.appendChild(root);
  }
  mount();
  setInterval(mount, 2000);
  try {
    // На случай, если panel.css (внешний файл манифеста) не подхватился на
    // странице со строгим CSP — подстрахуемся минимальными инлайн-стилями,
    // чтобы угловой пузырь был виден в любом случае.
    root.style.cssText = 'position:fixed!important;z-index:2147483647!important;';
    console.info('%c[Suerte] виджет внедрён', 'color:#4ade80;font-weight:700', 'connected =', root.isConnected, '| url =', location.href);
  } catch (_e) {}

  const $ = (sel) => root.querySelector(sel);
  const el = {
    root,
    corner: $('#aq-corner'),
    panel: $('#aq-panel'),
    head: $('#aq-head'),
    dot: $('#aq-dot'),
    status: $('#aq-status'),
    text: $('#aq-text'),
    micBtn: $('#aq-mic-btn'),
    sendBtn: $('#aq-send-btn'),
    cancelBtn: $('#aq-cancel-btn'),
    voiceBar: $('#aq-voice-bar'),
    voiceInterim: $('#aq-voice-interim'),
    micDenied: $('#aq-mic-denied-bar'),
    listenOff: $('#aq-listen-off-bar'),
    runProgress: $('#aq-run-progress'),
    runStepLabel: $('#aq-run-step-label'),
    runStepCount: $('#aq-run-step-count'),
    runBar: $('#aq-run-progress-bar'),
    runRoute: $('#aq-run-route-summary'),
    lastReply: $('#aq-last-reply'),
    lastReplyText: $('#aq-last-reply-text'),
    chat: $('#aq-chat'),
    domList: $('#aq-dom-list'),
    logPanel: $('#aq-log-list'),
    listenBtn: $('#aq-listen-btn'),
    listenLabel: $('#aq-listen-label'),
    wakeBadge: $('#aq-wake-badge'),
    ocrFile: $('#aq-ocr-file'),
    ocrResult: $('#aq-ocr-result'),
    ocrPick: $('#aq-ocr-pick'),
    ocrFileInfo: $('#aq-ocr-file-info'),
    ocrFiName: $('#aq-ocr-file-info .aq-ocr-fi-name'),
    ocrFiSize: $('#aq-ocr-file-info .aq-ocr-fi-size'),
    ocrSteps: $('#aq-ocr-steps'),
    ocrDrop: $('#aq-ocr-drop'),
    chainBadge: $('#aq-chain-badge'),
    chainName: $('#aq-chain-badge-name'),
    voiceTimer: $('#aq-voice-timer'),
    recHud: $('#aq-rec-hud'),
    recHudLabel: $('#aq-rec-hud-label'),
    recHudTimer: $('#aq-rec-hud-timer'),
    recHudWave: $('#aq-rec-hud-wave'),
    recHudInterim: $('#aq-rec-hud-interim'),
    recHudStop: $('#aq-rec-hud-stop'),
    recHudCancel: $('#aq-rec-hud-cancel'),
    confirmCard: $('#aq-confirm-card')
  };

  /* ════════════════════════════════════════════════════════════════════
   *  СОСТОЯНИЕ
   * ════════════════════════════════════════════════════════════════════ */
  const S = {
    listenWanted: false,   // ГЛОБАЛЬНОЕ желание слушать (общее для всех вкладок)
    micBlocked: false,     // в этой вкладке отказано в доступе к микрофону
    phase: 'idle',         // idle | armed | recording | confirm | sending
    recognizing: false,    // работает ли Web Speech сейчас
    mediaStream: null,
    recorder: null,
    chunks: [],
    carryBlob: null,
    analyser: null,
    audioCtx: null,
    vadRAF: null,
    silenceStart: 0,
    lastNoise: 0,
    armTimer: null,
    recognition: null,
    lastCommandText: '',
    runBusy: false,        // движок очереди шагов уже работает
    recStartTs: 0,         // момент старта текущего куска записи
    recBaseSec: 0,         // накопленная длительность (при дозаписи)
    recDurationSec: 0,     // итоговая длительность последней записи
    confirmCleanup: null,  // очистка ресурсов плеера карточки
    ctx: []                // короткая память диалога
  };

  function setStatus(t) { el.status.textContent = t; }
  function setDot(cls) { el.dot.className = cls || ''; }
  function setAlice(s) {
    if (s) root.setAttribute('data-alice', s);
    else root.removeAttribute('data-alice');
  }

  /* ════════════════════════════════════════════════════════════════════
   *  ЛОГ
   * ════════════════════════════════════════════════════════════════════ */
  // Расширенная запись лога: text — краткое, detail — объект (полный JSON, только devMode),
  // ms — длительность, cat — категория для фильтра ('net' | 'event').
  function log(kind, title, text, detail, ms, cat) {
    const stamp = new Date().toLocaleTimeString('ru-RU');
    const item = { kind, title, text: text || '', time: stamp, ts: Date.now(), cat: cat || 'event' };
    if (ms != null) item.ms = ms;
    if (detail !== undefined && detail !== null) {
      try { item.detail = JSON.stringify(detail, null, 2).slice(0, 8000); }
      catch (_e) { item.detail = String(detail).slice(0, 8000); }
    }
    renderLogItem(item);
    chrome.storage.local.get(LOG_KEY, (store) => {
      const arr = store[LOG_KEY] || [];
      arr.push(item);
      if (arr.length > 400) arr.splice(0, arr.length - 400);
      chrome.storage.local.set({ [LOG_KEY]: arr });
    });
  }
  // Пишет только в режиме разработчика (сквозной лог для отладки).
  function devCapture(kind, title, detail, ms, cat) {
    if (!CFG.devMode) return;
    log(kind, title, '', detail, ms, cat || 'event');
  }

  let logFilter = 'all';
  function applyLogFilter(div) {
    const f = logFilter;
    const show = f === 'all' ? true
      : f === 'error' ? div.classList.contains('error')
      : div.dataset.cat === f;
    div.style.display = show ? '' : 'none';
  }
  function flashCopied(btn) {
    if (!btn) return;
    const html = btn.innerHTML;
    btn.innerHTML = ICON.check + '<span>Готово</span>';
    setTimeout(() => { btn.innerHTML = html; }, 900);
  }

  const LOG_BADGE = { success: 'OK', error: 'ОШИБКА', warn: 'ВНИМ', info: 'ИНФО', run: 'ШАГ', net: 'СЕТЬ' };
  function renderLogItem(item) {
    const kind = item.kind || 'info';
    const div = document.createElement('div');
    div.className = 'aq-log-item ' + kind;
    div.dataset.cat = item.cat || 'event';
    if (item.detail) div.classList.add('has-detail');
    const msBadge = item.ms != null ? `<span class="aq-log-ms">${item.ms}ms</span>` : '';
    div.innerHTML =
      `<div class="aq-log-header">` +
        `<span class="aq-log-badge">${LOG_BADGE[kind] || 'ИНФО'}</span>` +
        `<span class="aq-log-title">${escapeHtml(item.title)}</span>` +
        msBadge +
        `<span class="aq-log-time">${escapeHtml(item.time)}</span>` +
      `</div>` +
      (item.text ? `<div class="aq-log-text">${escapeHtml(item.text)}</div>` : '') +
      (item.detail ? `<pre class="aq-log-detail">${escapeHtml(item.detail)}</pre>` +
        `<button class="aq-log-copy1" title="Копировать запись">${ICON.copy}<span>Копировать</span></button>` : '');
    if (item.detail) {
      div.querySelector('.aq-log-header').addEventListener('click', () => div.classList.toggle('open'));
      const cp = div.querySelector('.aq-log-copy1');
      cp.addEventListener('click', (e) => {
        e.stopPropagation();
        if (navigator.clipboard) navigator.clipboard.writeText(item.detail).then(() => flashCopied(cp));
      });
    }
    el.logPanel.appendChild(div);
    applyLogFilter(div);
    el.logPanel.scrollTop = el.logPanel.scrollHeight;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Перехват падений самого расширения (в режиме разработчика).
  window.addEventListener('error', (e) => {
    devCapture('error', 'JS: ' + (e.message || 'ошибка'),
      { message: e.message, source: e.filename, line: e.lineno, col: e.colno, stack: e.error && e.error.stack }, null, 'event');
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    devCapture('error', 'Promise rejected', { reason: (r && (r.stack || r.message)) || String(r) }, null, 'event');
  });

  function pushChat(role, textVal) {
    if (!textVal) return;
    // Не дублируем подряд одинаковые сообщения (showReply может звать один текст повторно).
    const last = el.chat.lastElementChild;
    if (last && last.dataset.role === role && last.dataset.text === textVal) return;
    const wrap = document.createElement('div');
    wrap.className = 'aq-chat-msg aq-chat-' + role;
    wrap.dataset.role = role;
    wrap.dataset.text = textVal;
    const b = document.createElement('div');
    b.className = 'aq-chat-bubble';
    b.textContent = textVal;
    wrap.appendChild(b);
    el.chat.appendChild(wrap);
    el.chat.scrollTop = el.chat.scrollHeight;
  }

  function showReply(textVal, isError) {
    el.lastReply.style.display = 'flex';
    el.lastReply.classList.toggle('error', !!isError);
    el.lastReplyText.textContent = textVal;
    // Ответ ИИ/статус попадает во вкладку «Ответ» как переписка (запрос → ответ).
    pushChat(isError ? 'error' : 'agent', textVal);
    if (CFG.narrator && !isError) speak(textVal);
  }
  function speak(t) {
    try {
      const u = new SpeechSynthesisUtterance(t);
      u.lang = CFG.lang || 'ru-RU';
      u.volume = CFG.volume != null ? CFG.volume : 1;
      speechSynthesis.speak(u);
    } catch (_e) {}
  }

  /* ════════════════════════════════════════════════════════════════════
   *  UI: ТАБЫ, DRAG, RESIZE, КНОПКИ
   * ════════════════════════════════════════════════════════════════════ */
  function openPanel() { root.setAttribute('data-state', 'panel'); refreshRecHud(); }
  function toCorner() { root.setAttribute('data-state', 'corner'); refreshRecHud(); }

  el.corner.addEventListener('click', openPanel);
  $('#aq-panel-close').addEventListener('click', toCorner);
  $('#aq-toggle-size').addEventListener('click', () => {
    const sz = root.getAttribute('data-size') === 'expanded' ? 'compact' : 'expanded';
    root.setAttribute('data-size', sz);
  });

  root.querySelectorAll('.aq-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.getAttribute('data-tab')));
  });
  function switchTab(name) {
    root.querySelectorAll('.aq-tab').forEach((t) => t.classList.toggle('active', t.getAttribute('data-tab') === name));
    root.querySelectorAll('.aq-tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  }

  // Настройки открываются ОТДЕЛЬНОЙ вкладкой (полноценный HTML), а не в iframe.
  function openSettings() {
    bg('OPEN_SETTINGS_TAB').catch(() => {
      // запасной путь, если background недоступен (сработает при клике-жесте)
      window.open(chrome.runtime.getURL('settings.html'), '_blank');
    });
  }
  $('#aq-settings-btn').addEventListener('click', openSettings);
  $('#aq-clear-ctx').addEventListener('click', () => { S.ctx = []; setStatus('Память диалога очищена'); });
  $('#aq-provider-chip').addEventListener('click', openSettings);

  // Позиция угла
  root.querySelectorAll('.aq-pos-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      root.classList.remove('aq-dragged');
      root.setAttribute('data-corner-pos', btn.getAttribute('data-pos'));
      $('#aq-pos-popup').style.display = 'none';
    });
  });

  // Drag за шапку
  (function enableDrag() {
    let sx, sy, ox, oy, dragging = false;
    el.head.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      const r = el.panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      root.classList.add('aq-dragged');
      root.style.setProperty('--aq-drag-left', (ox + e.clientX - sx) + 'px');
      root.style.setProperty('--aq-drag-top', (oy + e.clientY - sy) + 'px');
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  })();

  // Resize
  (function enableResize() {
    const handle = $('#aq-resize-handle');
    if (!handle) return;
    let sx, sy, sw, sh, res = false;
    handle.addEventListener('mousedown', (e) => {
      res = true; const r = el.panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height; e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!res) return;
      el.panel.style.width = Math.max(280, sw + (e.clientX - sx)) + 'px';
      el.panel.style.height = Math.max(240, sh + (e.clientY - sy)) + 'px';
    });
    window.addEventListener('mouseup', () => { res = false; });
  })();

  // Ручной ввод
  el.sendBtn.addEventListener('click', () => {
    const t = el.text.value.trim();
    if (t) { el.text.value = ''; pushChat('user', t); dispatchCommand(t); }
  });
  el.text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.sendBtn.click(); }
  });

  // Микрофон вручную запускает запись
  el.micBtn.addEventListener('click', () => {
    if (S.phase === 'idle') arm(true);
    else if (S.phase === 'recording') stopRecording('manual');
  });
  el.cancelBtn.addEventListener('click', () => cancelAll());

  // Плавающий HUD записи: Стоп (подтвердить) / Отмена
  el.recHudStop.addEventListener('click', () => {
    if (S.phase === 'recording') stopRecording('manual');
    else cancelAll();
  });
  el.recHudCancel.addEventListener('click', () => cancelAll());

  // Listen toggle (СПИТ / активен)
  el.listenBtn.addEventListener('click', toggleListen);
  function openBig() {
    root.setAttribute('data-state', 'panel');
    root.setAttribute('data-size', 'expanded');
    root.classList.remove('aq-dragged'); // вернуть к углу, если был перетащен
  }
  window.addEventListener('keydown', (e) => {
    // Alt+M — вкл/выкл прослушку; Alt+Q — открыть в большом (развёрнутом) режиме.
    // Используем e.code (физическая клавиша) — работает и на русской раскладке.
    if (e.altKey && (e.code === 'KeyM' || e.key === 'm' || e.key === 'M')) { e.preventDefault(); toggleListen(); }
    if (e.altKey && (e.code === 'KeyQ' || e.key === 'q' || e.key === 'Q')) { e.preventDefault(); openBig(); }
  });

  // Сканер
  $('#aq-scan-btn').addEventListener('click', () => { const ctx = collectPageContext(); renderScan(ctx); });

  // OCR
  $('#aq-ocr-pick').addEventListener('click', () => el.ocrFile.click());
  el.ocrFile.addEventListener('change', handleOcrFile);

  // OCR — быстрая drag&drop зона в среднем режиме (тот же поток, что и вкладка OCR)
  const OCR_ACCEPT = /\.(pdf|docx|png|jpe?g|tiff?|bmp)$/i;
  if (el.ocrDrop) {
    const drop = el.ocrDrop;
    drop.addEventListener('click', () => { if (drop.dataset.state !== 'busy') el.ocrFile.click(); });
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      if (drop.dataset.state !== 'busy') ocrDropState('drag');
    }));
    ['dragleave', 'dragend'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      if (drop.dataset.state === 'drag') ocrDropState('idle');
    }));
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (drop.dataset.state === 'busy') return;
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) { ocrDropState('idle'); return; }
      if (!OCR_ACCEPT.test(file.name)) {
        ocrDropState('error');
        showReply('OCR: неподдерживаемый формат — ' + file.name, true);
        setTimeout(() => { if (drop.dataset.state === 'error') ocrDropState('idle'); }, 1800);
        return;
      }
      processOcrFile(file);
    });
  }

  // DEV-лог: фильтры + экспорт (тулбар виден только при devMode — CSS [data-dev="on"])
  root.querySelectorAll('.aq-log-filter').forEach((b) => b.addEventListener('click', () => {
    logFilter = b.dataset.cat;
    root.querySelectorAll('.aq-log-filter').forEach((x) => x.classList.toggle('active', x === b));
    el.logPanel.querySelectorAll('.aq-log-item').forEach(applyLogFilter);
  }));
  const _logClear = $('#aq-log-clear');
  if (_logClear) _logClear.addEventListener('click', () => {
    chrome.storage.local.set({ [LOG_KEY]: [] });
    el.logPanel.innerHTML = '';
  });
  const _logCopy = $('#aq-log-copy');
  if (_logCopy) _logCopy.addEventListener('click', () => {
    chrome.storage.local.get(LOG_KEY, (s) => {
      const txt = JSON.stringify(s[LOG_KEY] || [], null, 2);
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => flashCopied(_logCopy));
    });
  });
  const _logDl = $('#aq-log-dl');
  if (_logDl) _logDl.addEventListener('click', () => {
    chrome.storage.local.get(LOG_KEY, (s) => {
      const blob = new Blob([JSON.stringify(s[LOG_KEY] || [], null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'suerte-devlog-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
  });

  // Сообщения от background/настроек
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'OPEN_SETTINGS') openSettings();
  });

  /* ════════════════════════════════════════════════════════════════════
   *  WEB SPEECH — wake / trigger слова
   * ════════════════════════════════════════════════════════════════════ */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  // Слушать реально нужно, только если глобально включено, вкладка активна и микрофон не заблокирован.
  function shouldListen() {
    return S.listenWanted && !S.micBlocked && document.visibilityState === 'visible';
  }

  function startRecognition() {
    if (!SR) { setStatus('Web Speech не поддерживается'); return; }
    if (S.recognizing) return;
    const rec = new SR();
    rec.lang = CFG.lang || 'ru-RU';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = onSpeechResult;
    rec.onend = () => {
      S.recognizing = false;
      // авто-рестарт, пока слушаем и вкладка активна
      if (shouldListen()) setTimeout(() => { if (shouldListen()) startRecognition(); }, 250);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        // Отказ в доступе — только в ЭТОЙ вкладке; глобальный тумблер не трогаем.
        S.micBlocked = true;
        el.micDenied.style.display = 'flex';
        stopRecognition();
      }
    };
    try { rec.start(); S.recognizing = true; S.recognition = rec; }
    catch (_e) { /* уже запущен */ }
  }
  function stopRecognition() {
    if (S.recognition) { try { S.recognition.stop(); } catch (_e) {} }
    S.recognizing = false;
  }

  function norm(s) { return (s || '').toLowerCase().replace(/[.,!?;:()"']/g, ' ').replace(/\s+/g, ' ').trim(); }
  function hasWord(text, words) {
    const t = ' ' + norm(text) + ' ';
    return (words || []).some((w) => w && t.includes(' ' + norm(w) + ' '));
  }

  function onSpeechResult(ev) {
    let interim = '', finalText = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
    }
    const heard = (finalText || interim);
    if (S.phase === 'recording') {
      el.voiceInterim.textContent = heard;
      el.recHudInterim.textContent = heard;
      // Триггеры во время записи
      if (hasWord(heard, CFG.triggers.stop)) { stopRecording('cancel'); return; }
      if (hasWord(heard, CFG.triggers.send)) { stopRecording('send'); return; }
      return;
    }
    // Пока не записываем — ловим управляющие слова
    if (hasWord(heard, CFG.triggers.settings)) { openSettings(); return; }
    if (hasWord(heard, CFG.triggers.sleep)) { setListen(false); return; }
    if (S.phase === 'idle' && S.listenWanted && hasWord(heard, CFG.triggers.wake)) { arm(false); return; }
  }

  /* ════════════════════════════════════════════════════════════════════
   *  ЗАПИСЬ ГОЛОСА (MediaRecorder + VAD)
   * ════════════════════════════════════════════════════════════════════ */
  async function ensureStream() {
    if (S.mediaStream && S.mediaStream.active) return S.mediaStream;
    S.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return S.mediaStream;
  }

  // arm: услышали wake-word (или ручной микрофон) — ждём голос, затем пишем
  async function arm(manual) {
    if (S.phase !== 'idle') return;
    try {
      await ensureStream();
    } catch (_e) {
      el.micDenied.style.display = 'flex';
      return;
    }
    S.phase = 'armed';
    S.recBaseSec = 0;
    S.recStartTs = 0;
    setAlice('listening');
    setStatus(manual ? 'Говорите...' : 'Слушаю, говорите...');
    el.micBtn.classList.add('recording');
    idleBars();
    refreshRecHud();
    startVAD();
    // Если голос так и не начался — вернёмся в покой
    S.armTimer = setTimeout(() => { if (S.phase === 'armed') disarm(); }, CFG.armTimeoutMs);
  }
  function disarm() {
    clearTimeout(S.armTimer);
    stopVAD();
    S.phase = 'idle';
    setAlice(null);
    el.micBtn.classList.remove('recording');
    hideRecHud();
    setStatus(shouldListen() ? 'Слушаю wake-word' : (S.listenWanted ? 'Пауза — вкладка неактивна' : 'Готов'));
  }

  function beginRecording() {
    if (S.phase === 'recording') return;
    clearTimeout(S.armTimer);
    S.phase = 'recording';
    S.recStartTs = Date.now();
    setAlice('recording');
    el.voiceBar.style.display = 'flex';
    el.voiceInterim.textContent = '';
    el.recHudInterim.textContent = '';
    el.recHudTimer.textContent = fmtDur(S.recBaseSec);
    el.voiceTimer.textContent = fmtDur(S.recBaseSec);
    refreshRecHud();
    // при дозаписи сохраняем ранее записанный blob как первый чанк
    S.chunks = S.carryBlob ? [S.carryBlob] : [];
    S.carryBlob = null;
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    S.recorder = new MediaRecorder(S.mediaStream, { mimeType: mime });
    S.recorder.ondataavailable = (e) => { if (e.data && e.data.size) S.chunks.push(e.data); };
    S.recorder.start(200);
    setStatus('Запись...');
  }

  // VAD: следим за уровнем сигнала — старт записи по шуму, стоп по тишине
  function startVAD() {
    S.audioCtx = S.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const src = S.audioCtx.createMediaStreamSource(S.mediaStream);
    S.analyser = S.audioCtx.createAnalyser();
    S.analyser.fftSize = 512;
    src.connect(S.analyser);
    const buf = new Uint8Array(S.analyser.frequencyBinCount);
    const freq = new Uint8Array(S.analyser.frequencyBinCount);
    S.lastNoise = Date.now();
    const START_TH = 0.02, SIL_TH = 0.012;
    const tick = () => {
      if (S.phase !== 'armed' && S.phase !== 'recording') return;
      S.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      const now = Date.now();
      // Живой отклик — рисуем спектр и обновляем таймер каждый кадр
      S.analyser.getByteFrequencyData(freq);
      renderBarsFrom(freq);
      updateRecTimers();
      if (rms > START_TH) {
        S.lastNoise = now;
        if (S.phase === 'armed') beginRecording();
      }
      if (S.phase === 'recording') {
        if (rms < SIL_TH && (now - S.lastNoise) >= CFG.silenceMs) { stopRecording('silence'); return; }
      }
      S.vadRAF = requestAnimationFrame(tick);
    };
    S.vadRAF = requestAnimationFrame(tick);
  }
  function stopVAD() {
    if (S.vadRAF) cancelAnimationFrame(S.vadRAF);
    S.vadRAF = null;
  }
  /* ─ Живой визуальный отклик записи: эквалайзер + таймер + HUD ─ */
  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  // Плавающие элементы (HUD и карточка) встают в угол, ПРОТИВОПОЛОЖНЫЙ виджету
  function oppositeCorner() {
    const pos = root.getAttribute('data-corner-pos') || 'bottom-right';
    return ({
      'bottom-right': 'top-left',
      'bottom-left':  'top-right',
      'top-right':    'bottom-left',
      'top-left':     'bottom-right'
    })[pos] || 'top-left';
  }
  function positionFloater(node) { if (node) node.setAttribute('data-corner', oppositeCorner()); }

  // Генерируем бары эквалайзера (тег <i>, чтобы не конфликтовать со старыми правилами span)
  function buildBars(container, n) {
    if (!container) return [];
    container.innerHTML = '';
    const bars = [];
    for (let i = 0; i < n; i++) {
      const b = document.createElement('i');
      b.className = 'aq-eqbar';
      container.appendChild(b);
      bars.push(b);
    }
    return bars;
  }
  let HUD_BARS = [], INLINE_BARS = [];
  function initBars() {
    HUD_BARS = buildBars(el.recHudWave, 22);
    INLINE_BARS = buildBars(root.querySelector('#aq-voice-waves'), 16);
  }

  // Рисуем бары по спектру микрофона (нижне-средние частоты — речь)
  function renderBarsFrom(freq) {
    const paint = (bars) => {
      if (!bars.length) return;
      const usable = Math.max(bars.length, Math.floor(freq.length * 0.55));
      const per = Math.max(1, Math.floor(usable / bars.length));
      for (let i = 0; i < bars.length; i++) {
        let sum = 0;
        for (let j = 0; j < per; j++) sum += freq[i * per + j] || 0;
        const v = (sum / per) / 255;                         // 0..1
        const scale = Math.max(0.08, Math.min(1, v * 1.45));
        bars[i].style.transform = 'scaleY(' + scale.toFixed(3) + ')';
      }
    };
    paint(HUD_BARS);
    paint(INLINE_BARS);
  }
  function idleBars() {
    [HUD_BARS, INLINE_BARS].forEach((bars) => bars.forEach((b) => { b.style.transform = 'scaleY(0.08)'; }));
  }

  function updateRecTimers() {
    if (S.phase !== 'recording') return;
    const t = S.recBaseSec + (S.recStartTs ? (Date.now() - S.recStartTs) / 1000 : 0);
    const txt = fmtDur(t);
    el.recHudTimer.textContent = txt;
    el.voiceTimer.textContent = txt;
  }

  // Показ/скрытие плавающего HUD: он нужен, когда панель НЕ открыта
  function refreshRecHud() {
    const active = (S.phase === 'armed' || S.phase === 'recording');
    const panelOpen = root.getAttribute('data-state') === 'panel';
    positionFloater(el.recHud);
    if (active && !panelOpen) {
      el.recHud.setAttribute('data-phase', S.phase);
      el.recHudLabel.textContent = (S.phase === 'recording') ? 'Идёт запись' : 'Слушаю, говорите…';
      el.recHud.style.display = 'flex';
    } else {
      el.recHud.style.display = 'none';
    }
  }
  function hideRecHud() { el.recHud.style.display = 'none'; }

  function stopRecording(reason) {
    stopVAD();
    S.recDurationSec = S.recBaseSec + (S.recStartTs ? (Date.now() - S.recStartTs) / 1000 : 0);
    S.recStartTs = 0;
    el.micBtn.classList.remove('recording');
    if (!S.recorder || S.recorder.state === 'inactive') {
      // ничего не записали
      finishAfterStop(reason, null);
      return;
    }
    S.recorder.onstop = () => {
      const blob = new Blob(S.chunks, { type: S.recorder.mimeType });
      finishAfterStop(reason, blob);
    };
    try { S.recorder.stop(); } catch (_e) { finishAfterStop(reason, null); }
  }

  function finishAfterStop(reason, blob) {
    el.voiceBar.style.display = 'none';
    hideRecHud();
    idleBars();
    setAlice(null);
    if (reason === 'cancel' || !blob || blob.size < 800) {
      S.phase = 'idle';
      setStatus(reason === 'cancel' ? 'Отменено' : 'Пусто');
      return;
    }
    if (reason === 'send' || reason === 'silence' || reason === 'manual') {
      if (CFG.confirmBeforeSend) askConfirm(blob);
      else sendVoice(blob);
    }
  }

  function cancelAll() {
    clearTimeout(S.armTimer);
    stopVAD();
    if (S.recorder && S.recorder.state !== 'inactive') { try { S.recorder.stop(); } catch (_e) {} }
    S.phase = 'idle';
    el.voiceBar.style.display = 'none';
    closeConfirmCard();
    hideRecHud();
    idleBars();
    el.cancelBtn.style.display = 'none';
    el.micBtn.classList.remove('recording');
    setAlice(null);
    setStatus('Отменено');
  }

  /* Карточка подтверждения — плавающая, в противоположном от виджета углу.
     Показывает плеер записи (прослушать) + Отправить / Дозаписать / Отмена. */
  function closeConfirmCard() {
    if (S.confirmCleanup) { try { S.confirmCleanup(); } catch (_e) {} S.confirmCleanup = null; }
    el.confirmCard.style.display = 'none';
    el.confirmCard.innerHTML = '';
  }

  function askConfirm(blob) {
    S.phase = 'confirm';
    hideRecHud();
    const durSec = S.recDurationSec || 0;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const card = el.confirmCard;
    positionFloater(card);
    card.innerHTML =
      '<div class="aq-confirm-title"><span class="aq-confirm-icon">🎙</span> Запись готова</div>' +
      '<div class="aq-rec-player">' +
        '<button class="aq-rec-play" type="button" title="Прослушать">▶</button>' +
        '<div class="aq-rec-player-track"><div class="aq-rec-player-fill"></div></div>' +
        '<span class="aq-rec-player-time">' + fmtDur(durSec) + '</span>' +
      '</div>' +
      '<div class="aq-confirm-btns">' +
        '<button class="aq-confirm-btn aq-confirm-append" data-cf="more">Дозаписать</button>' +
        '<button class="aq-confirm-btn aq-confirm-yes" data-cf="yes">Отправить</button>' +
        '<button class="aq-confirm-btn aq-confirm-no" data-cf="no">Отмена</button>' +
      '</div>';
    card.style.display = 'block';

    const playBtn = card.querySelector('.aq-rec-play');
    const fill = card.querySelector('.aq-rec-player-fill');
    const timeEl = card.querySelector('.aq-rec-player-time');

    S.confirmCleanup = () => { try { audio.pause(); } catch (_e) {} URL.revokeObjectURL(url); };

    playBtn.addEventListener('click', () => {
      if (audio.paused) audio.play().catch(() => {}); else audio.pause();
    });
    audio.addEventListener('play',  () => { playBtn.textContent = '⏸'; });
    audio.addEventListener('pause', () => { playBtn.textContent = '▶'; });
    audio.addEventListener('timeupdate', () => {
      // Blob от MediaRecorder часто отдаёт duration=Infinity, поэтому берём нашу длительность
      const d = (durSec && isFinite(durSec)) ? durSec : (isFinite(audio.duration) ? audio.duration : 0);
      if (d) fill.style.width = Math.min(100, (audio.currentTime / d) * 100) + '%';
      timeEl.textContent = fmtDur(audio.currentTime);
    });
    audio.addEventListener('ended', () => {
      playBtn.textContent = '▶';
      fill.style.width = '0%';
      timeEl.textContent = fmtDur(durSec);
    });

    card.querySelector('.aq-confirm-btns').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cf]'); if (!b) return;
      const act = b.getAttribute('data-cf');
      closeConfirmCard();
      if (act === 'yes') sendVoice(blob);
      else if (act === 'no') { S.phase = 'idle'; setStatus('Отменено'); }
      else if (act === 'more') resumeRecording(blob);
    });
  }
  async function resumeRecording(prevBlob) {
    // Дозапись: копим предыдущие чанки и продолжаем
    S.phase = 'armed';
    S.recBaseSec = S.recDurationSec || 0;   // продолжаем таймер с накопленного
    S.recStartTs = 0;
    setStatus('Дозапись...');
    try { await ensureStream(); } catch (_e) { return; }
    // сохраняем предыдущий blob — он станет первым чанком в beginRecording
    S.carryBlob = prevBlob || null;
    setAlice('listening');
    idleBars();
    refreshRecHud();
    startVAD();
    S.armTimer = setTimeout(() => { if (S.phase === 'armed') beginRecording(); }, 150);
  }

  /* ════════════════════════════════════════════════════════════════════
   *  ОТПРАВКА ГОЛОСА → ТРАНСКРИПЦИЯ → КОМАНДА
   * ════════════════════════════════════════════════════════════════════ */
  function blobToB64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1]);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  async function sendVoice(blob) {
    S.phase = 'sending';
    setAlice('sending');
    setDot('loading');
    setStatus('Распознаю речь...');
    try {
      const b64 = await blobToB64(blob);
      const res = await bg('MAIN_TRANSCRIBE', { audioB64: b64, mime: blob.type || 'audio/webm', provider: CFG.provider });
      const textVal = (res && res.text || '').trim();
      setAlice(null);
      if (!textVal) { setDot('error'); showReply('Не удалось распознать речь', true); S.phase = 'idle'; return; }
      pushChat('user', textVal);
      log('info', 'Голос распознан', textVal);
      await dispatchCommand(textVal);
    } catch (e) {
      setAlice(null); setDot('error');
      showReply('Ошибка транскрипции: ' + e.message, true);
      log('error', 'Транскрипция', e.message);
      S.phase = 'idle';
    }
  }

  /* ════════════════════════════════════════════════════════════════════
   *  ДИСПЕТЧЕР КОМАНДЫ  (скан по умолчанию → главный сервер)
   * ════════════════════════════════════════════════════════════════════ */
  // По умолчанию сканируем ЛЮБУЮ страницу. Исключения (статические сайты,
  // где скан не нужен) перечислены в noScanPages — на них скан пропускается.
  function isNoScanPage() {
    const here = (location.origin + location.pathname).replace(/\/+$/, '');
    const list = CFG.noScanPages || [];
    return list.some((p) => {
      const e = (p || '').trim().replace(/\/+$/, '');
      if (!e) return false;
      // совпадение по полному URL, по origin+path или по префиксу пути
      return here === e || here.startsWith(e) || location.href.indexOf(e) !== -1;
    });
  }

  async function dispatchCommand(textVal) {
    S.lastCommandText = textVal;
    S.ctx.push({ role: 'user', text: textVal });
    setDot('loading');
    setStatus('Отправляю запрос...');
    try {
      let scan = null;
      if (!isNoScanPage()) {
        setStatus('Сканирую страницу...');
        // Скан идёт через локальный сервер; если он недоступен — не валим
        // команду, а продолжаем без скана (главный сервер возьмёт готовый сканер).
        try {
          const ctx = collectPageContext();
          scan = await bg('LOCAL_SCAN', { html: ctx.html, values: ctx.values, url: location.href });
        } catch (e) {
          log('warn', 'Скан пропущен', 'локальный сервер недоступен: ' + e.message);
        }
      }
      setStatus('Думаю...');
      const resp = await bg('MAIN_COMMAND', { text: textVal, provider: CFG.provider, url: location.href, scan });
      setDot('');
      devCapture('info', 'Команда → ответ сервера', {
        request: textVal,
        url: location.href,
        scanned: !!scan,
        scanElements: scan && (Array.isArray(scan.elements) ? scan.elements.length : (Array.isArray(scan) ? scan.length : undefined)),
        response: resp,
        steps: Array.isArray(resp && resp.steps) ? resp.steps : (Array.isArray(resp) ? resp : undefined),
        reply: (resp && (resp.reply || resp.message)) || undefined,
      }, null, 'event');
      await startRun(resp);
    } catch (e) {
      setDot('error');
      showReply('Ошибка: ' + e.message, true);
      log('error', 'Команда', e.message);
      setStatus('Ошибка');
    }
  }

  /* ════════════════════════════════════════════════════════════════════
   *  ИСПОЛНИТЕЛЬ ДЕЙСТВИЙ  (click / write / writeByClick, много-шаг/страниц)
   * ════════════════════════════════════════════════════════════════════ */
  function normalizePlan(resp) {
    if (!resp) return [];
    if (Array.isArray(resp)) return resp;
    if (Array.isArray(resp.steps)) return resp.steps;
    if (resp.selector || resp.method) return [resp];
    if (resp.reply || resp.message) { showReply(resp.reply || resp.message); }
    return [];
  }

  /* Постоянная очередь шагов в chrome.storage — переживает переход между
     страницами (и полный reload, и SPA-навигацию). */
  const RESUME_WINDOW_MS = 120000;   // окно ожидания перехода/загрузки страницы
  function getPending() {
    return new Promise((r) => chrome.storage.local.get(PENDING_KEY, (s) => r(s[PENDING_KEY] || null)));
  }
  function setPending(p) {
    return new Promise((r) => chrome.storage.local.set({ [PENDING_KEY]: p }, r));
  }
  function clearPending() {
    return new Promise((r) => chrome.storage.local.remove(PENDING_KEY, r));
  }
  function normAddr(u) {
    try { const a = new URL(u, location.href); return a.origin + a.pathname.replace(/\/+$/, ''); }
    catch (_e) { return String(u || '').replace(/\/+$/, ''); }
  }
  function sameAddr(a, b) {
    if (!a || !b) return true;   // нет адреса ⇒ считаем той же страницей (без границы)
    return normAddr(a) === normAddr(b);
  }

  function samePage(addr) {
    if (!addr) return true;
    try {
      const a = new URL(addr, location.href);
      return a.origin + a.pathname === location.origin + location.pathname;
    } catch (_e) { return addr === location.href; }
  }

  async function startRun(resp) {
    const steps = normalizePlan(resp);
    if (!steps.length) {
      // сервер вернул только текст — он уже показан в normalizePlan
      if (!(resp && (resp.reply || resp.message))) showReply('Готово');
      setStatus('Готов');
      return;
    }
    // Новый план вытесняет любой прежний (в т.ч. недоделанную цепочку)
    await setPending({ runId: Date.now(), steps, index: 0, armedAt: Date.now(), waitingNav: false, expectAddress: null });
    if (steps.length > 1) log('info', 'План принят', steps.length + ' шаг(ов)');
    await driveRun('fresh');
  }

  /* Двигатель очереди. Исполняет шаги по одному и СОХРАНЯЕТ остаток В ПАМЯТЬ
     ПЕРЕД каждым шагом (index уже указывает на следующий). Поэтому, если шаг
     вызывает переход и страница выгружается — остаток уцелеет и продолжится на
     новой странице через resumeRun(). Ручная навигация ничего не запускает:
     возобновление разрешено только при waitingNav (осознанный переход). */
  async function driveRun(source) {
    if (S.runBusy) return;
    S.runBusy = true;
    try {
      let p = await getPending();
      if (!p || !p.steps) return;
      el.runProgress.style.display = 'block';

      while (p && p.index < p.steps.length) {
        const step = p.steps[p.index];
        const total = p.steps.length;
        const human = p.index + 1;

        // Не на той странице для текущего шага — вооружаемся и ждём перехода.
        // (index 0 всегда исполняется на текущей странице — как первый сегмент.)
        if (p.index > 0 && step.address && !samePage(step.address)) {
          await setPending({ ...p, armedAt: Date.now(), waitingNav: true, expectAddress: step.address });
          showChain(step.address);
          setStatus('Жду страницу…');
          showReply('Выполнено ' + p.index + '/' + total + '. Продолжу на: ' + shortUrl(step.address));
          hideRunProgressSoon();
          return;
        }

        // Ожидается ли переход ПОСЛЕ этого шага? (следующий шаг — на другой странице,
        // либо сервер явно пометил шаг как навигационный: step.navigates === true)
        const next = p.steps[p.index + 1];
        const nextAddr = next && next.address;
        const willNavigate = (step.navigates === true) ||
          (!!next && !!nextAddr && !sameAddr(nextAddr, step.address || location.href));
        const expectAddr = willNavigate ? (nextAddr || step.next_address || null) : null;

        el.runStepLabel.textContent = describeStep(step);
        el.runStepCount.textContent = human + '/' + total;
        el.runBar.style.width = Math.round((human / total) * 100) + '%';

        // КЛЮЧЕВОЕ: сохраняем ПЕРЕД шагом — index указывает на следующий,
        // waitingNav взведён, если ждём перехода.
        const advanced = { ...p, index: p.index + 1, armedAt: Date.now(),
                           waitingNav: willNavigate, expectAddress: expectAddr };
        await setPending(advanced);

        const _stepT0 = _now();
        try {
          const result = await runStep(step);
          devCapture('run', 'Шаг ' + human + '/' + total + ' · ' + describeStep(step),
            { step, result }, Math.round(_now() - _stepT0), 'event');
        } catch (e) {
          log('error', 'Шаг ' + human, e.message,
            { step, error: e.message, result: e.info || null }, Math.round(_now() - _stepT0), 'event');
          showReply('Ошибка на шаге ' + human + ': ' + e.message, true);
        }

        if (willNavigate) {
          // Остаток уже в памяти — ждём фактического перехода (reload или SPA).
          showChain(expectAddr || location.href);
          setStatus('Переход на страницу…');
          showReply('Шаг ' + human + '/' + total + ' выполнен. Перехожу дальше…');
          log('info', 'Ожидаю переход', 'после шага ' + human + '/' + total);
          hideRunProgressSoon();
          return;
        }

        await sleep(220);
        p = advanced;
      }

      // Все шаги выполнены
      await clearPending();
      showChain(null);
      showReply('Все шаги выполнены');
      setStatus('Готов');
      hideRunProgressSoon();
    } finally {
      S.runBusy = false;
    }
  }

  function hideRunProgressSoon() {
    setTimeout(() => { el.runProgress.style.display = 'none'; }, 900);
  }
  function showChain(addr) {
    if (!addr) { el.chainBadge.style.display = 'none'; return; }
    el.chainBadge.style.display = 'flex';
    el.chainName.textContent = 'Ждёт: ' + shortUrl(addr);
  }
  function shortUrl(u) { try { return new URL(u, location.href).pathname; } catch (_e) { return u; } }

  function describeStep(st) {
    if (st.method === 'click') return 'Клик: ' + (st.selector || '');
    return 'Ввод: ' + (st.value != null ? String(st.value).slice(0, 24) : '');
  }

  // Компактное описание DOM-узла для отладки: во что именно попал селектор.
  function describeNode(n) {
    if (!n) return null;
    const attr = (k) => { try { return n.getAttribute(k) || undefined; } catch (_e) { return undefined; } };
    const out = {
      tag: n.tagName ? n.tagName.toLowerCase() : String(n.nodeName || '').toLowerCase(),
      id: n.id || undefined,
      name: attr('name'),
      type: attr('type'),
      placeholder: attr('placeholder'),
      ariaLabel: attr('aria-label'),
    };
    if ('value' in n && n.value != null) out.valueBefore = String(n.value).slice(0, 200);
    const txt = (n.textContent || '').trim();
    if (txt) out.text = txt.slice(0, 80);
    return out;
  }

  async function runStep(st) {
    // Подробный результат шага — попадает в отладочный лог (куда/что/итог).
    const res = {
      selector: st.selector,
      method: st.method,
      type_write: st.type_write || null,
      value: st.value != null ? String(st.value) : null,
      address: st.address || location.href,
      found: false,
    };
    const node = resolveEl(st.selector);
    if (!node) {
      throw Object.assign(new Error('Элемент не найден: ' + st.selector), { info: res });
    }
    res.found = true;
    res.target = describeNode(node);
    node.scrollIntoView({ block: 'center', behavior: 'instant' in node ? 'instant' : 'auto' });

    if (st.method === 'click') {
      clickEl(node);
      res.action = 'click';
      log('success', 'Клик', st.selector);
      return res;
    }
    // method === 'write'
    const val = st.value != null ? String(st.value) : '';
    res.wrote = val;
    if (st.type_write === 'changeInnerHTML') {
      node.innerHTML = val;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      res.action = 'changeInnerHTML';
      res.after = (node.innerHTML || '').slice(0, 200);
      log('success', 'HTML', st.selector);
    } else if (st.type_write === 'writeByClick') {
      // div, слушающий клавиатуру: фокусируем кликом, затем макрос pyAutoGui
      node.focus();
      clickEl(node);
      await sleep(120);
      await bg('LOCAL_MACRO', { value: val });
      res.action = 'writeByClick (макрос)';
      log('success', 'Макрос-ввод', st.selector + ' ← ' + val);
    } else {
      // обычный input/textarea
      setNativeValue(node, val);
      res.action = 'write';
      res.after = ('value' in node) ? String(node.value).slice(0, 200) : undefined;
      res.verified = res.after === val;      // подтверждение, что значение действительно применилось
      log('success', 'Ввод', st.selector + ' ← ' + val);
    }
    return res;
  }

  function resolveEl(selector) {
    if (!selector) return null;
    try { return document.querySelector(selector); } catch (_e) { return null; }
  }
  function clickEl(node) {
    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) => {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
  }
  function setNativeValue(node, value) {
    // Правильный прототип под тип узла: input-сеттер на <select>/<textarea>
    // бросает «Illegal invocation», поэтому выбираем по тегу.
    let proto = HTMLInputElement.prototype;
    if (node instanceof HTMLTextAreaElement) proto = HTMLTextAreaElement.prototype;
    else if (node instanceof HTMLSelectElement) proto = HTMLSelectElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    node.focus();
    if (setter && setter.set) setter.set.call(node, value); else node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* Возобновление плана после перехода (полный reload ИЛИ SPA-навигация).
     Срабатывает ТОЛЬКО если переход был осознанным (waitingNav=true) — так
     ручная навигация врача по сайту ничего случайно не запускает. */
  async function resumeRun(source) {
    const p = await getPending();
    if (!p || !p.steps || p.index >= p.steps.length) return;
    const fresh = (Date.now() - (p.armedAt || 0)) < RESUME_WINDOW_MS;
    if (!fresh) { await clearPending(); showChain(null); return; }
    if (!p.waitingNav) return;                                        // не наш переход — не вмешиваемся
    if (p.expectAddress && !samePage(p.expectAddress)) { showChain(p.expectAddress); return; } // ещё не дошли
    // Мы на нужной странице — снимаем флаг ожидания и продолжаем
    await setPending({ ...p, waitingNav: false });
    await sleep(500);                                                // дать SPA дорисовать DOM
    const still = await getPending();
    if (!still || still.runId !== p.runId) return;                   // нас опередил новый запуск
    openPanel();
    log('info', 'Продолжаю план', 'шаг ' + (p.index + 1) + '/' + p.steps.length);
    await driveRun('resume');
  }

  // SPA-роутеры меняют URL без перезагрузки, а content.js не переинъектируется —
  // поэтому следим за сменой location и дёргаем возобновление.
  function installUrlWatcher() {
    let last = location.href;
    const fire = () => {
      if (location.href === last) return;
      last = location.href;
      setTimeout(() => resumeRun('urlchange'), 350);
    };
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
    setInterval(fire, 800);   // страховка для роутеров, не бросающих события истории
  }

  /* ════════════════════════════════════════════════════════════════════
   *  СКАНЕР СТРАНИЦЫ
   * ════════════════════════════════════════════════════════════════════ */
  function cssPath(node) {
    if (node.id) return '#' + CSS.escape(node.id);
    const parts = [];
    let e = node;
    while (e && e.nodeType === 1 && parts.length < 6) {
      let sel = e.nodeName.toLowerCase();
      if (e.parentNode) {
        const sibs = Array.from(e.parentNode.children).filter((c) => c.nodeName === e.nodeName);
        if (sibs.length > 1) sel += ':nth-child(' + (Array.from(e.parentNode.children).indexOf(e) + 1) + ')';
      }
      parts.unshift(sel);
      if (e.id) { parts[0] = '#' + CSS.escape(e.id); break; }
      e = e.parentElement;
    }
    return parts.join(' > ');
  }

  // Кликабельно ли что-то, что не является тегом-кнопкой/ссылкой:
  // <div onclick="...">, роли tab/menuitem/option/link, либо cursor:pointer.
  const CLICK_ROLES = new Set(['button', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'link', 'checkbox', 'radio', 'switch']);
  function isClickable(n, tag) {
    if (tag === 'button' || (tag === 'a' && n.hasAttribute('href'))) return true;
    if (n.hasAttribute('onclick') || typeof n.onclick === 'function') return true;
    const role = (n.getAttribute('role') || '').toLowerCase();
    if (CLICK_ROLES.has(role)) return true;
    if (n.tabIndex >= 0 && (tag === 'div' || tag === 'span' || tag === 'li')) {
      try { if (getComputedStyle(n).cursor === 'pointer') return true; } catch (_) {}
    }
    return false;
  }

  function collectPageContext() {
    const values = {};
    const items = [];
    const seen = new Set();
    // Формовые поля + всё кликабельное, включая div/span/li с onclick или ролью.
    const nodes = document.querySelectorAll(
      'input, textarea, select, button, a[href], [contenteditable="true"], ' +
      '[onclick], [role="button"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], ' +
      '[role="menuitemradio"], [role="option"], [role="link"], [role="checkbox"], ' +
      '[role="radio"], [role="switch"], [tabindex]'
    );
    nodes.forEach((n) => {
      if (root.contains(n)) return;
      const path = cssPath(n);
      if (seen.has(path)) return;              // защита от дублей (элемент попал по нескольким селекторам)
      const tag = n.tagName.toLowerCase();
      const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
      const editable = n.isContentEditable;
      const clickable = isClickable(n, tag);
      // tabindex-элементы без клика и не-поля пропускаем (контейнеры-обёртки).
      if (!isField && !editable && !clickable) return;
      seen.add(path);

      let type = tag;
      if (tag === 'input') type = (n.type || 'text');
      else if (clickable && !isField) type = 'button';   // подсказка для UI/ИИ: это цель клика

      // Действие и способ ввода — те же значения, что понимает исполнитель и сервер.
      let method, type_write;
      if (isField || editable) {
        method = 'write';
        type_write = editable ? 'writeByClick' : 'write';
      } else {
        method = 'click';
        type_write = 'write';
      }

      // Для полей value — это введённое значение; для кнопок текст идёт в label, не в value.
      const rawVal = ('value' in n && isField) ? n.value : '';
      const val = (rawVal || '').toString().trim().slice(0, 200);
      if (val) values[path] = val;
      const label = (n.getAttribute('placeholder') || n.getAttribute('aria-label')
        || n.getAttribute('title') || (n.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 80);
      items.push({ tag, type, path, value: val, label, method, type_write });
    });
    return { html: document.documentElement.outerHTML, values, items, url: location.href };
  }

  function renderScan(ctx) {
    const fields = ctx.items.filter((i) => ['input', 'textarea', 'select'].includes(i.tag)).length;
    const btns = ctx.items.filter((i) => i.tag === 'button' || i.type === 'button').length;
    $('#stat-fields').textContent = fields;
    $('#stat-btns').textContent = btns;
    $('#stat-all').textContent = ctx.items.length;
    el.domList.innerHTML = '';
    ctx.items.slice(0, 200).forEach((it) => {
      const row = document.createElement('div');
      row.className = 'aq-dom-item type-' + (it.tag === 'button' ? 'button' : it.tag === 'a' ? 'link' : it.tag);
      row.innerHTML = `<span class="aq-dom-badge">${escapeHtml(it.type)}</span>
        <div class="aq-dom-info"><div class="aq-dom-name">${escapeHtml(it.label || it.tag)}</div>
        ${it.value ? `<div class="aq-dom-value">${escapeHtml(it.value)}</div>` : ''}
        <div class="aq-dom-path">${escapeHtml(it.path)}</div></div>`;
      row.addEventListener('click', () => { const n = resolveEl(it.path); if (n) { n.style.outline = '2px solid #4ade80'; setTimeout(() => n.style.outline = '', 1200); } });
      el.domList.appendChild(row);
    });
    setStatus('Скан: ' + ctx.items.length + ' элементов');
  }

  /* ════════════════════════════════════════════════════════════════════
   *  OCR — визуальная индикация каждого этапа
   * ════════════════════════════════════════════════════════════════════ */
  const OCR_STAGES = ['read', 'ocr', 'tpl', 'fill'];

  function ocrStepEl(stage) { return el.ocrSteps.querySelector('.aq-ocr-step[data-stage="' + stage + '"]'); }

  function ocrStepIcon(state) {
    if (state === 'active') return '<span class="aq-ocr-spin"></span>';
    if (state === 'done') return ICON.check;
    if (state === 'error') return ICON.close;
    if (state === 'skip') return '<span class="aq-ocr-dash"></span>';
    return '<span class="aq-ocr-hollow"></span>';   // pending
  }

  // Обновляет один этап: state = pending|active|done|error|skip, detail — короткий текст справа.
  function ocrSetStep(stage, state, detail) {
    const node = ocrStepEl(stage);
    if (!node) return;
    node.setAttribute('data-state', state);
    node.querySelector('.aq-ocr-st-ic').innerHTML = ocrStepIcon(state);
    if (detail != null) node.querySelector('.aq-ocr-st-detail').textContent = detail;
  }

  // Сброс индикатора в начало нового прогона.
  function ocrResetSteps() {
    el.ocrSteps.style.display = 'flex';
    OCR_STAGES.forEach((s) => ocrSetStep(s, 'pending', ''));
    el.ocrResult.style.display = 'none';
    el.ocrResult.textContent = '';
  }

  function ocrShowResult(text) {
    el.ocrResult.textContent = text;
    el.ocrResult.style.display = 'block';
  }

  function ocrSetPickBusy(busy) {
    el.ocrPick.disabled = busy;
    el.ocrPick.classList.toggle('busy', busy);
    const lbl = el.ocrPick.querySelector('.aq-ocr-pick-label');
    if (lbl) lbl.textContent = busy ? 'Обработка документа…' : 'Загрузить PDF / DOCX / фото';
  }

  function fmtFileSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
    return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
  }

  // Состояние компактной OCR drop-зоны (средний режим): idle|drag|busy|done|error
  function ocrDropState(state) {
    if (!el.ocrDrop) return;
    el.ocrDrop.dataset.state = state;
    const lbl = el.ocrDrop.querySelector('.aq-ocr-drop-label');
    if (lbl) lbl.textContent =
      state === 'busy'  ? 'Распознаю…' :
      state === 'done'  ? 'Готово' :
      state === 'error' ? 'Ошибка распознавания' :
      state === 'drag'  ? 'Отпустите файл' :
                          'Перетащите файл или нажмите — OCR';
  }

  // Тонкий враппер над <input>: и picker, и drop-зона зовут processOcrFile(file).
  async function handleOcrFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';           // сброс, чтобы тот же файл можно было выбрать снова
    if (file) await processOcrFile(file);
  }

  async function processOcrFile(file) {
    if (!file) return;
    ocrDropState('busy');

    // Сразу видно, что файл принят: имя + размер + сброс этапов.
    el.ocrFileInfo.style.display = 'flex';
    el.ocrFiName.textContent = file.name;
    el.ocrFiSize.textContent = fmtFileSize(file.size);
    ocrResetSteps();
    ocrSetPickBusy(true);
    setDot('loading');

    let stage = 'read';
    try {
      // 1) Чтение файла
      ocrSetStep('read', 'active', '');
      setStatus('Читаю файл…');
      const b64 = await blobToB64(file);
      ocrSetStep('read', 'done', fmtFileSize(file.size));

      // 2) Распознавание (OCR на локальном сервере)
      stage = 'ocr';
      ocrSetStep('ocr', 'active', 'tesseract…');
      setStatus('Распознаю документ…');
      const res = await bg('LOCAL_OCR', { fileB64: b64, name: file.name, mime: file.type, langs: 'kaz+rus+eng' });
      const text = (res && res.text || '').trim();
      log('info', 'OCR', file.name + ' → ' + text.slice(0, 120));
      if (!text) {
        ocrSetStep('ocr', 'error', 'текст не распознан');
        ocrSetStep('tpl', 'skip', ''); ocrSetStep('fill', 'skip', '');
        setDot('error'); setStatus('Готов');
        showReply('Не удалось распознать текст в документе', true);
        return;
      }
      ocrSetStep('ocr', 'done', text.length + ' симв.');
      ocrShowResult(text);

      // 3) Подбор шаблона на главном сервере
      stage = 'tpl';
      ocrSetStep('tpl', 'active', 'ИИ подбирает…');
      setStatus('Подбираю шаблон…');
      const tpl = await bg('MAIN_OCR', { text: '[OCR] ' + text, provider: CFG.provider });
      setDot('');

      if (!tpl || tpl.id == null) {
        ocrSetStep('tpl', 'error', 'не найден');
        ocrSetStep('fill', 'skip', '');
        showReply(tpl && tpl.reply ? tpl.reply : 'Подходящий шаблон не найден');
        setStatus('Готов');
        return;
      }
      const steps = Array.isArray(tpl.steps) ? tpl.steps : [];
      const missing = Array.isArray(tpl.missing) ? tpl.missing : [];
      ocrSetStep('tpl', 'done', '#' + tpl.id + (tpl.llm_filled ? ' · ИИ' : ''));
      if (tpl.llm_filled) log('info', 'OCR-шаблон #' + tpl.id, 'часть полей дозаполнил ИИ');
      if (missing.length) log('info', 'OCR-шаблон #' + tpl.id, 'не распознаны поля: ' + missing.join(', '));

      // 4) Заполнение формы — тем же движком, что и голосовые команды.
      stage = 'fill';
      if (!steps.length) {
        ocrSetStep('fill', 'error', 'нет данных');
        showReply('Шаблон #' + tpl.id + ' подобран, но данных для заполнения нет');
        if (tpl.data) ocrShowResult(el.ocrResult.textContent + '\n\n[Шаблон #' + tpl.id + ']\n' + JSON.stringify(tpl.data, null, 2));
        setStatus('Готов');
        return;
      }
      ocrSetStep('fill', 'active', steps.length + ' пол.');
      showReply('Шаблон #' + tpl.id + ': заполняю ' + steps.length + ' пол(я/ей)…');
      log('info', 'OCR → план', 'шаблон #' + tpl.id + ', шагов: ' + steps.length);
      await startRun(tpl);
      const filledNote = missing.length ? (steps.length + ' пол., пропущено ' + missing.length) : (steps.length + ' пол.');
      ocrSetStep('fill', 'done', filledNote);
      setStatus('Готов');
    } catch (err) {
      ocrSetStep(stage, 'error', 'ошибка');
      setDot('error');
      ocrShowResult('Ошибка: ' + err.message);
      showReply('Ошибка OCR: ' + err.message, true);
      log('error', 'OCR', err.message);
      ocrDropState('error');
    } finally {
      ocrSetPickBusy(false);
      // Успех = состояние осталось 'busy' (ошибка бы переключила на 'error').
      if (el.ocrDrop && el.ocrDrop.dataset.state === 'busy') ocrDropState('done');
      setTimeout(() => {
        if (el.ocrDrop && (el.ocrDrop.dataset.state === 'done' || el.ocrDrop.dataset.state === 'error')) ocrDropState('idle');
      }, 1600);
    }
  }

  /* ════════════════════════════════════════════════════════════════════
   *  LISTEN toggle
   * ════════════════════════════════════════════════════════════════════ */
  // Пользователь щёлкнул тумблер / сказал sleep|wake: пишем ГЛОБАЛЬНО (во все вкладки) и применяем у себя.
  function setListen(on) {
    if (on) S.micBlocked = false;                 // повторное включение снимает локальную блокировку
    chrome.storage.local.set({ [LISTEN_KEY]: !!on });
    applyListen(on);
  }
  function toggleListen() { setListen(!S.listenWanted); }

  // Применить желаемое состояние в ЭТОЙ вкладке: UI отражает «включено везде»,
  // а микрофон запускаем только если вкладка активна (reconcileRecognition).
  function applyListen(wanted) {
    S.listenWanted = !!wanted;
    root.setAttribute('data-listen', wanted ? 'on' : 'off');
    root.setAttribute('data-wake', wanted ? 'on' : '');
    el.listenLabel.textContent = wanted ? 'СЛУШАЮ' : 'СПИТ';
    el.wakeBadge.style.display = wanted ? 'flex' : 'none';
    el.listenOff.style.display = wanted ? 'none' : 'flex';
    if (wanted) el.micDenied.style.display = 'none';
    reconcileRecognition();
  }

  // Согласовать реальную работу микрофона с желанием + активностью вкладки.
  function reconcileRecognition() {
    if (shouldListen()) {
      el.micDenied.style.display = 'none';
      startRecognition();
      setStatus('Слушаю wake-word');
    } else {
      stopRecognition();
      setStatus(S.listenWanted ? 'Пауза — вкладка неактивна' : 'Готов');
    }
  }

  /* ════════════════════════════════════════════════════════════════════
   *  ПРИМЕНЕНИЕ КОНФИГА К UI
   * ════════════════════════════════════════════════════════════════════ */
  const PROVIDER_LABEL = { qwen: 'Qwen', openai: 'OpenAI', deepseek: 'DeepSeek' };
  function applyConfigToUI() {
    if (CFG.theme) root.setAttribute('data-theme', CFG.theme); else root.removeAttribute('data-theme');
    root.setAttribute('data-dev', CFG.devMode ? 'on' : 'off');
    const chip = $('#aq-provider-chip');
    if (chip) {
      const p = CFG.provider || 'qwen';
      chip.textContent = PROVIDER_LABEL[p] || p;
      chip.setAttribute('data-provider', p);
    }
  }

  /* ════════════════════════════════════════════════════════════════════
   *  ИНИЦИАЛИЗАЦИЯ
   * ════════════════════════════════════════════════════════════════════ */
  loadConfig().then(() => {
    applyConfigToUI();
    initBars();
    positionFloater(el.recHud);
    positionFloater(el.confirmCard);
    // восстановить хвост лога (в devMode — глубже, там записей больше)
    chrome.storage.local.get(LOG_KEY, (store) => {
      const tail = CFG.devMode ? 150 : 40;
      (store[LOG_KEY] || []).slice(-tail).forEach(renderLogItem);
    });
    // Глобальное состояние «слушать»: если уже задано в storage — наследуем его
    // (новые вкладки/сессии просыпаются вместе со всеми), иначе — listenOnStart.
    chrome.storage.local.get(LISTEN_KEY, (store) => {
      const v = store[LISTEN_KEY];
      applyListen(typeof v === 'boolean' ? v : !!CFG.listenOnStart);
    });
    // Микрофон только в активной вкладке: реагируем на переключение вкладок/окна.
    document.addEventListener('visibilitychange', reconcileRecognition);
    installUrlWatcher();
    resumeRun('init');
    setStatus('Готов');
  });
})();
