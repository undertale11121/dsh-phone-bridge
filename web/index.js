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
  // /sdcard 是 Android 独有的，比环境变量可靠。PHONE_BRIDGE_ROLE 只在证据
  // 站得住时才算数：桌面上万一有人设了 ROLE=phone，不能因此把两个方向都
  // 判成手机端（那样就没有唤醒器，消息没人取）。
  const android =
    fs.existsSync('/opt/dsh-app/phone/relay.cjs') ||
    fs.existsSync('/var/lib/dsh-app/phone/bridge.json') ||
    fs.existsSync('/sdcard')
  const role = process.env.PHONE_BRIDGE_ROLE
  if (role === 'desktop') return false
  if (role === 'phone') return android
  return android
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
        const liveRow = listLiveSessions().find((item) => item.id === id)
        if (liveRow?.title) return liveRow.title
        const row = sessionRows().find((item) => item.id === id)
        if (row && row.name) return row.name
        const base = liveRow?.cwd ? path.basename(liveRow.cwd) : ''
        return base || id.replace(/^session-/, '').slice(0, 8)
      })(),
      active: readActive(),
    },
    // 会话目录：模型可以按用途挑唤醒对象（peer_say 的 to 写 desktop:<名字>）
    registry: sessionRows(),
    // 引擎里正开着的会话（内存态，重启就没了）。排查「为什么没投出去」时看这个。
    live: listLiveSessions(),
    // 所有会话（含没开着的），面板下拉用这个，否则只有一个选项可选。
    allSessions: listAllSessions(),
    // 协作对：电脑会话 × 手机会话，面板上两排下拉读写它。
    collab: readCollab(config),
    // 每个会话的互联开关（面板上逐行勾选）。
    links: readLinks(config),
    // 手机端：电脑那边同步过来的开关表（真源仍写在电脑的 desktop.json 里）。
    peerLinks: (readJson(phoneConfigPath(), null)?.peerLinks) || {},
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
  if (body.action === 'say') {
    // 用户（或任一端模型）在面板上打一句话，直接进工作台，对端的收件器
    // 会把它投进钉住的会话。和模型自己说话用的是同一条管道。
    const text = String(body.text || '').trim()
    if (!text) throw new Error('要说的话不能是空的')
    const collab = readCollab(config)
    const to = String(body.to || 'phone')
    let target = to
    if (to === 'phone' && collab.phoneSessionId) target = `phone:${collab.phoneSessionId}`
    const info = await ensureServer(config)
    const row = await bridgePost(`http://127.0.0.1:${info.port}`, '/thread', config.token, { from: 'desktop', to: target, text, level: body.level })
    return { text: `已发到 ${target}（#${row.seq ?? '?'}）` }
  }
  if (body.action === 'linkRemote') {
    // 手机端会话界面上的开关：写回电脑，真源在电脑。
    const conf = readJson(phoneConfigPath(), null)
    if (!conf?.url || !conf?.token) throw new Error('手机还没连上电脑：先在电脑面板上配对')
    const phoneId = String(body.phoneId || '').trim()
    if (!phoneId) throw new Error('要指定哪个手机会话')
    const remoteBase = String(conf.url).replace(/\/+$/, '')
    const payload = { phoneId, desktopId: String(body.desktopId || '').trim(), off: !!body.off }
    const out = await bridgePost(remoteBase, '/collab', conf.token, payload)
    if (!out || out.ok === false) throw new Error(String((out && out.text) || '电脑那边没同意'))
    try {
      writeJson(phoneConfigPath(), { ...conf, peerLinks: out.links || {} })
    } catch {}
    return { text: body.off ? '已断开这个会话的互联' : '已连上电脑上的会话' }
  }
  if (body.action === 'link') {
    // 面板上某个会话的「互联」开关：打开 = 配一个对端会话，关闭 = 删掉。
    const desktopId = String(body.desktopId || '').trim()
    if (!desktopId) throw new Error('要指定是哪个电脑会话')
    const links = readLinks(config)
    if (body.off) {
      delete links[desktopId]
      config.links = links
      writeJson(configPath(), config)
      return { text: '已断开这个会话的互联' }
    }
    // 用户 m04337「不用手动选」：没指定手机会话就接最近上报的那个。
    const phoneId = String(body.phoneId || '').trim() || defaultPhoneSession()
    if (!phoneId) throw new Error('手机上还没上报任何会话：先让手机连上电脑，手机端也要跑 0.6.4 以上的插件')
    links[desktopId] = { phoneId, at: new Date().toISOString() }
    config.links = links
    writeJson(configPath(), config)
    const short = (id) => String(id).replace(/^session-/, '').slice(0, 8)
    return { text: `已把这个会话连到手机 ${short(phoneId)}` }
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

// 互联开关：一个电脑会话对一个手机会话，{ [电脑会话 id]: { phoneId, at } }。
// 用户的原话是「在每个会话里面做一个互联开关，打开后……不用用户自己选」——
// 开关打开后，谁不点名发的消息都默认走这条配对。
// 用户要「不用手动选」：没给 phoneId 时，自动用手机上最近上报的那个会话。
export function defaultPhoneSession() {
  const rows = readAgents().filter((a) => a.host === 'phone' && String(a.id).startsWith('psess:'))
  if (!rows.length) return ''
  return String(rows[rows.length - 1].id).slice('psess:'.length)
}

function readLinks(config) {
  const raw = (config || readConfig()).links
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

/** 最近打开的那条配对。没有就返回 null。 */
export function recentLink(config) {
  const entries = Object.entries(readLinks(config)).filter(([id, row]) => id && row && row.phoneId)
  if (!entries.length) return null
  entries.sort((a, b) => String(b[1].at || '').localeCompare(String(a[1].at || '')))
  return { desktopId: entries[0][0], phoneId: entries[0][1].phoneId }
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

// 会话目录（registry.json）本来只靠 MCP 半的 caller.sessionId 被动登记，但
// DSH 的 MCP 客户端从来不告诉 server 是哪个会话在调 —— 于是 registry 永远
// 是空的，session_list / session_note 变成死功能。宿主半能直接枚举活会话，
// 所以由它把开着的会话补进同一份 registry；名字和用途仍归模型自己写，这里
// 只补第一次，不覆盖。
function syncRegistry(agents) {
  let rows = []
  try {
    rows = listLiveSessions(agents)
  } catch {
    return
  }
  if (!rows.length) return
  const data = readRegistry()
  if (!data.sessions) data.sessions = {}
  const now = new Date().toISOString()
  let changed = false
  for (const row of rows) {
    const id = String(row.id || '')
    if (!id || data.sessions[id]) continue
    const cwd = String(row.cwd || '')
    data.sessions[id] = {
      id,
      name: (cwd ? path.basename(cwd) : '') || id.slice(0, 8),
      cwd,
      host: 'desktop',
      at: now,
      ast: now,
      calls: 0,
    }
    changed = true
  }
  if (!changed) return
  try {
    writeJson(registryPath(), data)
  } catch {
    // 登记失败不能影响唤醒
  }
}

/**
 * 手机侧：把对面（电脑）报上来的会话记进本机目录。
 *
 * 为什么要有这个：手机模型想知道「电脑上开着哪些会话」才能 to: 'desktop:<名字>'
 * 点名，但它自己看不到对方。电脑端每 3 秒把活会话写进 live.json，桥接服务的
 * GET /collab 顺手带回来，这里收下。
 *
 * 只补第一次，不覆盖模型自己写的名字/用途；host 标 'desktop'，
 * session_list 会显示「电脑上」。
 */
export function syncPeerSessions(rows) {
  if (!Array.isArray(rows) || !rows.length) return 0
  const data = readRegistry()
  if (!data.sessions) data.sessions = {}
  const now = new Date().toISOString()
  let changed = 0
  for (const row of rows) {
    const id = String(row?.id || '')
    if (!id) continue
    const previous = data.sessions[id]
    if (previous && previous.name) continue
    data.sessions[id] = {
      id,
      name: String(row.title || row.name || '') || String(row.cwd || ''),
      purpose: previous?.purpose || '',
      project: previous?.project || '',
      cwd: String(row.cwd || ''),
      host: 'desktop',
      at: previous?.at || now,
      ast: now,
      calls: previous?.calls || 0,
    }
    changed += 1
  }
  if (!changed) return 0
  try {
    writeJson(registryPath(), data)
  } catch {
    return 0
  }
  return changed
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
export async function wakeSession(agents, sessionId, text, mode = 'queue', options = {}) {
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
  // 对方正在生成（一回合没跑完）时别 followup：那会排进 inbox，界面上就多出
  // 一条「等待发送」的消息气泡——用户的原话是「有时候会出现等待发送的对方模型
  // 消息」。等它空下来再投，反正消息留在工作台上不丢，3 秒后还会再试。
  const status = String(agent.status || '')
  if (!options.force && status && status !== 'idle') {
    throw new Error(`会话 ${String(sessionId).slice(0, 8)}… 正忙（${status}），这条消息等它空下来再投`)
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

async function threadPath(config, query) {
  const auth = Buffer.from(JSON.stringify({ k: 'token', token: config.token })).toString('base64url')
  const res = await fetch(`http://127.0.0.1:${config.port}/thread?${query}&auth=${auth}`, {
    signal: AbortSignal.timeout(2500),
  })
  if (!res.ok) throw new Error(`工作台读不到（HTTP ${res.status}）`)
  return await res.json()
}

async function threadSince(config, since) {
  return threadPath(config, `since=${since}&limit=50`)
}

// 工作台上躺着几十条历史。第一次跑（cursor 还是 0）如果从 0 开始拉，会把它们
// 一次性全灌进会话——对方看到的就是「历史消息重放」，一屏老话。
// 所以首次只探路不投递：先问出「现在最后一条是几号」，把 cursor 对齐到那儿。
async function alignCursor(fetchThread, viewer = 'desktop') {
  let since = 0
  let last = 0
  for (let i = 0; i < 20; i++) {
    const data = await fetchThread(`since=${since}&as=${viewer}&limit=200`)
    const rows = data?.messages || []
    if (!rows.length) break
    last = Number(rows[rows.length - 1].seq || last)
    if (rows.length < 200) break
    since = last
  }
  return last
}

// 一次只说一句：投完一条就停下，等对方回话（或等够久）再投下一条。
// 不然攒了几条的消息会一口气灌进对方会话，看着就是刷屏。
// 注意：这只管**发送**方向。接收方向（别人发给我的话）不能压——那是该我看见的消息，
// 压 120 秒等于让对话卡住。所以 wakeTick/inboxTick 都不用它，留给 say/peer_say。
const REPLY_WAIT_MS = 120_000

// 用户的原话是「可以对话发在后台，然后页面只发一点内容唤醒模型」——
// 所以投进去的只是一句**唤醒语**：谁发的、几条、多少字、开头一小段。
// 全文留在工作台上（peer_read 拿），但唤醒语里带一小段原文——两个模型要
// 商量着干活，光看到「N 条」不知道对方要什么，结果就是各干各的。
const PEEK_CHARS = 200

// 两端约定的暗号：发送方标 level，唤醒语里就带对应符号，一眼看出要不要
// 放下手上的活。web 半不能 import ../src/*，所以和 src/thread.mjs 各存一份。
const LEVEL_MARKS = { urgent: '❗', question: '❓', alert: '⚠️', done: '✅', report: '📋' }
const LEVEL_LABELS = {
  urgent: '重要，等你回',
  question: '要你决定',
  alert: '出问题了',
  done: '做完了',
  report: '进度汇报，不用回',
  normal: '',
}
const LEVEL_ORDER = ['urgent', 'alert', 'question', 'done', 'report', 'normal']

function topLevel(rows) {
  for (const name of LEVEL_ORDER) {
    if (rows.some((item) => item && item.level === name)) return name
  }
  // 老消息没有 level 字段：翻翻正文开头有没有暗号，有就认。
  for (const item of rows) {
    const mark = String(item && item.text ? item.text : '').trim().slice(0, 2)
    const found = Object.keys(LEVEL_MARKS).find((name) => LEVEL_MARKS[name] && mark.startsWith(LEVEL_MARKS[name]))
    if (found) return found
  }
  return 'normal'
}

// 「（手机已连上电脑）」这类是桥接自己写的系统通知，不是模型说的话。
// 拿它去唤醒对端模型，就会得到「手机 1 条（9 字）」这种莫名其妙的消息。
const NOTICE_RE = /^（[^）]{0,40}已连上[^）]{0,40}）$/
export function isNotice(text) {
  const plain = String(text == null ? '' : text).trim()
  return plain.length <= 60 && NOTICE_RE.test(plain)
}

// 唤醒语里带多少原文：够看清对方要什么，又不会把对话流撑长。

// web 半会被单独拷进 profile 的 node_modules，不能 import ../src/*，所以这里放一份
// 本地的时间格式化（与 src/util.mjs 的 clockOf 保持一致）。
function clockOf(at) {
  const d = new Date(at || Date.now())
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function composeBatch(incoming, who) {
  const rows = Array.isArray(incoming) ? incoming : []
  if (!rows.length) return ''
  const total = rows.reduce((sum, item) => sum + String(item?.text == null ? '' : item.text).length, 0)
  const head = rows.length > 1 ? `${who} ${rows.length} 条` : `${who} 1 条`
  // 带发送时间：两个模型对账时能看出先后和间隔，不必再去翻 thread.jsonl。
  const at = rows[rows.length - 1]?.at
  const clock = clockOf(at)
  const when = clock ? ` · ${clock}` : ''
  // 只给摘要不给全文（5000 字会把对话撑爆），但也不能只丢一句「N 条」——
  // 两个模型要商量着干活，得先看见对方在说什么，不然就是各干各的。
  const joined = rows.map((item) => String(item?.text == null ? '' : item.text)).join('\n')
  const peek = joined.length > PEEK_CHARS ? `${joined.slice(0, PEEK_CHARS)}…` : joined
  const level = topLevel(rows)
  // 符号本身就说明了要紧程度，别再加「（重要，等你回）」这种括号——
  // 用户原话：「你都有暗号了，干嘛还要加个括号说要你决定」。
  const mark = LEVEL_MARKS[level] ? `${LEVEL_MARKS[level]} ` : ''
  return (
    `${mark}【互联】${head}（${total} 字）${when}\n${peek}\n` +
    '（全文在工作台，peer_read 看完整内容；回话时顺带说一句你这边的进度，对方才知道你在干哪一半。）'
  )
}

// 把 phone:<…> / desktop:<…> 后面那截认成一个具体会话：可以是完整 id、
// 去掉 session- 的裸 uuid、手动起的名字，或者左侧栏那个标题。
export function matchSession(live, want) {
  const key = String(want == null ? '' : want).trim()
  if (!key) return null
  const rows = Array.isArray(live) ? live : []
  const plain = key.replace(/^psess:/, '').replace(/^session-/, '')
  return (
    rows.find((row) => {
      const id = String(row?.id || '')
      const bare = id.replace(/^session-/, '')
      return id === key || `psess:${id}` === key || bare === plain
    }) ||
    rows.find((row) => String(row?.name || '') === key || String(row?.title || '') === key) ||
    null
  )
}

async function wakeTick(agents) {
  const config = readConfig()
  const wake = readWake(config)
  const state = readWakeState()
  // 先把开着的会话补进会话目录，session_list / session_note 才有的可选
  try {
    if (wake.enabled || config.token) syncRegistry(agents)
  } catch {
    // 目录登记失败不影响唤醒
  }
  // 顺手写一份「这边开着哪些会话」的快照，桥接服务的 GET /collab 会带给对面。
  // 手机模型靠它才能 to: 'desktop:<名字>' 点名——它自己看不到电脑开了什么。
  try {
    if (config.token) {
      writeJson(path.join(bridgeDir(), 'live.json'), {
        at: new Date().toISOString(),
        sessions: listLiveSessions(agents),
      })
    }
  } catch {
    // 快照失败不影响唤醒
  }
  if (!wake.enabled || !config.token) return

  // 首次启动：把 cursor 对齐到「现在最后一条」，一条历史都不投。
  if (!state.cursor) {
    try {
      const last = await alignCursor((query) => threadPath(config, query))
      if (last > 0) {
        state.cursor = last
        state.lastError = ''
        writeWakeState(state)
      }
    } catch {}
    return
  }

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

  // 上一条还没等到回话就别急着投下一条。等超过 REPLY_WAIT_MS 就当对方在忙，
  // 继续投——宁可慢，也不能把消息永远卡在自己这儿。
  // 接收方向不节流：这些本来就是该我看见的消息，压住只会让对话卡住。

  const incoming = (data.messages || []).filter(
    (item) =>
      item &&
      item.from !== 'desktop' &&
      !isNotice(item.text) &&
      (item.to === 'desktop' || String(item.to || '').startsWith('desktop:')),
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
  // 优先级：会话开关（links）> 面板钉的协作对 > 卡片里的 sessionId > 最近用过的那个。
  const link = recentLink(config)
  const pinned = link?.desktopId || collab.desktopSessionId || wake.sessionId || readActive()?.sessionId || ''
  const pickByPinned = pinned ? live.find((row) => row.id === pinned) : null

  // 同一个会话的消息合成一条投。用户的原话是「每次你俩发消息，出现一大串，
  // 影响我看回答」—— 逐条 followup 会把对话刷屏，而模型之间的话本来也不需要
  // 那么啰嗦：合并成一条，超长截断，全文仍留在工作台上可查。
  const groups = new Map()
  for (const item of incoming) {
    const named = String(item.to || '').startsWith('desktop:') ? String(item.to).slice('desktop:'.length) : ''
    let sessionId = pickByPinned?.id || live[0]?.id || ''
    if (named) {
      // 点名的会话：先按 id / 裸 uuid / 左边栏标题认，再退到会话目录里的名字。
      // 名字找不到就退回到「开着的那个」，消息不能丢
      const row = matchSession(live, named) || resolveNamed(named)
      sessionId = row ? row.id : pickByPinned?.id || live[0]?.id || ''
    }
    if (!sessionId) {
      // 一个会话都没开着：**cursor 不前进**，下次再试；消息留在工作台上不丢。
      state.lastError = 'DSH 里现在没有开着的会话，这条消息留在工作台等你打开对话'
      continue
    }
    if (!groups.has(sessionId)) groups.set(sessionId, [])
    groups.get(sessionId).push(item)
  }

  const sentSeqs = []
  for (const [sessionId, items] of groups) {
    const who = items[0].from === 'phone' ? '手机模型' : String(items[0].from || '对方')
    try {
      state.lastWake = await wakeSession(agents, sessionId, composeBatch(items, who), wake.mode)
      state.lastError = ''
      for (const item of items) sentSeqs.push(Number(item.seq) || 0)
    } catch (error) {
      state.lastError = String(error?.message || error)
      break
    }
  }
  // cursor 只推到最后一条**确实投出去**的消息，没投的留着下次再来。
  if (sentSeqs.length) state.cursor = Math.max(...sentSeqs, Number(state.cursor) || 0)
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
// 会话在左侧栏显示的名字（就是「安装 dsh-phone-bridge 插件」那种），存在
// projcache 的 record.rows.title 里；运行中的 agent 对象上没有它。
const metaCache = new Map()
function sessionMeta(id) {
  const key = String(id || '')
  const empty = { title: '', cwd: '', at: 0 }
  if (!key) return empty
  const file = path.join(dshHome(), 'storages', 'session_projcache', 'sessions', `${key}.json`)
  let stamp = 0
  try {
    stamp = fs.statSync(file).mtimeMs
  } catch {
    return empty
  }
  const hit = metaCache.get(key)
  if (hit && hit.stamp === stamp) return hit.value
  let value = empty
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const record = data?.record || {}
    value = {
      title: String(record?.rows?.title?.val || ''),
      cwd: String(record?.identity?.cwd || ''),
      at: Number(record?.identity?.createdAt || 0) || 0,
    }
  } catch {
    value = empty
  }
  metaCache.set(key, { stamp, value })
  return value
}

function sessionTitle(id) {
  return sessionMeta(id).title
}

// 全部会话（不只是开着的）。面板上要能挑历史会话，否则只有一个选项。
// open 表示这个会话此刻开在引擎里——投递只对 open 的会话有效。
export function listAllSessions() {
  const dir = path.join(dshHome(), 'storages', 'session_projcache', 'sessions')
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const live = new Map(listLiveSessions().map((row) => [row.id, row]))
  let named = {}
  try {
    named = readRegistry().sessions || {}
  } catch {
    named = {}
  }
  const rows = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -5)
    if (!/^session-[0-9a-f-]+$/i.test(id)) continue
    const meta = sessionMeta(id)
    const liveRow = live.get(id)
    // 完全空白的会话（没标题又没开着）不占位置
    if (!meta.title && !liveRow) continue
    // 子智能体的会话 cwd 在 .dsh\profiles\ 下面，不是人开的，别混进下拉
    if (/[\\/]\.dsh[\\/]profiles[\\/]/i.test(String(meta.cwd || liveRow?.cwd || ''))) continue
    const known = named[id] || {}
    rows.push({
      id,
      title: meta.title || liveRow?.title || '',
      cwd: liveRow?.cwd || meta.cwd || known.cwd || '',
      name: String(known.name || ''),
      at: Number(liveRow?.at || meta.at) || 0,
      open: Boolean(liveRow),
    })
  }
  rows.sort((a, b) => (Number(b.open) - Number(a.open)) || (b.at - a.at))
  return rows
}

export function listLiveSessions(agents) {
  const handle = agents || agentsRef
  const rows = []
  // 会话的名字是人起的（session_note），挂在 registry 里；下拉要显示名字而不是
  // 「D:\... · 0e47a423」这种代码，所以这里顺手带出来。
  let named = {}
  try {
    named = readRegistry().sessions || {}
  } catch {
    named = {}
  }
  const push = (id, item) => {
    if (!id) return
    // agent 对象上没有扁平 cwd，真正的目录挂在 session.header.cwd 上
    const header = item?.session?.header || item?.header || {}
    const known = named[String(id)] || {}
    rows.push({
      id: String(id),
      at: Number(item?.at || item?.updatedAt || item?.lastActivity || 0) || 0,
      cwd: String(item?.cwd || header.cwd || known.cwd || ''),
      title: sessionTitle(id) || String(item?.title || header.title || ''),
      name: String(known.name || ''),
      purpose: String(known.purpose || ''),
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
  // 桌面半的活：把手机上发来的话投进电脑会话。手机半由 installInbox 接手，
  // 两边各管一个方向，不然同一句话会被投两次。
  if (isPhone()) return
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

  // 和桌面侧一个规矩：第一次跑先把 cursor 对齐到最新，不把历史灌进会话。
  if (!state.cursor) {
    try {
      const last = await alignCursor((query) => bridgeGet(base, `/thread?${query}`, config.token, 8000), 'phone')
      if (last > 0) {
        state.cursor = last
        state.lastError = ''
        writeJson(inboxStatePath(), state)
      }
    } catch {}
    return lastReport
  }

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

  // 接收方向不节流：这些本来就是该手机看见的消息，压住只会让对话卡住。

  let collab = null
  let peerSessions = []
  let peerLinks = null
  try {
    const snapshot = await bridgeGet(base, '/collab', config.token, 5000)
    collab = snapshot?.collab || null
    peerSessions = Array.isArray(snapshot?.desktopSessions) ? snapshot.desktopSessions : []
    peerLinks = snapshot?.links && typeof snapshot.links === 'object' ? snapshot.links : {}
  } catch {}
  // 开关的真源在电脑上，手机这边只是镜像一份给会话顶部的按钮看。
  if (peerLinks) {
    try {
      if (JSON.stringify(config.peerLinks || {}) !== JSON.stringify(peerLinks)) {
        writeJson(phoneConfigPath(), { ...config, peerLinks })
      }
    } catch {}
  }
  // 电脑上开着的会话也记进本机目录，手机模型才有得点名
  if (peerSessions.length) {
    try {
      syncPeerSessions(peerSessions)
    } catch {}
  }
  const link = recentLink(config)
  const pinned = String(link?.phoneId || collab?.phoneSessionId || '')

  const incoming = (data?.messages || []).filter((item) => {
    if (!item || item.from === 'phone') return false
    if (isNotice(item.text)) return false
    const to = String(item.to || '')
    // 收「给手机」的，也收「点名某个手机会话」的：phone:<id | 名字 | 标题>
    return to === 'phone' || to.startsWith('phone:')
  })

  if (incoming.length) {
    const live = listLiveSessions(agents)
    if (!live.length) {
      // 和桌面侧一个规矩：没会话就**不动 cursor**，消息留着，绝不吞。
      state.lastError = `手机上现在没有开着的会话，${incoming.length} 条消息留在工作台`
      writeJson(inboxStatePath(), state)
      return lastReport
    }
    const fallback = (pinned && live.find((row) => row.id === pinned)) || live[0] || null
    // 按收件人分组：没点名的给 fallback，点了名的投给它点的那一个
    const groups = new Map()
    for (const item of incoming) {
      const to = String(item.to || '')
      const key = to.startsWith('phone:') ? to : 'phone'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    }
    const sent = []
    const misses = []
    const fails = []
    for (const [key, rows] of groups) {
      const want = key === 'phone' ? '' : key.slice('phone:'.length)
      const target = want ? matchSession(live, want) : fallback
      if (!target) {
        misses.push(want)
        continue
      }
      try {
        state.lastWake = await wakeSession(agents, target.id, composeBatch(rows, '电脑模型'), 'queue')
        for (const item of rows) sent.push(Number(item.seq) || 0)
      } catch (error) {
        fails.push(String(error?.message || error))
      }
    }
    if (fails.length) state.lastError = fails[0]
    else if (misses.length) state.lastError = `找不到这些手机会话：${misses.join('、')}`
    else state.lastError = ''
    if (sent.length) state.cursor = Math.max(...sent, Number(state.cursor) || 0)
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