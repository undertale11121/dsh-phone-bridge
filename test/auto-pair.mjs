// End-to-end: the phone asks once ("连电脑"), the desktop shows the request,
// its user taps 允许, and the phone connects by itself — no code, no token.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const home = path.join(root, 'test', 'home-autopair')
const DESK_PORT = Number(process.env.AUTOPAIR_PORT || 8904)
const SETUP_PORT = Number(process.env.AUTOPAIR_SETUP || 8795)

fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(path.join(home, 'phone-bridge'), { recursive: true })
fs.writeFileSync(path.join(home, 'phone-bridge', 'phone.json'), JSON.stringify({ port: DESK_PORT }))

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`)
}

const health = async () => (await fetch(`http://127.0.0.1:${DESK_PORT}/health`)).json()
const post = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  return { status: res.status, data: await res.json().catch(() => null) }
}
const waitFor = (list, pattern, timeoutMs) => {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const match = list.join('\n').match(pattern)
      if (match) {
        clearInterval(timer)
        resolve(match[0])
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`等待超时：${list.join('\n').slice(-800)}`))
      }
    }, 200)
  })
}

const procs = []
const start = (args, env, onStderr, keepStdin = false) => {
  // The phone half is an MCP server: closing stdin makes it exit, so keep a pipe.
  const child = spawn(process.execPath, args, { env, stdio: [keepStdin ? 'pipe' : 'ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', (buf) => onStderr?.(String(buf)))
  procs.push(child)
  return child
}

try {
  const deskLog = []
  start([path.join(root, 'bridge.mjs'), 'desktop', '--serve', '--port', String(DESK_PORT)], { ...process.env, DSH_HOME: home, PHONE_BRIDGE_NO_GATE: '1', PHONE_BRIDGE_LOG: path.join(home, 'bridge.log') }, (text) => deskLog.push(text))
  const startedAt = Date.now()
  while (Date.now() - startedAt < 15_000) {
    try {
      if ((await health()).ok) break
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  const phoneLog = []
  const phoneEnv = { ...process.env, DSH_HOME: home, PHONE_BRIDGE_NO_GATE: '1', PHONE_BRIDGE_SETUP_PORT: String(SETUP_PORT) }
  start([path.join(root, 'bridge.mjs'), 'phone'], phoneEnv, (text) => phoneLog.push(text), true)
  // wait for its config page
  const pageAt = Date.now()
  while (Date.now() - pageAt < 20_000) {
    try {
      const res = await fetch(`http://127.0.0.1:${SETUP_PORT}/api/state`)
      if (res.ok) break
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  const asked = await post(`http://127.0.0.1:${SETUP_PORT}/api/action`, { id: 'connect', fields: { host: '127.0.0.1', port: DESK_PORT } })
  check('手机点一下就发出配对请求（不用输码）', /已发出配对请求/.test(asked.data?.text || ''), asked.data?.text)

  const pending = (await health()).pendingPair
  check('电脑卡片能看到是谁想连', Boolean(pending?.name), JSON.stringify(pending))

  await post(`http://127.0.0.1:${DESK_PORT}/pair/approve`, {})
  const connected = await waitFor(phoneLog, /已连接桌面：/, 20_000)
  check('电脑点允许后手机自动连上', connected.includes('已连接桌面'), connected.trim().slice(0, 80))

  const online = (await health()).online
  check('电脑端显示手机在线', online === true, String(online))
} catch (error) {
  check('一键配对端到端', false, error?.message || String(error))
} finally {
  for (const child of procs) child.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 500))
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)