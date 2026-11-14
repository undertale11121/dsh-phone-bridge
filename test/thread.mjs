// Shared workbench + camera-free pairing.
//   node test/thread.mjs
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { McpChild, readToolResult } from '../src/mcp.mjs'
import { scanLan } from '../src/util.mjs'
import { deviceIdOf, sign } from '../src/pubkey.mjs'

const root = path.resolve(import.meta.dirname, '..')
const home = path.join(root, 'test', 'home-thread')
const PORT = Number(process.env.THREAD_PORT || 8898)

fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(path.join(home, 'phone-bridge'), { recursive: true })
const env = { ...process.env, DSH_HOME: home, PHONE_BRIDGE_NO_GATE: '1', PHONE_BRIDGE_SETUP_PORT: '8793' }

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
const startPhone = async () => {
  phoneLog.length = 0
  phone = new McpChild({
    command: process.execPath,
    args: [path.join(root, 'bridge.mjs'), 'phone'],
    env: { ...env, PHONE_BRIDGE_SETUP_PORT: '8792' },
    name: 'phone',
    onStderr: (text) => phoneLog.push(text),
  })
  await phone.start()
}
const stopPhone = async () => {
  phone?.stop()
  await new Promise((resolve) => setTimeout(resolve, 300))
}

const say = async (text) => {
  const res = await fetch('http://127.0.0.1:8792/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'say', fields: { text } }),
  })
  return res.json()
}

try {
  await desktop.start()
  await waitFor(desktopLog, /dshphone:\/\/[^\s]+/)
  const config = JSON.parse(fs.readFileSync(path.join(home, 'phone-bridge', 'desktop.json'), 'utf8'))

  // 1. Camera-free pairing: open the window on the desktop, phone has a URL only.
  const permit = await (
    await fetch(`http://127.0.0.1:${PORT}/permit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  ).json()
  check('电脑端能打开配对窗口', permit.ok && permit.permitLeft > 0)

  fs.writeFileSync(path.join(home, 'phone-bridge', 'phone.json'), JSON.stringify({ url: `http://127.0.0.1:${PORT}`, autoconnect: true }))
  await startPhone()
  const connected = await waitFor(phoneLog, /已连接桌面：.*/)
  check('没 token 也能在配对窗口内连上', connected.includes('已连接桌面'), connected.trim())
  const devices = JSON.parse(fs.readFileSync(path.join(home, 'phone-bridge', 'desktop.json'), 'utf8')).devices || []
  check('窗口期登记了手机公钥', devices.length === 1 && Boolean(devices[0].pub))

  // 2. 6-digit code: a brand-new key pairs with the code alone.
  const issued = await (
    await fetch(`http://127.0.0.1:${PORT}/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  ).json()
  check('能生成 6 位配对码', issued.ok && /^\d{6}$/.test(issued.code))
  // 3. Shared workbench: desktop says, phone reads and answers, desktop converses.
  const said = readToolResult(await desktop.callTool('peer_say', { text: '开始分工：我写代码，你负责真机验证' }, 20000))
  check('电脑模型能往工作台说话', /第 \d+ 条/.test(said.text), said.text.trim())

  const phoneSaid = await say('收到。我先把屏幕截一张看看当前状态')
  check('手机端能往工作台说话', phoneSaid.ok && /第 \d+ 条/.test(phoneSaid.text), phoneSaid.text)

  const read = readToolResult(await desktop.callTool('peer_read', {}, 20000))
  check(
    '两边都能读到同一段对话',
    read.text.includes('开始分工') && read.text.includes('先把屏幕截一张'),
    read.text.split('\n').slice(0, 2).join(' / '),
  )

  // phone answers while the desktop is waiting for it
  const pending = desktop.callTool('peer_converse', { text: '你打算先测什么？', waitSeconds: 20 }, 40000)
  await new Promise((resolve) => setTimeout(resolve, 400))
  await say('先测登录流程，再看设置页')
  const reply = readToolResult(await pending)
  check('电脑等到了手机的回话（一问一答）', reply.text.includes('先测登录流程'), reply.text.split('\n').slice(0, 2).join(' / '))

  // 4. Symmetric tools: the phone can drive the computer just as the computer
  // drives the phone (peer_run / peer_get / peer_info go over POST /call).
  const phoneTools = await phone.listTools(20000)
  const names = phoneTools.map((tool) => tool.name)
  check('手机端有对等的 peer_* 工具', ['peer_info', 'peer_run', 'peer_get', 'peer_put', 'peer_say', 'peer_converse', 'peer_read'].every((n) => names.includes(n)), names.join(' '))

  const phoneInfo = readToolResult(await phone.callTool('peer_info', {}, 20000))
  check('手机能读到电脑状态', /电脑：/.test(phoneInfo.text), phoneInfo.text.split('\n')[0])

  const phoneRan = readToolResult(await phone.callTool('peer_run', { command: 'echo from-phone; uname -s' }, 30000))
  check('手机能让电脑执行命令', /from-phone/.test(phoneRan.text), phoneRan.text.replace(/\n/g, ' | '))

  const pulled = readToolResult(await phone.callTool('peer_get', { path: 'package.json', destPath: path.join(root, 'test', 'home-thread', 'pulled.json') }, 30000))
  check('手机能从电脑取文件', fs.existsSync(path.join(root, 'test', 'home-thread', 'pulled.json')), pulled.text)

  const desktopCall = await fetch(`http://127.0.0.1:${PORT}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'file.put', args: { path: path.join(root, 'test', 'home-thread', 'pushed.txt'), data: Buffer.from('hello from peer').toString('base64') }, auth: { k: 'token', token: config.token } }),
  })
  const putResult = await desktopCall.json()
  check('对端也能把文件写进电脑', putResult.ok && fs.existsSync(path.join(root, 'test', 'home-thread', 'pushed.txt')), putResult.text || putResult.error)

  // 5. The human can read the same conversation: /workbench page + /health link.
  const bench = await fetch(`http://127.0.0.1:${PORT}/workbench?t=${config.token}`)
  const benchHtml = await bench.text()
  check('能打开「两个模型的对话」网页', bench.status === 200 && benchHtml.includes('两个模型的对话') && benchHtml.includes('电脑模型'), `${bench.status} ${benchHtml.length}B`)

  const denied = await fetch(`http://127.0.0.1:${PORT}/workbench?t=nope`)
  check('错的令牌看不到对话', denied.status === 403, String(denied.status))

  const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()
  check('健康检查给出对话页地址', /\/workbench\?t=/.test(health.workbenchUrl || ''), health.workbenchUrl)

  // 6. Discovery helper finds a beacon on an explicit host list.
  const found = await scanLan([PORT], { timeoutMs: 500, hosts: ['127.0.0.1'] })
  check('局域网发现能找到电脑', found.length === 1 && found[0].v === 2, JSON.stringify(found[0] || {}))
} catch (error) {
  check('共享工作台测试', false, error?.message || String(error))
  if (phoneLog.length) console.log(`—— phone ——\n${phoneLog.join('')}`)
} finally {
  await stopPhone()
  desktop.stop()
}

const passed = results.filter((item) => item.ok).length
console.log(`\n${passed}/${results.length} 通过`)
process.exit(passed === results.length ? 0 : 1)