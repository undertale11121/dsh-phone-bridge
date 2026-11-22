# dsh-phone-bridge 交付说明（2026-11-22 10:30）

## 一句话

代码已经全部修完、测试全绿、手机端已更新。**桌面端需要重启一次 DSH 才加载新代码**，重启后手机 ↔ 电脑的消息就能互通。

## 为什么必须重启桌面 DSH

投递器（`wakeTick`）跑在 DSH 主进程里，每 3 秒执行一次。它加载的是**进程启动那一刻的代码**。
这次修的关键点之一（工作台改读本地 `thread.jsonl`）在修复后被重启的进程才会用上。

当前证据（重启前）：

```
wake-state.json:
  cursor: 340
  lastError: "工作台读不到（HTTP 404）"     ← 每 3 秒被旧代码写回
thread.jsonl:
  maxseq: 341                              ← 手机发来的「你好，请回复」卡在这里
```

新逻辑单独跑过验证：

```
since 340 -> 返回 1 条, next = 341
 seq 341 phone -> desktop | 你好，请回复
```

目标会话也存在（`session-e220963a` / 标题「测试手机互联消息」）。所以重启后会立刻投进去。

## 重启后的三步验证

1. 等 10 秒
2. 看 `C:/Users/17735/.dsh/phone-bridge/wake-state.json`：
   - `lastError` 应为 `""`
   - `cursor` 应 ≥ 341
   - `lastWake.sessionId` 应指向一个活着的会话
3. 看电脑端对应会话里有没有「你好，请回复」

## 本轮修掉的真 bug（按影响排序）

| # | 问题 | 后果 | 修法 |
|---|---|---|---|
| 1 | `wakeTick` 走 `http://127.0.0.1:8080/thread` | 8080 回环被别的进程占用 → 每轮 404 → **一条消息都投不出去** | 直接读本地 `thread.jsonl`（`threadFileFromDisk`） |
| 2 | 手机 `listLiveSessions(agents)` 返回空 | 收件器找不到手机会话 → 消息全 blocked → 手机看不到 | agents 为空时扫 `session_projcache/sessions/` 兜底 |
| 3 | `titleOf` 声明在使用它的循环之后 | `const` 暂时性死区 → 预建会话每轮抛错 → **一条手机会话都建不出来** | 移到循环之前 |
| 4 | `writeSessionTitle` 只在 projcache 文件存在时写 | 新建会话来不及落盘 → 永远没标题 → App 列表里看不见 | 文件不存在时直接创建最小结构 |
| 5 | `aligned:false` + `cursor>0` 组合 | 状态卡死，跳过对齐又不读旧消息 | 补 aligned 标记，不重新对齐 |
| 6 | busy 计时在 idle 时被清零 | 永远攒不满超时 → 投给正在跑的会话永远不显示 | 超时 120s→15s，只在投递成功后清零 |
| 7 | 电脑端点 🔗 只写 `links` 不写 `collab` | 投递目标没切换 →「有时行有时不行」 | 同步 `collab.desktopSessionId` / `wake.sessionId` |
| 8 | 收件器不续租单例租约 | 两个收件器并存 → 同一消息投两遍 | `inboxTick` 每轮 `renewLease` |
| 9 | 手机上挂了旧收件器 `phone-bridge-inbox` | 同一消息出现两种格式（两套投递） | 从手机 profile 摘掉 |
| 10 | 手机新建会话 → 电脑不建对应会话 | 一一对应断掉 | `autoPairPhoneSessions` + `pendingNewSession` |

## 测试状态

14 个测试文件全绿，222 断言：

```
auth 11 / gate 14 / gate-phone 8 / web 65 / rotate 6 / render ✓
auto 9 / pair 5 / qr 15 / links 14/14 / thread 17/17
e2e 7 / agents 19 / delivery-stress 17/17 / inbox-tick 12/12
```

## 手机端

- 代码已更新到 **149045 字节**（`threadFileFromDisk` 2 处、`session_projcache` 4 处、`node --check` 通过）
- 手机日志已正常：
  ```
  00:31:51 收件器已启动（agents 已注入）
  00:32:04 预建手机会话：e220963a → a1924b00
  ```
- `inbox-state.json`：`cursor 341`、`blocked {}`、`lastError ""`

## 端口

桥接跑在 **8080**（8787 被 360 安全软件拦，手机连不上，已整体搬过来）。

- 配对串：`dshphone://192.168.1.10:8080/1fef9e7233821b11967f5b9d9b45a416`
- 注意：本机 `127.0.0.1:8080` 被另一个进程占用，本机测试请用 `http://192.168.1.10:8080`

## 已知限制

手机 DSH 的 `agents.create` 有时会抛 `no agent factory registered`（agent-loop 插件在某些重启后没起好）。
已加降级：建不了新会话时投给「最近活跃的手机会话」，保证消息不丢；但那种情况下做不到严格一一对应。