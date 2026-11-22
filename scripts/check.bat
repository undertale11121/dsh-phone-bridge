@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
echo.
echo 正在检查手机与电脑的互联状态...
echo.
"D:\c\dsh\workspace\.bin\node.cmd" "scripts\self-check.mjs"
echo.
pause