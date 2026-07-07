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


# ───────────────────────────── РЕЕСТР ─────────────────────────────
def _match_doctor(url):
    u = (url or "").lower()
    return  "/doctor.html" in u
    # return "dmed.kz" in u and "/doctor" in u


REGISTRY = [
    {"name": "doctor", "match": _match_doctor, "fn": scan_doctor},
]


def pick(url):
    """Возвращает запись специализированного сканера для URL или None."""
    for entry in REGISTRY:
        try:
            if entry["match"](url):
                return entry
        except Exception:
            pass
    return None
