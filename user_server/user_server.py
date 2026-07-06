"""
Suerte / Aqbobek — ЛОКАЛЬНЫЙ сервер (машина врача, Windows).
──────────────────────────────────────────────────────────────────────────
Работает рядом с браузером врача. Отвечает за то, что физически привязано к
этой машине:
    POST /ping        — проверка живости
    POST /scan        — весь HTML страницы -> список элементов-кандидатов (JSON)
    POST /macro       — набрать текст / нажать клавиши через pyAutoGui (writeByClick)
    POST /ocr         — PDF / DOCX / картинка -> текст (сначала текстом, потом tesseract)

Whisper (транскрипция голоса) вынесен на ГЛАВНЫЙ сервер (server.py /transcribe) —
здесь его больше нет.

Тяжёлые зависимости (pyautogui, tesseract, fitz) импортируются лениво,
чтобы сервер поднимался даже если что-то из них не установлено — так можно
тестировать /scan без остальных пакетов.

Запуск:   python user_server.py       (или start_local.bat)
Порт по умолчанию 8000 — совпадает с настройками расширения.
"""

import io
import os
import json
import traceback

from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn

# ───────────────────────────── КОНФИГ ─────────────────────────────
HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")

# .env с токенами/путями — грузим ДО чтения конфига (python-dotenv опционален).
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(HERE, ".env"))                    # рядом с сервером
    load_dotenv(os.path.join(os.path.dirname(HERE), ".env"))   # общий .env в корне проекта
except Exception:
    pass

DEFAULT_CONFIG = {
    "host": "127.0.0.1",
    "port": 8000,
    "provider": "qwen",                 # запасной, если расширение не прислало
    "ocr_langs": "kaz+rus+eng",
    "tesseract_cmd": "",                # напр. C:\\Program Files\\Tesseract-OCR\\tesseract.exe
    "macro_paste": True,                # True: вставка из буфера (unicode); False: посимвольный ввод
    # CORS: пускаем только расширение (chrome-extension://...), не веб-страницы.
    "allowed_origin_regex": r"^chrome-extension://.*$",
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
    if os.environ.get("TESSERACT_CMD"):
        cfg["tesseract_cmd"] = os.environ["TESSERACT_CMD"]
    return cfg


CONFIG = load_config()

app = FastAPI(title="Suerte Local Server", version="11.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=CONFIG["allowed_origin_regex"],   # только расширение, не сайты
    allow_methods=["*"],
    allow_headers=["*"],
)


# ───────────────────────────── ЗАЩИТА ─────────────────────────────
# /scan,/macro,/ocr защищены CORS (только chrome-extension://...) и привязкой
# сервера к 127.0.0.1 (host в config.json). Отдельный токен не используется.

# ═══════════════════════════════ /ping ═══════════════════════════════
@app.post("/ping")
@app.get("/ping")
async def ping():
    return {"ok": True, "service": "suerte-local", "version": "11.0.0"}


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


def _scan_html(html, values, url):
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

    selectors = "input, textarea, select, button, a[href], [role=button], [contenteditable=true]"
    for tag in soup.select(selectors):
        name = tag.name
        typ = name
        if name == "input":
            typ = tag.get("type", "text")

        # метод и способ ввода
        if name in ("button", "a") or tag.get("role") == "button":
            method, type_write = "click", "write"
        elif tag.get("contenteditable") == "true":
            method, type_write = "write", "writeByClick"   # div, слушающий клавиатуру
        elif name == "select":
            method, type_write = "click", "write"
        else:
            method, type_write = "write", "write"

        sel = css_path(tag)
        if not sel or sel in seen:
            continue
        seen.add(sel)

        label = (
            tag.get("placeholder")
            or tag.get("aria-label")
            or tag.get("title")
            or tag.get("name")
            or (tag.get_text() or "").strip()
        )
        label = (label or name)[:80]
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
    print(f"  provider={CONFIG['provider']}  ocr={CONFIG['ocr_langs']}")
    print("  " + "─" * 58)
    print("  Защита: CORS только для расширения + привязка к 127.0.0.1.")
    print("  " + "─" * 58)
    uvicorn.run(app, host=CONFIG["host"], port=int(CONFIG["port"]), log_level="info")
