"""把 0.0.0.0:8080 的 TCP 连接转发到 127.0.0.1:8090。

为什么要它：Steam 的 steamwebhelper.exe 抢占了 127.0.0.1:8080，
我们自己的桥接只能退到 8090；但手机里存的配对地址仍是 8080。
这个转发让手机不用重新配对，同时桌面侧桥接在 8090 上不会再被 Steam 干扰。
"""
import socket
import threading
import sys

LISTEN = ("0.0.0.0", 8080)
TARGET = ("127.0.0.1", 8090)


def pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except Exception:
            pass


def handle(client):
    try:
        upstream = socket.create_connection(TARGET, timeout=10)
        upstream.settimeout(None)
    except Exception:
        try:
            client.close()
        except Exception:
            pass
        return
    client.settimeout(None)
    threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
    pipe(upstream, client)
    try:
        upstream.close()
    except Exception:
        pass


def main():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        server.bind(LISTEN)
    except OSError as exc:
        print(f"bind {LISTEN} failed: {exc}", flush=True)
        sys.exit(1)
    server.listen(128)
    print(f"forwarding 0.0.0.0:8080 -> {TARGET[0]}:{TARGET[1]}", flush=True)
    while True:
        try:
            client, _ = server.accept()
        except Exception:
            continue
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()