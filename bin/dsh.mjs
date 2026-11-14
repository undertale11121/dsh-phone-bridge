// dsh CLI 的转发器。
//
// DSH Desktop 里没有独立的 dsh 命令，@deepseek-ai/dsh 的 bin.js 在 app.asar 内部，
// 而 ELECTRON_RUN_AS_NODE 只能在**启动** Electron 时设置 —— 所以这里用 node 跑，
// 由它去拉起 Electron（node 模式）+ asar 内的 bin.js。
//
// 用法：node bin/dsh.mjs headless --patch x.yml --json "任务"
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const ELECTRON = process.env.DSH_ELECTRON || 'D:\\c\\DEEPSEEK\\DeepSeek Harness.exe'
const ASAR_BIN = process.env.DSH_ASAR_BIN || 'D:\\c\\DEEPSEEK\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'

if (!fs.existsSync(ELECTRON)) {
  console.error(`找不到 DSH Desktop 的可执行文件：${ELECTRON}（用 DSH_ELECTRON 指定）`)
  process.exit(127)
}
if (!fs.existsSync(ASAR_BIN)) {
  console.error(`找不到 dsh CLI：${ASAR_BIN}（用 DSH_ASAR_BIN 指定）`)
  process.exit(127)
}

const child = spawn(ELECTRON, [ASAR_BIN, ...process.argv.slice(2)], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
  windowsHide: true,
})
child.on('error', (error) => {
  console.error(`启动 dsh 失败：${error?.message || error}`)
  process.exit(126)
})
child.on('close', (code, signal) => {
  if (signal) process.exit(1)
  process.exit(code ?? 0)
})