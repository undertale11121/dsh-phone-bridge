// Verifies the phone-side MCP tools (bridge_pair / bridge_status) that the phone
// model uses after install: nothing pre-paired, pairing must be done by tool call.
import fs from 'node:fs'
import path from 'node:path'
import { McpChild, readToolResult } from '../src/mcp.mjs'
import { sleep } from '../src/util.mjs'

const root = path.resolve(import.meta.dirname, '..')
const home = path.join(root, 'test', 'home-pair')
const PORT = Number(process.env.E2E_PORT || 8901)

fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(path.join(home, 'phone-bridge'), { recursive: true })
const env = { ...process.env, DSH_HOME: home, PHONE_BRIDGE_NO_GATE: '1' }

const desktopLog = []
const desktop = new McpChild({
  command: process.execPath,
  args: [path.join(root, 'bridge.mjs'), 'desktop', '--port', String(PORT)],
  env,
  name: 'desktop',
  onStderr: (text) => desktopLog.push(text),
})

function waitFor(list, pattern, timeoutMs = 15000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const match = list.join('\n').match(pattern)
      if (match) {
        clearInterval(timer)
        resolve(match[0])
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`等待超时：${list.join('\n')}`))
      }
    }, 100)
  })
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`)
}

let phone = null
try {
  await desktop.start()
  const pair = await waitFor(desktopLog, /dshphone:\/\/[^\s]+/)

  const phoneLog = []
  phone = new McpChild({
    command: process.execPath,
    args: [path.join(root, 'bridge.mjs'), 'phone'],
    env,
    name: 'phone',
    onStderr: (text) => phoneLog.push(text),
  })
  await phone.start()

  const tools = await phone.listTools()
  const names = tools.map((tool) => tool.name)
  check('手机端 MCP 暴露 bridge 工具', ['bridge_status', 'bridge_pair', 'bridge_unpair'].every((n) => names.includes(n)), names.join(','))

  const before = readToolResult(await phone.callTool('bridge_status', {}))
  check('未配对时状态为假', /配对：否/.test(before.text), before.text.split('\n')[0])

  const paired = readToolResult(await phone.callTool('bridge_pair', { pair }))
  check('bridge_pair 保存配对', /已保存配对|已连接电脑/.test(paired.text), paired.text)

  await waitFor(phoneLog, /已连接桌面/)
  await sleep(500)
  const after = readToolResult(await phone.callTool('bridge_status', {}))
  check('配对后 status 显示在线', /在线：是/.test(after.text), after.text.split('\n').slice(0, 3).join(' | '))

  const ping = readToolResult(await desktop.callTool('peer_info', {}))
  check('桌面看到手机在线', /在线：是/.test(ping.text), ping.text.split('\n')[0])
} catch (error) {
  check('配对测试执行', false, error?.message || String(error))
  console.log(desktopLog.slice(-6).join('\n'))
} finally {
  desktop.stop()
  phone?.stop()
  await sleep(200)
  const failed = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  if (failed) process.exitCode = 1
}