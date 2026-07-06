@echo off
setlocal enableextensions
title Suerte - local server (doctor's machine)
cd /d "%~dp0"

echo ============================================================
echo   Suerte - local server bootstrap
echo   First run installs Python, Tesseract and dependencies.
echo   Internet required. Python and the server need NO admin;
echo   installing Tesseract/OCR asks for admin once (a UAC prompt).
echo ============================================================
echo.

REM ==== Versions / URLs (bump here when new releases appear) ====
set "PY_VER=3.12.10"
set "PY_URL=https://www.python.org/ftp/python/%PY_VER%/python-%PY_VER%-amd64.exe"
set "TESS_URL=https://github.com/UB-Mannheim/tesseract/releases/download/v5.4.0.20240606/tesseract-ocr-w64-setup-5.4.0.20240606.exe"
set "TESSDATA_BASE=https://github.com/tesseract-ocr/tessdata_best/raw/main"

REM ==== curl ships with Windows 10 1803+ / 11 ====
where curl >nul 2>nul
if errorlevel 1 (
  echo [ERROR] curl.exe not found. Update Windows 10/11 or install curl manually.
  goto :fail
)

call :ensure_python || goto :fail
call :ensure_tesseract
call :ensure_venv || goto :fail
call :ensure_config

REM ==== Pass Tesseract path to the server via env var (config.json not touched) ====
if defined TESSDIR if exist "%TESSDIR%\tesseract.exe" set "TESSERACT_CMD=%TESSDIR%\tesseract.exe"

echo.
echo [Suerte] Starting local server at http://127.0.0.1:8000
echo          (to stop: close this window or press Ctrl+C)
echo.
"venv\Scripts\python.exe" user_server.py

echo.
echo [Suerte] Server stopped.
pause
exit /b 0


REM ===================================================================
REM  Python: find a working one (ignore the Microsoft Store stub) or install
REM ===================================================================
:ensure_python
set "PYEXE="
REM 1) py launcher (present only if a real Python is installed)
py -3 -c "import sys" >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%p in ('py -3 -c "import sys;print(sys.executable)"') do set "PYEXE=%%p"
)
REM 2) python on PATH - only if it is NOT the Microsoft Store stub
if not defined PYEXE (
  python -c "import sys" >nul 2>nul
  if not errorlevel 1 (
    for /f "delims=" %%p in ('python -c "import sys;print(sys.executable)"') do set "PYEXE=%%p"
  )
)
if defined PYEXE if exist "%PYEXE%" (
  echo [Python] Found: "%PYEXE%"
  goto :eof
)

echo [Python] Not found. Downloading Python %PY_VER% installer ...
set "PYINST=%TEMP%\python-%PY_VER%-amd64.exe"
curl -L --fail --retry 3 --progress-bar -o "%PYINST%" "%PY_URL%"
if errorlevel 1 (
  echo [ERROR] Failed to download Python. Check your internet connection.
  exit /b 1
)
echo [Python] Installing (per-user, silent) ...
"%PYINST%" /quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 Include_pip=1
REM Locate the freshly installed python.exe (session PATH is not refreshed yet)
set "PYEXE="
for /d %%d in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
  if exist "%%d\python.exe" set "PYEXE=%%d\python.exe"
)
if not defined PYEXE (
  echo [ERROR] Python installed but python.exe was not found.
  exit /b 1
)
echo [Python] Installed: "%PYEXE%"
goto :eof


REM ===================================================================
REM  Tesseract-OCR (per-machine) + kaz/rus/eng language data.
REM  The official installer needs admin, so this step asks for elevation
REM  ONCE (a single UAC prompt). Language data is pre-downloaded first
REM  without admin, then a small helper installs + copies it elevated.
REM  Non-critical: the server still runs without OCR.
REM ===================================================================
:ensure_tesseract
set "SYSTESS=%ProgramFiles%\Tesseract-OCR"

REM Already fully usable? (tesseract + kaz + rus present) -> nothing to do
if exist "%SYSTESS%\tesseract.exe" if exist "%SYSTESS%\tessdata\kaz.traineddata" if exist "%SYSTESS%\tessdata\rus.traineddata" (
  set "TESSDIR=%SYSTESS%"
  echo [Tesseract] Already installed with kaz/rus.
  goto :eof
)

REM 1) Pre-download language data to TEMP (no admin needed)
echo [Tesseract] Downloading language data (kaz/rus/eng) ...
call :dl_lang kaz
call :dl_lang rus
call :dl_lang eng

REM 2) Download the installer only if Tesseract is not installed yet
if not exist "%SYSTESS%\tesseract.exe" (
  echo [Tesseract] Downloading installer ...
  curl -L --fail --retry 3 --progress-bar -o "%TEMP%\tesseract-setup.exe" "%TESS_URL%"
)
if not exist "%SYSTESS%\tesseract.exe" if not exist "%TEMP%\tesseract-setup.exe" (
  echo [WARN] Failed to download Tesseract. Server will run without OCR.
  goto :eof
)

REM 3) Build a helper script to run elevated: install + copy language files
set "TESSHELP=%TEMP%\suerte_tess_admin.cmd"
> "%TESSHELP%" echo @echo off
if not exist "%SYSTESS%\tesseract.exe" >>"%TESSHELP%" echo "%TEMP%\tesseract-setup.exe" /S
>>"%TESSHELP%" echo if not exist "%SYSTESS%\tessdata" mkdir "%SYSTESS%\tessdata"
if exist "%TEMP%\kaz.traineddata" >>"%TESSHELP%" echo copy /y "%TEMP%\kaz.traineddata" "%SYSTESS%\tessdata" ^>nul
if exist "%TEMP%\rus.traineddata" >>"%TESSHELP%" echo copy /y "%TEMP%\rus.traineddata" "%SYSTESS%\tessdata" ^>nul
if exist "%TEMP%\eng.traineddata" >>"%TESSHELP%" echo copy /y "%TEMP%\eng.traineddata" "%SYSTESS%\tessdata" ^>nul

REM 4) Run the helper elevated (one UAC prompt)
echo [Tesseract] Requesting administrator rights (UAC) to install Tesseract ...
echo             Please click "Yes" in the Windows prompt.
powershell -NoProfile -Command "try { Start-Process -FilePath '%TESSHELP%' -Verb RunAs -Wait } catch { exit 1 }"
if not exist "%SYSTESS%\tesseract.exe" (
  echo [WARN] Tesseract was not installed (UAC declined or install failed). Server will run without OCR.
  goto :eof
)
set "TESSDIR=%SYSTESS%"
echo [Tesseract] Ready: "%SYSTESS%" (kaz/rus/eng)
goto :eof

:dl_lang
set "LNG=%~1"
if exist "%TEMP%\%LNG%.traineddata" (
  echo [Tesseract] %LNG% data cached.
  goto :eof
)
curl -L --fail --retry 3 -sS -o "%TEMP%\%LNG%.traineddata" "%TESSDATA_BASE%/%LNG%.traineddata"
if errorlevel 1 echo [WARN] Failed to download %LNG%.traineddata.
goto :eof


REM ===================================================================
REM  Virtual environment + dependencies (first run only)
REM ===================================================================
:ensure_venv
if exist "venv\Scripts\python.exe" (
  echo [venv] Environment already present.
  goto :eof
)
echo [venv] Creating virtual environment ...
"%PYEXE%" -m venv venv
if not exist "venv\Scripts\python.exe" (
  echo [ERROR] Failed to create venv.
  exit /b 1
)
echo [venv] Installing dependencies (this may take a couple of minutes) ...
"venv\Scripts\python.exe" -m pip install --upgrade pip
"venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo [ERROR] Failed to install dependencies from requirements.txt.
  exit /b 1
)
goto :eof


REM ===================================================================
REM  config.json - copy from the example if missing
REM ===================================================================
:ensure_config
if not exist "config.json" (
  echo [config] config.json not found - copying from example.
  copy /y "config.example.json" "config.json" >nul
)
goto :eof


:fail
echo.
echo [Suerte] Setup aborted due to an error. Read the message above.
pause
exit /b 1
