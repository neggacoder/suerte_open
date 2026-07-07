"""
Suerte / Aqbobek — ЛОКАЛЬНЫЙ сервер (машина врача, Windows).
──────────────────────────────────────────────────────────────────────────
Работает рядом с браузером врача. Отвечает за то, что физически привязано к
этой машине:
    POST /ping        — проверка живости
    POST /transcribe  — аудио -> текст (Whisper локальный или OpenAI)
    POST /scan        — весь HTML страницы -> список элементов-кандидатов (JSON)
    POST /macro       — набрать текст / нажать клавиши через pyAutoGui (writeByClick)
    POST /ocr         — PDF / DOCX / картинка -> текст (сначала текстом, потом tesseract)

Тяжёлые зависимости (whisper, pyautogui, tesseract, fitz) импортируются лениво,
чтобы сервер поднимался даже если что-то из них не установлено — так можно
тестировать /scan без Whisper и т.д.

Запуск:   python user_server.py       (или start_local.bat)
Порт по умолчанию 8000 — совпадает с настройками расширения.
"""

import io
import os
import json
import base64
import tempfile
import traceback

from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn

# ───────────────────────────── КОНФИГ ─────────────────────────────
HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")

DEFAULT_CONFIG = {
    "host": "127.0.0.1",
    "port": 8000,
    "provider": "qwen",                 # запасной, если расширение не прислало
    "openai_api_key": "",               # для provider=openai (Whisper + OCR-помощь)
    "whisper_model": "small",           # faster-whisper: tiny|base|small|medium|large-v3
    "whisper_language": "ru",           # ru|kk|en|None(авто)
    "whisper_device": "cpu",            # cpu|cuda
    "whisper_compute_type": "int8",     # int8|int8_float16|float16|float32
    "ocr_langs": "kaz+rus+eng",
    "tesseract_cmd": "",                # напр. C:\\Program Files\\Tesseract-OCR\\tesseract.exe
    "macro_paste": True                 # True: вставка из буфера (unicode); False: посимвольный ввод
}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg.update(json.load(f))
        except Exception as e:
            print("[config] ошибка чтения config.json:", e)
    # env перекрывает
    if os.environ.get("OPENAI_API_KEY"):
        cfg["openai_api_key"] = os.environ["OPENAI_API_KEY"]
    if os.environ.get("TESSERACT_CMD"):
        cfg["tesseract_cmd"] = os.environ["TESSERACT_CMD"]
    return cfg


CONFIG = load_config()

app = FastAPI(title="Suerte Local Server", version="11.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # локальный сервер — только на этой машине
    allow_methods=["*"],
    allow_headers=["*"],
)

# ───────────────────────── ЛЕНИВЫЕ СИНГЛТОНЫ ─────────────────────────
_whisper_model = None


def get_whisper():
    """Локальная модель faster-whisper (кешируется)."""
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel(
            CONFIG["whisper_model"],
            device=CONFIG["whisper_device"],
            compute_type=CONFIG["whisper_compute_type"],
        )
    return _whisper_model


# ═══════════════════════════════ /ping ═══════════════════════════════
@app.post("/ping")
@app.get("/ping")
async def ping():
    return {"ok": True, "service": "suerte-local", "version": "11.0.0"}


# ═════════════════════════════ /transcribe ═══════════════════════════
@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), provider: str = Form(None)):
    provider = (provider or CONFIG["provider"]).lower()
    data = await file.read()
    suffix = os.path.splitext(file.filename or "audio.webm")[1] or ".webm"

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        tmp.write(data)
        tmp.close()
        if provider == "openai":
            text = _transcribe_openai(tmp.name)
        else:
            text = _transcribe_local(tmp.name)
        return {"text": text.strip(), "provider": provider}
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"detail": f"transcribe: {e}"})
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def _transcribe_local(path):
    model = get_whisper()
    lang = CONFIG.get("whisper_language") or None
    segments, _info = model.transcribe(path, language=lang, vad_filter=True)
    return " ".join(seg.text for seg in segments)


def _transcribe_openai(path):
    key = CONFIG.get("openai_api_key")
    if not key:
        raise RuntimeError("openai_api_key не задан (config.json или env OPENAI_API_KEY)")
    from openai import OpenAI
    client = OpenAI(api_key=key)
    with open(path, "rb") as f:
        tr = client.audio.transcriptions.create(model="whisper-1", file=f)
    return tr.text


# ═══════════════════════════════ /scan ═══════════════════════════════
# «Шаблонный» сканер: разбирает HTML и возвращает список элементов-кандидатов
# в формате действий главного сервера + текущее value. Особые эвристики под
# конкретные сайты добавляются в SPECIAL_RULES (место оставлено намеренно).

SPECIAL_RULES = [
    # Пример правила (заполняется под конкретный сайт Damumed):
    # {"match": "akt.dmed.kz", "selector": "#patient-search", "description": "Поиск пациента",
    #  "method": "write", "type_write": "write"},
]


@app.post("/scan")
async def scan(request: Request):
    body = await request.json()
    html = body.get("html", "")
    values = body.get("values", {}) or {}
    url = body.get("url", "")
    try:
        elements = _scan_html(html, values, url)
        # спец-правила для этого url
        for rule in SPECIAL_RULES:
            if rule.get("match") and rule["match"] in url:
                elements.insert(0, {
                    "description": rule.get("description", ""),
                    "selector": rule.get("selector", ""),
                    "method": rule.get("method", "click"),
                    "type_write": rule.get("type_write", "write"),
                    "value": values.get(rule.get("selector", ""), None),
                    "address": url,
                })
        return {"url": url, "count": len(elements), "elements": elements}
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"detail": f"scan: {e}"})


def _clean_text(s):
    """Схлопывает пробелы/переносы строк (в т.ч. из вложенных <span>/<svg>) в одну строку."""
    import re
    return re.sub(r"\s+", " ", (s or "")).strip()


def _scan_html(html, values, url):
    import copy
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "html.parser")
    out = []
    seen = set()

    def css_path(tag):
        if tag.get("id"):
            return "#" + tag.get("id")
        parts = []
        cur = tag
        depth = 0
        while cur is not None and getattr(cur, "name", None) and depth < 6:
            name = cur.name
            parent = cur.parent
            if parent and getattr(parent, "find_all", None):
                sibs = [c for c in parent.find_all(name, recursive=False)]
                if len(sibs) > 1:
                    idx = sibs.index(cur) + 1
                    name += f":nth-of-type({idx})"
            parts.insert(0, name)
            if cur.get("id"):
                parts[0] = "#" + cur.get("id")
                break
            cur = parent
            depth += 1
        return " > ".join(parts)

    def onclick_selector(tag):
        """Для кликабельных нон-семантических тегов (div/li/span с onclick, как
        nav-item в сайдбаре) пробуем селектор по точному значению onclick — он
        читаемее и устойчивее к перестановке соседних элементов, чем nth-of-type.
        Используем, только если он однозначно указывает на один элемент."""
        onclick = tag.get("onclick")
        if not onclick:
            return None
        # onclick обычно в одинарных кавычках ('appointments') — оборачиваем
        # селектор в двойные; если внутри всё же встретятся двойные (редко),
        # используем одинарные и экранируем их внутри значения.
        if '"' in onclick and "'" not in onclick:
            quote = "'"
            value = onclick.replace("'", "\\'")
        else:
            quote = '"'
            value = onclick.replace('"', '\\"')
        try:
            sel = f'{tag.name}[onclick={quote}{value}{quote}]'
            if len(soup.select(sel)) == 1:
                return sel
        except Exception:
            pass
        return None

    def build_selector(tag):
        if tag.get("id"):
            return "#" + tag.get("id")
        return onclick_selector(tag) or css_path(tag)

    # [onclick] — ловит кликабельные div/li/span и т.п. (например, пункты меню
    # вида <div class="nav-item" onclick="showTab('appointments')">...</div>),
    # которые не входят ни в одну из семантических категорий выше.
    selectors = "input, textarea, select, button, a[href], [role=button], [contenteditable=true], [onclick]"
    for tag in soup.select(selectors):
        name = tag.name
        typ = name
        if name == "input":
            typ = tag.get("type", "text")

        # метод и способ ввода
        if name in ("button", "a") or tag.get("role") == "button" or tag.has_attr("onclick"):
            method, type_write = "click", "write"
        elif tag.get("contenteditable") == "true":
            method, type_write = "write", "writeByClick"   # div, слушающий клавиатуру
        elif name == "select":
            method, type_write = "click", "write"
        else:
            method, type_write = "write", "write"

        sel = build_selector(tag)
        if not sel or sel in seen:
            continue
        seen.add(sel)

        # Текст кнопки без служебных «бейджей»-счётчиков (например, <span
        # class="nav-badge">3</span>) — их выносим в описание отдельно, чтобы
        # не путать текст пункта меню со счётчиком уведомлений/задач.
        badge_text = None
        text_source = tag
        badge_el = tag.find(class_=lambda c: c and "badge" in c)
        if badge_el is not None:
            text_source = copy.copy(tag)
            badge_el2 = text_source.find(class_=lambda c: c and "badge" in c)
            if badge_el2 is not None:
                badge_text = _clean_text(badge_el2.get_text())
                badge_el2.decompose()

        label = (
            tag.get("placeholder")
            or tag.get("aria-label")
            or tag.get("title")
            or tag.get("name")
            or _clean_text(text_source.get_text())
        )
        label = (label or name)[:80]
        if badge_text:
            label = f"{label} ({badge_text})"
        value = values.get(sel)
        if value is None and tag.has_attr("value"):
            value = tag.get("value")

        out.append({
            "description": label,
            "selector": sel,
            "method": method,
            "type_write": type_write,
            "value": value,
            "address": url,
        })
    return out


# ═══════════════════════════ /scan-dynamic ═══════════════════════════
# Тот же вход и тот же формат ответа, что и у /scan, но для «известных»
# страниц (например, doctor Damumed) подключается специализированный сканер
# из first_scan.py: он разбирает блоки по ФИО и пишет в description, чья это
# кнопка, с уникальным селектором. Сканер выбирается по URL (first_scan.pick).
# Если спец-сканер не подошёл или упал (нет Playwright/Chromium, таймаут) —
# деградируем на общий _scan_html, то есть ведём себя ровно как /scan.
#
# first_scan импортируется лениво (и только модуль — Playwright он тянет ещё
# позже, внутри самого сканера), чтобы сервер поднимался даже без Playwright.

def _load_first_scan():
    """Импорт first_scan независимо от способа запуска сервера:
    `python user_server.py` (cwd=user_server/) или
    `uvicorn user_server.user_server:app` (cwd=корень репо). HERE — папка с
    этим файлом, там же лежит first_scan.py, поэтому кладём её в sys.path."""
    import sys
    import importlib
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    return importlib.import_module("first_scan")


@app.post("/scan-dynamic")
async def scan_dynamic(request: Request):
    body = await request.json()
    html = body.get("html", "")
    values = body.get("values", {}) or {}
    url = body.get("url", "")

    scanner = None
    warning = None
    try:
        # выбираем специализированный сканер по URL
        entry = None
        try:
            first_scan = _load_first_scan()
            entry = first_scan.pick(url)
        except Exception as e:
            traceback.print_exc()
            warning = f"first_scan недоступен, общий разбор: {e}"

        if entry is not None:
            try:
                elements = await entry["fn"](html, url, values)
                scanner = entry.get("name")
            except Exception as e:
                # Playwright/Chromium не установлен, таймаут set_content и т.п.
                traceback.print_exc()
                warning = (f"спец-сканер '{entry.get('name')}' упал, "
                           f"откат на общий разбор: {e}")
                elements = _scan_html(html, values, url)
        else:
            # неизвестная страница — ведём себя как /scan
            elements = _scan_html(html, values, url)

        # спец-правила из /scan применяем и здесь — единый вход/выход с /scan
        for rule in SPECIAL_RULES:
            if rule.get("match") and rule["match"] in url:
                elements.insert(0, {
                    "description": rule.get("description", ""),
                    "selector": rule.get("selector", ""),
                    "method": rule.get("method", "click"),
                    "type_write": rule.get("type_write", "write"),
                    "value": values.get(rule.get("selector", ""), None),
                    "address": url,
                })

        resp = {"url": url, "count": len(elements), "elements": elements,
                "scanner": scanner}
        if warning:
            resp["warning"] = warning
        return resp
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"detail": f"scan-dynamic: {e}"})


# ═══════════════════════════════ /macro ══════════════════════════════
# Для type_write=writeByClick: расширение уже сфокусировало элемент кликом,
# сюда приходит value — набираем его на клавиатуре. Для unicode (рус/каз)
# используем вставку из буфера (Ctrl+V). Опционально keys для спец-клавиш.

@app.post("/macro")
async def macro(request: Request):
    body = await request.json()
    value = body.get("value", "")
    keys = body.get("keys")   # напр. "enter" | "tab" | ["ctrl","s"]
    try:
        import pyautogui
        pyautogui.PAUSE = 0.02
        if keys:
            if isinstance(keys, list):
                pyautogui.hotkey(*keys)
            else:
                pyautogui.press(str(keys))
            return {"ok": True, "action": "keys", "keys": keys}

        if CONFIG.get("macro_paste", True):
            import pyperclip
            prev = None
            try:
                prev = pyperclip.paste()
            except Exception:
                pass
            pyperclip.copy(value)
            pyautogui.hotkey("ctrl", "v")
            # вернуть прежний буфер не обязательно; оставим значение
        else:
            pyautogui.typewrite(value, interval=0.01)
        return {"ok": True, "action": "type", "len": len(value)}
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"detail": f"macro: {e}"})


# ═══════════════════════════════ /ocr ════════════════════════════════
@app.post("/ocr")
async def ocr(file: UploadFile = File(...), langs: str = Form(None)):
    langs = langs or CONFIG["ocr_langs"]
    data = await file.read()
    name = (file.filename or "document").lower()
    try:
        if name.endswith(".pdf"):
            text = _ocr_pdf(data, langs)
        elif name.endswith(".docx"):
            text = _ocr_docx(data)
        else:
            text = _ocr_image(data, langs)
        return {"text": (text or "").strip(), "file": file.filename}
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"detail": f"ocr: {e}"})


def _tess_configure():
    if CONFIG.get("tesseract_cmd"):
        import pytesseract
        pytesseract.pytesseract.tesseract_cmd = CONFIG["tesseract_cmd"]


def _ocr_image(data, langs):
    _tess_configure()
    import pytesseract
    from PIL import Image
    img = Image.open(io.BytesIO(data))
    return pytesseract.image_to_string(img, lang=langs)


def _ocr_docx(data):
    import docx  # python-docx
    doc = docx.Document(io.BytesIO(data))
    return "\n".join(p.text for p in doc.paragraphs)


def _ocr_pdf(data, langs):
    """Сначала пытаемся достать текстовый слой; если пусто — рендерим страницы
    в картинки и прогоняем через tesseract."""
    import fitz  # PyMuPDF
    doc = fitz.open(stream=data, filetype="pdf")
    text_parts = []
    for page in doc:
        text_parts.append(page.get_text())
    joined = "\n".join(text_parts).strip()
    if len(joined) >= 20:
        return joined

    # текстового слоя нет — OCR по изображениям
    _tess_configure()
    import pytesseract
    from PIL import Image
    ocr_parts = []
    for page in doc:
        pix = page.get_pixmap(dpi=200)
        img = Image.open(io.BytesIO(pix.tobytes("png")))
        ocr_parts.append(pytesseract.image_to_string(img, lang=langs))
    return "\n".join(ocr_parts)


# ═══════════════════════════════ MAIN ════════════════════════════════
if __name__ == "__main__":
    print(f"Suerte local server → http://{CONFIG['host']}:{CONFIG['port']}")
    print(f"  provider={CONFIG['provider']}  whisper={CONFIG['whisper_model']}  ocr={CONFIG['ocr_langs']}")
    uvicorn.run(app, host=CONFIG["host"], port=int(CONFIG["port"]), log_level="info")
