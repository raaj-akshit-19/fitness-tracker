@echo off
rem Starts the Fitness Tracker on this computer and opens it in the browser.
rem Everything is found relative to this file, so the project folder can be
rem moved or renamed. The server only listens on 127.0.0.1.
setlocal
title Fitness Tracker
cd /d "%~dp0"
set "PYTHONDONTWRITEBYTECODE=1"
set "CODE=1"

set "VENV_PY=%~dp0.venv\Scripts\python.exe"
if not exist "%VENV_PY%" goto no_venv

"%VENV_PY%" -c "import sys" >nul 2>nul
if errorlevel 1 goto broken_venv

"%VENV_PY%" -m backend.launch %*
set "CODE=%errorlevel%"
goto finished

:no_venv
echo The project's own Python environment (.venv) was not found.
echo Trying the Python installed on this computer instead.
echo.
where py >nul 2>nul
if not errorlevel 1 goto use_py
where python >nul 2>nul
if not errorlevel 1 goto use_python
echo Python was not found on this computer.
echo Install Python 3, then in this folder run:
echo   python -m venv .venv
echo   .venv\Scripts\python -m pip install -r requirements.txt
goto failed

:use_py
py -3 -m backend.launch %*
set "CODE=%errorlevel%"
goto finished

:use_python
python -m backend.launch %*
set "CODE=%errorlevel%"
goto finished

:broken_venv
echo The Python environment in .venv does not run on this computer.
echo It was probably made on another computer, or Python was removed.
echo Delete the .venv folder, then in this folder run:
echo   python -m venv .venv
echo   .venv\Scripts\python -m pip install -r requirements.txt
goto failed

:finished
if "%CODE%"=="0" goto end

:failed
echo.
echo Fitness Tracker did not start. Read the message above.
echo Press any key to close this window.
pause >nul

:end
endlocal & exit /b %CODE%
