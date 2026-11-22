# dsh-phone-bridge 交付说明（2026-11-22）

## 现在通到什么程度（都是实测过的）

| 能力 | 状态 |
|---|---|
| 手机 ↔ 电脑 双向消息 | ✅ 通（手机发的投到电脑对应会话，电脑发的投到手机对应会话） |
| 手机点「互联」→ 电脑自动新建对应会话 | ✅ 通（`/collab` 收到 `phoneId`+`phoneName` → `pendingNewSession` → 建会话并接上开关） |
| 新会话带名字（不出现空白条目） | ✅ 已修（`createFreshSession` 把名字塞进 `meta.title`，桥接侧再兜底补写 projcache），**需重启 DSH 验证** |
| 不重复投递 / 不永久丢失 | ✅ 游标 + `delivered` 去重 + `blocked` 上限；`test/delivery-stress.mjs` 17 项断言 |
| 两端重启后自动恢复 | ✅ 开机自启脚本（`scripts/start-all.py`）起 8090 桥接 + 8080 转发，均 detached |

## 需要你做的（一次性）

1. **重启桌面 DSH**（完全退出再打开，不是刷新窗口）
2. **重启手机 DSH Go**
3. 在手机那个对话里点一次「🔗 互联」

## 环境说明（都是踩出来的，别改回去）

- **桥接端口 8090**：原来的 8080 被 Steam 的 `steamwebhelper.exe` 占了 `127.0.0.1:8080`，桌面自己读工作台会打到 Steam → 每轮 404 → 一条消息都投不出去。
- **8080 → 8090 有一个 TCP 转发器**（`scripts/forward-8080.py`）：因为手机里存的配对地址还是 8080，这样不用重新配对。
- 两者的启动都必须是 **detached** 进程（`scripts/start-all.py` 用 `DETACHED_PROCESS`）：DSH 重启会杀掉它 Job Object 里的子进程，之前用普通后台方式起，DSH 一重启手机就掉线。

## 已知限制

- **手机上 `agents.create` 时好时坏**：手机版 DSH 偶尔不注册 agent factory，报 `no agent factory registered (load an agent-loop plugin)`。
  - 已做降级：建不出新会话时，投给「最近活跃的手机会话」，至少消息不会悬空。
  - 走不通的情况：手机上确实没有可投的会话时，消息会 `blocked` 并写 `lastError`，不会静默丢。
- **标题依赖引擎**：projcache 是引擎整份覆盖的，外部写入会被冲掉；只能用 `meta.title` 让它自己认。

## 排查入口

- 桥接：`http://127.0.0.1:8090/health`
- 电脑侧唤醒状态：`C:/Users/17735/.dsh/phone-bridge/wake-state.json`（看 `cursor`/`lastError`/`lastWake`）
- 手机侧收件状态：`/root/.dsh/phone-bridge/inbox-state.json`、`inbox-boot.log`
- 桥接日志：`C:/Users/17735/.dsh/phone-bridge/bridge-restart.log`

## 测试

```bash
npm run test:all
```

15 个文件、约 222 条断言：`auth 11 / gate 14 / gate-phone 8 / web 65 / rotate 6 / render / auto 9 / pair 5 / qr 15 / links 14 / thread 17 / e2e 7 / agents 19 / delivery-stress 17 / inbox-tick 12`。