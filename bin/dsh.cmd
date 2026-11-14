@echo off
rem dsh CLI 的包装：DSH Desktop 的 @deepseek-ai/dsh 在 app.asar 里，没有独立的
rem dsh.cmd。用 Electron 的 node 模式直接跑 asar 内的 bin.js。
rem 注意 set 要用引号包住，否则 MSYS/Git-Bash 会把 \E 当转义符吃掉。
set "ELECTRON_RUN_AS_NODE=1"
"D:\c\DEEPSEEK\DeepSeek Harness.exe" "D:\c\DEEPSEEK\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" %*