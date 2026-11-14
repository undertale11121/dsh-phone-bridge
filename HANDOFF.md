# 0.6.2 时期的手工装法（已废弃，0.6.3+ 不需要）

0.6.2 分两半：一个仓库目录（引擎 + MCP 行）和一份 web bundle。当时 web bundle 没有发布，
只能手工拷进 profile 的 `node_modules`，再手改 `package.json` / `cordis.patch.yml`。

这套做法已经废弃，原因：

- pnpm 不认手工拷进 `node_modules` 的目录，下次 install 会把它挪到 `node_modules/.ignored`
  （日志里写 `Moving dsh-phone-bridge-web to "node_modules\.ignored\..."`），卡片就没了；
- 手工写 profile 的 `package.json` / `cordis.patch.yml`、在 profile 里跑 pnpm，都不是官方支持的路径；
- MCP 行的 args 是绝对路径，别人装了也用不了。

现在做这件事的正确方式：**整个仓库就是一个 bundle**，用插件页的「添加插件 → 选本地目录」装上，
或者从插件市场装。装完重启一次 DSH 即可。详见 README。