"""
Suerte / Aqbobek — специализированные («первичные») сканеры динамических страниц.
──────────────────────────────────────────────────────────────────────────
Общий /scan (BeautifulSoup) перечисляет все элементы подряд и не понимает
семантику конкретной страницы. Здесь живут «заточенные» сканеры под известные
страницы Damumed: они разбирают блоки по ФИО пациента и для каждой кнопки пишут
в description, ЧЬЯ это кнопка, с уникальным CSS-селектором.

Движок — Playwright (headless Chromium). Расширение присылает готовый HTML-снимок
(document.outerHTML); мы загружаем его через set_content в настоящий браузер и всю
разборку выполняем одним page.evaluate в реальном DOM — так селекторы строятся и
проверяются на уникальность там же, где их потом будет искать document.querySelector.

Реестр: pick(url) -> запись сканера {name, match, fn} или None.
Каждый сканер: async fn(html, url, values) -> list[element], где element в формате /scan:
    {description, selector, method, type_write, value, address}

Playwright — тяжёлая зависимость (нужен `playwright install chromium`), поэтому
браузер поднимается лениво и один раз. Если Playwright/Chromium не установлены,
scan_doctor бросит исключение — вызывающий /scan-dynamic перехватит его и откатится
на общий разбор.
"""

import asyncio

# ───────────────────── Playwright: ленивый синглтон ─────────────────────
_pw = None
_browser = None
_browser_lock = asyncio.Lock()


async def _get_browser():
    """Один headless-Chromium на весь процесс; переподнимается, если отвалился."""
    global _pw, _browser
    if _browser is not None and _browser.is_connected():
        return _browser
    async with _browser_lock:
        if _browser is None or not _browser.is_connected():
            from playwright.async_api import async_playwright
            _pw = await async_playwright().start()
            _browser = await _pw.chromium.launch(headless=True)
    return _browser


# ───────────────────── JS-экстрактор (работает в DOM) ─────────────────────
# Один проход по .panel-heading блокам: для каждого блока достаём ФИО (data-fullname
# или заглавные слова, включая казахские буквы), номер (№...) и дату — как контекст,
# а для каждой кнопки-действия строим селектор по уникальному id из onclick и
# описание вида "Выбрать ФИО (категория, №..., дата)".
_JS_EXTRACTOR = r"""
(ctx) => {
  const url = ctx.url || '';
  const HANDLERS = {
    onSelectClick:        {action: 'Выбрать', cat: 'история болезни'},
    onShareClick:         {action: 'Выдать временный доступ', cat: 'история болезни'},
    onPrintClick:         {action: 'Открыть', cat: 'архив'},
    onExecuteClick:       {action: 'Выполнить', cat: 'задача'},
    onDefectExecuteClick: {action: 'Выполнить', cat: 'дефект'},
    onCheckDefect:        {action: 'Проверить', cat: 'дефект'},
  };
  const UP = 'А-ЯЁӘҒҚҢӨҰҮҺІ';
  const TOKEN = '(?:[' + UP + ']{2,}|[' + UP + ']\\.)';         // слово ИЛИ инициал "П."
  const NAME_RE = new RegExp(TOKEN + '(?:\\s+' + TOKEN + ')+');
  const NUM_RE = /№\s*(\d+)/;
  const DATE_RE = /\d{2}\.\d{2}\.\d{4}(?:\s+\d{2}:\d{2})?/;
  const HANDLER_RE = /(onSelectClick|onShareClick|onPrintClick|onDefectExecuteClick|onExecuteClick|onCheckDefect)/;

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const isUuid = (s) => /-/.test(s) && s.length >= 8;

  function isHidden(el) {
    if (!el) return false;
    if (el.hidden) return true;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const style = cur.getAttribute('style') || '';
      if (cur.hasAttribute('hidden') || /display\s*:\s*none/i.test(style)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function cssPath(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el.nodeType === 1 && el.tagName.toLowerCase() !== 'html') {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
      let nth = 1, sib = el;
      while (sib.previousElementSibling) { sib = sib.previousElementSibling; if (sib.tagName === el.tagName) nth++; }
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + nth + ')');
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  function buildSelector(a, onclick, handler) {
    const ids = (onclick.match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1));
    const rid = ids.length ? ids[ids.length - 1] : null;    // последний строковый аргумент = id записи
    if (rid) {
      const sel = isUuid(rid)
        ? 'a[onclick*="' + rid + '"]'
        : 'a[onclick*="' + handler + '"][onclick*="' + rid + '"]';
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) {}
    }
    return cssPath(a);
  }

  const out = [];
  const seen = new Set();
  document.querySelectorAll('.panel-heading').forEach((block) => {
    const text = block.innerText || block.textContent || '';
    let name = null;
    const dfEl = block.querySelector('[data-fullname]');
    if (dfEl && dfEl.getAttribute('data-fullname')) name = norm(dfEl.getAttribute('data-fullname'));
    if (!name) { const m = text.match(NAME_RE); if (m) name = norm(m[0]); }
    const numM = text.match(NUM_RE); const number = numM ? numM[1] : null;
    const dateM = text.match(DATE_RE); const date = dateM ? dateM[0] : null;

    block.querySelectorAll('a[onclick]').forEach((a) => {
      const onclick = a.getAttribute('onclick') || '';
      const hm = onclick.match(HANDLER_RE);
      if (!hm) return;
      const info = HANDLERS[hm[1]];
      if (!info) return;
      const action = norm(a.innerText || a.textContent) || info.action;
      const sel = buildSelector(a, onclick, hm[1]);
      if (!sel || seen.has(sel)) return;
      seen.add(sel);
      const parts = [];
      if (info.cat) parts.push(info.cat);
      if (number) parts.push('№' + number);
      if (date) parts.push(date);
      const suffix = parts.length ? ' (' + parts.join(', ') + ')' : '';
      const description = (name ? action + ' ' + name : action) + suffix;
      out.push({ description: description, selector: sel, method: 'click', type_write: 'write', value: null, address: url });
    });
  });

  // ── Верхнее меню профиля врача: специализация, Сообщения, Роли,
  //    Сменить пароль, Выйти (выпадающий список в правом верхнем углу) ──
  const seenAccount = new Set();
  document.querySelectorAll('.account-item a').forEach((a) => {
    if (isHidden(a)) return;
    const isToggle = a.classList.contains('dropdown-toggle');
    const label = isToggle ? 'Открыть меню профиля' : norm(a.textContent);
    if (!label) return;
    const onclick = a.getAttribute('onclick');
    const href = a.getAttribute('href');
    const key = onclick || href || label;
    if (seenAccount.has(key)) return;
    seenAccount.add(key);

    let sel = null;
    if (onclick) {
      const q = onclick.replace(/"/g, '\\"');
      const cand = 'a[onclick="' + q + '"]';
      try { sel = document.querySelectorAll(cand).length === 1 ? cand : cssPath(a); } catch (e) { sel = cssPath(a); }
    } else {
      sel = cssPath(a);
    }
    out.push({ description: 'Меню: ' + label, selector: sel, method: 'click', type_write: 'write', value: null, address: url });
  });

  // ── Виджет «Дежурство врача отделения»: кнопка регистрации дежурства
  //    и разворачивание виджета (стабильные id, не зависят от данных) ──
  const SHIFT_BUTTONS = [
    { id: 'btnCreateDepartmentShiftSchedule', label: 'Регистрация дежурства врача' },
    { id: 'departmentShiftScheduleButton', label: 'Развернуть виджет «Дежурство врача отделения»' },
  ];
  SHIFT_BUTTONS.forEach(({ id, label }) => {
    const el = document.getElementById(id);
    if (!el || isHidden(el)) return;
    out.push({ description: label, selector: '#' + CSS.escape(id), method: 'click', type_write: 'write', value: null, address: url });
  });

  return out;
}
"""


async def scan_doctor(html, url, values=None):
    """Сканер страницы врача Damumed (…/doctor). Загружает HTML-снимок в headless
    Chromium и одним проходом возвращает элементы в формате /scan."""
    browser = await _get_browser()
    context = await browser.new_context()
    try:
        page = await context.new_page()

        async def _abort(route):
            # Гасим все подзапросы снимка (внешние css/js/шрифты): DOM уже готов,
            # сеть не нужна — так set_content не зависает и чужие скрипты не мешают.
            try:
                await route.abort()
            except Exception:
                pass

        await page.route("**/*", _abort)
        try:
            await page.set_content(html, wait_until="domcontentloaded", timeout=30000)
        except Exception:
            # даже при таймауте DOM уже установлен — продолжаем разбор
            pass
        elements = await page.evaluate(_JS_EXTRACTOR, {"url": url})
        return elements or []
    finally:
        try:
            await context.close()
        except Exception:
            pass


# ───────────────── JS-экстрактор для medicalHistory (Стационар) ─────────────────
# Страница истории болезни (вкладка «Медицинские записи», грид #grdMedicalRecords).
# Формат вывода для строк грида: "<группа/тип записи> : <действие>" — например
# "01. Осмотр врача приемного покоя (1) : Подписать". Если в группе больше одной
# записи (число в скобках > 1), к описанию добавляется дата регистрации записи,
# чтобы отличать одинаковые кнопки разных записей одного типа.
#
# Кроме грида разбираются:
#   - верхнее меню вкладок (Главная, Медицинские записи, Диагнозы, ... включая
#     подпункты выпадающего меню «Прочее»);
#   - панель фильтров над гридом (тип мед. записи, диапазон дат регистрации,
#     показать удалённые, свернуть/развернуть, обновить);
#   - кнопка «Добавить» и список типов записей в её выпадающем меню;
#   - блок сведений о дефектах (кнопки «Обновить»/детали дефектов).
#
# Верхнее меню в HTML продублировано дважды (варианты big-screen/normal-screen —
# переключаются через @media в зависимости от ширины экрана), поэтому пункты
# дедуплицируются по точному значению onclick (или по тексту для dropdown-toggle
# без onclick), чтобы не показывать одну и ту же кнопку дважды.
_JS_EXTRACTOR_MEDRECORDS = r"""
(ctx) => {
  const url = ctx.url || '';
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function cssPath(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el.nodeType === 1 && el.tagName.toLowerCase() !== 'html') {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
      let nth = 1, sib = el;
      while (sib.previousElementSibling) { sib = sib.previousElementSibling; if (sib.tagName === el.tagName) nth++; }
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + nth + ')');
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  function isHidden(el) {
    if (!el) return false;
    if (el.hidden) return true;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const style = cur.getAttribute('style') || '';
      if (cur.hasAttribute('hidden') || /display\s*:\s*none/i.test(style)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  const out = [];

  // ── 1. Верхнее меню вкладок (+ подпункты «Прочее») ──
  // Меню в HTML продублировано (big-screen/normal-screen), а у части пунктов
  // (Операции, Ввод показателей здоровья, Документы, Дневниковые записи)
  // копии зовут обработчик с разными аргументами ('big'/'normal'/без аргумента).
  // Дедуплицируем по ИМЕНИ функции-обработчика (без аргументов), а не по
  // полной строке onclick, — иначе одна и та же кнопка попадёт в список дважды.
  const seenNav = new Set();
  document.querySelectorAll('ul.mh-navigation a').forEach((a) => {
    const onclick = a.getAttribute('onclick');
    const isToggle = a.classList.contains('dropdown-toggle');
    const text = norm(a.textContent) || a.getAttribute('title') || '';
    const fnName = onclick ? (onclick.match(/(\w+)\s*\(/) || [])[1] : null;
    const key = fnName || onclick || (isToggle ? 'toggle:' + text : null);
    if (!key || seenNav.has(key) || !text) return;
    seenNav.add(key);

    let sel = null;
    if (onclick) {
      const q = onclick.replace(/"/g, '\\"');
      const cand = 'a[onclick="' + q + '"]';
      try { sel = document.querySelectorAll(cand).length ? cand : cssPath(a); } catch (e) { sel = cssPath(a); }
    } else {
      sel = cssPath(a);
    }
    out.push({
      description: 'Меню: ' + text,
      selector: sel, method: 'click', type_write: 'write', value: null, address: url,
    });
  });

  // ── 2. Панель фильтров и управляющие кнопки над гридом записей ──
  // Kendo combobox: реальный <select>/<input> с id визуально скрыт (display:none),
  // а кликабельно-печатаемое поле — соседний <input name="ID_input">. Работаем
  // именно с ним, иначе автоматизация будет "нажимать" на невидимый элемент.
  const COMBO_FIELDS = [
    { id: 'cmbMedicalRecordTypes', label: 'Фильтр: Тип мед. записи' },
    { id: 'cmbMedicalRecordTypeMo', label: 'Фильтр: Подтип медицинской записи' },
  ];
  COMBO_FIELDS.forEach(({ id, label }) => {
    const visible = document.querySelector('input[name="' + id + '_input"]');
    if (!visible || isHidden(visible)) return;
    out.push({
      description: label, selector: cssPath(visible), method: 'click',
      type_write: 'write', value: visible.value || null, address: url,
    });
  });

  const DATE_FIELDS = [
    { id: 'dtBeginDate', label: 'Фильтр: Дата регистрации (с)' },
    { id: 'dtEndDate', label: 'Фильтр: Дата регистрации (по)' },
  ];
  DATE_FIELDS.forEach(({ id, label }) => {
    const el = document.getElementById(id);
    if (!el || isHidden(el)) return;
    out.push({
      description: label, selector: '#' + id, method: 'click',
      type_write: 'write', value: el.value || null, address: url,
    });
  });

  document.querySelectorAll('#divBtns button, #divBtns [onclick]').forEach((btn) => {
    if (btn.closest('.dropdown-menu')) return; // пункты «Добавить» разбираются отдельно ниже
    // title часто висит не на самой кнопке, а на вложенном <span class="glyphicon">
    const titledEl = btn.hasAttribute('title') ? btn : btn.querySelector('[title]');
    const title = titledEl ? titledEl.getAttribute('title') : null;
    const glyph = btn.querySelector('[class*="glyphicon-"]');
    let label = title || norm(btn.textContent);
    if (!label && glyph) {
      const cls = (glyph.className.match(/glyphicon-([\w-]+)/) || [])[1];
      label = cls || 'кнопка';
    }
    if (!label) return;
    const sel = cssPath(btn);
    out.push({
      description: 'Панель записей: ' + label, selector: sel,
      method: 'click', type_write: 'write', value: null, address: url,
    });
  });

  // Пункты выпадающего меню «Добавить» (создание новой мед. записи нужного типа)
  document.querySelectorAll('#divBtns .dropdown-menu a[onclick]').forEach((a) => {
    const text = norm(a.textContent);
    if (!text) return;
    const onclick = a.getAttribute('onclick') || '';
    const q = onclick.replace(/"/g, '\\"');
    const cand = 'a[onclick="' + q + '"]';
    let sel;
    try { sel = document.querySelectorAll(cand).length === 1 ? cand : cssPath(a); } catch (e) { sel = cssPath(a); }
    out.push({
      description: 'Добавить: ' + text, selector: sel,
      method: 'click', type_write: 'write', value: null, address: url,
    });
  });

  // ── 3. Блок сведений о дефектах над гридом ──
  document.querySelectorAll('#badge-defects [onclick]').forEach((el) => {
    if (el.id === 'sync-defects-btn') return; // эта кнопка добавляется ниже отдельно
    const text = norm(el.textContent) || 'Показать детали дефектов';
    out.push({
      description: 'Дефекты: ' + text, selector: cssPath(el),
      method: 'click', type_write: 'write', value: null, address: url,
    });
  });
  const syncBtn = document.getElementById('sync-defects-btn');
  if (syncBtn) {
    out.push({
      description: 'Дефекты: ' + (norm(syncBtn.textContent) || 'Обновить'),
      selector: '#sync-defects-btn', method: 'click', type_write: 'write', value: null, address: url,
    });
  }

  // ── 4. Грид медицинских записей: группа (тип записи) + действия по записи ──
  let currentCategory = '';
  document.querySelectorAll('#grdMedicalRecords tr').forEach((tr) => {
    if (tr.classList.contains('k-grouping-row')) {
      currentCategory = norm(tr.textContent);
      return;
    }
    const id = tr.getAttribute('data-id');
    if (!id) return;

    const muted = tr.querySelector('.text-muted');
    const muteText = muted ? norm(muted.textContent) : '';
    const dateMatch = muteText.match(/\d{2}\.\d{2}\.\d{4}(?:\s+\d{2}:\d{2})?/);
    const date = dateMatch ? dateMatch[0] : null;
    // Автор записи обычно идёт после даты через запятую: "01.07.2026 09:00, ФИО"
    const commaIdx = muteText.indexOf(',');
    const author = commaIdx >= 0 ? norm(muteText.slice(commaIdx + 1)) : '';
    const countMatch = currentCategory.match(/\((\d+)\)\s*$/);
    const count = countMatch ? parseInt(countMatch[1], 10) : null;

    tr.querySelectorAll('a[onclick]').forEach((a) => {
      const text = norm(a.textContent);
      if (!text) return;
      const onclick = a.getAttribute('onclick') || '';
      const fnMatch = onclick.match(/\.(\w+)\(/);
      const fn = fnMatch ? fnMatch[1] : null;
      const bySelKey = fn || text;
      const candSel = 'tr[data-id="' + id + '"] a[onclick*="' + bySelKey + '"]';
      let sel;
      try { sel = document.querySelectorAll(candSel).length === 1 ? candSel : cssPath(a); } catch (e) { sel = cssPath(a); }

      let description = currentCategory ? currentCategory + ' : ' + text : text;
      if (count && count > 1 && date) {
        description += ' (запись от ' + date + (author ? ', ' + author : '') + ')';
      }

      out.push({
        description: description, selector: sel,
        method: 'click', type_write: 'write', value: null, address: url,
      });
    });
  });

  return out;
}
"""


async def scan_medical_records(html, url, values=None):
    """Сканер вкладки «Медицинские записи» истории болезни Damumed
    (…/medicalHistory/medicalHistory). Разбирает верхнее меню, панель фильтров
    и грид записей (#grdMedicalRecords), подписывая каждую кнопку тем, к какой
    группе/типу записи и (при необходимости) к какой конкретной записи по дате
    она относится."""
    browser = await _get_browser()
    context = await browser.new_context()
    try:
        page = await context.new_page()

        async def _abort(route):
            try:
                await route.abort()
            except Exception:
                pass

        await page.route("**/*", _abort)
        try:
            await page.set_content(html, wait_until="domcontentloaded", timeout=30000)
        except Exception:
            pass
        elements = await page.evaluate(_JS_EXTRACTOR_MEDRECORDS, {"url": url})
        return elements or []
    finally:
        try:
            await context.close()
        except Exception:
            pass


# ───────────── JS-экстрактор для medicalHistory (вкладка «Назначения») ─────────────
# Вкладка «Назначения» (mh-assignments, тот же URL medicalHistory/medicalHistory).
# Разбираются:
#   1) верхнее меню вкладок — тот же код, что и в medrecords-экстракторе;
#   2) панель фильтров и переключения даты/масштаба над таблицей (тип/статус
#      назначения, чекбоксы, поиск по названию, дата, зум, кнопка «Добавить»
#      с выпадающим списком типов назначения);
#   3) блок «без графика» (#lvAssignment_<caseID>) — Диета/Режим и т.п., где у
#      записи нет расписания по датам, только «Изменить»/«Удалить»;
#   4) сама таблица #assignmentTable — матрица «строка-назначение × колонка-дата».
#      Каждая пара строк <tr> — врач (кто назначил/отменяет/копирует/продлевает)
#      и медсестра (кто выполняет/не выполняет по времени). Ячейка на пересечении
#      либо пустая с onclick на самой <td> (клик = «Продлить» на эту дату), либо
#      содержит выпадающее меню (бейдж с количеством): для пунктов-подменю
#      (Отменить/Удалить/Выполнить/Не выполнить) — список конкретных времён
#      приёма, для простых пунктов (Копировать/Продлить/Удалить назначение) —
#      действие на всё назначение целиком, но показанное в контексте этой даты.
#      Т.к. Копировать/Продлить/Удалить назначение используют один и тот же id
#      во ВСЕХ колонках-датах, где назначение есть, их onclick не уникален —
#      селектор в этом случае строится полным DOM-путём (cssPath), чтобы каждая
#      дата давала свой рабочий селектор, а не совпадающий с соседними датами.
_JS_EXTRACTOR_ASSIGNMENTS = r"""
(ctx) => {
  const url = ctx.url || '';
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function cssPath(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el.nodeType === 1 && el.tagName.toLowerCase() !== 'html') {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
      let nth = 1, sib = el;
      while (sib.previousElementSibling) { sib = sib.previousElementSibling; if (sib.tagName === el.tagName) nth++; }
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + nth + ')');
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  function isHidden(el) {
    if (!el) return false;
    if (el.hidden) return true;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const style = cur.getAttribute('style') || '';
      if (cur.hasAttribute('hidden') || /display\s*:\s*none/i.test(style)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // Строит селектор по onclick-обработчику элемента (a или td): имя функции +
  // последний непустой строковый аргумент. Проверяет уникальность в DOM;
  // если не уникален (напр. Копировать/Продлить с одним и тем же id во всех
  // датах) — откатывается на полный CSS-путь конкретного элемента.
  function buildSelector(el) {
    const onclick = el.getAttribute('onclick') || '';
    const fnMatch = onclick.match(/\.(\w+)\s*\(/);
    const fn = fnMatch ? fnMatch[1] : null;
    const args = (onclick.match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1)).filter(Boolean);
    const key = args.length ? args[args.length - 1] : null;
    if (fn && key) {
      const tag = el.tagName.toLowerCase();
      const cand = tag + '[onclick*="' + fn + '"][onclick*="' + key + '"]';
      try { if (document.querySelectorAll(cand).length === 1) return cand; } catch (e) {}
    }
    return cssPath(el);
  }

  const FN_LABELS = {
    onAssignmentProlongButtonClick: 'Продлить',
    onAssignmentCopyButtonClick: 'Копировать',
    onAssignmentDeleteButtonClick: 'Удалить назначение',
    onAssignmentCancelButtonClick: 'Отменить',
    onAssignmentRecDeleteButtonClick: 'Удалить',
    onAssignmentExecuteButtonClick: 'Выполнить',
    onAssignmentNotExecuteButtonClick: 'Не выполнить',
  };

  function labelFor(el, fallbackText) {
    const text = norm(fallbackText);
    if (text) return text;
    const onclick = el.getAttribute('onclick') || '';
    const fnMatch = onclick.match(/\.(\w+)\s*\(/);
    return (fnMatch && FN_LABELS[fnMatch[1]]) || 'действие';
  }

  const out = [];

  // ── 1. Верхнее меню вкладок (общее для всех вкладок medicalHistory) ──
  const seenNav = new Set();
  document.querySelectorAll('ul.mh-navigation a').forEach((a) => {
    const onclick = a.getAttribute('onclick');
    const isToggle = a.classList.contains('dropdown-toggle');
    const text = norm(a.textContent) || a.getAttribute('title') || '';
    const fnName = onclick ? (onclick.match(/(\w+)\s*\(/) || [])[1] : null;
    const key = fnName || onclick || (isToggle ? 'toggle:' + text : null);
    if (!key || seenNav.has(key) || !text) return;
    seenNav.add(key);
    let sel = null;
    if (onclick) {
      const q = onclick.replace(/"/g, '\\"');
      const cand = 'a[onclick="' + q + '"]';
      try { sel = document.querySelectorAll(cand).length ? cand : cssPath(a); } catch (e) { sel = cssPath(a); }
    } else {
      sel = cssPath(a);
    }
    out.push({ description: 'Меню: ' + text, selector: sel, method: 'click', type_write: 'write', value: null, address: url });
  });

  // ── 2. Панель фильтров/навигации над таблицей назначений ──
  document.querySelectorAll('.btn-current-date-left-wrapper button, .btn-current-date-right-wrapper button').forEach((b) => {
    const title = b.getAttribute('title') || norm(b.textContent) || 'дата';
    out.push({ description: 'Назначения: ' + title, selector: cssPath(b), method: 'click', type_write: 'write', value: null, address: url });
  });
  const curDate = document.getElementById('dtCurrentDate');
  if (curDate && !isHidden(curDate)) {
    out.push({ description: 'Назначения: Текущая дата', selector: '#dtCurrentDate', method: 'click', type_write: 'write', value: curDate.value || null, address: url });
  }
  document.querySelectorAll('.btn-zoom-minus-wrapper button, .btn-zoom-plus-wrapper button').forEach((b) => {
    const title = b.getAttribute('title') || norm(b.textContent) || 'масштаб';
    out.push({ description: 'Назначения: ' + title, selector: cssPath(b), method: 'click', type_write: 'write', value: null, address: url });
  });

  const COMBO_FIELDS = [
    { id: 'cmbAssignmentType', label: 'Фильтр: Тип назначения' },
    { id: 'cmbAssignmentStatus', label: 'Фильтр: Статус' },
  ];
  COMBO_FIELDS.forEach(({ id, label }) => {
    const visible = document.querySelector('input[name="' + id + '_input"]');
    if (!visible || isHidden(visible)) return;
    out.push({ description: label, selector: cssPath(visible), method: 'click', type_write: 'write', value: visible.value || null, address: url });
  });

  [
    { id: 'cbShowAllAssignment', label: 'Фильтр: показать все' },
    { id: 'cbShowEmergencyAssignment', label: 'Фильтр: показать назначения приёмного покоя' },
  ].forEach(({ id, label }) => {
    const el = document.getElementById(id);
    if (!el || isHidden(el)) return;
    out.push({ description: label, selector: '#' + id, method: 'click', type_write: 'write', value: el.checked ? '1' : '0', address: url });
  });

  const nameSearch = document.getElementById('tbMedAssignmentName');
  if (nameSearch && !isHidden(nameSearch)) {
    out.push({ description: 'Фильтр: Наименование назначения', selector: '#tbMedAssignmentName', method: 'click', type_write: 'write', value: nameSearch.value || null, address: url });
  }

  // Кнопка «Добавить» + список типов назначения в выпадающем меню
  document.querySelectorAll('[title="Добавить"]').forEach((btn) => {
    const el = btn.tagName.toLowerCase() === 'button' ? btn : btn.closest('button');
    if (!el) return;
    out.push({ description: 'Назначения: Добавить', selector: cssPath(el), method: 'click', type_write: 'write', value: null, address: url });
  });
  document.querySelectorAll('a[onclick*="onEditAssignmentButtonClick"]').forEach((a) => {
    const text = norm(a.textContent);
    if (!text) return;
    out.push({ description: 'Добавить назначение: ' + text, selector: buildSelector(a), method: 'click', type_write: 'write', value: null, address: url });
  });

  // ── 3. Записи «без расписания» (Диета/Режим и т.п.): #lvAssignment_<caseID> ──
  document.querySelectorAll('[id^="lvAssignment_"] .row[data-uid]').forEach((row) => {
    const labelEl = row.querySelector('.col-md-6');
    const label = labelEl ? norm(labelEl.textContent) : '';
    if (!label) return;
    row.querySelectorAll('a[onclick*="onEditButtonClick"], a[onclick*="onDeleteButtonClick"]').forEach((a) => {
      const action = norm(a.textContent) || labelFor(a, '');
      out.push({ description: action + ' ' + label, selector: buildSelector(a), method: 'click', type_write: 'write', value: null, address: url });
    });
  });

  // ── 4. Таблица #assignmentTable: строка-назначение × колонка-дата ──
  const DATE_RE = /^\d{1,2}\s+\S+\.?$/;
  const dateHeaders = Array.from(document.querySelectorAll('#assignmentTable thead th.floatThead-col'))
    .map((h) => norm(h.getAttribute('aria-label') || ''))
    .filter((l) => DATE_RE.test(l));

  let currentName = '';
  document.querySelectorAll('#assignmentTable > tbody > tr').forEach((tr) => {
    const tds = Array.from(tr.children).filter((c) => c.tagName === 'TD');
    if (!tds.length) return;

    let idx = 0;
    if (tds[0].hasAttribute('rowspan')) {
      const nameSpan = tds[0].querySelector('[data-id]');
      currentName = norm((nameSpan ? nameSpan.textContent : tds[0].textContent));
      idx = 1;
    }
    const authorTd = tds[idx]; idx += 1;
    const author = authorTd ? norm(authorTd.textContent) : '';

    let dateIdx = 0;
    for (; idx < tds.length; idx++, dateIdx++) {
      const td = tds[idx];
      const date = dateHeaders[dateIdx] || null;
      const toggle = td.querySelector(':scope > .dropdown > a.dropdown-toggle');

      if (toggle) {
        const menu = td.querySelector(':scope > .dropdown > ul.dropdown-menu');
        if (!menu) continue;
        Array.from(menu.children).forEach((li) => {
          if (li.classList.contains('dropdown-submenu')) {
            const headA = li.querySelector(':scope > a');
            const submenuLabel = headA ? norm(headA.textContent) : '';
            if (!submenuLabel) return;
            const items = li.querySelectorAll(':scope > ul.dropdown-menu > li > a[onclick]');
            items.forEach((a) => {
              const timeText = norm(a.textContent);
              const suffix = items.length > 1 && timeText ? ' (' + timeText + ')' : '';
              const parts = [currentName, author, date, submenuLabel + suffix].filter(Boolean);
              out.push({ description: parts.join(' : '), selector: buildSelector(a), method: 'click', type_write: 'write', value: null, address: url });
            });
          } else {
            const a = li.querySelector('a[onclick]');
            if (!a) return;
            const action = labelFor(a, a.textContent);
            const parts = [currentName, author, date, action].filter(Boolean);
            out.push({ description: parts.join(' : '), selector: buildSelector(a), method: 'click', type_write: 'write', value: null, address: url });
          }
        });
      } else if (td.hasAttribute('onclick')) {
        const action = labelFor(td, '');
        const parts = [currentName, author, date, action].filter(Boolean);
        out.push({ description: parts.join(' : '), selector: buildSelector(td), method: 'click', type_write: 'write', value: null, address: url });
      }
    }
  });

  return out;
}
"""


async def scan_assignments(html, url, values=None):
    """Сканер вкладки «Назначения» истории болезни Damumed
    (…/medicalHistory/medicalHistory, активная вкладка mh-assignments). Разбирает
    верхнее меню, панель фильтров/навигации, кнопку «Добавить», блок записей без
    расписания (Диета/Режим) и матрицу таблицы #assignmentTable (назначение ×
    дата), подписывая каждое действие тем, к какому назначению, исполнителю
    (врач/медсестра) и дате оно относится."""
    browser = await _get_browser()
    context = await browser.new_context()
    try:
        page = await context.new_page()

        async def _abort(route):
            try:
                await route.abort()
            except Exception:
                pass

        await page.route("**/*", _abort)
        try:
            await page.set_content(html, wait_until="domcontentloaded", timeout=30000)
        except Exception:
            pass
        elements = await page.evaluate(_JS_EXTRACTOR_ASSIGNMENTS, {"url": url})
        return elements or []
    finally:
        try:
            await context.close()
        except Exception:
            pass


# ───────────── JS-экстрактор для medicalHistory (вкладка «Дневниковые записи») ─────────────
# Вкладка «Дневниковые записи» (mh-diaries, тот же URL medicalHistory/medicalHistory).
# В отличие от страницы patientDiary/editDiary (там редактируется ОДНА запись,
# верстка статична — см. scan_diary выше), здесь список ВСЕХ дневниковых записей
# пациента (#grdDiary) — количество карточек растёт вместе с историей болезни,
# поэтому нужен настоящий DOM-разбор через Playwright, а не заранее собранный список.
#
# Разбираются:
#   1) верхнее меню вкладок — тот же код, что и в medrecords/assignments-экстракторах;
#   2) панель фильтров над гридом (отделение/должность, диапазон дат, быстрые
#      периоды «за последнюю неделю»/«все», показать удалённые, обновить, добавить);
#   3) сам грид #grdDiary — карточка на запись (дата+показатели здоровья в
#      заголовке, текст записи, врач, действия: Посмотреть/Изменить/Копировать/
#      Файлы/Удалить), каждое действие подписывается датой записи и врачом.
_JS_EXTRACTOR_DIARIES = r"""
(ctx) => {
  const url = ctx.url || '';
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function cssPath(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el.nodeType === 1 && el.tagName.toLowerCase() !== 'html') {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
      let nth = 1, sib = el;
      while (sib.previousElementSibling) { sib = sib.previousElementSibling; if (sib.tagName === el.tagName) nth++; }
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + nth + ')');
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  const out = [];

  // ── 1. Верхнее меню вкладок (дедуп как в medrecords/assignments-экстракторах) ──
  const seenNav = new Set();
  document.querySelectorAll('ul.mh-navigation a').forEach((a) => {
    const onclick = a.getAttribute('onclick');
    const isToggle = a.classList.contains('dropdown-toggle');
    const text = norm(a.textContent) || a.getAttribute('title') || '';
    const fnName = onclick ? (onclick.match(/(\w+)\s*\(/) || [])[1] : null;
    const key = fnName || onclick || (isToggle ? 'toggle:' + text : null);
    if (!key || seenNav.has(key) || !text) return;
    seenNav.add(key);

    let sel = null;
    if (onclick) {
      const q = onclick.replace(/"/g, '\\"');
      const cand = 'a[onclick="' + q + '"]';
      try { sel = document.querySelectorAll(cand).length ? cand : cssPath(a); } catch (e) { sel = cssPath(a); }
    } else {
      sel = cssPath(a);
    }
    out.push({
      description: 'Меню: ' + text,
      selector: sel, method: 'click', type_write: 'write', value: null, address: url,
    });
  });

  // ── 2. Панель фильтров и управляющие кнопки над гридом ──
  // Kendo DropDownList (#ddlPostFuncStructure): реальный <select>/<input> скрыт
  // (display:none), кликабельный виджет — обёртка .k-widget, в которой он лежит.
  const ddl = document.getElementById('ddlPostFuncStructure');
  if (ddl) {
    const wrap = ddl.closest('.k-widget') || ddl;
    const valEl = wrap.querySelector('.k-input');
    out.push({
      description: 'Фильтр: Отделение/должность', selector: cssPath(wrap),
      method: 'click', type_write: 'write', value: valEl ? norm(valEl.textContent) : null, address: url,
    });
  }

  const DATE_FIELDS = [
    { id: 'dtBeginDate', label: 'Фильтр: Дата (с)' },
    { id: 'dtEndDate', label: 'Фильтр: Дата (по)' },
  ];
  DATE_FIELDS.forEach(({ id, label }) => {
    const el = document.getElementById(id);
    if (!el) return;
    out.push({
      description: label, selector: '#' + id, method: 'click',
      type_write: 'write', value: el.value || null, address: url,
    });
  });

  const BTN_IDS = [
    { id: 'btnPeriodLastWeek', label: 'За последнюю неделю' },
    { id: 'btnPeriodAll', label: 'Все' },
    { id: 'btnShowDeleted', label: 'Показывать удалённые' },
  ];
  BTN_IDS.forEach(({ id, label }) => {
    const el = document.getElementById(id);
    if (!el) return;
    out.push({
      description: 'Панель записей: ' + label, selector: '#' + id,
      method: 'click', type_write: 'write', value: null, address: url,
    });
  });

  const refreshBtn = document.querySelector('[onclick="Diary.onSearchFilterChange();"]');
  if (refreshBtn) {
    out.push({
      description: 'Панель записей: Обновить', selector: 'button[onclick="Diary.onSearchFilterChange();"]',
      method: 'click', type_write: 'write', value: null, address: url,
    });
  }

  // «Добавить» — новая запись; первый аргумент onclick для новой записи всегда 0,
  // второй — id карты пациента (персональные данные), поэтому матчим по префиксу.
  const addBtn = document.querySelector('[onclick^="DiaryList.onEditClick(0"]');
  if (addBtn) {
    out.push({
      description: 'Добавить дневниковую запись', selector: 'button[onclick^="DiaryList.onEditClick(0"]',
      method: 'click', type_write: 'write', value: null, address: url,
    });
  }

  // ── 3. Грид #grdDiary: карточка на запись + действия ──
  const DATE_RE = /\d{2}\.\d{2}\.\d{4}(?:\s+\d{2}:\d{2})?/;
  const HANDLER_RE = /DiaryList\.(onViewClick|onEditClick|onCopyClick|onFilesClick|onDeleteClick)/;

  function buildSelector(a, onclick, handler, rid) {
    if (rid) {
      const quotedRid = "'" + rid + "'";
      const sel = 'a[onclick*="' + handler + '"][onclick*="' + quotedRid + '"]';
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) {}
    }
    return cssPath(a);
  }

  document.querySelectorAll('#grdDiary tr[data-id]').forEach((tr) => {
    const id = tr.getAttribute('data-id');
    if (!id) return;

    const headEl = tr.querySelector('.panel-heading .row .col-md-7, .panel-heading .row [style*="font-weight:bold"]');
    const headText = headEl ? norm(headEl.textContent) : '';
    const dateMatch = headText.match(DATE_RE);
    const date = dateMatch ? dateMatch[0] : null;

    let doctor = '';
    tr.querySelectorAll('.panel-heading span').forEach((sp) => {
      const t = norm(sp.textContent);
      if (t.startsWith('Врач:')) doctor = norm(t.slice('Врач:'.length));
    });

    tr.querySelectorAll('a[onclick]').forEach((a) => {
      const onclick = a.getAttribute('onclick') || '';
      const hm = onclick.match(HANDLER_RE);
      if (!hm) return;
      const handler = hm[1];
      const idsInOnclick = (onclick.match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1));
      const rid = idsInOnclick.length ? idsInOnclick[0] : id;
      const text = norm(a.textContent) || handler;
      const sel = buildSelector(a, onclick, handler, rid);

      const parts = [];
      if (date) parts.push('запись от ' + date);
      if (doctor) parts.push(doctor);
      const suffix = parts.length ? ' (' + parts.join(', ') + ')' : '';
      out.push({
        description: text + suffix, selector: sel,
        method: 'click', type_write: 'write', value: null, address: url,
      });
    });
  });

  return out;
}
"""


async def scan_diary_notes(html, url, values=None):
    """Сканер вкладки «Дневниковые записи» истории болезни Damumed
    (…/medicalHistory/medicalHistory, активная вкладка mh-diaries). Разбирает
    верхнее меню, панель фильтров/периодов и грид #grdDiary (карточка на
    запись), подписывая каждое действие датой записи и врачом."""
    browser = await _get_browser()
    context = await browser.new_context()
    try:
        page = await context.new_page()

        async def _abort(route):
            try:
                await route.abort()
            except Exception:
                pass

        await page.route("**/*", _abort)
        try:
            await page.set_content(html, wait_until="domcontentloaded", timeout=30000)
        except Exception:
            pass
        elements = await page.evaluate(_JS_EXTRACTOR_DIARIES, {"url": url})
        return elements or []
    finally:
        try:
            await context.close()
        except Exception:
            pass


# ───────────────────────────── РЕЕСТР ─────────────────────────────
# Damumed — SPA: у страницы истории болезни (…/medicalHistory/medicalHistory?id=...)
# URL НЕ меняется при переключении вкладок (Медицинские записи / Назначения /
# Диагнозы / Дневник / ...) — id в URL это id карты пациента, а не вкладки.
# Поэтому по одному URL нельзя понять, какая вкладка открыта: разные снимки
# одной и той же карты (разных вкладок) дают идентичный address.
#
# Надёжный признак — пункт верхнего меню с классом "mh-<tab> active": ровно
# один такой <li> в разметке в любой момент, он не зависит ни от ФИО/номера
# карты/дат (персональные данные), ни от URL. Меню продублировано дважды
# (big-screen/normal-screen), но активная вкладка в обеих копиях совпадает.
_MH_NAV_CLASSES = {"mh-navigation", "nav", "nav-pills", "big-screen"}


def _active_tab(html):
    """Повторяет 1-в-1 JS-логику, которой пользуется расширение в браузере:
        document.getElementsByClassName('mh-navigation nav nav-pills big-screen')[0]
            .getElementsByClassName('active')[0].classList[0]
    т.е. берёт ПЕРВЫЙ элемент с классами {mh-navigation, nav, nav-pills,
    big-screen} (именно big-screen копию меню — normal-screen копию
    сознательно игнорируем), внутри неё — первый потомок с классом "active",
    и возвращает его САМЫЙ ПЕРВЫЙ CSS-класс as-is (например "mh-assignments",
    "mh-medicalrecords", "mh-diaries") — без префикса "mh-" и без lower(),
    чтобы сравнение 1-в-1 совпадало с тем, что видел бы JS в браузере.
    Возвращает None, если верстка не содержит такого меню/активного пункта."""
    if not html:
        return None
    try:
        from bs4 import BeautifulSoup
    except Exception:
        return None
    try:
        soup = BeautifulSoup(html, "html.parser")
    except Exception:
        return None

    nav = None
    for tag in soup.find_all(class_=True):
        if _MH_NAV_CLASSES <= set(tag.get("class", [])):
            nav = tag
            break
    if nav is None:
        return None

    active = None
    for tag in nav.find_all(class_=True):
        if "active" in tag.get("class", []):
            active = tag
            break
    if active is None:
        return None

    classes = active.get("class", [])
    return classes[0] if classes else None


def _match_doctor(html, url):
    u = (url or "").lower()
    if "akt.dmed" not in u:
        return False
    if "/doctor" in u:
        return True
    # На проде адрес страницы врача — ".../doctor" (без .html), часто с "#"
    # или query-параметрами в конце (например ".../doctor#" или ".../doctor?x=1").
    # Раньше здесь проверялось буквальное "/doctor.html", которое никогда не
    # совпадало с реальным URL — сканер всегда проваливался в общий разбор.
    path = u.split("?", 1)[0].split("#", 1)[0]
    if path.rstrip("/").endswith("/doctor"):
        return True
    # Локальные тестовые HTML-снэпшоты могут называться "*doctor.html".
    return u.endswith("doctor.html")


def _match_medical_records(html, url):
    u = (url or "").lower()
    if "akt.dmed" not in u:
        return False
    if "medicalhistory/medicalhistory" not in u:
        return False
    return _active_tab(html) == "mh-medicalrecords"


def _match_assignments(html, url):
    u = (url or "").lower()
    if "akt.dmed" not in u:
        return False
    if "medicalhistory/medicalhistory" not in u:
        return False
  
    return _active_tab(html) == "mh-assignments"


# ───────────── Статический сканер дневниковой записи (Стационар) ─────────────
# Страница «Дневниковая запись» (…/patientDiary/editDiary?id=...&medicalHistoryID=...).
# В отличие от doctor/medical_records/assignments верстка тут ПОЛНОСТЬЮ статична:
# набор полей/кнопок не зависит от данных пациента и новых блоков появиться не
# может — поэтому Playwright не нужен, просто возвращаем заранее собранный список
# элементов, подставляя текущие значения полей формы из values (если переданы).
#
# ВАЖНО про текст дневника: он лежит в <iframe> — это ФИЗИЧЕСКИ ВНЕШНИЙ документ,
# document.outerHTML главной страницы НЕ включает его содержимое. Расширение
# должно отдельно снимать HTML именно из iframe (iframe.contentDocument
# .documentElement.outerHTML) и присылать его вместе с html главной страницы —
# сюда он приходит четвёртым (необязательным) аргументом iframe_html; пока
# расширение не обновлено под это, функция работает и без него (см. ниже).
# Внутри iframe лежит <body id="editor_0" contenteditable="...">: если
# contenteditable="true" — поле редактируемо, можно писать; если "false" —
# только чтение, поле для записи текста добавлять не нужно.

import re as _re_diary

_CONTENTEDITABLE_RE = _re_diary.compile(
    r'id=["\']editor_0["\'][^>]*contenteditable=["\'](true|false)["\']', _re_diary.IGNORECASE
)


def _diary_editor_writable(iframe_html):
    """True, если iframe#editor_0 доступен для записи (contenteditable="true").
    Если iframe_html не передан (расширение ещё не обновлено под отдельный
    снимок фрейма) — по умолчанию считаем поле редактируемым, это обычный
    случай для страницы редактирования дневниковой записи."""
    if not iframe_html:
        return True
    m = _CONTENTEDITABLE_RE.search(iframe_html)
    if not m:
        return True
    return m.group(1).lower() == "true"


# ── Текущий текст поля editor_0: HTML -> чистые строки ──────────────────────
# Само поле хранит построчную разметку (см. content.js: isLineEditorBody /
# buildEditorLinesHtml) — первая строка голым текстом, каждая следующая в своём
# <div>, пустая строка как <div><br></div>. Для сканера это нужно развернуть
# ОБРАТНО в обычный текст с переводами строк — расширению (и модели, которая
# читает scan) не нужна разметка самого редактора, только фактическое
# содержимое (см. content.js: buildEditorLinesHtml делает обратное превращение
# перед записью).
def _extract_diary_editor_text(iframe_html):
    """Достаёт из HTML-снимка документа iframe#editor_0 текущий текст дневника
    как обычные строки, разделённые "\\n", БЕЗ HTML-тегов редактора
    (<div>/<br>/форматирование). Первая строка — то, что лежит прямо в body до
    первого <div>; каждая следующая строка — текст очередного top-level <div>
    (пустой <div><br></div> даёт пустую строку). Возвращает None, если
    iframe_html не передан или body#editor_0 не нашёлся."""
    if not iframe_html:
        return None
    try:
        from bs4 import BeautifulSoup, Tag
    except Exception:
        return None

    try:
        soup = BeautifulSoup(iframe_html, "html.parser")
        body = soup.find("body", id="editor_0") or soup.find("body")
        if body is None:
            return None

        lines = []
        first_line_parts = []
        seen_div = False
        for node in body.contents:
            is_div = isinstance(node, Tag) and node.name == "div"
            text = node.get_text() if isinstance(node, Tag) else str(node)
            if is_div:
                seen_div = True
                lines.append(text)
            elif not seen_div:
                # Пропускаем чисто форматирующие пробелы/переводы строк исходного
                # HTML-снимка (отступы между тегами), пока в первую строку ещё
                # ничего не попало — иначе первая строка будет начинаться с "\n  ".
                if text.strip() == "" and not first_line_parts:
                    continue
                first_line_parts.append(text)
            elif text.strip():
                # Текст/инлайн-элемент между <div>-ами — нестандартно, но не теряем.
                lines.append(text)

        if first_line_parts:
            # Была настоящая голая первая строка перед первым <div>.
            first_line = "".join(first_line_parts).strip("\n")
            return "\n".join([first_line] + lines)
        # Ничего не было перед первым <div> — значит первая строка изначально была
        # ПУСТОЙ и её представляет сам первый <div><br></div> (см. buildEditorLinesHtml
        # в content.js: пустая первая строка тоже оборачивается в div, а не остаётся
        # голым текстом). Поэтому просто используем список div-строк как есть —
        # без искусственного добавления ещё одной пустой строки перед ним.
        return "\n".join(lines) if lines else ""
    except Exception:
        return None


async def scan_diary(html, url, values=None, iframe_html=None):
    """Сканер страницы «Дневниковая запись» (Стационар, patientDiary/editDiary).
    Верстка статична — возвращает заранее собранный список элементов вместо
    разбора DOM через Playwright."""
    values = values or {}

    def val(sel):
        return values.get(sel)

    out = []

    # ── Дата записи + показатели здоровья (числовые поля формы) ──
    out.append({"description": "Дата записи", "selector": "#dtRegDateTime",
                "method": "write", "type_write": "write", "value": val("#dtRegDateTime"), "address": url})

    fields = [
        ("#ntbTemperature", "Температура (Т˚)"),
        ("#ntbPulse", "Пульс"),
        ("#ntbTopPressure", "АД, верхнее"),
        ("#ntbBottomPressure", "АД, нижнее"),
        ("#ntbBreath", "Дыхание"),
        ("#ntbSaturation", "Сатурация"),
        ("#cmbResuscitationStatus", "Состояние (реанимационный статус)"),
        ("#ntbWeight", "Вес"),
    ]
    for sel, desc in fields:
        out.append({"description": desc, "selector": sel, "method": "write",
                    "type_write": "write", "value": val(sel), "address": url})

    # ── Быстрые ссылки над показателями ──
    out.append({"description": "Заполнить последними показателями (последние)",
                "selector": 'a[onclick="EditDiary.onLastClick();"]', "method": "click",
                "type_write": "write", "value": None, "address": url})
    out.append({"description": "Заполнить нормальными показателями (норма)",
                "selector": 'a[onclick="EditDiary.onDefaultClick();"]', "method": "click",
                "type_write": "write", "value": None, "address": url})
    out.append({"description": "Очистить показатели здоровья",
                "selector": 'a[onclick="EditDiary.onClearClick();"]', "method": "click",
                "type_write": "write", "value": None, "address": url})

    # ── Текст дневника: iframe#editor_0 (см. пояснение про внешний документ выше) ──
    if _diary_editor_writable(iframe_html):
        # Раньше тут был val("body#editor_0") — ключ, которого в values НИКОГДА не
        # было (значения приходят из collectPageContext() в content.js, а тот не
        # заглядывал внутрь iframe), поэтому value всегда было None. Теперь текст
        # достаём напрямую из iframe_html и отдаём чистыми строками, без <div>/<br>.
        out.append({"description": "Текст дневниковой записи (редактор)",
                    "selector": "#editor_0", "method": "write",
                    "type_write": "write", "value": _extract_diary_editor_text(iframe_html), "address": url})


    # ── Панель шаблонов над редактором ──
    templates = [
        ('a[onclick*="onSelectTemplate()"]', "Выбрать шаблон"),
        ('a[onclick*="onSaveTemplate()"]', "Сохранить как шаблон"),
        ('button[onclick*="onSelectTemplateVariable"]', "Добавить поле"),
        ("#btnFormField_0", "Поле формы"),
        ('a[onclick*="onSaveDocx"]', "Документ Word (*.docx)"),
    ]
    for sel, desc in templates:
        out.append({"description": desc, "selector": sel, "method": "click",
                    "type_write": "write", "value": None, "address": url})

    # ── Отменить / Сохранить ──
    out.append({"description": "Отменить", "selector": 'button[onclick="EditDiary.onCancelButtonClick();"]',
                "method": "click", "type_write": "write", "value": None, "address": url})
    out.append({"description": "Сохранить", "selector": 'button[onclick="EditDiary.onSaveButtonClick(this);"]',
                "method": "click", "type_write": "write", "value": None, "address": url})

    return out


def _match_diary(html, url):
    u = (url or "").lower()
    if "akt.dmed" not in u:
        return False
    if "patientdiary/editdiary" in u:
        return True
    # return True
    if "--editdiary.html" in u:
        return True
    return False


def _match_diary_notes(html, url):
    u = (url or "").lower()
    if "akt.dmed" not in u:
        return False
    if "medicalhistory/medicalhistory" not in u:
        return False
    return _active_tab(html) == "mh-diaries"


# ─────────── JS-экстрактор для medicalHistory/index (список историй болезни) ───────────
# Страница списка историй болезни (…/medicalHistory/index, грид #grdMedicalHistories,
# карточка на пациента строится из kendo-шаблона #tmplMedicalHistory). Для каждой
# карточки (.panel-heading) достаём ФИО пациента и все кнопки действий рядом с ним
# (Открыть/Удалить/Выдать временный доступ/Получить доступ и т.п.), формируя
# description вида "<ФИО> : <действие>".
_JS_EXTRACTOR_MEDICAL_HISTORY_LIST = r"""
(ctx) => {
  const url = ctx.url || '';
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function cssPath(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el.nodeType === 1 && el.tagName.toLowerCase() !== 'html') {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
      let nth = 1, sib = el;
      while (sib.previousElementSibling) { sib = sib.previousElementSibling; if (sib.tagName === el.tagName) nth++; }
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + nth + ')');
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

  // Приоритет идентификатора записи: id из onclick -> UUID -> data-id -> href -> route.
  function extractId(onclick, href, el) {
    if (onclick) {
      const m = onclick.match(/\(\s*'([^']+)'/);
      if (m && m[1]) return { id: m[1], kind: 'onclick' };
    }
    const hay = (onclick || '') + ' ' + (href || '');
    const um = hay.match(UUID_RE);
    if (um) return { id: um[0], kind: 'uuid' };
    const dataId = el.getAttribute('data-id') || (el.closest('[data-id]') && el.closest('[data-id]').getAttribute('data-id'));
    if (dataId) return { id: dataId, kind: 'data-id' };
    if (href) {
      const hm = href.match(/[?&]id=([^&#]+)/);
      if (hm) return { id: hm[1], kind: 'href' };
    }
    if (href && href !== '#' && href.indexOf('#') !== 0) return { id: href, kind: 'route' };
    return null;
  }

  function buildSelector(a, onclick, href, info) {
    if (onclick && info && (info.kind === 'onclick' || info.kind === 'uuid')) {
      const fnMatch = onclick.match(/(\w+)\s*\(/);
      const fn = fnMatch ? fnMatch[1] : null;
      const parts = [];
      if (fn) parts.push("[onclick*='" + fn + "']");
      parts.push("[onclick*='" + info.id + "']");
      const sel = 'a' + parts.join('');
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) {}
    }
    if (href && info && info.kind === 'href') {
      const sel = 'a[href*="id=' + info.id + '"]';
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) {}
    }
    if (href && info && info.kind === 'route') {
      const sel = 'a[href="' + href.replace(/"/g, '\\"') + '"]';
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) {}
    }
    return cssPath(a);
  }

  // ФИО пациента: data-fullname -> первый span в шапке карточки -> регэксп по ФИО.
  function getPatientName(block) {
    const df = block.querySelector('[data-fullname]');
    if (df && df.getAttribute('data-fullname')) return norm(df.getAttribute('data-fullname'));
    const nameSpan = block.querySelector('.col-md-9 .col-md-12 span');
    if (nameSpan) {
      const t = norm(nameSpan.textContent);
      if (t) return t;
    }
    const text = block.innerText || block.textContent || '';
    const UP = 'А-ЯЁӘҒҚҢӨҰҮҺІ';
    const TOKEN = '(?:[' + UP + ']{2,}|[' + UP + ']\\.)';
    const NAME_RE = new RegExp(TOKEN + '(?:\\s+' + TOKEN + ')+');
    const m = text.match(NAME_RE);
    return m ? norm(m[0]) : null;
  }

  const out = [];
  const seen = new Set();

  document.querySelectorAll('.panel-heading').forEach((block) => {
    const name = getPatientName(block);
    if (!name) return;

    block.querySelectorAll('a[onclick], a[href]').forEach((a) => {
      const text = norm(a.textContent) || norm(a.getAttribute('title')) || '';
      if (!text) return;
      const onclick = a.getAttribute('onclick');
      const href = a.getAttribute('href');
      const info = extractId(onclick, href, a);
      const sel = buildSelector(a, onclick, href, info);
      if (!sel || seen.has(sel)) return;
      seen.add(sel);

      out.push({
        description: name + ' : ' + text,
        selector: sel,
        method: 'click',
        type_write: 'write',
        value: null,
        address: url,
      });
    });
  });

  return out;
}
"""


async def scan_medical_history_list(html, url, values=None):
    """Сканер списка историй болезни Damumed (…/medicalHistory/index). Разбирает
    карточки пациентов (.panel-heading) и подписывает каждую найденную рядом
    кнопку действия ("<ФИО> : <действие>": Открыть/Удалить/Выдать временный
    доступ/Получить доступ и т.п.)."""
    browser = await _get_browser()
    context = await browser.new_context()
    try:
        page = await context.new_page()

        async def _abort(route):
            try:
                await route.abort()
            except Exception:
                pass

        await page.route("**/*", _abort)
        try:
            await page.set_content(html, wait_until="domcontentloaded", timeout=30000)
        except Exception:
            pass
        elements = await page.evaluate(_JS_EXTRACTOR_MEDICAL_HISTORY_LIST, {"url": url})
        return elements or []
    finally:
        try:
            await context.close()
        except Exception:
            pass


def _match_medical_history_list(html, url):
    u = (url or "").lower()
    if "akt.dmed" not in u:
        return False
    if "medicalhistory/index" not in u:
        return False
    return True


# ══════════════════════════════════════════════════════════════════════════
# Дополнительные вкладки истории болезни (Стационар) + страница «Медицинская
# запись». Все ҚУАНОВ-снимки в ToScaner — это ОДНА и та же SPA-страница
# medicalHistory/medicalHistory, отличаются только активной вкладкой (тот же
# приём, что для medrecords/assignments/diaries): вкладка определяется по
# _active_tab (первый CSS-класс активного пункта меню — "mh-diagnoses",
# "mh-operations", "mh-healthIndicators", "mh-documents"). Пятый снимок
# («Медицинская запись») — отдельная страница patientMedicalRecord/
# editMedicalRecord, у неё нет меню вкладок и она выбирается по URL.
#
# Чтобы не копировать в каждый экстрактор одни и те же helper'ы (cssPath /
# isHidden / построение селектора / разбор верхнего меню / блок дефектов),
# они вынесены в _JS_COMMON, а _extractor(body) склеивает общий пролог с
# телом конкретного сканера. Все тела возвращают элементы в формате /scan.
_JS_COMMON = r"""
  const url = ctx.url || '';
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const out = [];

  function cssPath(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el.nodeType === 1 && el.tagName.toLowerCase() !== 'html') {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
      let nth = 1, sib = el;
      while (sib.previousElementSibling) { sib = sib.previousElementSibling; if (sib.tagName === el.tagName) nth++; }
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + nth + ')');
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  function isHidden(el) {
    if (!el) return false;
    if (el.hidden) return true;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const style = cur.getAttribute('style') || '';
      if (cur.hasAttribute('hidden') || /display\s*:\s*none/i.test(style)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // Селектор по ПОЛНОЙ строке onclick (если она уникальна в документе). Для
  // строк грида это самый надёжный вариант: onclick содержит id записи и
  // потому уникален. Возвращает null, если onclick нет или он не уникален.
  function buildOnclickSelector(el) {
    const oc = el.getAttribute('onclick');
    if (!oc) return null;
    const q = oc.replace(/"/g, '\\"');
    const cand = el.tagName.toLowerCase() + '[onclick="' + q + '"]';
    try { if (document.querySelectorAll(cand).length === 1) return cand; } catch (e) {}
    return null;
  }

  // Общий выбор селектора для кнопки-действия: сначала полный onclick, затем —
  // если задан scope (например 'tr[data-id="X"]') — имя функции + последний
  // строковый аргумент внутри строки, иначе тот же приём глобально, иначе
  // полный CSS-путь. Аргумент матчим в кавычках ('40'), чтобы '40' не совпал
  // как подстрока внутри другого числа (напр. '14034').
  function actionSelector(a, scope) {
    const exact = buildOnclickSelector(a);
    if (exact) return exact;
    const oc = a.getAttribute('onclick') || '';
    const fnm = oc.match(/\.(\w+)\s*\(/) || oc.match(/(\w+)\s*\(/);
    const fn = fnm ? fnm[1] : null;
    const args = (oc.match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1)).filter(Boolean);
    const arg = args.length ? args[args.length - 1] : null;
    if (scope) {
      let cand = scope + ' a';
      if (fn) cand += '[onclick*="' + fn + '"]';
      if (arg) cand += "[onclick*=\"'" + arg + "'\"]";
      try { if (document.querySelectorAll(cand).length === 1) return cand; } catch (e) {}
    }
    if (fn && arg) {
      const c = 'a[onclick*="' + fn + "\"][onclick*=\"'" + arg + "'\"]";
      try { if (document.querySelectorAll(c).length === 1) return c; } catch (e) {}
    }
    return cssPath(a);
  }

  // Верхнее меню вкладок (общее для всех вкладок medicalHistory). Меню
  // продублировано (big-screen/normal-screen), у части пунктов копии зовут
  // обработчик с разными аргументами — дедуп по ИМЕНИ функции-обработчика.
  function addNav() {
    const seenNav = new Set();
    document.querySelectorAll('ul.mh-navigation a').forEach((a) => {
      const onclick = a.getAttribute('onclick');
      const isToggle = a.classList.contains('dropdown-toggle');
      const text = norm(a.textContent) || a.getAttribute('title') || '';
      const fnName = onclick ? (onclick.match(/(\w+)\s*\(/) || [])[1] : null;
      const key = fnName || onclick || (isToggle ? 'toggle:' + text : null);
      if (!key || seenNav.has(key) || !text) return;
      seenNav.add(key);
      let sel = null;
      if (onclick) {
        const q = onclick.replace(/"/g, '\\"');
        const cand = 'a[onclick="' + q + '"]';
        try { sel = document.querySelectorAll(cand).length ? cand : cssPath(a); } catch (e) { sel = cssPath(a); }
      } else {
        sel = cssPath(a);
      }
      out.push({ description: 'Меню: ' + text, selector: sel, method: 'click', type_write: 'write', value: null, address: url });
    });
  }

  // Блок сведений о дефектах над гридом (есть на всех вкладках).
  function addDefects() {
    document.querySelectorAll('#badge-defects [onclick]').forEach((el) => {
      if (el.id === 'sync-defects-btn') return;
      const text = norm(el.textContent) || 'Показать детали дефектов';
      out.push({ description: 'Дефекты: ' + text, selector: cssPath(el), method: 'click', type_write: 'write', value: null, address: url });
    });
    const syncBtn = document.getElementById('sync-defects-btn');
    if (syncBtn && !isHidden(syncBtn)) {
      out.push({ description: 'Дефекты: ' + (norm(syncBtn.textContent) || 'Обновить'), selector: '#sync-defects-btn', method: 'click', type_write: 'write', value: null, address: url });
    }
  }

  // Строки грида «<контекст записи> : <действие>». gridSel — CSS грида,
  // prefix — необязательная приставка к контексту (напр. пусто). Контекст
  // берётся из первой ячейки строки (обрезается до 90 символов).
  function addGridRows(gridSel, ctxPrefix) {
    document.querySelectorAll(gridSel + ' tr[data-id], ' + gridSel + ' tr[data-uid]').forEach((tr) => {
      const did = tr.getAttribute('data-id');
      const duid = tr.getAttribute('data-uid');
      const scope = did ? 'tr[data-id="' + did + '"]' : (duid ? 'tr[data-uid="' + duid + '"]' : null);
      const firstCell = tr.querySelector('td');
      let cx = norm(firstCell ? firstCell.textContent : tr.textContent);
      if (cx.length > 90) cx = cx.slice(0, 90) + '…';
      if (ctxPrefix) cx = cx ? ctxPrefix + cx : ctxPrefix.trim();
      const seenRow = new Set();
      tr.querySelectorAll('a[onclick]').forEach((a) => {
        const text = norm(a.textContent);
        if (!text) return;
        const oc = a.getAttribute('onclick') || '';
        if (seenRow.has(oc)) return;
        seenRow.add(oc);
        out.push({
          description: cx ? cx + ' : ' + text : text,
          selector: actionSelector(a, scope),
          method: 'click', type_write: 'write', value: null, address: url,
        });
      });
    });
  }
"""


def _extractor(body):
    """Склеивает общий пролог (_JS_COMMON) с телом конкретного сканера в
    готовую для page.evaluate стрелочную функцию (ctx) => {...; return out;}."""
    return "(ctx) => {\n" + _JS_COMMON + "\n" + body + "\n  return out;\n}\n"


async def _run_extractor(html, url, js):
    """Загружает HTML-снимок в headless-Chromium (гася все подзапросы) и
    выполняет js через page.evaluate. Возвращает список элементов /scan.
    Единый раннер для всех «вкладочных» сканеров ниже — тот же приём, что в
    scan_doctor/scan_medical_records, только без дублирования boilerplate."""
    browser = await _get_browser()
    context = await browser.new_context()
    try:
        page = await context.new_page()

        async def _abort(route):
            try:
                await route.abort()
            except Exception:
                pass

        await page.route("**/*", _abort)
        try:
            await page.set_content(html, wait_until="domcontentloaded", timeout=30000)
        except Exception:
            pass
        elements = await page.evaluate(js, {"url": url})
        return elements or []
    finally:
        try:
            await context.close()
        except Exception:
            pass


# ── Вкладка «Диагнозы» (mh-diagnoses): грид #grdDiagnoses ──
# Строка = диагноз (дата, тип, код МКБ и текст в первой ячейке), действия рядом:
# Изменить / Удалить (по uuid), «Протокол лечения» (выпадающее меню: Вводная
# часть / Диагностика / Тактика лечения / Организационные аспекты), Примечание.
_JS_DIAGNOSES = _extractor(r"""
  addNav();
  addDefects();
  document.querySelectorAll('[onclick*="Diagnosis.onAddButtonClick"]').forEach((el) => {
    if (isHidden(el)) return;
    out.push({ description: 'Диагнозы: Добавить', selector: actionSelector(el, null), method: 'click', type_write: 'write', value: null, address: url });
  });
  addGridRows('#grdDiagnoses', '');
""")


async def scan_diagnoses(html, url, values=None):
    """Сканер вкладки «Диагнозы» истории болезни (mh-diagnoses). Верхнее меню,
    кнопка «Добавить», блок дефектов и грид #grdDiagnoses (диагноз : действие)."""
    return await _run_extractor(html, url, _JS_DIAGNOSES)


# ── Вкладка «Операции» (mh-operations): грид #grdOperations ──
# Строка = операция; действия рядом с ней. Кнопка «Добавить»
# (Operation.onAddButtonClick) открывает окно создания операции.
_JS_OPERATIONS = _extractor(r"""
  addNav();
  addDefects();
  document.querySelectorAll('[onclick*="Operation.onAddButtonClick"]').forEach((el) => {
    if (isHidden(el)) return;
    out.push({ description: 'Операции: Добавить', selector: actionSelector(el, null), method: 'click', type_write: 'write', value: null, address: url });
  });
  addGridRows('#grdOperations', '');
""")


async def scan_operations(html, url, values=None):
    """Сканер вкладки «Операции» истории болезни (mh-operations). Верхнее меню,
    кнопка «Добавить», блок дефектов и грид #grdOperations (операция : действие)."""
    return await _run_extractor(html, url, _JS_OPERATIONS)


# ── Вкладка «Документы» (mh-documents): грид #grdDocuments ──
# «Добавить» — выпадающее меню типов документов (На пациента / На лицо по уходу /
# Заключение на МСЭ / Справки 036/037/038/079 и т.п.), каждый пункт — своя
# кнопка. Строки грида = выданные документы (документ, статус, срок действия).
_JS_DOCUMENTS = _extractor(r"""
  addNav();
  addDefects();
  const seenAdd = new Set();
  document.querySelectorAll('a[onclick*="Document.onEdit"]').forEach((a) => {
    const text = norm(a.textContent);
    if (!text) return;
    const oc = a.getAttribute('onclick') || '';
    if (seenAdd.has(oc)) return;
    seenAdd.add(oc);
    out.push({ description: 'Добавить документ: ' + text, selector: actionSelector(a, null), method: 'click', type_write: 'write', value: null, address: url });
  });
  addGridRows('#grdDocuments', '');
""")


async def scan_documents(html, url, values=None):
    """Сканер вкладки «Документы» истории болезни (mh-documents). Верхнее меню,
    пункты меню «Добавить» (типы документов), блок дефектов и грид #grdDocuments
    (документ : действие)."""
    return await _run_extractor(html, url, _JS_DOCUMENTS)


# ── Вкладка «Ввод показателей здоровья» (mh-healthIndicators) ──
# Здесь нет обычного грида: содержимое — матрица #healthTable (строка =
# показатель: Пульс / АД верх. / АД нижн. / Температура / ЧД / …; колонка =
# дата-время замера; ячейка = редактируемое значение с onCreateControl).
# Заголовок-строка содержит даты и ссылки «копировать показатели» на эту дату.
# Плюс панель: Настройки, Печать (Температурный лист / Показатели здоровья).
_JS_HEALTH_INDICATORS = _extractor(r"""
  addNav();
  addDefects();

  document.querySelectorAll('[onclick*="HealthIndicator.onSettings"]').forEach((el) => {
    if (isHidden(el)) return;
    out.push({ description: 'Показатели: Настройки', selector: actionSelector(el, null), method: 'click', type_write: 'write', value: null, address: url });
  });
  document.querySelectorAll('a[onclick*="onPrintTemperatureList"], a[onclick*="onPrintHealthIndicator"]').forEach((a) => {
    const text = norm(a.textContent) || 'Печать';
    out.push({ description: 'Печать: ' + text, selector: actionSelector(a, null), method: 'click', type_write: 'write', value: null, address: url });
  });

  const table = document.getElementById('healthTable');
  if (table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    // Заголовок: даты замеров по колонкам + ссылки «копировать показатели».
    const dateHeaders = [];
    if (rows.length) {
      Array.from(rows[0].children).forEach((cell, i) => {
        dateHeaders[i] = norm(cell.textContent);
        const copy = cell.querySelector('a[onclick*="onCopyHealthIndicators"]');
        if (copy && dateHeaders[i]) {
          out.push({ description: 'Копировать показатели : ' + dateHeaders[i], selector: actionSelector(copy, null), method: 'click', type_write: 'write', value: null, address: url });
        }
      });
    }
    // Тело: показатель × дата → редактируемая ячейка (method write).
    rows.slice(1).forEach((tr) => {
      const cells = Array.from(tr.children);
      if (!cells.length) return;
      const name = norm(cells[0].textContent);
      if (!name) return;
      cells.forEach((td, i) => {
        if (i === 0) return;
        if (!td.hasAttribute('onclick')) return;
        const date = dateHeaders[i] || ('колонка ' + i);
        const val = norm(td.textContent);
        out.push({ description: name + ' : ' + date, selector: cssPath(td), method: 'write', type_write: 'write', value: val || null, address: url });
      });
    });
  }
""")


async def scan_health_indicators(html, url, values=None):
    """Сканер вкладки «Ввод показателей здоровья» (mh-healthIndicators).
    Верхнее меню, панель (Настройки/Печать) и матрица #healthTable: для каждой
    редактируемой ячейки — "<показатель> : <дата-время>" c текущим значением."""
    return await _run_extractor(html, url, _JS_HEALTH_INDICATORS)


# ─────────── JS-экстрактор для страницы «Медицинская запись» ───────────
# Страница patientMedicalRecord/editMedicalRecord — редактор одной мед. записи
# (у неё НЕТ меню вкладок mh-navigation). Верстка динамическая: шапка пациента
# (специализация, сообщения, триаж, доступ, госпитализация, выписка, печать
# документов — namespace Patient.*), блок диагнозов записи
# (EditMedicalRecordDiagnosis.*), поля записи (EditMedicalRecordFieldData.* —
# Жалобы/Итоговая запись и т.п.), сама запись (EditMedicalRecord.* — добавить
# соисполнителя, копировать, Сохранить и закрыть) и редакторы шаблонов
# (MedicalRecordsEditor[...]). Собираем ВСЕ видимые onclick-действия, дедуп по
# строке onclick, снабжая каждое приставкой-разделом по namespace обработчика.
# Панель самого расширения (#aqbobek-root, id вида "aq-*") исключаем.
_JS_MEDICAL_RECORD = _extractor(r"""
  const seenMR = new Set();
  document.querySelectorAll('a[onclick], button[onclick]').forEach((el) => {
    if (el.closest('#aqbobek-root')) return;
    if ((el.id || '').indexOf('aq-') === 0) return;
    if (isHidden(el)) return;
    const oc = el.getAttribute('onclick') || '';
    const text = norm(el.textContent) || norm(el.getAttribute('title'));
    if (!text) return;
    if (seenMR.has(oc)) return;
    seenMR.add(oc);
    let pre = '';
    if (/Patient\./.test(oc)) pre = 'Пациент: ';
    else if (/EditMedicalRecordDiagnosis/.test(oc)) pre = 'Диагноз: ';
    else if (/EditMedicalRecordFieldData/.test(oc)) pre = 'Поле записи: ';
    else if (/EditMedicalRecord\b|EditMedicalRecord\./.test(oc)) pre = 'Мед. запись: ';
    else if (/MedicalRecordsEditor/.test(oc)) pre = 'Редактор: ';
    out.push({ description: pre + text, selector: actionSelector(el, null), method: 'click', type_write: 'write', value: null, address: url });
  });
""")


async def scan_medical_record(html, url, values=None):
    """Сканер страницы «Медицинская запись» (patientMedicalRecord/editMedicalRecord).
    Собирает все динамические onclick-действия редактора мед. записи (шапка
    пациента, диагнозы, поля записи, сохранение, редакторы шаблонов),
    группируя их приставкой-разделом."""
    return await _run_extractor(html, url, _JS_MEDICAL_RECORD)


def _match_diagnoses(html, url):
    u = (url or "").lower()
    if "akt.dmed" not in u:
        return False
    if "medicalhistory/medicalhistory" not in u:
        return False
    return _active_tab(html) == "mh-diagnoses"


def _match_operations(html, url):
    u = (url or "").lower()
    if "akt.dmed" not in u:
        return False
    if "medicalhistory/medicalhistory" not in u:
        return False
    return _active_tab(html) == "mh-operations"


def _match_health_indicators(html, url):
    u = (url or "").lower()
    if "akt.dmed" not in u:
        return False
    if "medicalhistory/medicalhistory" not in u:
        return False
    # _active_tab возвращает первый класс as-is (без lower()) — здесь он
    # в camelCase, поэтому сравниваем именно "mh-healthIndicators".
    return _active_tab(html) == "mh-healthIndicators"


def _match_documents(html, url):
    u = (url or "").lower()
    if "akt.dmed" not in u:
        return False
    if "medicalhistory/medicalhistory" not in u:
        return False
    return _active_tab(html) == "mh-documents"


def _match_medical_record(html, url):
    u = (url or "").lower()
    if "akt.dmed" not in u:
        return False
    return "patientmedicalrecord/editmedicalrecord" in u


REGISTRY = [
    {"name": "doctor", "match": _match_doctor, "fn": scan_doctor},
    {"name": "medical_records", "match": _match_medical_records, "fn": scan_medical_records},
    {"name": "assignments", "match": _match_assignments, "fn": scan_assignments},
    {"name": "diagnoses", "match": _match_diagnoses, "fn": scan_diagnoses},
    {"name": "operations", "match": _match_operations, "fn": scan_operations},
    {"name": "health_indicators", "match": _match_health_indicators, "fn": scan_health_indicators},
    {"name": "documents", "match": _match_documents, "fn": scan_documents},
    {"name": "diary", "match": _match_diary, "fn": scan_diary},
    {"name": "diary_notes", "match": _match_diary_notes, "fn": scan_diary_notes},
    {"name": "medical_record", "match": _match_medical_record, "fn": scan_medical_record},
    {"name": "medical_history_list", "match": _match_medical_history_list, "fn": scan_medical_history_list},
]


def pick(html, url):
    """Возвращает запись специализированного сканера для (html, url) или None."""
    for entry in REGISTRY:
        try:
            if entry["match"](html, url):
                return entry
        except Exception:
            pass
    return None
