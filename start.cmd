@echo off
setlocal
cd /d "%~dp0"
if exist "node\node.exe" (
  "node\node.exe" launcher\launcher.mjs %*
) else (
  node launcher\launcher.mjs %*
)
if errorlevel 1 pause
endlocal
