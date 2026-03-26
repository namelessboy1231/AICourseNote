@echo off
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-AICourseNote.ps1"
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
  echo.
  echo AICourseNote install failed. Exit code: %EXIT_CODE%
  pause
  exit /b %EXIT_CODE%
)

echo.
echo AICourseNote install completed.
echo Main executable: %~dp0AICourseNote\AICourseNote.exe
pause
exit /b 0
