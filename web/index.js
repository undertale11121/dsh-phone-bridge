// Host half of the desktop UI: one route the card on the Plugins page reads and
// writes. Self-contained on purpose — the card ships as its own bundle, gets
// copied into the profile's node_modules, and must never import ../src/*: the
// engine side lives in the phone-bridge folder the MCP row points at.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'phone-bridge-web'

const MAX_BODY = 32 * 1024
const TOGGLES = ['allowShell', 'allowAsk', 'allowFiles', 'allowTest']

export function dshHome() {
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME)
  return path.join(os.homedir(), '.dsh')
}

export function bridgeDir() {
  return path.join(dshHome(), 'phone-bridge')
}

const configPath = () => path.join(bridgeDir(), 'desktop.json')
const lockPath = () => path.join(bridgeDir(), 'desktop.lock')
const logPath = () => path.join(bridgeDir(), 'bridge.log')

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
}

function defaults() {
  return {
    token: '',
    port: 8787,
    host: '0.0.0.0',
    name: os.hostname(),
    allowShell: true,
    allowAsk: true,
    allowFiles: true,
    allowTest: true,
    devices: [],
    peers: [],
    bridge: '',
    toolTimeoutMs: 1800000,
  }
}

export function readConfig() {
  const existing = readJson(configPath(), null)
  const config = existing && existing.token ? { ...defaults(), ...existing } : { ...defaults(), token: crypto.randomBytes(16).toString('hex') }
  if (!existing || !existing.token) writeJson(configPath(), config)
  if (process.env.PHONE_BRIDGE_PORT) config.port = Number(process.env.PHONE_BRIDGE_PORT)
  if (process.env.PHONE_BRIDGE_BIN && !config.bridge) config.bridge = process.env.PHONE_BRIDGE_BIN
  return config
}

function readLogTail(maxLines = 8) {
  try {
    const text = fs.readFileSync(logPath(), 'utf8')
    return text.trimEnd().split('\n').slice(-maxLines)
  } catch {
    return []
  }
}

async function probe(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function ensureServer(config) {
  const running = await probe(config.port, 800)
  if (running?.ok) {
    const lock = readJson(lockPath(), null)
    return { pid: lock?.pid || 0, port: config.port, pairing: running.pairing || [] }
  }
  const lock = readJson(lockPath(), null)
  if (lock?.port && pidAlive(lock.pid) && (await probe(lock.port, 800))?.ok) return { pid: lock.pid, port: lock.port, pairing: lock.pairing || [] }
  const bridge = config.bridge
  if (!bridge || !fs.existsSync(bridge)) {
    throw new Error('还没找到 bridge.mjs（先在电脑的 DSH 里跑一次 bridge_start，或手动执行 node bridge.mjs desktop --serve）')
  }
  fs.mkdirSync(bridgeDir(), { recursive: true })
  const child = spawn(process.execPath, [bridge, 'desktop', '--serve', '--port', String(config.port)], {
    detached: true,
    stdio: 'ignore',
    cwd: path.dirname(bridge),
    env: { ...process.env, PHONE_BRIDGE_LOG: logPath() },
  })
  child.unref()
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const health = await probe(config.port, 600)
    if (health?.ok) return { pid: child.pid, port: config.port, pairing: health.pairing || [] }
  }
  throw new Error(`后台桥接没能在 8 秒内启动，看日志：${logPath()}`)
}

// The same bundle can be installed on either machine. On the phone the useful
// controls live in the App's native panel, so the card says so instead of
// offering desktop toggles that would mean nothing there.
export function isPhone() {
  if (process.env.PHONE_BRIDGE_ROLE) return process.env.PHONE_BRIDGE_ROLE === 'phone'
  return fs.existsSync('/opt/dsh-app/phone/relay.cjs') || fs.existsSync('/var/lib/dsh-app/phone/bridge.json') || fs.existsSync('/sdcard')
}

// First non-internal IPv4, i.e. the address the phone has to dial.
function lanAddresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item && !item.internal && item.family === 'IPv4' && !item.address.startsWith('169.254.')) out.push(item.address)
    }
  }
  return out
}

function fallbackPairUrl(config) {
  const [first] = lanAddresses()
  return `http://${first || '127.0.0.1'}:${config.port}/pair?t=${config.token}`
}

// The QR encoder lives with the engine half (src/qr.mjs); the bundle finds it
// through the bridge path the engine writes into desktop.json.
async function qrSvgFor(config, text) {
  const bridge = config.bridge
  if (!bridge) throw new Error('还没记录 bridge.mjs 路径，先启动一次桥接')
  const file = path.join(path.dirname(bridge), 'src', 'qr.mjs')
  if (!fs.existsSync(file)) throw new Error(`找不到 ${file}`)
  const { qrSvg } = await import(pathToFileURL(file).href)
  return qrSvg(text, { margin: 3, label: '配对手机' })
}

function readThread(limit = 4) {
  try {
    const file = path.join(path.dirname(configPath()), 'thread.jsonl')
    const rows = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row && typeof row.text === 'string')
    return { total: rows.length, messages: rows.slice(-limit) }
  } catch {
    return { total: 0, messages: [] }
  }
}

// sessions.json: one dedicated phone session per project, keyed by session name.
// A missing or broken file simply means "no work dispatched yet".
function readSessions() {
  const rows = readJson(path.join(bridgeDir(), 'sessions.json'), {})
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return []
  return Object.entries(rows)
    .filter(([, item]) => item && typeof item === 'object')
    .map(([name, item]) => ({
      name,
      sessionId: String(item.sessionId || '').slice(0, 8),
      at: item.at || '',
      title: item.title || '',
    }))
}

// agents.json: the agents the phone may talk to. src/agents.mjs keeps it as
// `{ agents: [...] }`; a bare array is accepted too so a hand-written file
// still shows up. Only the fields the card needs survive.
function readAgents() {
  const data = readJson(path.join(bridgeDir(), 'agents.json'), [])
  const rows = Array.isArray(data) ? data : Array.isArray(data?.agents) ? data.agents : []
  return rows
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: String(item.id || ''),
      name: item.name || 'agent',
      host: item.host === 'phone' ? 'phone' : 'desktop',
      kind: item.kind === 'subagent' ? 'subagent' : 'model',
      // The file records a pid, not liveness, for subagents it started.
      running: typeof item.running === 'boolean' ? item.running : pidAlive(item.pid),
    }))
}

async function snapshot() {
  const config = readConfig()
  let background = null
  let error = ''
  try {
    background = await ensureServer(config)
  } catch (err) {
    error = String(err?.message || err)
  }
  const health = await probe(background?.port || config.port)
  const lock = readJson(lockPath(), null)
  return {
    role: isPhone() ? 'phone' : 'desktop',
    online: Boolean(health?.online),
    device: health?.device || null,
    port: health?.port || background?.port || config.port,
    listen: `${config.host}:${config.port}`,
    background: background ? { pid: background.pid, port: background.port } : null,
    pairing: health?.pairing?.length ? health.pairing : Array.isArray(lock?.pairing) ? lock.pairing : [],
    pairUrl: health?.pairUrl || (config.token ? fallbackPairUrl(config) : ''),
    workbenchUrl: health?.workbenchUrl || '',
    permitLeft: Number(health?.permitLeft || 0),
    pendingPair: health?.pendingPair || null,
    code: Number(health?.codeLeft || 0) > 0 ? '' : '',
    thread: readThread(4).messages,
    toggles: Object.fromEntries(TOGGLES.map((key) => [key, config[key] !== false])),
    devices: (config.devices || []).map((item) => ({
      id: String(item.id || '').slice(0, 8),
      name: item.name || '手机',
      platform: item.platform || '',
      at: item.at || '',
    })),
    sessions: readSessions(),
    wake: {
      ...readWake(config),
      ...readWakeState(),
      ready: Boolean(agentsRef),
      target: readWake(config).sessionId || readActive()?.sessionId || '',
      targetName: (() => {
        // 三步退化，都用真实信息，不猜人名：
        //   ① registry 里登记过的名字  ② 活会话的 cwd 目录名  ③ id 前 8 位
        const id = readWake(config).sessionId || readActive()?.sessionId || ''
        if (!id) return ''
        const row = sessionRows().find((item) => item.id === id)
        if (row && row.name) return row.name
        const liveRow = listLiveSessions().find((item) => item.id === id)
        const base = liveRow?.cwd ? path.basename(liveRow.cwd) : ''
        return base ? `${base} · ${id.slice(0, 8)}` : id.slice(0, 8)
      })(),
      active: readActive(),
    },
    // 会话目录：模型可以按用途挑唤醒对象（peer_say 的 to 写 desktop:<名字>）
    registry: sessionRows(),
    // 引擎里正开着的会话（内存态，重启就没了）。排查「为什么没投出去」时看这个。
    live: listLiveSessions(),
    // 协作对：电脑会话 × 手机会话，面板上两排下拉读写它。
    collab: readCollab(config),
    agents: readAgents(),
    log: readLogTail(8),
    configPath: configPath(),
    error,
  }
}

async function runAction(body) {
  const config = readConfig()
  if (body.action === 'toggle') {
    const key = String(body.key || '')
    if (!TOGGLES.includes(key)) throw new Error('不认识的开关')
    config[key] = Boolean(body.value)
    writeJson(configPath(), config)
    return { text: `已${config[key] ? '允许' : '关闭'} ${key}` }
  }
  if (body.action === 'token') {
    config.token = crypto.randomBytes(16).toString('hex')
    writeJson(configPath(), config)
    return { text: '已换新配对串；登记过的手机仍会用设备密钥重连' }
  }
  if (body.action === 'permit' || body.action === 'code') {
    const info = await ensureServer(config)
    const res = await fetch(`http://127.0.0.1:${info.port}/${body.action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(4000),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
    if (body.action === 'permit') return { text: `配对窗口已打开，${Math.round((data.permitLeft || 0) / 1000)} 秒内手机可以直接连上` }
    return { text: `配对码：${data.code}（2 分钟内有效）`, code: data.code }
  }
  if (body.action === 'approve' || body.action === 'deny') {
    const info = await ensureServer(config)
    const res = await fetch(`http://127.0.0.1:${info.port}/pair/${body.action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(4000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) throw new Error(data?.error || `HTTP ${res.status}`)
    if (body.action === 'approve') return { text: `已允许 ${data?.device?.name || '这台手机'} 连接` }
    return { text: '已拒绝这次配对请求' }
  }
  if (body.action === 'wake') {
    const wake = readWake(config)
    if (typeof body.enabled === 'boolean') wake.enabled = body.enabled
    if (typeof body.sessionId === 'string') wake.sessionId = body.sessionId.trim()
    if (body.mode === 'steer' || body.mode === 'queue') wake.mode = body.mode
    config.wake = wake
    writeJson(configPath(), config)
    if (typeof body.text === 'string' && body.text.trim()) {
      const agents = wakeAgents()
      if (!agents) return { text: '设置已保存；引擎里还没挂上 agents 服务，等一会儿再试' }
      const target = wake.sessionId || readActive()?.sessionId || ''
      if (!target) throw new Error('还没有模型调用过互联工具，所以不知道唤哪个会话；让电脑模型用一次 peer_info 再试')
      const result = await wakeSession(agents, target, body.text.trim(), wake.mode)
      const state = readWakeState()
      state.lastWake = result
      state.lastError = ''
      writeWakeState(state)
      return { text: `已把消息投进会话 ${target.slice(0, 8)}…（${result.mode}）` }
    }
    const auto = wake.sessionId || readActive()?.sessionId || ''
    return { text: `唤醒：${wake.enabled ? '开' : '关'}${auto ? `，会话 ${auto.slice(0, 8)}…` : '，还没记录到会话'}` }
  }
  if (body.action === 'collab') {
    const collab = readCollab(config)
    if (typeof body.desktopSessionId === 'string') collab.desktopSessionId = body.desktopSessionId.trim()
    if (typeof body.phoneSessionId === 'string') collab.phoneSessionId = body.phoneSessionId.trim()
    if (typeof body.phoneName === 'string') collab.phoneName = body.phoneName.trim()
    config.collab = collab
    // 钉了电脑会话就等于告诉唤醒器「投给它」，不用再让用户去另一个开关里填一遍。
    if (collab.desktopSessionId) {
      const wake = readWake(config)
      wake.sessionId = collab.desktopSessionId
      wake.enabled = true
      config.wake = wake
    }
    writeJson(configPath(), config)
    const parts = []
    parts.push(collab.desktopSessionId ? `电脑会话 ${collab.desktopSessionId.slice(0, 8)}…` : '电脑会话未选')
    parts.push(collab.phoneSessionId ? `手机会话 ${(collab.phoneName || collab.phoneSessionId).slice(0, 16)}` : '手机会话未选')
    return { text: `协作对已保存：${parts.join(' · ')}` }
  }
  if (body.action === 'start') {
    const info = await ensureServer(config)
    return { text: `后台服务在跑：pid ${info.pid}，端口 ${info.port}` }
  }
  throw new Error(`不认识的操作：${body.action}`)
}

const WAKE_DEFAULTS = { enabled: false, sessionId: '', mode: 'queue' }

// 协作对：用户在这里点名「电脑的哪个会话」×「手机的哪个会话」。
// 两边都钉死之后，消息就不再是丢在工作台上等人来取，而是直接投进对方会话。
const COLLAB_DEFAULTS = { desktopSessionId: '', phoneSessionId: '', phoneName: '' }

function readCollab(config) {
  return { ...COLLAB_DEFAULTS, ...((config || readConfig()).collab || {}) }
}

let agentsRef = null

const wakeAgents = () => agentsRef

const wakeStatePath = () => path.join(bridgeDir(), 'wake-state.json')
const activePath = () => path.join(bridgeDir(), 'active.json')
const registryPath = () => path.join(bridgeDir(), 'registry.json')

// 会话目录（src/sessions.mjs 维护）。插件是自包含的，所以这里自己读同一份 JSON。
function readRegistry() {
  const value = readJson(registryPath(), null)
  return value && value.sessions ? value : { sessions: {} }
}

function sessionRows() {
  const active = readActive()?.sessionId || ''
  return Object.values(readRegistry().sessions || {})
    .map((row) => ({
      id: row.id,
      short: String(row.id).slice(0, 8),
      name: row.name || '',
      purpose: row.purpose || '',
      project: row.project || '',
      calls: row.calls || 0,
      at: row.ast || row.at || '',
      active: row.id === active,
    }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

// "登录页" / "3f9a2b1c" / 用途里的词 → 一个会话
export function resolveNamed(name) {
  const wanted = String(name || '').trim().toLowerCase()
  if (!wanted) return null
  const rows = sessionRows()
  return (
    rows.find((row) => String(row.name).toLowerCase() === wanted) ||
    rows.find((row) => String(row.short).startsWith(wanted) || String(row.id).startsWith(wanted)) ||
    rows.find((row) => String(row.purpose).toLowerCase().includes(wanted)) ||
    null
  )
}

function readActive() {
  const value = readJson(activePath(), null)
  return value && value.sessionId ? value : null
}

function readWake(config = readConfig()) {
  return { ...WAKE_DEFAULTS, ...(config.wake || {}) }
}

function readWakeState() {
  const state = readJson(wakeStatePath(), {})
  return {
    cursor: Number(state.cursor || 0),
    lastWake: state.lastWake || null,
    lastError: String(state.lastError || ''),
  }
}

function writeWakeState(value) {
  writeJson(wakeStatePath(), value)
}

/**
 * Deliver one user message into a live Session through the engine's own agent
 * service, the same path the Web UI uses.
 */
export async function wakeSession(agents, sessionId, text, mode = 'queue') {
  const agent = agents?.get?.(sessionId)
  if (!agent) {
    // 会话没在这个引擎里打开（切走了、重启过、或者 id 记错了）就别硬投。
    // 但要让等待的一方知道：**是目标不在线，不是投递出错**。
    const open = listLiveSessions(agents)
    const hint = open.length
      ? `；当前开着 ${open.length} 个会话：${open.map((row) => row.id.slice(0, 8)).join('、')}`
      : '；当前一个会话都没开'
    throw new Error(`会话 ${String(sessionId).slice(0, 8)}… 没开在引擎里${hint}。先把它切到前台，或用工牌 ID 重新指定`)
  }
  const message = {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: `phone-bridge-${crypto.randomUUID()}` },
  }
  if (mode === 'steer' && typeof agent.steer === 'function') agent.steer(message)
  else agent.followup(message)
  return { sessionId, mode: mode === 'steer' ? 'steer' : 'queue', preview: String(text).slice(0, 120), at: new Date().toISOString() }
}

async function threadSince(config, since) {
  const auth = Buffer.from(JSON.stringify({ k: 'token', token: config.token })).toString('base64url')
  const res = await fetch(`http://127.0.0.1:${config.port}/thread?since=${since}&limit=50&auth=${auth}`, {
    signal: AbortSignal.timeout(2500),
  })
  if (!res.ok) throw new Error(`工作台读不到（HTTP ${res.status}）`)
  return await res.json()
}

async function wakeTick(agents) {
  const config = readConfig()
  const wake = readWake(config)
  const state = readWakeState()
  if (!wake.enabled || !config.token) return

  let data
  try {
    data = await threadSince(config, state.cursor)
  } catch (error) {
    const message = String(error?.message || error)
    if (message !== state.lastError) {
      state.lastError = message
      writeWakeState(state)
    }
    return
  }

  const incoming = (data.messages || []).filter(
    (item) => item && item.from !== 'desktop' && (item.to === 'desktop' || String(item.to || '').startsWith('desktop:')),
  )
  if (!incoming.length) {
    // 没有新消息也要把 lastError 收干净，别让一条旧报错一直挂着。
    if (state.lastError) {
      state.lastError = ''
      writeWakeState(state)
    }
    return
  }

  // 先看有没有活会话。可能早就不剩一个（用户全关了、或者重启后没打开任何对话），
  // 这时候**连 cursor 都不能动**：动了下条新消息来了也拿不到，等于直接吞掉。
  const liveBefore = listLiveSessions(agents)
  if (!liveBefore.length) {
    const message = `DSH 里没有开着的会话，${incoming.length} 条消息留在工作台等你打开对话`
    if (message !== state.lastError) {
      state.lastError = message
      writeWakeState(state)
    }
    return
  }

  // agents.get() 只认「当前引擎进程里的活 agent」（dsh-agent: "Look up a live agent"），
  // 而会话 id 可能来自卡片填写、active.json 或文件名推断——大概率拿不到。
  // 所以不点名投递，按优先级挑一个投：
  //   ① 卡片指定且还活着的会话  ② 最近有活动的活会话  ③ 一个都没有就等
  const live = listLiveSessions(agents)
  const collab = readCollab(config)
  // 面板上钉的协作对优先级最高；没钉才退回到卡片里的 sessionId / 最近用过的那个。
  const pinned = collab.desktopSessionId || wake.sessionId || readActive()?.sessionId || ''
  const pickByPinned = pinned ? live.find((row) => row.id === pinned) : null

  for (const item of incoming) {
    const named = String(item.to || '').startsWith('desktop:') ? String(item.to).slice('desktop:'.length) : ''
    let sessionId = pickByPinned?.id || live[0]?.id || ''
    if (named) {
      const row = resolveNamed(named)
      if (row) sessionId = row.id
      else {
        // 名字找不到就退回到「开着的那个」，消息不能丢
        sessionId = pickByPinned?.id || live[0]?.id || ''
      }
    }
    if (!sessionId) {
      // 一个会话都没开着：**cursor 不前进**，下次再试；消息留在工作台上不丢。
      state.lastError = 'DSH 里现在没有开着的会话，这条消息留在工作台等你打开对话'
      continue
    }
    const text = `【来自${item.from === 'phone' ? '手机模型' : item.from}的消息】\n${item.text}`
    try {
      state.lastWake = await wakeSession(agents, sessionId, text, wake.mode)
      state.lastError = ''
      state.cursor = Number(data.next || state.cursor)
    } catch (error) {
      state.lastError = String(error?.message || error)
      break
    }
  }
  writeWakeState(state)
}

// ── 唤醒目标：谁开着就把消息投给谁 ─────────────────────────────────────────
// 老办法要求事先知道 sessionId，而 card 上根本填不出来：会话 id 只有 MCP
// caller 才带得回来，宿主半这边的工具（peer_*）压根拿不到。于是 wake 永远算
// 不出 target，手机上发的话到不了任何对话。
//
// 换个思路：不做「点名」，做「掷给开着的那个」。每次 tick 从 agents 服务里
// 现查还开着的会话，按最近活跃排序取第一个；有多个且用户又在卡片里明确指定
// 了某个 id，就仍以那个 id 为准（它在就投它）。
export function listLiveSessions(agents) {
  const handle = agents || agentsRef
  const rows = []
  const push = (id, item) => {
    if (!id) return
    // agent 对象上没有扁平 cwd，真正的目录挂在 session.header.cwd 上
    const header = item?.session?.header || item?.header || {}
    rows.push({
      id: String(id),
      at: Number(item?.at || item?.updatedAt || item?.lastActivity || 0) || 0,
      cwd: String(item?.cwd || header.cwd || ''),
      title: String(item?.title || header.title || ''),
    })
  }
  const feed = (value) => {
    if (!value) return
    if (typeof value[Symbol.iterator] === 'function' && typeof value !== 'string') {
      for (const item of value) {
        // 迭代出来的可能是 [id, info] 也可能是整个 session 对象
        if (Array.isArray(item)) push(item[0], item[1])
        else push(item?.id || item?.sessionId, item)
      }
      return
    }
    if (typeof value === 'object') for (const [id, item] of Object.entries(value)) push(id, item)
  }
  try {
    // roots() 只返回顶层 agent（entry.owner === undefined），子 agent 被过滤掉；
    // list() 会吐出 mnemon 之类跑在子 agent 里的会话，拿它当投递目标等于丢进黑洞。
    // 所以 roots 优先，退化才用 list，最后再按 id 前缀兜底一次。
    for (const key of ['roots', 'list', 'array', 'all', 'values', 'entries', 'sessions']) {
      if (typeof handle?.[key] !== 'function') continue
      try {
        const value = handle[key]()
        feed(value)
        if (rows.length) break
      } catch {}
    }
  } catch {}
  const real = rows.filter((row) => !/^mnemon-run-/.test(row.id))
  return (real.length ? real : rows).sort((a, b) => b.at - a.at)
}

function bindLiveTarget(agents) {
  const probe = () => {
    const rows = listLiveSessions(agents)
    if (rows.length === 1) {
      const only = rows[0].id
      const config = readConfig()
      const wake = readWake(config)
      if (!wake.sessionId) {
        wake.sessionId = only
        config.wake = wake
        try {
          writeJson(configPath(), config)
        } catch {}
      }
      return only
    }
    return ''
  }
  try {
    if (typeof agents?.on === 'function') agents.on('internal/session', probe)
  } catch {}
  return probe
}

function installWake(ctx) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['agents'], (scope) => {
    agentsRef = scope.agents
    bindLiveTarget(scope.agents)
    const start = () => {
      let busy = false
      const timer = setInterval(() => {
        if (busy) return
        busy = true
        wakeTick(scope.agents)
          .catch(() => {})
          .finally(() => {
            busy = false
          })
      }, 3000)
      timer.unref?.()
      return () => clearInterval(timer)
    }
    try {
      if (typeof scope.effect === 'function') scope.effect(start, 'phone-bridge: wake poller')
      else start()
    } catch (error) {
      console.error(`[phone-bridge] wake poller skipped: ${error}`)
    }
  })
}

// ── 手机侧收件器：电脑模型 → 手机会话 ────────────────────────────────────────
// installWake 负责「手机说的话投进电脑会话」，这一段是它的对称另一半。
// 手机上才有 phone.json（配对时就写在那里），桌面自然不启用，所以两端可以
// 塞同一份代码。
const phoneConfigPath = () => path.join(bridgeDir(), 'phone.json')
const inboxStatePath = () => path.join(bridgeDir(), 'inbox-state.json')

const phoneAuth = (token) => Buffer.from(JSON.stringify({ k: 'token', token })).toString('base64url')

async function bridgeGet(base, pathname, token, timeoutMs = 8000) {
  const sep = pathname.includes('?') ? '&' : '?'
  const res = await fetch(`${base}${pathname}${sep}auth=${phoneAuth(token)}`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

async function bridgePost(base, pathname, token, payload, timeoutMs = 8000) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auth: { k: 'token', token }, ...payload }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

// 把手机上开着的会话报给电脑：面板的两排下拉和 peer_sessions 都靠这份名单。
async function reportPhoneSessions(agents, base, token) {
  for (const row of listLiveSessions(agents).slice(0, 12)) {
    try {
      await bridgePost(
        base,
        '/agents/register',
        token,
        {
          agent: {
            id: `psess:${row.id}`,
            name: row.title || path.basename(row.cwd || '') || row.id.slice(0, 8),
            host: 'phone',
            kind: 'session',
            note: `手机上开着的会话 · ${row.cwd || '目录未知'}`,
            running: true,
            at: new Date().toISOString(),
          },
        },
        5000,
      )
    } catch {
      return // 电脑不在线就先不报，下一轮再说
    }
  }
}

async function inboxTick(agents, lastReport) {
  const config = readJson(phoneConfigPath(), null)
  if (!config?.url || !config?.token) return lastReport
  const base = String(config.url).replace(/\/+$/, '')
  const state = readJson(inboxStatePath(), { cursor: 0, lastError: '' })

  let data
  try {
    data = await bridgeGet(base, `/thread?since=${Number(state.cursor) || 0}&as=phone&limit=50`, config.token)
  } catch (error) {
    const message = String(error?.message || error)
    if (message !== state.lastError) {
      state.lastError = message
      writeJson(inboxStatePath(), state)
    }
    return lastReport
  }

  let collab = null
  try {
    collab = (await bridgeGet(base, '/collab', config.token, 5000))?.collab || null
  } catch {}
  const pinned = String(collab?.phoneSessionId || '')

  const incoming = (data?.messages || []).filter((item) => {
    if (!item || item.from === 'phone') return false
    const to = String(item.to || '')
    return to === 'phone' || (pinned && to === `phone:${pinned}`)
  })

  if (incoming.length) {
    const live = listLiveSessions(agents)
    const target = (pinned && live.find((row) => row.id === pinned)) || live[0] || null
    if (!target) {
      // 和桌面侧一个规矩：没会话就**不动 cursor**，消息留着，绝不吞。
      state.lastError = `手机上现在没有开着的会话，${incoming.length} 条消息留在工作台`
      writeJson(inboxStatePath(), state)
      return lastReport
    }
    for (const item of incoming) {
      try {
        state.lastWake = await wakeSession(agents, target.id, `【来自电脑模型的消息】\n${item.text}`, 'queue')
        state.lastError = ''
        state.cursor = Number(data?.next || state.cursor)
      } catch (error) {
        state.lastError = String(error?.message || error)
        break
      }
    }
    writeJson(inboxStatePath(), state)
  }

  const now = Date.now()
  if (now - (Number(lastReport) || 0) > 30_000) {
    await reportPhoneSessions(agents, base, config.token)
    return now
  }
  return lastReport
}

function installInbox(ctx) {
  if (!isPhone()) return
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['agents'], (scope) => {
    let busy = false
    let lastReport = 0
    const start = () => {
      const timer = setInterval(() => {
        if (busy) return
        busy = true
        inboxTick(scope.agents, lastReport)
          .then((next) => {
            lastReport = next
          })
          .catch(() => {})
          .finally(() => {
            busy = false
          })
      }, 3000)
      timer.unref?.()
      return () => clearInterval(timer)
    }
    try {
      if (typeof scope.effect === 'function') scope.effect(start, 'phone-bridge: inbox poller')
      else start()
    } catch (error) {
      console.error(`[phone-bridge] inbox poller skipped: ${error}`)
    }
  })
}

// ── 引擎半自注册 ─────────────────────────────────────────────────────────────
// 从市场装的只是这个 bundle：宿主路由、左栏面板、插件卡片。真正干活的
// bridge.mjs 要以 stdio 挂给 @deepseek-ai/dsh-mcp-client，而那一行的 args 必须
// 是装到目标机器之后才知道的绝对路径——装包的人不可能预先填对。
// 所以第一次加载时自己补：找到装了本 bundle 的 profile，往它的 cordis.patch.yml
// 追加一行（幂等，写前备份）。补完要重启一次 DSH，下一轮启动 mcp-client 才会
// 把工具挂上来。不想被自动改就设 PHONE_BRIDGE_NO_AUTOPATCH=1。

const ENGINE_ENTRY_ID = 'dsh-phone-bridge-engine'
const ENGINE_CLIENT = '@deepseek-ai/dsh-mcp-client'
const ENGINE_BUNDLE = 'dsh-phone-bridge'
const AUTOPATCH_ENV = 'PHONE_BRIDGE_NO_AUTOPATCH'

/** bridge.mjs 在哪：npm 装到包根、bundle 自带、或旧版 ~/.dsh/phone-bridge/。 */
export function enginePath() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.PHONE_BRIDGE_ENGINE,
    path.join(here, '..', 'bridge.mjs'),
    path.join(here, 'bridge.mjs'),
    path.join(bridgeDir(), 'bridge.mjs'),
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (fs.statSync(candidate).isFile()) return path.resolve(candidate)
    } catch {}
  }
  return null
}

/** YAML 双引号标量：反斜杠必须再转义一次，否则 Windows 路径会被当成转义序列吃掉。 */
function yamlDoubleQuoted(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// 自注册段的开头/结尾锚点。没有锚点就插在文件最前面：绝对不能再无脑追加到末尾
// （第一次实现就是这么干的，结果掉在另一个插件的中途，整份补丁坏掉）。
const AUTO_BEGIN = '# >>> phone-bridge engine row (auto-added, edit the row or set PHONE_BRIDGE_NO_AUTOPATCH=1) >>>'
const AUTO_END = '# <<< phone-bridge engine row <<<'

export function enginePatch(engine) {
  return [
    AUTO_BEGIN,
    '# 互联（phone-bridge）的引擎半：bridge.mjs 以 stdio 挂给 mcp-client。',
    '# 由 web/index.js 首次加载时自动追加；删掉它，桥接工具就没了。',
    '- insert:',
    `    - id: ${ENGINE_ENTRY_ID}`,
    `      name: '${ENGINE_CLIENT}'`,
    '      config:',
    '        serverName: phone-bridge',
    '        transport: stdio',
    '        command: !!js process.execPath',
    '        args:',
    `          - ${yamlDoubleQuoted(engine)}`,
    '          - auto',
    '        toolCallTimeoutMs: 1800000',
    '        failOnStartupError: false',
    '        # 让桥接知道是哪个会话在调用它（自动唤醒要用）',
    '        dshGoPhoneCaller: true',
    AUTO_END,
    '',
  ].join('\n')
}

/** 把自注册段放进补丁：有锚点就原地替换，没有就插在最前面。 */
export function withEngineRow(patch, engine) {
  const block = enginePatch(engine)
  const begin = patch.indexOf(AUTO_BEGIN)
  if (begin >= 0) {
    const end = patch.indexOf(AUTO_END, begin)
    const stop = end >= 0 ? end + AUTO_END.length : patch.length
    return `${patch.slice(0, begin)}${block.trimEnd()}${patch.slice(stop).replace(/^\n*/, '\n')}`
  }
  return `${block}\n${patch.replace(/^\uFEFF/, '')}`
}

// 认的是 serverName，不是 id：bundle 自身的行也叫 dsh-phone-bridge，光看 id 会
// 把它误当成引擎行而永远不补。
const ENGINE_ROW = /serverName:\s*['"]?phone-bridge['"]?\s*$/m

/** 哪些 profile 装了本 bundle：bundles 列表里有本包名，或补丁里提到了它。 */
function profilesWithThisBundle() {
  const found = []
  const root = path.join(dshHome(), 'profiles')
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const bundles = readJson(path.join(dir, 'package.json'), null)?.dsh?.profile?.bundles
    const patchFile = path.join(dir, 'cordis.patch.yml')
    let patch = ''
    try {
      patch = fs.readFileSync(patchFile, 'utf8')
    } catch {
      continue
    }
    const listed = Array.isArray(bundles) && (bundles.includes(ENGINE_BUNDLE) || bundles.includes('dsh-phone-bridge-web'))
    const mentioned = /dsh-phone-bridge(-web)?\b/.test(patch)
    if (listed || mentioned) found.push({ patchFile, patch })
  }
  return found
}

/** 幂等地把引擎行补进每个装了本 bundle 的 profile，返回改过的文件。 */
export function installEngineRow() {
  if (process.env[AUTOPATCH_ENV] === '1') return []
  const engine = enginePath()
  if (!engine) return []
  const touched = []
  for (const profile of profilesWithThisBundle()) {
    if (ENGINE_ROW.test(profile.patch)) continue
    try {
      try {
        fs.copyFileSync(profile.patchFile, `${profile.patchFile}.bak-autopatch`)
      } catch {}
      const next = withEngineRow(profile.patch, engine)
      const temp = `${profile.patchFile}.${process.pid}.tmp`
      fs.writeFileSync(temp, next)
      fs.renameSync(temp, profile.patchFile)
      touched.push(profile.patchFile)
      console.log(`[phone-bridge] 已把引擎行补进 ${profile.patchFile}（重启 DSH 后生效）`)
    } catch (error) {
      console.error(`[phone-bridge] 引擎行没写进 ${profile.patchFile}: ${error?.message || error}`)
    }
  }
  return touched
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY) throw new Error('请求太大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

export function apply(ctx) {
  // webServer exists only under the web profile, and cordis has no optional
  // inject form, so the route rides a scoped inject of its own.
  if (typeof ctx.inject !== 'function') return
  const route = {
    name: 'phone-bridge-config',
    kind: 'exact',
    path: '/phone-bridge/config',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET' || req.method === 'HEAD') {
          send(res, 200, await snapshot())
          return
        }
        if (req.method !== 'POST') {
          send(res, 405, { error: '只支持 GET / POST' })
          return
        }
        const body = await readJsonBody(req)
        const result = await runAction(body)
        send(res, 200, { ok: true, text: result.text, state: await snapshot() })
      } catch (error) {
        send(res, 400, { ok: false, error: String(error?.message || error) })
      }
    },
  }
  const qrRoute = {
    name: 'phone-bridge-qr',
    kind: 'exact',
    path: '/phone-bridge/qr.svg',
    handler: async (req, res) => {
      try {
        const config = readConfig()
        const health = await probe(config.port, 1200)
        const text = health?.pairUrl || fallbackPairUrl(config)
        const svg = await qrSvgFor(config, text)
        res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' })
        res.end(svg)
      } catch (error) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: String(error?.message || error) }))
      }
    },
  }
  installWake(ctx)
  // 手机侧的反方向：把电脑模型发的话直接投进手机上的会话。
  // 两端共用这一份代码，靠 isPhone() 分工，谁也不抢谁的活。
  try {
    installInbox(ctx)
  } catch (error) {
    console.error(`[phone-bridge] 收件器跳过: ${error}`)
  }
  try {
    installEngineRow()
  } catch (error) {
    console.error(`[phone-bridge] 引擎行自注册跳过: ${error}`)
  }
  ctx.inject(['webServer'], (scope) => {
    const register = () => {
      scope.webServer.register(route)
      scope.webServer.register(qrRoute)
    }
    try {
      if (typeof scope.effect === 'function') scope.effect(register, 'phone-bridge: config routes')
      else register()
    } catch (error) {
      console.error(`[phone-bridge] config route skipped: ${error}`)
    }
  })
}