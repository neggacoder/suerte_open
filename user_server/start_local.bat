@echo off
REM Suerte — запуск локального сервера на машине врача (Windows)
cd /d "%~dp0"

REM Первый запуск: создать venv и поставить зависимости
if not exist "venv\Scripts\python.exe" (
  echo [Suerte] Создаю виртуальное окружение...
  python -m venv venv
  call "venv\Scripts\activate.bat"
  python -m pip install --upgrade pip
  python -m pip install -r requirements.txt
  echo [Suerte] Устанавливаю браузер Playwright для /scan-dynamic...
  python -m playwright install chromium
  if errorlevel 1 echo [Suerte] Playwright Chromium не установился — /scan-dynamic откатится на общий разбор.
) else (
  call "venv\Scripts\activate.bat"
)

if not exist "config.json" (
  echo [Suerte] config.json не найден — копирую из примера
  copy config.example.json config.json
)

echo [Suerte] Запуск локального сервера на http://127.0.0.1:8000
python user_server.py
pause
