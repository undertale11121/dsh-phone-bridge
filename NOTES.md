# phone-bridge 进度（2026-11-12）

## 目标
让 DSH 桌面端（Windows）与手机端（dsh-go / Android proot）互通，两端模型共同完成一个任务：
电脑端写软件 → 手机端装/开、截图判断、跑测试并回报。用户确认：局域网优先、跨网隧道；网页和 APK 都要测；手机模型参与判断。

## 现状：已跑通（同机 9/9 端到端）
```
桌面 DSH ──MCP stdio──► bridge.mjs desktop（HTTP 长轮询 :8787，token）
                              ▲ 手机出站 GET /poll
手机 DSH ──MCP stdio──► bridge.mjs phone ──► relay.cjs（截图/点按/…）
                                    ├─► bash shell
                                    ├─► 文件收发
                                    └─► dsh --profile headless（手机模型）
```
- 工具（桌面侧 12 个）：phone_status、phone_tools、phone_tool、phone_shell、phone_send_file、phone_fetch_file、phone_ask、phone_test、phone_send_dir、phone_build_apk、phone_install、phone_shell_target、bridge_log、bridge_start
- 工具（手机侧 7 个）：bridge_status、bridge_pair、bridge_unpair、bridge_doctor、phone_test、phone_plan、phone_screenshot
- 代码：bridge.mjs + src/{util,mcp,desktop,phone}.mjs；测试 test/e2e.mjs；说明 README.md

## 装过的地方
- 手机 web profile：`/root/.dsh/profiles/web/cordis.patch.yml` 末尾加了 `dsh-phone-bridge`（备份 .bak-*），重启 App 生效。
- 电脑（Windows）：待用户在电脑上装（README「安装：电脑端」）。

## 验证记录
- 长轮询协议 /hello /poll /res /prog /health 全通；配对串 dshphone://IP:PORT/token。
- relay 第二进程可连；phone_tool apps 返回 81 个应用；phone_shell/文件收发通过。
- phone_ask：生成 `$DSH_HOME/phone-bridge/headless.patch.yml`（从 web profile 抽 agent-default-model + llm-pi-ai，再补 `id: credentials / disabled: false`），跑 headless 成功。
- 坑：`--patch` 必须写在 `--json` 之前，否则 CLI 报 unknown option '--patch'。
- 坑：headless profile 默认禁用 dsh-credentials-local，必须显式 `- id: credentials / disabled: false`。
- 坑：屏幕资源互斥（同一时间一个对话操作）；DSH 自己的界面读不了。
- 未决：`screen {image:true}` 经 relay 只回文本，没拿到图片（华为桌面场景）。

## 待办
1. 用户在 Windows 装好桌面端 → 真机跨设备联调（局域网 + 隧道各一次）。
2. APK 安装流程：系统安装器需要用户点确认 → 用 handoff；装完用 phone_ask 打开截图检查。
3. 可选：截图兜底（phone_shell screencap + fetch_file 取 png）。
4. 可选：多桌面实例共用桥接（现在端口顺延会让第二个实例收不到请求）。

## 2026-11-12 v2「全自动」四项
1. 免配对重连 ✔：手机生成 Ed25519（`$DSH_HOME/phone-bridge/device.json`，0600）；`/hello` 带回 challenge，手机签名走 `/auth`；桌面首次用 token 校验时登记 `devices[{id,pub}]`，之后只认签名（`${id}:${ts}`，±5 分钟）。`phone.json` 只留 url 也能连。
2. 自动发现 ✔：`GET /beacon`（无鉴权）；电脑端 `phone_status` 扫本机 /24 找手机；手机端 `peer.json` 30 秒 tick 探对端 beacon，自动补 autoUrl。
3. APK 自动安装 ✔：`phone_install` → `file.put` → `open file://…` → 轮询 `screen`/`tap`，点「安装/继续安装/仍要安装/确定」→ 可选核对包名；失败如实给「当前画面」，不假装成功。
4. 一句话自动循环 ✔：桌面 `phone_test`（构造测试简报 → 手机模型执行 → 截图取回）＋手机 `phone_plan`（先出计划）。更新代码后再调一次同一 `#sessionId` 即可。

新增测试：test/auto.mjs（首次配对、丢 token 重连、设备公钥入库、新工具存在）5/5。

## v0.3.0（单插件 + 图形化配置）

- `bridge.mjs auto`：按 relay/`/sdcard` 判断手机还是电脑，两端共用同一段 profile 补丁（手机 profile 已改成 `auto`，备份 `cordis.patch.yml.bak-v3`）。
- `src/setup.mjs`：通用状态/动作配置页，桌面 8790 测试端口、线上默认 8789，只监听 127.0.0.1。
- 桌面：`bridge_setup` 工具 + 配置页（状态/配对串/扫描/换 token/日志/四个开关）；手机：`bridge_setup` + 配置页（配对/测试/断开）。
- 测试：auto 9/9（新增配置页 HTML、/api/state、开关落盘三项），e2e 8/8，pair 5/5。

## v0.3.1（桌面 DSH 界面）

- 按 `@liustack/modsearch` 的手写 bundle 范式做 `web/`（包名 `dsh-phone-bridge-web`，零构建）：
  `dsh.bundle.patch` + `dsh.client {platform:'web', immediately:true}`，`exports["./client"]`。
- 宿主 `web/index.js` 自包含（不 import `../src/*`，因为装进 profile 时会被拷到 node_modules）：
  自己读写 `$DSH_HOME/phone-bridge/desktop.json`、探 `/health`、用配置里的 `bridge` 路径 detached 拉起
  `bridge.mjs desktop --serve`；注册 `GET/POST /phone-bridge/config`（32KB body 上限，toggle/token/start）。
  `ctx.inject(['webServer'], scope => scope.effect(...))`，`scope.effect` 缺失时直接 register（旧宿主兜底）。
- 客户端 `web/client.js`：`window.__ModuleLoader__.load({id, factory})` 惰性 CJS，`require('react')` 手写卡片，
  `slots.inject('plugins.bundle.config', function*(){ yield slots.register({name,key}, Card) })`；中英双语文案；5 秒轮询。
- `src/desktop.mjs`：`loadDesktopConfig()` 写入 `bridge` 绝对路径；`runDesktopMcp()` 的 `cfg()` 按 mtime 重读
  desktop.json，所以网页/卡片改权限立即生效；修了 `ensureDesktopServer` 只把第一个局域网地址写进配对串的问题。
- 新测试 `test/web.mjs` 18/18（路由 GET/POST、开关落盘、换 token、未知动作 400、bundle 装载与卡片首帧）。
  全量：e2e 8/8、pair 5/5、auto 9/9、web 18/18。
- 已装到手机 profile 验证：`dsh plugin --profile web add /root/workspace/phone-bridge/web`（link），
  `--dump-config` 命中 `phone-bridge-web`；临时 `dsh web --port 3098` 下 `/phone-bridge/config` 返回 401
  （存在但需浏览器会话），未知路径 404。
- 打包 0.3.1：`node scripts/pack.mjs`（web/ 一起进 zip）。
- 卡片按角色分叉：`isPhone()` 看 relay/`/sdcard`（`PHONE_BRIDGE_ROLE` 可强制），手机端只显示提示。
- 真机验证（临时引擎 `dsh web --port 3095/3096` + 会话 cookie）：
  `GET /phone-bridge/config` 200，role=phone/desktop 都正确；POST `toggle allowTest=false` →
  返回的 state 立即反映，改回为 true 恢复；未鉴权时 401、未知路径 404（路由确实注册了）。
- 手机 profile 里的 web bundle 已 remove（卡片主要给电脑；手机用 App 原生面板）。

## v0.3.2（扫码配对）

- 新 `src/qr.mjs`：零依赖二维码编码器（byte 模式、M 级、版本 1–10），出 `qrMatrix` / `qrSvg` / `qrPng` / `qrDataUrl`。
  对拍过 `qrcode@1.5.4` 的矩阵（短文本逐模块一致），并用 `jsQR` 解码 PNG 与线上 SVG，5/5、6/6 都对。
- 桌面端 `GET /pair`（手机竖屏配对页）+ `GET /pair/qr.svg`；`/health` 增加 `pairing` 与 `pairUrl`；
  新增 `pairUrl()`（取第一个局域网 IPv4）。
- 配对页把配对串 POST 到手机本机配置页 `127.0.0.1:8789/api/action`，失败时显示配对串+复制，退回手动。
- `src/setup.mjs` 加 CORS / `Access-Control-Allow-Private-Network` 与 OPTIONS 预检。
- `web/index.js` 加 `GET /phone-bridge/qr.svg`（借 desktop.json 里的 bridge 路径动态 import `src/qr.mjs`），
  `snapshot()` 增加 `pairUrl`；`web/client.js` 卡片顶部画二维码 + 「让手机扫码」说明（中英）。
- 新 `test/qr.mjs` 15 项：版本边界、定位图案、SVG/PNG、配对页、`/pair` 与二维码路由、错 token 403、预检、动作落盘。
- `test/web.mjs` 扩到 21 项（两条路由 + 二维码 503/SVG 分支）。打包 0.3.2。

## v0.3.3 · 两个模型直接商量 + 不扫码配对

- 共享工作台 `src/thread.mjs`：JSONL + 文件锁，`append/read/waitFor`，手机侧带缓存；对话在
  `$DSH_HOME/phone-bridge/thread.jsonl`。
- 电脑模型：`phone_say` / `phone_converse`（长轮询等回话）/ `phone_read`；`phone_status` 末尾会显示手机模型
  最近说了什么。
- 手机模型：`bridge_say` / `bridge_converse` / `bridge_read`，由 `src/thread-mcp.mjs` + `thread.patch.yml`
  注入 headless 会话；`ask()` 会自动把最近 12 条对话塞进 prompt，并要求「拿不准就问电脑模型」。
- 免扫码配对：电脑端 `POST /permit`（2 分钟窗口）与 `POST /code`（6 位码，2 分钟），
  `/hello` 在窗口期放行未知设备，`/auth` 支持 `code` 与窗口期 `device` 两条路径；手机端 `discover()`
  扫局域网并按「可配对」排序，`connectTo()` 支持 code。图形界面：电脑端配置页/插件卡片有「允许新手机配对」
  与「生成配对码」，手机上多了「找电脑」「配对码」两个胶囊与面板按钮。
- 测试：`test/thread.mjs` 9/9（窗口配对、配对码、双向说话、一问一答、局域网发现）；qr 15、web 21、pair 5、e2e 8、auto 9 全绿。

## v0.4.0 · 对等协作（没有主次）

- 统一的 `peer_*` 词汇，两端工具名相同：`peer_info` / `peer_say` / `peer_converse` / `peer_read` /
  `peer_run` / `peer_get` / `peer_put`。旧名（`phone_say`…）作为内部别名保留，模型看到的是 `peer_*`。
- 反向通道：手机可以主动让电脑做事 —— `POST /call {op:'info'|'shell'|'file.get'|'file.put'}`，
  走同一套 token/设备签名鉴权，遵守电脑端的 allowShell / allowFiles；手机侧 `PhoneBridge.callDesktop()`
  与 `phoneTools` 的 `peer_run`/`peer_get`/`peer_put`/`peer_info` 用它。
- `src/thread-mcp.mjs` 改为 `peer_say`/`peer_converse`/`peer_read`；headless 手机模型的提示词也改成 `peer_*`。
- 测试：`test/thread.mjs` 扩到 14 项（含手机 `peer_run` 让电脑执行命令、`peer_get` 从电脑取文件、
  对端 `file.put` 写入电脑）；qr 15、web 21、pair 5、e2e 8、auto 9 全绿。

## v0.5.0 · 对等协作 + 项目会话 + agent 目录（2026-11-13）

- **工具总表**：对外统一 7 个 `peer_*`，两端同名。电脑端共 24 个工具（7 peer + 6 agent +
  `phone_tools`/`phone_tool`/`phone_ask`/`phone_test`/`phone_send_dir`/`phone_build_apk`/`phone_install`/
  `phone_shell_target`/`bridge_log`/`bridge_start`/`bridge_setup`）；手机端另有 `bridge_pair`/`bridge_unpair`/
  `bridge_doctor`/`phone_plan`/`phone_screenshot`。旧名只在内部作别名：电脑端 `src/desktop.mjs:1715`
  （`phone_status`→`peer_info`、`phone_say`→`peer_say`、`phone_shell`→`peer_run`、`phone_send_file`→`peer_put`、
  `phone_fetch_file`→`peer_get`），手机端 `src/phone.mjs:1402` 的 `handlerAliases`。模型工具表和文档里只出现新名。
- **agent 目录**：`src/agents.mjs`。内建两条：`desktop`（电脑模型）/`phone`（手机模型）；用户起的子智能体存在
  `$DSH_HOME/phone-bridge/agents.json`（电脑端是源，手机 spawn 后 `POST /agents/register` 同步）。
  名字 slug 成 id，重名加后缀；`agent_list` 的「运行中」只标同机进程 —— 跨机状态拿不到，不猜。
- **子智能体**：`agent_spawn` 起独立的 `dsh headless --patch thread.patch.yml --json` 进程
  （`src/agent-run.mjs`），上线/完成都往工作台发 `all` 消息；电脑端 detached spawn，`host:"phone"` 时
  转发 `agent.spawn` 给手机执行。`agent_stop` 只 SIGTERM 自己起的，两个内建模型拒绝。
- **收件人过滤**：`src/thread.mjs:106` 的 `read(since, limit, as)` 只返回「`to==='all'`、`to===as`、
  `from===as`」；`waitFor` 以发起方为查看者过滤回复。手机端 `agent_read` 传 `'phone'`，电脑端没传 → 读全量；
  人的 `/workbench` 读全量。JSONL 追加带文件锁，手机侧另有 `thread-phone.json` 缓存。
- **项目会话**：`phone_ask` / `phone_test` 的 `session`（默认 `default`）→ `sessions.json` 的 `sessionId` →
  `--session-id`（`src/phone.mjs:544`）；跑完写回 `{sessionId, at, title: 前 80 字}`（643-649）。映射文件
  `$DSH_HOME/phone-bridge/sessions.json`，同名复用、可手改、删一条就是新会话；不用让用户记 UUID。
- **独立 home**：派给手机的活跑在 `$DSH_HOME/phone-bridge/home`（`askHome()`，`src/phone.mjs:1060`），
  用 `--profile headless` + 从真实 profile 生成的 `headless.patch.yml`（保留 agent-default-model、llm-pi-ai，
  补 `{id: credentials, disabled: false}`），`.credentials.yaml` 软链/复制进去。**为什么不用 App 自己的 home**：
  `phone_ask` 一天可能跑很多次，直接建会话会把用户的 App 会话列表刷满、聊天也乱；独立 home 里建会话，App 列表干净。
- **配对窗口 / 配对码**：`POST /permit` 开 120 秒窗口（可调 10s–10min），`POST /code` 出 6 位数字
  （120 秒、单次）；两个接口只监听 `127.0.0.1`，局域网里的设备不能替电脑开窗。`/hello` 在窗口期接受
  未登记设备，`/auth` 两条路：`code`（校验后立刻作废）或窗口期 `device`（签名 + 首次登记公钥）。
  二维码内容是 `/pair?t=<token>`，配对页把 `dshphone://…` POST 给手机本机 `8789`。
- **App 内不能扫码（如实写）**：dsh-go 插件 `package.json` 的 `wants` 只有 `clipboard`/`draft`，没有相机；
  插件只能做「配对码胶囊」「从剪贴板取配对串」，扫码只能交给系统相机/相机 App。文档写清，不假装能。
- **已知问题**：`test/agents.mjs` 17/18。第二次 `phone_ask`（同 session 续用）超时：`test/agents.mjs:166`
  的 check 落进 catch 记失败，168（`--session-id sess-from-fake` 复用）、169（独立 home）两项没跑到；
  第一次派活和 `sessions.json` 映射本身通过。正在修，目标 18/18。
- **顺手发现的静态问题（未实跑，先记着）**：手机端 `handlerAliases` 方向像是反了 —— `src/phone.mjs:1402`
  写的是 `bridge_say → peer_say`，循环只在 `from` 不存在时补，而 handlers 里只有 `bridge_say`
  （`src/phone.mjs:1506`）、没有 `peer_say`，于是工具表声明了 `peer_say`（1315）但调用会落到
  `未实现：peer_say`（1585）。headless 手机模型不受影响（`src/thread-mcp.mjs` 直接提供）；
  `test/thread.mjs:124` 只查工具名，所以没抓到。真机点一次就能确认。
- **测试**：e2e 8/8（`E2E_ASK=1` 时 9）、pair 5/5、auto 9/9、thread 17/17、qr 15/15、web 21/21、
  agents 17/18。README 的「自测」改成一张命令表。

### 0.5.0 修掉的三个坑

1. `POST /res` 忘了回响应（`src/desktop.mjs` 的 `/res` 分支只 `settle` 就 `return`）。桌面端看着一切正常，手机端每次上报结果都要等 30 秒 fetch 超时才继续轮询——表现为「第一次派活之后手机像卡住了」。已改成 `sendJson(res, 200, { ok: true })`。
2. 桌面端工具名改成 `peer_*` 后，handlers 还是 `phone_info/phone_shell/phone_send_file/phone_fetch_file` 的实现，于是 `peer_info`、`peer_run`、`peer_put`、`peer_get` 一调就报「未实现」。已把实现改名为 `peer_*`，旧的 `phone_*` 只留别名。
3. 手机端同样：`peer_say/peer_converse/peer_read` 只有 `bridge_*` 实现，工具表里却是 `peer_*`，调用报「未实现」。已改名并修正 `handlerAliases` 的方向。

另外 `test/fake-dsh/dsh` 记录 argv 时会把多行 prompt 写进多行，导致「第几次调用」数错；改成把换行压成空格。

## v0.5.1 —— 不用输配对码，改名「互联」

- 新增「请求-允许」配对：手机 `POST /request`（带设备公钥）→ 电脑 `pendingPair` → 电脑卡片显示
  「有手机想连接」→ `POST /pair/approve|deny`（仅本机）→ 登记公钥。手机端 `requestPairOnly()` 只发请求
  不等待，写 `autoUrl` 后由轮询循环自动连上；`requestPair()` 是等待版本（MCP 工具用）。
- `/health` 增加 `pendingPair {name,platform,left}`（5 分钟过期）；`/beacon` 不变。
- 手机端不再需要「配对码胶囊」：composer.actions 换成「连电脑」(bridge-connect，自动找+请求) 与「互联」；
  6 位码只在浏览器配置页或输入框兜底。
- 命名：插件标题、胶囊、面板、web 卡片统一改为「互联 / Link」，去掉「手机桥接」这个只看得到手机的名字。
- 测试：新增 `test/approve.mjs` 6/6（请求→卡片可见→未批准 401→允许→免码连上→拒绝后清空）；
  web 21、thread 17、e2e 8、auto 9、pair 5、qr 15、agents 19 全绿。
- 网络：局域网扫描从「254 主机 × 4 端口、并发 96/128」降到「254 × 2 端口、并发 24、每 8 个歇 20ms」。
  之前那种扫法在便宜的路由器上会让手机 Wi-Fi 短暂卡住（实测有一次断网），别为了快牺牲稳。
- 新增 `test/auto-pair.mjs` 4/4：手机点「连电脑」→ 电脑卡片出现请求 → 点允许 → 手机自动连上、显示在线。

## 待办（用户 2026-11-14 同意，次日做）

### 1. 模拟发消息唤醒会话（电脑端会话）
- 结论（已查 `/opt/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/commands.js:297`）：session controller 的 `prompt(request, source)` 内部 `agent.followup(message)`（`mode:'steer'` 时 `agent.steer`），`source` 形如 `user-rpc`。
- 做法：在电脑端插件（与引擎同进程）加本机路由 `POST /phone-bridge/wake { sessionId, text, mode? }`，内部拿 `ctx.agents` / session controller 调 followup；bridge 端加工具 `peer_wake`（手机侧）/ `phone_wake`（桌面侧 `handleCall` op `agent.wake`）。
- 边界：只能唤醒引擎里存在（或已恢复）的会话；发的是真用户消息会花 token → 配权限开关，默认关。

### 2. 电脑上线通知模型
- 桌面 `/health` 的 `online` 已是 70s 心跳窗口；在 `DesktopBridge` 里监听 online 由 false→true 时，往 thread 追加一条系统消息（`from:'desktop'`，如「电脑上线了」）。
- 手机端 poll 循环里同样检测「电脑上线」；配合 1 里的 wake 就能把休眠模型叫起来。

## 0.5.2（2026-11-14）：唤醒 + 上线通知

- `web/index.js` 新增唤醒：`wakeSession(agents, sessionId, text, mode)` 直接调引擎的 `ctx.agents.get(id)` 再 `agent.followup/steer`（消息形状 `{id, role:'user', content:[{type:'text',text}], source:{kind:'user', rpcId}}`，等价于 `createUserMessage`）；`installWake(ctx)` 用 `ctx.inject(['agents'])` + 3 秒轮询 bridge `/thread`，把 `to==='desktop'` 的新消息投进配置的会话；游标/最近结果存 `wake-state.json`。卡片加「唤醒电脑模型」区块（会话 id 输入 + 开/关 + 试一次），`snapshot().wake` 带 `ready`（agents 服务是否挂上）。
- 配置在 `desktop.json` 的 `wake: {enabled:false, sessionId:'', mode:'queue'}`，默认关。
- 补了 `web/cordis.patch.yml`（0.3.1 打包时漏掉，导致 `dsh plugin add` 后引擎里路由 404——`package.json` 的 `dsh.bundle.patch` 指向它）。
- 上线通知：桌面端 `/poll` 里 `online` 由 false→true 时往 thread 写「（<手机>已连上，可以派活了）」；手机端首次连上写「（手机已连上电脑）」，断线后重置 `announced`。
- 测试：web 27/27（新增 wake 落盘/回读、未开会话提示、followup 收到用户消息形状）、thread 17/17（序号断言改为正则）、agents 19/19、e2e 8/8、auto 9/9、pair 5/5、approve 6/6、auto-pair 4/4、qr 15/15。
- 真引擎验证（`dsh web --port 3103` + 真实 profile）：`/phone-bridge/config` 200，`wake.ready=true`（agents 服务真的挂上了），投递到不存在的会话时正确回「会话 xxx 没开在引擎里」。
- 未做：live 会话里 followup 的端到端验证（需要用户真实打开的会话，卡片「试一次」即可测）。

## 0.6.0（2026-11-14）：自动唤醒，用户只开关

- 关键发现：`@deepseek-ai/dsh-mcp-client` 支持实验能力 `dsh-go/phone-caller`（lib/index.js:141-149）：server 在 `initialize` 的 `capabilities.experimental['dsh-go/phone-caller']` 声明 `v:1`，且 MCP 行配置 `dshGoPhoneCaller: true`（默认 false，schema 在 lib/index.js:862）时，每次 `tools/call` 带 `params._meta['dsh-go/phone-caller'] = {sessionId, runId, callId, ...}`。
- `src/mcp.mjs`：initialize 声明该能力；`tools/call` 把 `_meta` 的 caller 作为第三参数传给 `call(name, args, caller)`。
- `src/desktop.mjs`：`serveMcp` 的 call 里 `if (caller?.sessionId) writeActive(caller.sessionId, {tool, cwd})` → `$DSH_HOME/phone-bridge/active.json`。
- `src/util.mjs`：新增 `activePath/readActive/writeActive`。
- `web/index.js`：唤醒目标改为 `wake.sessionId || active.sessionId`；`snapshot().wake` 增 `target`/`active`；runAction 不再要求填会话 id。
- `web/client.js`：卡片去掉输入框，改成「目标会话（自动）只读 + 开启/关闭自动唤醒 + 排队/插话切换 + 试一次」。
- 配置：`desktop.json` 的 `wake.sessionId` 变成可选覆盖（一般留空，走自动）。MCP 行要加 `dshGoPhoneCaller: true`（`print-patch` 已带上，手机 profile 已加）。
- 测试：新增 `test/mcp.mjs` 5/5（能力声明、caller 透传、无 caller 为 null）；`test/web.mjs` 31/31（自动目标、不填会话投递、模式切换）。

## 0.6.1（2026-11-14）：会话目录 + 流量场景

- `src/sessions.mjs` 新增：`registry.json` 会话目录（touchSession 被动登记 / noteSession 写用途 / resolveSession 按名字或 id 前 8 位解析 / listSessions + formatSessions）。
- 桌面：`session_list`、`session_note` 两个工具；`GET/POST /sessions` 路由（token 或设备签名，loopback 无需额外权限）；`serveMcp` 的 call 里顺手 `touchSession(caller.sessionId, {cwd, tool})`。
- 手机：`bridge_sessions`、`bridge_note` 工具；`peer_say` 加 `to`（默认 desktop，可写 `desktop:<名字>`）。
- 插件：`wakeTick` 按 `to=desktop:<名字>` 用 `resolveNamed()` 找会话再投；`snapshot.registry` 给卡片列出目录；卡片新增「电脑记住的会话」区块。
- 流量场景：`POLL_WAIT` 25s→15s；`pollForever` 前两次失败就地重试，三次才重连；新增 `endpointKindOf()`（lan/cgnat/public/link-local/loopback）并在 `bridge_status`、`bridge_doctor` 里显示「地址类型 + 说明」。
- 测试：新增 `test/sessions.mjs` 10/10；`test/web.mjs` 扩到 36/36（resolveNamed 按名字/用途/id 前缀解析、state.registry）。

## 0.6.2（2026-11-14）：清掉回环残留 + 流量下不扫网段

- 现场问题：手机面板显示「地址 http://127.0.0.1:8787」「电脑：一直重试」「『互联』没有响应」。根因是 `peer.json` 里残留一条 `127.0.0.1:8787` 的 pair（测试遗留），手机连自己 → 永远连不上。
- 修复：`src/peer.mjs` 的 tick 过滤回环 host（127.0.0.1/localhost/::1）；清掉手机 `peer.json` 的那条 pair。
- `src/util.mjs`：`lanAddresses()` 增加 `kind`（wifi/wired/mobile/other，按接口名判断），Wi-Fi 排前面；新增 `ifaceKind()`。
- `src/phone.mjs`：`discover()` 只在 wifi/wired 地址上扫；没有 Wi-Fi（如 rmnet0 移动数据）直接报「现在用的是手机流量…扫不到电脑」而不是空扫 254 个地址。
- 原生插件 `lib/index.js`：banner 文案改为「点『找电脑』…也可以把配对串复制，点输入框上方『连电脑』胶囊」，不再说「粘到下面」。
- README 增「面板里没有输入框」三条路径。

## 0.6.3（2026-11-14）：配置页改成服务端渲染

- 现场问题：电脑上 `http://127.0.0.1:8789/` 白屏，但 `/api/state` 返回完整 JSON。页面的状态行、按钮全靠前端 JS 拼，脚本一旦不执行（旧包 / 被拦 / 缓存）就只剩标题。
- 修复：`src/setup.mjs` 的页面改成**服务端渲染**（`pageHtml(state)`），浏览器不需要 JavaScript 也能看到所有状态、开关和按钮。
  - 操作按钮改为原生表单：`POST /act`（`application/x-www-form-urlencoded`），执行后 303 重定向回 `/?msg=...` 显示结果。
  - 所有按钮共享一个 form（`<button name="id" value="...">`），字段（host/code/pair/say）一起提交。
  - 保留 `/api/state`、`/api/action`（JSON）给插件和测试用。
  - 页面 5 秒自动刷新，给人看的实时状态。
- 测试：`test/auto.mjs` 的「配置页返回 HTML」断言改为匹配 `action="/act"`；web 36、thread 17、agents 19、e2e 8、auto 9 全绿。
- 教训：配置页这种东西不该依赖前端脚本——用户看到的第一个界面必须服务端就能出内容。
