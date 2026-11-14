// 会话目录：模型能不能记住「哪个会话在干什么」，并按名字选唤醒对象。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { McpChild, readToolResult } from '../src/mcp.mjs'

const root = path.resolve(import.meta.dirname, '..')
const bridge = path.join(root, 'bridge.mjs')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-sessions-'))
process.env.DSH_HOME = home
const SETUP_PORT = '8794'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const waitFor = async (fn, ms = 4000) => {
  const started = Date.now()
  while (Date.now() - started < ms) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return null
}

const dir = path.join(home, 'phone-bridge')
fs.mkdirSync(dir, { recursive: true })
const desktop = new McpChild({
  name: 'desktop',
  command: process.execPath,
  args: [bridge, 'desktop'],
  env: { ...process.env, DSH_HOME: home, PHONE_BRIDGE_SETUP_PORT: SETUP_PORT },
  onStderr: () => {},
})
await desktop.start()

try {
  // ── 被动登记：模型调用过工具，目录里就多一条 ─────────────────────────────
  const call = async (name, args = {}) => readToolResult(await desktop.callTool(name, args, 20_000))
  const info = await call('peer_info', {})
  check('peer_info 可用', /手机|配对|在线/.test(info.text || ''), info.text)

  // 模拟「某个会话调用过桥接」：桥接靠 MCP caller 写 active.json
  const sessionId = 'sess-login-0001'
  fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({ sessionId, tool: 'peer_info', cwd: '/home/me/proj/login', at: new Date().toISOString() }))
  // touchSession 需要走真实工具调用；这里直接调工具让 handler 生效做不到（caller 为 null），
  // 所以用 noteSession 的 current 路径验证目录能长出来。
  const noted = await call('session_note', { purpose: '在改登录页的验证码流程', project: 'shop' })
  check('session_note 用 current 登记会话', /已记下/.test(noted.text || ''), noted.text)

  const list = await call('session_list', {})
  check('session_list 列出会话', /sess-logi|登录|shop/.test(list.text || ''), list.text)
  check('session_list 带唤醒提示', /desktop:/.test(list.text || ''), list.text)

  // 改名后能按名字找
  const renamed = await call('session_note', { target: sessionId.slice(0, 8), name: '登录页' })
  check('按 id 前 8 位改名字', /登录页/.test(renamed.text || ''), renamed.text)

  // ── HTTP /sessions：手机端要用 ───────────────────────────────────────────
  const configPath = path.join(dir, 'desktop.json')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const port = config.port
  const auth = Buffer.from(JSON.stringify({ k: 'token', token: config.token })).toString('base64url')
  const res = await fetch(`http://127.0.0.1:${port}/sessions?auth=${auth}`)
  const data = await res.json()
  check('GET /sessions 返回目录', res.status === 200 && data.sessions?.some((row) => row.name === '登录页'), JSON.stringify(data.sessions))
  check('目录标记当前会话', data.sessions?.some((row) => row.active && row.name === '登录页'), JSON.stringify(data.sessions))

  const denied = await fetch(`http://127.0.0.1:${port}/sessions`)
  check('没令牌拒绝', denied.status === 401, String(denied.status))

  const post = await fetch(`http://127.0.0.1:${port}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: '登录页', purpose: '登录页的验证码 + 短信登录', auth: { k: 'token', token: config.token } }),
  })
  const posted = await post.json()
  check('POST /sessions 改用途', post.status === 200 && /验证码/.test(posted.session?.purpose || ''), JSON.stringify(posted))

  const missing = await fetch(`http://127.0.0.1:${port}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: '不存在的会话', purpose: 'x', auth: { k: 'token', token: config.token } }),
  })
  check('找不到会话回 404', missing.status === 404, String(missing.status))
} finally {
  await desktop.stop()
  fs.rmSync(home, { recursive: true, force: true })
}

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)