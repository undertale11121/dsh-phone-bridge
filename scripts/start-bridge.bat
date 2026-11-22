@echo off
rem 开机自启：8090 桥接 + 8080 转发（Steam 占着 127.0.0.1:8080，手机配对地址仍是 8080，靠转发接回来）
rem 必须用 python 的 DETACHED_PROCESS 起子进程：cmd 的 start 会继承父进程的 Job Object，
rem DSH 一重启（或这个 bat 被谁 kill）就把桥接和转发一起带走 —— 之前手机就是这么掉线的。
cd /d "%~dp0.."
python "%~dp0start-all.py"