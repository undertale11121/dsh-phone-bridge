# 交给电脑端：接手说明

这个项目是 **phone-bridge**（插件名「互联 / Link」）：让 DSH 电脑端和手机端（dsh-go）互通，
两边各有同一套工具，两个模型可以互相派活、商量、互传文件和截图。当前版本 **0.6.3**。

手机端已经把代码装好并在跑；电脑端要做的只有三件事：装包、接进 profile、验证。

---

## 1. 装包

解压 `dsh-phone-bridge-0.6.3.zip` 到任意目录，例如 `%USERPROFILE%\phone-bridge\dsh-phone-bridge-0.6.3`。

```powershell
cd "$env:USERPROFILE\phone-bridge\dsh-phone-bridge-0.6.3"
node bridge.mjs doctor        # 自检：应打印两端状态
```

要求：Node >= 20（无第三方依赖，不需要 npm install）。

## 2. 接进电脑端 profile

```powershell
node bridge.mjs print-patch   # 打印一段 YAML
```

把这段 YAML（`- insert: ...` 那几行）追加到 `DSH_HOME\profiles\<profile名>\cordis.patch.yml` 末尾，
**并把 `args:` 里的 `bridge.mjs` 路径改成解压后的真实绝对路径**。

然后装配置卡片：

```powershell
dsh plugin --profile <profile名> add "<解压目录>\web"
```

检查：

```powershell
dsh --profile <profile名> --dump-config | findstr phone-bridge
```

## 3. 重启 DSH，验证

- 配置页：<http://127.0.0.1:8789/>　（服务端渲染，不依赖前端脚本）
- 健康检查：<http://127.0.0.1:8787/health>　应返回 `ok:true`
- 在对话里让模型调用 `peer_info`，能看到手机在线即通。

手机上：连同一个 Wi-Fi → App 输入框上方「互联」胶囊 → 面板里点「找电脑」→ 电脑配置页点
「允许新手机配对（2 分钟）」或等它请求后点「允许」。配对一次后靠设备密钥自动重连。

---

## 目录结构

```
bridge.mjs            入口 CLI：auto / desktop / phone / doctor / pair / print-patch
src/desktop.mjs       电脑端：HTTP 长轮询服务 + MCP 工具（24 个）+ 配置页
src/phone.mjs         手机端：出站轮询客户端 + MCP 工具（21 个）+ 配置页
src/mcp.mjs           零依赖 MCP stdio server / client
src/thread.mjs        共享工作台（JSONL + 文件锁 + 长轮询）
src/sessions.mjs      会话目录（谁在哪个会话做什么）
src/agents.mjs        子智能体目录
src/thread-mcp.mjs    注入 headless 会话的工作台工具
src/agent-run.mjs     子智能体进程
src/peer.mjs          对端发现与重连
src/setup.mjs         图形化配置页（服务端渲染）
src/qr.mjs            二维码编码器（自写，零依赖）
src/pair.mjs          扫码配对页
src/workbench.mjs     「两个模型的对话」网页
src/pubkey.mjs        Ed25519 设备身份
src/util.mjs          地址/文件/日志等工具
web/                  电脑端 DSH 插件卡片（零构建 bundle）
dsh-go-plugin/        手机端 dsh-go 原生插件（已在手机上装好）
test/                 端到端测试：web / thread / agents / e2e / auto / pair / qr / ...
scripts/pack.mjs      打 zip（零依赖）
```

## 测试

```powershell
node test/web.mjs      # 36 项
node test/thread.mjs   # 17 项
node test/agents.mjs   # 19 项
node test/e2e.mjs      # 8 项
node test/auto.mjs     # 9 项
node test/pair.mjs     # 5 项
node test/qr.mjs       # 15 项
```

（`test/e2e.mjs` 带 `E2E_ASK=1` 时会真实调用手机模型，需要模型凭据。）

## 已知限制

- 配对靠局域网发现；手机用移动数据时扫不到电脑，需要隧道地址（如 Tailscale `http://100.x.y.z:8787`）。
- dsh-go 插件协议没有相机、面板没有输入框，所以「App 内扫码」做不到，配对串要用「连电脑」胶囊或浏览器配置页。
- APK 安装遇到「未知来源」授权 / 安装密码框必须人手点一次。
- 电脑/手机模型都叫不醒对方正在休眠的会话，只能留言（peer_say）或等它（peer_converse）。

## 最近改了什么（0.6.3）

- 配置页改为服务端渲染：不再依赖前端脚本，杜绝白屏；按钮改成表单提交（`POST /act`）。
- 配对残留：`peer.json` 里 127.0.0.1 的回环记录导致手机连自己，已禁止写回环。
- 移动数据下不扫整个网段，直接提示原因。
