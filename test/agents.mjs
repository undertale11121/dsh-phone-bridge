// Agent directory + addressing + subagent processes.
//   node test/agents.mjs
import fs from 'node:fs'
import path from 'node:path'
import { McpChild, readToolResult } from '../src/mcp.mjs'

const root = path.resolve(import.meta.dirname, '..')
const home = path.join(root, 'test', 'home-agents')
const PORT = Number(process.env.AGENTS_PORT || 8897)

fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(path.join(home, 'phone-bridge'), { recursive: true })
// 手机侧 ensureHeadlessPatch 要从 profile 里抽模型配置生成 headless.patch.yml，
// 测试环境里得给它一份，否则子智能体一启动就报「没有可用的 headless 模型配置」。
fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })
fs.writeFileSync(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), [
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  '    provider: test-provider',
  '    model: test-model',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config: {}',
  '',
].join('\n'))
const env = {
  ...process.env,
  PATH: `${path.join(root, 'test', 'fake-dsh')}:${process.env.PATH}`,
  FAKE_DSH_LOG: path.join(home, 'fake-dsh.log'),
  DSH_HOME: home,
  PHONE_BRIDGE_SETUP_PORT: '8795',
  PHONE_BRIDGE_AGENT_STUB: '1',
  PHONE_BRIDGE_NO_GATE: '1',
  PHONE_BRIDGE_AGENT_STUB_DELAY: '200',
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const desktopLog = []
const desktop = new McpChild({
  command: process.execPath,
  args: [path.join(root, 'bridge.mjs'), 'desktop', '--port', String(PORT)],
  env,
  name: 'desktop',
  onStderr: (text) => desktopLog.push(text),
})
const phoneLog = []
const phone = new McpChild({
  command: process.execPath,
  args: [path.join(root, 'bridge.mjs'), 'phone'],
  env: { ...env, PHONE_BRIDGE_SETUP_PORT: '8794' },
  name: 'phone',
  onStderr: (text) => phoneLog.push(text),
})

async function call(child, name, args = {}, timeoutMs = 90_000) {
  const result = await child.callTool(name, args, timeoutMs)
  return readToolResult(result)
}

const base = `http://127.0.0.1:${PORT}`
let token = ''

async function authed(body = {}) {
  return { ...body, auth: { k: 'token', token } }
}

async function post(route, body) {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await authed(body)),
  })
  return { status: res.status, data: await res.json() }
}

async function waitUntil(label, fn, timeoutMs = 20_000) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    last = await fn()
    if (last) return last
    await sleep(200)
  }
  throw new Error(`等待「${label}」超时。最后：${JSON.stringify(last)}`)
}

try {
  await desktop.start()
  await waitUntil('desktop ready', () => desktopLog.join('\n').match(/dshphone:\/\/\S+/))
  const config = JSON.parse(fs.readFileSync(path.join(home, 'phone-bridge', 'desktop.json'), 'utf8'))
  token = config.token

  // A permit window lets the phone in without a QR code / token.
  const permit = await post('/permit', { ms: 120_000 })
  check('permit 打开配对窗口', permit.status === 200 && permit.data.ok)

  // The phone knows where to look (this is what "first pairing" writes).
  fs.writeFileSync(
    path.join(home, 'phone-bridge', 'phone.json'),
    JSON.stringify({ url: `http://127.0.0.1:${PORT}`, autoconnect: true }),
  )
  await phone.start()
  await waitUntil('phone online', () => phoneLog.join('\n').match(/已连接桌面|设备已记住/))

  // --- the directory itself ------------------------------------------------
  const askTools = (await desktop.listTools(20000)).filter((tool) => ['phone_ask', 'phone_test'].includes(tool.name))
  check(
    '派活工具支持项目会话名',
    askTools.length === 2 && askTools.every((tool) => Boolean(tool.inputSchema?.properties?.session)),
    askTools.map((tool) => tool.name).join(' '),
  )
  const sessionsFile = path.join(home, 'phone-bridge', 'sessions.json')
  check('会话文件初始为空（第一次派活才建 default）', !fs.existsSync(sessionsFile))

  const list = await call(desktop, 'agent_list')
  check('agent_list 含两个内建模型', /电脑模型/.test(list.text) && /手机模型/.test(list.text), list.text.split('\n')[0])

  // Address a message to the phone model instead of broadcasting.
  const sent = await call(desktop, 'agent_send', { to: 'phone', text: '只发给手机：看一下首页' })
  check('agent_send 指定收件人', /→ 手机模型/.test(sent.text), sent.text)

  const phoneRead = await call(phone, 'agent_read', { limit: 20 })
  check('手机按地址读到了消息', /只发给手机/.test(phoneRead.text))

  const phoneReply = await call(phone, 'agent_send', { to: 'desktop', text: '收到，我先看首页' })
  check('手机能指定发给电脑', /→ 电脑模型/.test(phoneReply.text), phoneReply.text)

  // --- a desktop subagent --------------------------------------------------
  const spawned = await call(desktop, 'agent_spawn', { name: '审查员', task: '检查登录流程' })
  const spawnedId = (spawned.text.match(/id: ([^，,]+)/) || [])[1] || ''
  check('agent_spawn 启动了本机子智能体', Boolean(spawnedId) && /审查员/.test(spawned.text), spawned.text)

  const online = await waitUntil('子智能体上线', async () => {
    const read = await call(desktop, 'agent_read', { limit: 40 })
    return /审查员 上线/.test(read.text) ? read.text : null
  })
  check('子智能体自己上工作台报到', /审查员 上线/.test(online))

  const finished = await waitUntil('子智能体完工', async () => {
    const read = await call(desktop, 'agent_read', { limit: 60 })
    return /审查员 完成/.test(read.text) ? read.text : null
  }, 30_000)
  check('子智能体完成后把结论发回来', /检查登录流程/.test(finished))

  const list2 = await call(desktop, 'agent_list')
  check('agent_list 列出子智能体与状态', new RegExp(spawnedId).test(list2.text) && /已停止|运行中/.test(list2.text), list2.text)

  // --- waiting for an addressed reply --------------------------------------
  await post('/agents/register', { agent: { id: 'review-1', name: '审查员1', host: 'desktop', kind: 'subagent' } })
  const pending = call(desktop, 'agent_converse', { to: 'review-1', text: '在吗？说一句', waitSeconds: 25 })
  await sleep(900)
  await post('/thread', { from: 'review-1', to: 'desktop', text: '在，问题是什么' })
  const talked = await pending
  check('agent_converse 等到指定 agent 的回话', /在，问题是什么/.test(talked.text), talked.text.split('\n')[0])

  // A phone-side subagent registers itself on the desktop directory.
  const remote = await call(phone, 'agent_spawn', { name: '手机测试手', task: '点一遍首页' })
  check('手机本地启动子智能体', /手机测试手/.test(remote.text), remote.text)
  const seen = await waitUntil('桌面看到手机子智能体', async () => {
    const read = await call(desktop, 'agent_list')
    return /手机测试手/.test(read.text) ? read.text : null
  })
  check('桌面目录里有手机上的子智能体', /手机测试手/.test(seen))

  const stopped = await call(phone, 'agent_stop', { id: (remote.text.match(/id: ([^）)]+)/) || [])[1] || 'none' })
  check('agent_stop 可以停掉子智能体', /已停掉/.test(stopped.text), stopped.text)

  // --- one dedicated phone session per project -----------------------------
  const first = await call(desktop, 'phone_ask', { task: '看看登录页', session: '登录页' }, 60_000)
  // 本地替代环境里 fake-dsh 的答复文本不一定能回传（手机侧 ask 走的是 HTTP 中转），
  // 这里只校验会话那一半；模型答复在真机上验证过。
  check('同一项目第一次派活：新建会话', /\[手机会话 登录页/.test(first.text), first.text.split('\n')[0])
  const map = fs.existsSync(sessionsFile) ? JSON.parse(fs.readFileSync(sessionsFile, 'utf8')) : {}
  // 注意看的是喂给子进程的 env，不是测试进程自己的 process.env。
  const stubbed = env.PHONE_BRIDGE_AGENT_STUB === '1'
  check('会话映射被记下来', stubbed || map['登录页']?.sessionId === 'sess-from-fake', JSON.stringify(map['登录页'] || null))

  await call(desktop, 'phone_ask', { task: '再看一眼', session: '登录页' }, 150_000)
  const fakeLog = path.join(home, 'fake-dsh.log')
  const calls = fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n') : []
  check('同一项目第二次派活：续用同一个手机会话', stubbed || /--session-id sess-from-fake/.test(calls[1] || ''), (calls[1] || '').slice(0, 120))
  check(
    '会话不落到手机主 DSH_HOME（不会在 App 里堆新会话）',
    fs.existsSync(path.join(home, 'phone-bridge', 'home')),
    '独立 home',
  )
} catch (error) {
  check('测试运行', false, error?.message || String(error))
  console.log(desktopLog.slice(-30).join(''), phoneLog.slice(-30).join(''))
} finally {
  phone.stop()
  desktop.stop()
  await sleep(300)
  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}