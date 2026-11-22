@echo off
rem 开机自启：8090 桥接 + 8080 转发（Steam 占着 127.0.0.1:8080，手机配对地址仍是 8080，靠转发接回来）
cd /d "%~dp0.."
start "" /min "D:\c\dsh\workspace\.bin\node.cmd" bridge.mjs desktop --serve
timeout /t 3 /nobreak >nul
start "" /min pythonw "%~dp0forward-8080.py"
