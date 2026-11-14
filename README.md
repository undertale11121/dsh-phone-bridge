# 互联（dsh-phone-bridge）

让 DSH 桌面端和一台 [DSH Go](https://github.com/ccch1mneyyy/dsh-go) 手机连起来，两端的模型可以互相操作、互相派活。

桌面模型能做的事：读手机屏幕（带可点的元素编号）、点按、输入、按返回/主页/最近任务、打开应用或链接、滚动、剪贴板、发通知、设置闹钟/日程/导航、长列表收集、把某一步交给用户手动做。也能在手机上调 `peer_run` 跑 shell、`peer_put`/`peer_get` 传文件。
反向也行：手机模型有自己的操控和 shell 能力，可以把整个任务派给电脑这边跑（`phone_ask`），跑完把结果送回来；两边还能就一件事一轮一轮商量（`peer_converse`）。

## 装

需要 DSH 桌面端（`>=0.2.1-rc.2 <0.3.0-0`）和 Node 20 以上。

**手机端先装 [DSH Go](https://github.com/ccch1mneyyy/dsh-go)**：Android 8+，作者 [ccch1mneyyy](https://github.com/ccch1mneyyy)，是 DeepSeek Harness 的第三方手机客户端。第一次打开时让它装好内置 Linux 环境（约 1 GB，不需要 root），本插件的手机那一半就跑在里面。

**从插件市场装**：在「插件市场」里点安装，装完**重启一次 DSH**。第一次启动时 bundle 会自己把引擎那一行（`bridge.mjs` 的绝对路径）补进当前 profile 的 `cordis.patch.yml`，所以第二次启动后 `mcp__phone-bridge__*` 工具才出现。补丁写前会留一份 `cordis.patch.yml.bak-autopatch`。

不想让它自动改 profile，就先设环境变量 `PHONE_BRIDGE_NO_AUTOPATCH=1`，然后自己生成那一段：

```bash
npx dsh-phone-bridge print-patch     # 打印要加进 profile 的 YAML
```

**从源码装**：把整个目录当成一个 bundle 装（插件页 → 添加插件 → 选本地目录），其余同上。

## 会话级开关

连上之后，**每个会话自己决定要不要和手机通**：

- 在任意会话的标题栏点 **🔗 互联**，按钮变蓝显示「互联中」，这个会话就接上了。
- 手机侧会为它自动开一个**对应的会话**（已存在就复用）。一个电脑会话配一个手机会话，不同会话的对话不会串在一起。
- 没开开关的会话，互联工具一律不可用，模型不会在你没授权的会话里乱发消息。
- 关掉开关只是断开会话，连接本身不受影响。

之后两边的模型直接说话就行，不用在面板里选来选去。

## 连手机

1. 桌面端点开左栏的 **「互联」**（或者在「插件」→ dsh-phone-bridge 详情页上看同一张卡片）。
2. 扫上面的二维码，或者把配对串复制到手机上：`npx dsh-phone-bridge pair <配对串>`。
3. 手机端跑起来之后，卡片上会显示在线的设备。

配置页上能改的：监听地址/端口、四个开关（允许手机执行命令 / 允许手机调用电脑模型 / 允许传文件 / 允许跑自测）、以及「自动唤醒」——把手机会话来的消息投递到某个已经开着的桌面会话里。

## 工具一览

桌面模型可以用：

| 工具 | 做什么 |
| --- | --- |
| `peer_info` | 手机在不在线、什么设备 |
| `peer_run` | 在手机 Linux 环境里跑一条 shell |
| `peer_put` / `peer_get` | 往手机送文件 / 从手机取文件 |
| `phone_tool` | 手机操控：`screen`/`tap`/`tap_xy`/`type`/`key`/`open`/`apps`/`scroll`/`intent`/`notify`/`clipboard`/`collect`/`handoff` |
| `phone_tools` | 手机当前有哪些操控工具及其参数 |
| `phone_ask` | 把整个任务交给手机自己的模型，等它交回答 |
| `phone_test` | 让手机模型自测一个网页/APK/应用，交回报告和截图 |
| `phone_install` / `phone_build_apk` / `phone_send_dir` | 装 APK、在手机上构建、把项目目录推过去 |
| `bridge_start` / `bridge_setup` / `bridge_log` | 启动后台服务、打开配置页、看日志 |
| `peer_say` / `peer_converse` / `peer_read` | 和手机模型轮流说话 |
| `agent_list` / `agent_spawn` / `agent_converse` / `agent_send` / `agent_stop` / `agent_read` | 电脑/手机两边的子智能体 |

## 自检与测试

```bash
node bridge.mjs doctor     # 环境、配对、端口、补丁是否就位
npm test                   # web bundle 的 65 项检查，不起浏览器
npm run test:all           # 再跑 auto / pair / qr
```

## 已知限制

- 手机端要有 dsh-go 的 Linux 环境（`/opt/dsh-app/phone/` 下能跑 node），配对靠局域网，跨网段需要自己打通。
- 引擎那一行是 bundle 首次加载时补进去的：装完必须**重启一次** DSH，工具才会挂上来。
- `bridge.mjs auto` 在手机上会走 `phone` 角色、在电脑上走 `desktop` 角色；同一段补丁两端通用。
- Windows 上如果 agent shell 用 MSYS bash，路径写成 `/d/repo` 这种形式。

## 许可与致谢

MIT。图标与源码均为本仓库原创。

手机端宿主是 [DSH Go](https://github.com/ccch1mneyyy/dsh-go)（AGPL-3.0，作者 [ccch1mneyyy](https://github.com/ccch1mneyyy)）——DeepSeek Harness 的第三方 Android 客户端。本插件以它的插件协议和内置 Linux 环境为宿主，**不包含、也不修改它的任何代码**；`dsh-go-plugin/` 下是我们自己写的插件，不是你项目代码的衍生。

桌面端宿主是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。