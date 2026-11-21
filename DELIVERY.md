# 早上起来怎么验（3 步）

## 1. 重启桌面 DSH

关掉 DeepSeek Harness 再打开。**必须重启**，否则下面这些修复都不生效（进程里还是旧代码）：

| 修复 | 说明 |
|---|---|
| `aligned:false + cursor>0` 死锁 | 以前只要状态文件长这样，一条消息都投不出去，而且没有任何报错 |
| busy 超时 120s → 15s | 以前会话状态在 idle/running 之间闪，计时被反复清零，消息永远等不到 |
| 消息带 `desktopId` | 以前对话式的发送（`peer_converse`/`phone_say`）丢了来源会话，对端只能瞎猜 |
| 建不了会话时降级 | 手机版 DSH 没有 agent factory 时，退到最近活跃的手机会话，消息至少能落地 |
| 单例租约 | 两个 DSH 进程各跑一份收件器 → 同一条消息投两遍 |
| 8080 端口 | 8787 被 360 拦，已整体搬到 8080（新配对串见下） |

## 2. 重启手机上的 DSH Go

手机侧代码已经推到 **0.6.19**（34 文件，解压到 `/root/workspace/phone-bridge`，`node --check` 通过）。
重启 App 后，`inbox-boot.log` 应该重新出现「收件器已启动」。

## 3. 在你要用的那个电脑会话里，点一次顶部「🔗 互联」

**这一步不能省**。原因：`desktop.json` 里的 `collab.desktopSessionId` 和 `wake.sessionId` 现在是空的
（不知道什么时候被清掉的），空着的时候：
- 手机消息**没有点名、也没带 desktopId** 时，投给谁都算「猜」，所以代码会跳过并在 `lastError` 里提示
- 点一次开关，这两个字段就有值了，之后这个会话的消息会稳定投到这里

点完之后，在手机上那个会话里发一句话，电脑这边应该几秒内出现
`【互联】手机模型 N 条（xx 字） · 时间`。

---

# 现在到底通到什么程度（别抱错期待）

## 已经通了的

- **手机 → 电脑**：手机模型 `peer_say` / `converse` 发的消息，电脑会话里能看到（只要上面第 3 步做过）
- **电脑 → 手机**：电脑发的消息会合批成一条，投到手机的对应会话
- **不重复投递**：游标推进按「连续 handled」算，自己发的消息也记进 skipped，不会再每 3 秒重发同一批
- **不永久丢消息**：busy 时游标停住等，不跳过；blocked 有 5 分钟上限
- **面板**：对话区从只显示 4 条改成 50 条；手机会话按 90 秒新鲜度显示在线/停止，不再全显示「已停止」
- **标题**：电脑会话新建手机会话时会带上标题，手机上不再是空白条目

## 还没完全通的（今天早上最好先知道）

**先说最重要的：手机侧预建会话的一个致命手误已经修好了。**

`inbox-boot.log` 里每 3 秒一条：

```
预建失败 session-3b356685…：Cannot access 'titleOf' before initialization
```

是我上一版加「给预建会话起标题」时把 `const titleOf` 写在了使用它的预建循环**后面**，
`const` 的暂时性死区让每轮预建都直接抛错 → **一条手机会话都建不出来**，用户在 App 里自然看不到。
已把声明移到循环之前，`web/index.js` 已推到手机（148851 字节，`node --check` 通过），**重启 App 后生效**。

**再往下的硬限制：手机版 DSH 的 agent factory 时有时无。**

偶发日志：

```
no agent factory registered (load an agent-loop plugin)
```

`dsh-base` 的 patch 里确实有 `agent-loop` 行（`/opt/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:517`），
包也在 `/opt/dsh/node_modules/@deepseek-ai/dsh-agent-loop`，但手机 profile 自己的 `node_modules` 里
**没有 `@deepseek-ai/`**（桌面 profile 有 190 个包），运行时会偶发拿不到 factory。
降级逻辑已经就位：真建不出来时投到「最近活跃的手机会话」，消息至少能看见。

手机侧 DSH 报：

```
no agent factory registered (load an agent-loop plugin)
```

`dsh-base` 的 patch 里确实有 `agent-loop` 行（`/opt/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:517`），
`dsh-agent-loop` 包也在 `/opt/dsh/node_modules`，但运行时就是拿不到 factory。
**凌晨 02:44 和 02:49 两次重启时还能建**（日志里 `72e1dc21`、`44124ce3` 都是新建成功的），
之后某次重启就一直是这个错误 —— 大概率是那次启动时 `agent-loop` 没起好，被 `apply()` 的错误吞掉了。

**所以现在的行为是：**
- 电脑新建会话 → 手机**建不出对应会话** → 降级投到「最近活跃的那个手机会话」（消息能看见，但不是一一对应）
- 手机新建会话 → 电脑端仍然会看到（`reportPhoneSessions` 每 30 秒上报，走 `pendingNewSession` 自动开对应电脑会话）

**如果这个降级你受不了**（比如多个手机会话互相串），跟我说，我换另一条路：让电脑端只投给「已确认对应」的会话，其余留在工作台 + 提示，不硬塞。

---

# 新配对信息（端口已从 8787 改到 8080）

```
dshphone://192.168.1.10:8080/1fef9e7233821b11967f5b9d9b45a416
```

配网页：`http://192.168.1.10:8080/pair?t=1fef9e7233821b11967f5b9d9b45a416`

手机如果显示离线，先确认手机浏览器能打开 `http://192.168.1.10:8080/health`。

---

# 测试状态

13 个测试文件全绿，共 **222 断言**：

```
web 65 / links 14 / gate 14 / thread 17 / delivery-stress 17 / e2e 7
agents 19 / pair 5 / auth 11 / qr 15 / auto 9 / rotate 6 / render ✓
```

代码：`1f132ad` → `0.6.19`，已 push 到 github.com/undertale11121/dsh-phone-bridge。

---

# 还没做的（不影响早上验主链路）

- npm 0.6.17 还 staged 等你点批准（`7cc3e1d6-4fb8-4742-8971-860d7cc7940e`），之后还要发 0.6.19
- 市场 PR [#104](https://github.com/ccch1mneyyy/dsh-go-market/pull/104) 等维护者合并
- 提醒：npm token `npm_…（已在对话里明文出现过，请到 npm 后台 revoke 换新）` 已经写在对话里了，建议 revoke 换一个