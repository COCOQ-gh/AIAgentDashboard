@echo off
chcp 65001 >nul

rem AI Agent Dashboard 起動: サーバを別ウィンドウで立ち上げ、ブラウザを開く。
rem サーバのウィンドウを閉じれば停止する。PORT を変えたいときは環境変数 PORT を設定してから実行。
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。https://nodejs.org/ からインストールしてください。
  pause
  exit /b 1
)

if not defined PORT set PORT=4317

start "AI Agent Dashboard (port %PORT%)" node src\server.mjs
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:%PORT%/
endlocal
