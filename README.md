# dsh-phone-bridge

让 DSH **电脑端**和 **手机端**互通：两边模型可以互相派活——电脑上的模型能截图、点按、跑 shell、让手机上的模型自己做判断；手机上的模型也能反过来指挥电脑。配合完成一件事（电脑写软件、手机装上去测）。

```
电脑上的 DSH ──MCP stdio──► bridge.mjs desktop ──HTTP 长轮询(8787)──► bridge.mjs phone ──MCP stdio──► 手机操控(relay)
     ▲                             ▲                                      │
     └── peer_* / agent_* 给两边模型 └── 手机主动连电脑（局域网/隧道都行）    └── 手机 shell / 手机模型(dsh headless)
```

- **手机主动连电脑**：电脑不需要能反向访问手机，跨网用隧道就行。
- **配对一次，之后自动连**：首次配对有三种方式（2 分钟窗口 / 6 位码 / 扫码，见下）；手机生成 Ed25519 设备密钥，电脑记住公钥，之后只靠签名重连（token 丢了也能连）。
- **同一份代码、同一段补丁，两端都一样**：`bridge.mjs auto` 自己判断是手机还是电脑（看 relay / `/sdcard`），不用分别配置。
- **两个模型对等**：两边看到同一套 `peer_*` 工具，谁都能让对面跑命令、传文件；还能像子智能体一样指定对话对象（`agent_*`），工作台按收件人过滤。
- **图形化配置页**：两端各跑一个本机网页 `http://127.0.0.1:8789/`，看状态、配对、开关权限、扫局域网，不用手改 JSON；模型侧也有 `bridge_setup` 工具直接给地址。
- **两端各是一个 MCP server**，用 profile 补丁注册，和 App 自己的 `phone` 工具用的是同一套机制。
- 所有请求都带 token；文件上限 16MB；`desktop.json` 里可以关掉 shell / 手机模型 / 文件传输。

## 电脑模型能用的工具

| 工具 | 作用 |
| --- | --- |
| `peer_info` | 对面（手机）是否在线、设备信息；没连上时给出配对串 |
| `peer_say` | 在共享工作台上说一句；不指定收件人，等于广播给所有人（手机模型下次开口能看到） |
| `peer_converse` | 对手机模型说一句并**等它回话**（默认 120 秒，最多 10 分钟） |
| `peer_read` | 读共享工作台的对话（两边说的话都在里面），默认最近 40 条 |
| `agent_list` | 看能对话的对象：电脑模型、手机模型，以及双方起的子智能体（带 id、在哪台机器、是否在跑） |
| `agent_send` | 给指定对象留话（不执行任务）：`{to:"phone", text:"…"}`；`to` 省略=广播 |
| `agent_converse` | 给指定对象说一句并等回话；对方是子智能体时，它会自己动手再回报 |
| `agent_read` | 读工作台对话，可 `since` / `limit`（手机端按收件人过滤，电脑端读全量） |
| `agent_spawn` | 起一个子智能体：`{name:"查日志", task:"…", host:"desktop"}`；`host` 也可写 `phone` |
| `agent_stop` | 停掉一个子智能体（内建的两个模型不能这样停） |
| `peer_run` | 在对面的 Linux 环境跑命令（跑测试、看日志、装依赖） |
| `peer_put` | 推网页/APK/脚本到手机，默认 `/sdcard/Download/DSH-Go/` |
| `peer_get` | 取回截图、日志、测试产物 |
| `phone_tools` | 列出手机操控工具（screen/tap/open/apps/intent…）及参数 |
| `phone_tool` | 调一个手机操控工具，例如 `screen {image:true}`、`tap {screen,id}` |
| `phone_ask` | 把一段任务交给**手机上的模型**，返回它的结论；同一个项目传同一个 `session` 续会话 |
| `phone_test` | 「一句话自动测」：把目标/网页/APK 交给手机模型，它自己开应用、看截图、点按、跑命令，交回报告和截图（自动取回桌面）；`session` 续会话 |
| `phone_send_dir` | 整个目录推到手机（自动跳过 node_modules/.git，上限 16MB） |
| `phone_build_apk` | 让手机自己构建 APK，构建完自动把 `.apk` 取回桌面 |
| `phone_install` | 一键装 APK：传文件 → 打开系统安装器 → 自动点「安装/继续安装」；遇到未知来源/密码框会如实报「需要你处理」 |
| `phone_shell_target` | 目标是「能被建连的一方」时也能用：自动判断在手机上跑还是本机跑 |
| `bridge_log` | 看桥接日志（默认 60 行），排查连不上 |
| `bridge_start` | 电脑上没有前台桥接时，自动拉起一个后台共享服务（`--serve`，同一台电脑所有 DSH 实例共用） |
| `bridge_setup` | 给出图形化配置页地址（状态/配对串/权限开关/扫描局域网） |

手机模型能看到同样的 7 个 `peer_*`（`peer_info`、`peer_say`、`peer_converse`、`peer_read`、
`peer_run`、`peer_get`、`peer_put`）和 6 个 `agent_*`（`agent_spawn` 只在手机上起子智能体，没有 `host` 参数）；
另外有本机专属的 `bridge_setup`、`bridge_status`、`bridge_pair`、`bridge_unpair`、`bridge_doctor`、
`phone_test`、`phone_plan`（只出测试计划）、`phone_screenshot`（screencap 兜底截图）。

**没有主次**：两边看到的是同一套名字，谁先开口都行。电脑模型用 `peer_run` 指挥手机跑测试，
手机模型也可以用 `peer_run` 指挥电脑构建、跑脚本；两边都能 `peer_say` / `peer_converse` / `peer_read`，
也都能 `peer_get` / `peer_put` 互传文件。谁先开始任务都可以，另一边不需要「授权」或「被派活」。
旧名（`phone_say` / `phone_shell` / `phone_send_file`…）在电脑端仍作为内部别名接受，模型看到的是新名字。

## 安装（两端一样的步骤）

1. 把整个 `phone-bridge` 目录拷到这台机器（需要 Node.js ≥ 20）。
2. 运行 `node bridge.mjs print-patch`，把 YAML 片段追加到 profile 的 `cordis.patch.yml` 末尾。
   片段里的命令是 `bridge.mjs auto`——同一段在手机和电脑上都能用，会自动识别角色。
3. 重启 DSH，然后打开 `http://127.0.0.1:8789/`（或让模型调 `bridge_setup`）看状态。
4. （可选，推荐）装桌面界面卡片：`dsh plugin --profile <profile> add <phone-bridge 目录>/web`，重启后在
   DSH 网页版的「插件」页会出现「互联」卡片，不用记端口也不用开浏览器标签。

## 安装：手机端（本机已装）

代码在 `/root/workspace/phone-bridge`，补丁已加到
`/root/.dsh/profiles/web/cordis.patch.yml`（备份同目录 `cordis.patch.yml.bak-*`），**重启 App 后生效**。
重启后手机模型会多出 `bridge_setup` / `bridge_pair` / `bridge_status` / `phone_test` 等工具。

## 安装：电脑端（Windows）

1. 把整个 `phone-bridge` 目录拷到电脑，例如 `C:\dsh-phone-bridge`（需要 Node.js ≥ 20）。
2. 在该目录运行 `node bridge.mjs print-patch`，把打印的 YAML 片段追加到
   `%USERPROFILE%\.dsh\profiles\<你的 profile 目录>\cordis.patch.yml` 末尾。
   如果 `!!js process.execPath` 那行启动失败（例如 DSH 是 Electron 应用），把 `command` 改成 `node` 或 `node.exe` 的绝对路径。
3. 重启 DSH。首次启动会生成 `%USERPROFILE%\.dsh\phone-bridge\desktop.json`（token、端口 8787）。
4. Windows 防火墙放行 8787（至少「专用网络」）。
5. 在桌面 DSH 里让模型调用 `peer_info`，它会返回配对串，例如
   `dshphone://192.168.1.5:8787/9f3c…`（也可以用 `node bridge.mjs print-pair` 直接打出来）。
6. 想在 DSH 界面里管理而不用浏览器标签：在该目录执行
   `dsh plugin --profile <profile> add <目录>/web`，重启后「插件」页多了「互联」卡片
   （状态、配对串复制、四个权限开关、已登记手机、最近日志、启动后台服务/换配对串）。

## 图形化配置页

两端各有一个本机网页（默认 `127.0.0.1:8789`，`PHONE_BRIDGE_SETUP_PORT` 可改）：

- **电脑端**：手机是否在线、配对串（一键复制）、允许新手机配对（2 分钟）、生成 6 位配对码、扫描局域网、换新配对串、看日志、四个权限开关（shell / 手机模型 / 文件传输 / 自动测试）。
- **手机端**：连了哪台电脑、当前地址、自动连接的对端列表、专用会话、agent 列表；粘贴配对串点「连接」，或「找附近的电脑」/填 6 位码连接，也可以「断开并清除配对」。
- **手机端配置页带 CORS**：电脑端配对页要从别的源 POST 进来（见「扫码配对」），预检会返回 `access-control-allow-origin: *`（页面只监听 `127.0.0.1`，仍然要有效配对串）。

开关改完立即写入配置文件生效，不用重启（运行中的桥接会检测 desktop.json 变化后重读）。

## 桌面 DSH 里的界面

`web/` 是一个独立的零依赖 bundle（`dsh-phone-bridge-web`），不写 Cordis 插件构建链也能装：

- 宿主半边 `web/index.js` 注册 `GET/POST /phone-bridge/config`，自己读写
  `$DSH_HOME/phone-bridge/desktop.json`、探测 `/health`，需要时用配置里记录的 `bridge`
  路径拉起后台服务（所以它不 import `../src/*`，装进 profile 后也能跑）。
- 浏览器半边 `web/client.js` 是手写的 lazy-CJS 模块，往 `plugins.bundle.config` 槽注册一张卡片：
  在线状态、设备/监听/后台三行、配对串复制、四个权限开关、已登记手机、最近日志、最近几条工作台对话；
  按钮有「允许新手机配对」「生成 6 位配对码」「启动后台服务」「换新配对串」「刷新」，每 5 秒刷新一次；
有手机请求配对时，卡片顶部多一块「有手机想连接」，两个按钮「允许 / 拒绝」。
- 「看完整对话 ↗」指向电脑的 `/workbench?t=<token>` 只读网页（自动刷新，手机竖屏也能看）。
- 安装：`dsh plugin --profile <profile> add <phone-bridge 目录>/web`，重启引擎；
  卡片在「插件」页。用不着时 `dsh plugin --profile <profile> remove dsh-phone-bridge-web`。
- 卡片认角色：同一份 bundle 装在手机上会显示「这台是手机端，请用 App 胶囊」，不展示电脑端的开关。
- 卡片顶部是二维码（「让手机扫码」）：用手机**系统相机**扫一下，浏览器打开配对页后自动把配对写进手机，不用手抄配对串。
- 自测：`node test/web.mjs`（两条路由 + 卡片首帧渲染 + 两种角色，21 项）。

## 让两个模型自己商量、自己选对象（共享工作台）

不只是「电脑派活、手机照做」。两边都能开口，也都能选择跟谁说话：

- 电脑模型：`peer_say` / `peer_converse` / `peer_read`，默认对象是手机模型。
- 手机模型：同样有 `peer_*`；它跑任务时会自动带上最近 12 条对话，也会被告知「拿不准就问电脑模型」。
- 想指定对象时用 `agent_*`：`agent_list` 看有谁（内建 `desktop` 电脑模型、`phone` 手机模型，
  还有 `agent_spawn` 起的子智能体），`agent_send` 留话，`agent_converse` 说一句并等回话。
- 子智能体是独立的 `dsh headless` 进程：`agent_spawn {name, task, host}` 起一个，`host` 选 `desktop`
  就在电脑上跑、选 `phone` 就到手机上跑；它上线和完成都会在工作台留言，`agent_stop {id}` 停掉。
- 对话存在 `$DSH_HOME/phone-bridge/thread.jsonl`。手机端的 `agent_read` 按收件人过滤：只看到广播、
  发给它的、它自己说的；电脑端模型读全量，人和 `/workbench` 页面看完整记录。

一段真实的来回（电脑模型和手机模型各自调自己的工具）：

```
电脑模型 → agent_say {to:"phone", text:"我先把构建跑起来，你那边先别动屏幕"}
手机模型 → peer_read                              # 看工作台上有没有新交代
电脑模型 → agent_converse {to:"phone", text:"登录页按钮改好了，帮我重测登录流程；注册页验证码框点不动，也一起看看"}
手机模型 → peer_run {command:"cd /root/workspace/app && pnpm test"}   # 在电脑上跑
手机模型 → agent_converse {to:"desktop", text:"登录能过。验证码框点不动，报错是 …，像是没绑点击"}
电脑模型 → agent_spawn {name:"查日志", task:"翻最近 200 行日志，定位验证码框没绑事件的原因", host:"desktop"}
查日志（子智能体）→ 上线留言：「收到任务：…」
查日志 → agent_send {to:"desktop", text:"找到了：…"}
```

`peer_say` 等于不指定对象的广播；`peer_converse` 固定等手机模型。要等子智能体或别的对象，
用 `agent_converse`。两边都可以先开口，不需要谁批准。

## 同一项目复用同一个手机会话

电脑模型派活给手机时，`phone_ask` 和 `phone_test` 都认一个 `session` 参数：

```
phone_ask  {task:"把登录页的欢迎语改成「早上好」", session:"登录页"}
phone_test {goal:"登录、退出、错误密码三条路径都要过", session:"登录页"}
```

- **同名 = 同一个手机会话**：第一次自动建，之后自动续。映射存在
  `$DSH_HOME/phone-bridge/sessions.json`，形如
  `{"登录页":{"sessionId":"…","at":"…","title":"…"}}`（`title` 是任务前 80 字，方便认）。
- 不传 `session` 就用 `default`；想直接指定会话 id 用 `sessionId`，一般不用。
- 这些活跑在**独立 home** `$DSH_HOME/phone-bridge/home` 的专用会话里，不会出现在手机 App 的会话列表，
  也不会把用户自己的聊天挤乱；手机「互联」面板会列出「专用会话」。
- 回复末尾会带 `[手机会话 登录页 · <id>]`，方便对着 sessions.json 排查。
- 想换新会话：换一个 `session` 名，或删掉 sessions.json 里那一条。

## 首次配对：四种方式

配对一次以后自动重连，平常不用再管。

### 1. 一键配对（推荐，什么都不用输）

手机点输入框上方的「连电脑」胶囊 → 自动搜索同一 Wi-Fi 下的电脑 → 电脑的「互联」卡片顶部出现
「有手机想连接 · <手机名>」→ 电脑上点「允许」。手机那边几秒内自己连上，不用输配对码、不用抄串。

电脑上 5 分钟没点就自动作废；点「拒绝」也会消失。这个确认只能由电脑本机的人点。

### 2. 允许新手机配对（在电脑上发起）

电脑卡片点「允许新手机配对（2 分钟）」→ 手机打开「互联」面板，点「找电脑」→ 点「连第一台」。
效果和上面一样，只是由电脑先开门。

### 3. 6 位配对码（兜底：手机找不到电脑、或电脑不在同一网段时）

电脑卡片点「生成 6 位配对码」→ 手机打开浏览器进 `http://127.0.0.1:8789/`，填电脑地址和这 6 位数字。
码 2 分钟有效、只能用一次。App 里不再占用输入框。

### 3. 二维码（用手机系统相机扫）

电脑卡片顶部有二维码（内容是 `http://<电脑局域网 IP>:8787/pair?t=<令牌>`）。用手机**系统相机**扫，
浏览器打开配对页后会自动把配对写进手机上的「互联」；打不开手机本机页时（App 没跑、端口被改），
页面会显示配对串和「复制」按钮，走手动那条路。

**限制（如实说）**：dsh-go 插件协议目前没有相机能力（`wants` 只支持 `draft` / `clipboard` / `message`），
所以「在 App 内直接扫码」做不到；只能用系统相机或相机 App 扫，扫完回到 App 即可。

二维码内容就是一次配对权限：别截图外发；电脑端「换新配对串」之后旧码立即失效。

## 配对（一次就好）

也可以手动：把配对串发到**手机**的 DSH 对话里，说「用这个连电脑：dshphone://…」，
手机模型会调用 `bridge_pair`；或者命令行：
`cd /root/workspace/phone-bridge && node bridge.mjs pair "dshphone://192.168.1.5:8787/令牌"`。

配对信息存在 `$DSH_HOME/phone-bridge/phone.json`，之后每次开机自动重连（断线会指数退避重试）。

**全自动三件事**：

1. **免配对重连**：首次配对后电脑记住手机公钥（`desktop.json` 的 `devices`），之后手机只凭设备密钥签名重连，`phone.json` 里连 token 都可以没有。
2. **自动发现**：电脑端 `peer_info` 在没连上时会扫局域网找手机；手机端 `peer.json` 每 30 秒探一次对端 `/beacon`，自动补上地址（换 Wi-Fi/IP 也不用重配）。
3. **一句话循环**：电脑模型改完代码直接 `phone_test`，报告和截图回来再改，直到通过；不需要你中间点确认（装 APK 时只有系统「未知来源」授权这类必须人点的才停）。

## 用法示例

- **网页测试**：电脑上让模型「把 dist 用 `peer_put` 推到手机，然后 `phone_ask {session:"网页测试"}`：用浏览器打开 file:///sdcard/Download/DSH-Go/dist/index.html，滚到底截图，报告报错」
- **APK 一条龙**：`phone_install {path:"app-debug.apk", packageName:"com.demo"}` → 装机；然后 `phone_test {goal:"启动后 3 秒内出现首页，无崩溃", app:"com.demo"}` 自动验收
- **真机回归**：`peer_run {command:"cd /root/workspace/app && pnpm test"}` 直接在手机环境跑
- **两个模型分工**：电脑模型 `agent_spawn {name:"审查员", task:"复查这个 diff", host:"desktop"}`；手机模型在真机上验，两边都在工作台留言
- **跨网**：电脑上 `cloudflared tunnel --url http://127.0.0.1:8787`，把配对串换成
  `https://xxx.trycloudflare.com/<token>`（手机端 `bridge.mjs pair` 接受 URL 形式）

## 排错

```
node bridge.mjs doctor        # 两端环境、配对、连通性
node bridge.mjs print-pair    # 重新打印配对串（电脑端）
```

- 手机连不上：确认同一 Wi-Fi、防火墙放行；不行就走隧道。
- 手机模型没新工具：重启 DSH；引擎日志里应有 `[phone-bridge]` 开头的行。
- `screen` 报「屏幕正被另一个对话使用」：手机屏幕同一时间只能一个对话操作，等那边的操作结束，或在 `phone_ask` 里先让它别动屏幕。
- 截图只回文字：部分机型/场景 APK 不给图片（安全限制），此时改用 `peer_run` 里的 `screencap` 或让手机模型自己看。
- 电脑上开了多个 DSH 实例：用 `bridge_start`（或 `peer_info` 里自动拉起）把它们指到同一个后台服务；老办法是只用先占住 8787 的那个实例。
- 装 APK 停在确认框：先看返回里的「当前画面」；华为/小米的「未知来源」授权、安装密码框必须人点一次，脚本不会绕过。
- 找不到子智能体：`agent_list` 看状态；子智能体要能在这台机器上跑 `dsh headless`。

## 安全

- 每个请求都校验 token（`timingSafeEqual`），token 只存在本机配置文件里；不要把配对串贴到公开地方。
- `desktop.json` 的 `allowShell` / `allowAsk` / `allowFiles` 可以单独关掉对应能力。
- `phone_ask` 会用 `--permission-mode danger-full-access` 在手机上跑本机模型（手机环境只有这个模式可用）。

## 自测

```
cd /root/workspace/phone-bridge
```

| 命令 | 项数 | 覆盖 |
| --- | --- | --- |
| `node test/e2e.mjs` | 8 | 同机跑桌面端 + 手机端全链路；`E2E_ASK=1` 时 9 项，含手机模型实际执行 |
| `node test/pair.mjs` | 5 | 手机端 MCP 工具的配对流程 |
| `node test/auto.mjs` | 9 | 免配对重连 + 新工具存在 |
| `node test/thread.mjs` | 17 | 双向说话、一问一答、配对窗口/码、局域网发现、对等工具 |
| `node test/qr.mjs` | 15 | 二维码、配对页、CORS |
| `node test/web.mjs` | 21 | 桌面界面 bundle：路由 + 卡片渲染 |
| `node test/agents.mjs` | 19 | agent 目录、子智能体、项目会话（含同一项目续用同一个手机会话） |

## 手机用流量（不在同一 WiFi）

桥接默认是**局域网直连**：手机切到流量后，两端不在同一个网络，直连一定不通——这是网络拓扑，不是插件坏了。面板上「地址类型」会直接告诉你：

| 地址类型 | 能不能通 |
|---|---|
| `lan`（192.168 / 10. / 172.16-31.） | 只有同一个 WiFi 下能通 |
| `cgnat`（100.64/10） | 手机流量到不了，必须换隧道 |
| `public`（域名 / 公网 IP） | 走流量也能连 |

三种做法：

1. **Tailscale（推荐）**：电脑装 Windows 版、手机装 Android 版，登同一账号；在手机「互联」面板里填 `http://100.x.y.z:8787`（电脑的 Tailscale IP）。配一次以后自动连，走流量也稳。
2. **临时隧道**：电脑上 `cloudflared tunnel --url http://127.0.0.1:8787`，把打印的 https 地址填到手机。用完就失效；它会把电脑暴露到公网，配对令牌等于密码，别长期开着。
3. **回到同一个 WiFi**：最简单的老办法。

桥接自己也做了两件事少折腾流量：轮询间隔 15 秒；断开后前两次就地重试（不重新握手），连续三次失败才重连，退避最长 15 秒。


### 面板里没有输入框

dsh-go 原生面板的组件里没有输入框（插件协议限制），所以面板上不能粘配对串。三条能填东西的路：

1. **胶囊「连电脑」**：先把配对串复制到剪贴板，点输入框上方这个胶囊，它读剪贴板直接连。
2. **「找电脑」**：同一 Wi-Fi 下一键搜，选中后到电脑卡片点「允许」。
3. **浏览器配置页**：手机上打开 `http://127.0.0.1:8789/`，那里有完整的输入框。

面板上的「地址类型」会告诉你现在这条链路为什么不通。

## 自动唤醒（0.6.0）

你只需要在电脑的「互联」卡片上点一下「开启自动唤醒」，别的都不用管：

1. 电脑模型哪次用过互联的工具（`peer_info`、`peer_say`、`phone_test` 都算），桥接就记住它是哪个会话；
2. 之后手机往电脑发消息（`peer_say`，收件人是 desktop），卡片插件每 3 秒读一次工作台，把新消息投进那个会话；
3. 会话里的电脑模型被叫醒，接着干，可以再 `peer_say` 回话。

会话不用填、也不用复制 id——MCP 客户端会告诉我们「这次调用来自哪个会话」（`dsh-go/phone-caller` 能力 + 配置里的 `dshGoPhoneCaller: true`）。

两种投递方式，卡片上可切：

- **排队投递**（默认）：模型跑完当前这轮再接
- **插话投递**：模型正跑着也立刻插进去

安全默认：**关**。关着时消息照样进工作台，但不会唤醒谁、也不会花 token。开着时每条发往 desktop 的消息都会真的跑一轮。

限制（如实说）：

- 只能在**引擎里开着的会话**上工作；没开就会在卡片上提示，不假装成功
- 唤的是「最近用过互联的那个会话」；同一台电脑开多个会话时，以最后一次调用桥接的为准
- 想续历史会话而不是唤醒，仍用 `phone_ask` 的 `session` 参数

## 两端上线会互相说一声

- 手机重新连上电脑时，工作台会自动多一条「（手机名已连上，可以派活了）」；
- 手机连上电脑时也会写一条「（手机已连上电脑）」；
- 这样另一端模型下次读工作台就知道对方回来了，配合上面的唤醒就能「回来接着干」。
