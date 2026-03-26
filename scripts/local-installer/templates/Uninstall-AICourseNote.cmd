@echo off
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall-AICourseNote.ps1"
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
  echo.
  echo AICourseNote uninstall failed. Exit code: %EXIT_CODE%
  pause
  exit /b %EXIT_CODE%
)

exit /b 0
