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


def lan_ip():
    """手机走的是局域网 IP，探测也得用它。

    127.0.0.1:8080 在 Steam 开着的机器上永远指向 Steam（Windows 允许
    0.0.0.0:8080 与 127.0.0.1:8080 并存，更具体的绑定优先），所以用回环
    地址探测 8080 永远拿到 404，会把「转发器其实好好的」误判成 down。
    """
    import socket

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("192.168.1.1", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return ""


def is_listening(port, host="127.0.0.1"):
    """端口「真的在服务我们的桥接」才算 up。

    只看 netstat 会被 Steam 骗：它长期占着 127.0.0.1:8080，端口有监听但
    /health 404，于是这里误判「已经起来了」→ 转发器永远不起 → 手机连不上。
    所以改成发一次 HTTP 探测，只认 /health 返回 ok 的。
    """
    import json
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://{host}:{port}/health", timeout=3) as res:
            return bool(json.loads(res.read().decode()).get("ok"))
    except Exception:
        return False


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
    ip = lan_ip()
    target = ip or "127.0.0.1"
    if not is_listening(8080, target):
        spawn([sys.executable, os.path.join(ROOT, "scripts", "forward-8080.py")],
              os.path.join(ROOT, "scripts"), "forward.log")
        time.sleep(2)
    print("8090:", "up" if is_listening(8090) else "down",
          "| 8080:", "up" if is_listening(8080, target) else "down",
          f"(probe {target})")


if __name__ == "__main__":
    main()