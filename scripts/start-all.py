"""开机自启：起 8090 桥接 + 8080 转发器，两个都脱离父进程（Job Object）。

为什么要 detached：DSH 重启会连带杀掉它自己 Job Object 里的子进程
（之前用 op_bash 后台 job 起转发器，DSH 一重启 8080 就没了，手机直接掉线）。
"""
import os
import subprocess
import sys
import time

DETACHED = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r"D:\c\dsh\workspace\.bin\node.cmd"


def is_listening(port):
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=15).stdout
    except Exception:
        return False
    return any(f":{port} " in line and "LISTENING" in line for line in out.splitlines())


def spawn(args, cwd, log_name):
    log = open(os.path.join(ROOT, log_name), "a", encoding="utf-8")
    return subprocess.Popen(
        args,
        cwd=cwd,
        creationflags=DETACHED,
        stdout=log,
        stderr=subprocess.STDOUT,
        close_fds=True,
    )


def main():
    if not is_listening(8090):
        spawn(["cmd", "/c", NODE, "bridge.mjs", "desktop", "--serve"], ROOT, "bridge-restart.log")
        time.sleep(4)
    if not is_listening(8080):
        spawn([sys.executable, os.path.join(ROOT, "scripts", "forward-8080.py")],
              os.path.join(ROOT, "scripts"), "forward.log")
    time.sleep(1)
    print("8090:", "up" if is_listening(8090) else "down",
          "| 8080:", "up" if is_listening(8080) else "down")


if __name__ == "__main__":
    main()