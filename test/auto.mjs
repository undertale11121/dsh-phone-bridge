// Automation test: reconnect without a token after the first pairing.
//   node test/auto.mjs
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { McpChild } from '../src/mcp.mjs'

const root = path.resolve(import.meta.dirname, '..')
const home = path.join(root, 'test', 'home-auto')
const PORT = Number(process.env.E2E_PORT || 8897)

fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(path.join(home, 'phone-bridge'), { recursive: true })
const env = { ...process.env, DSH_HOME: home, PHONE_BRIDGE_SETUP_PORT: '8790' }

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`)
}

function waitFor(list, pattern, timeoutMs = 20000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const match = list.join('\n').match(pattern)
      if (match) {
        clearInterval(timer)
        resolve(match[0])
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`等待 ${pattern} 超时：\n${list.join('\n')}`))
      }
    }, 100)
  })
}

const desktopLog = []
const desktop = new McpChild({
  command: process.execPath,
  args: [path.join(root, 'bridge.mjs'), 'desktop', '--port', String(PORT)],
  env,
  name: 'desktop',
  onStderr: (text) => desktopLog.push(text),
})

const phoneLog = []
let phone = null
const startPhone = () => {
  phoneLog.length = 0
  phone = spawn(process.execPath, [path.join(root, 'bridge.mjs'), 'phone', '--no-mcp'], {
    env: { ...env, PHONE_BRIDGE_SETUP_PORT: '8791' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  phone.stdout.on('data', (chunk) => phoneLog.push(chunk.toString()))
  phone.stderr.on('data', (chunk) => phoneLog.push(chunk.toString()))
}
const stopPhone = async () => {
  phone?.kill()
  await new Promise((resolve) => setTimeout(resolve, 400))
}

try {
  await desktop.start()
  await waitFor(desktopLog, /dshphone:\/\/[^\s]+/)
  const config = JSON.parse(fs.readFileSync(path.join(home, 'phone-bridge', 'desktop.json'), 'utf8'))

  // First contact: the pairing string carries the token.
  fs.writeFileSync(
    path.join(home, 'phone-bridge', 'phone.json'),
    JSON.stringify({ url: `http://127.0.0.1:${PORT}`, token: config.token, autoconnect: true }),
  )
  startPhone()
  await waitFor(phoneLog, /已连接桌面/)
  check('首次配对能连上', true)
  await stopPhone()

  // Second contact: the token is gone, only the URL remains.
  fs.writeFileSync(
    path.join(home, 'phone-bridge', 'phone.json'),
    JSON.stringify({ url: `http://127.0.0.1:${PORT}`, autoconnect: true }),
  )
  startPhone()
  const line = await waitFor(phoneLog, /已连接桌面：.*/)
  check('丢掉 token 也能重连（设备密钥）', line.includes('设备已记住'), line.trim())
  const recorded = JSON.parse(fs.readFileSync(path.join(home, 'phone-bridge', 'desktop.json'), 'utf8'))
  check('桌面记住了设备公钥', Array.isArray(recorded.devices) && recorded.devices.length === 1 && Boolean(recorded.devices[0].pub))

  const tools = await desktop.listTools(30000)
  check('桌面端有 phone_install', tools.some((tool) => tool.name === 'phone_install'))
  check('桌面端有 bridge_start（自动拉起）', tools.some((tool) => tool.name === 'bridge_start'))
  check('桌面端有 bridge_setup（配置页入口）', tools.some((tool) => tool.name === 'bridge_setup'))

  // Graphical setup page: HTML, JSON state, and an action that persists.
  const page = await fetch('http://127.0.0.1:8790/')
  const html = await page.text()
  check('配置页返回 HTML', page.ok && html.includes('手机桥接') && html.includes('action="/act"'))
  const state = await (await fetch('http://127.0.0.1:8790/api/state')).json()
  check('配置页能读出状态', state.role === 'desktop' && state.rows.length > 0 && state.toggles.length >= 4)
  const action = await (
    await fetch('http://127.0.0.1:8790/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'toggle:allowShell:0', fields: {} }),
    })
  ).json()
  const afterToggle = JSON.parse(fs.readFileSync(path.join(home, 'phone-bridge', 'desktop.json'), 'utf8'))
  check('配置页开关能保存', action.ok && afterToggle.allowShell === false)
} catch (error) {
  check('自动重连测试', false, error?.message || String(error))
  if (phoneLog.length) console.log(`—— phone stderr ——\n${phoneLog.join('')}`)
} finally {
  await stopPhone()
  desktop.stop()
}

const passed = results.filter((item) => item.ok).length
console.log(`\n${passed}/${results.length} 通过`)
process.exit(passed === results.length ? 0 : 1)