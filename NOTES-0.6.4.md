# 0.6.4 — 一个包就是一个 bundle

0.6.3 之前分两半分装：`C:\Users\17735\.dsh\phone-bridge`（引擎 + MCP 行）和一份手工拷进
profile `node_modules` 的 `dsh-phone-bridge-web`（卡片）。后者被 pnpm 当野文件清掉过两次，
而且别人装了也用不了——MCP 行的 args 是绝对路径，换台机器就错。

0.6.4 把两半合成一个包：

- 根 `package.json` 声明 `dsh.bundle.patch` 和 `dsh.client`，`main`/`exports` 指到 `web/`；
- 根 `cordis.patch.yml` 只插宿主那一行（`id: dsh-phone-bridge`，名字 = 包名）；
- **引擎行自注册**：`web/index.js` 首次加载时找装了本 bundle 的 profile，把
  `@deepseek-ai/dsh-mcp-client` 那一行（args = 本包里 `bridge.mjs` 的绝对路径）追加进去。
  幂等（认 `serverName: phone-bridge`），写前备份 `cordis.patch.yml.bak-autopatch`，
  `PHONE_BRIDGE_NO_AUTOPATCH=1` 可关。装完需要重启一次 DSH。
- 卡片同时挂到新旧两个 bundle key（`dsh-phone-bridge` / `dsh-phone-bridge-web`），升级期间两边都能看到；
- 补了 `locale/{en,zh}.json`（meta.title / meta.description）、`icon.svg`、`LICENSE`、`.gitignore`；
- 测试：`test/web.mjs` 48 项（原 40 项 + 自注册 8 项）。

## 提交到插件市场的差异

收录提的是**骨架**——`package.json` + `cordis.patch.yml` + 引擎行自注册那一小段。
真实实现要从作者的仓库拿。