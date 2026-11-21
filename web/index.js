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
// 会话开关单独放一个文件：desktop.json 由宿主半和桥接进程两边读写，
// 混在一起会互相覆盖（手机实测「开着开着 links 就没了」）。
const linksPath = () => path.join(bridgeDir(), 'links.json')
const lockPath = () => path.join(bridgeDir(), 'desktop.lock')
const logPath = () => path.join(bridgeDir(), 'bridge.log')

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

// 状态文件（游标）不能用「读失败就当空」的语义：文件损坏或瞬时不可读时若当成首次启动，
// 游标会归零、重新对齐到最新，积压的消息就永久跳过了。这里把「文件不存在」和「读坏了」分开。
function readJsonStrict(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, value: null }
    throw error
  }
  try {
    return { exists: true, value: JSON.parse(raw) }
  } catch (error) {
    throw new Error(`${path.basename(file)} 损坏：${error.message}`)
  }
}

const LOG_CAP_BYTES = 1024 * 1024
/** append 一行日志，文件超过 1MB 时只保留最后一半，避免手机上无限增长。 */
function appendCappedLog(name, line) {
  const file = path.join(bridgeDir(), name)
  try {
    const stat = fs.statSync(file)
    if (stat.size > LOG_CAP_BYTES) {
      const kept = fs.readFileSync(file, 'utf8').slice(-Math.floor(LOG_CAP_BYTES / 2))
      fs.writeFileSync(file, kept)
    }
  } catch {
    /* 文件不存在就正常 append */
  }
  fs.appendFileSync(file, line)
}

/** 同机器上是否还有这个 pid（跨进程单例用）。 */
function processAlive(pid) {
  const n = Number(pid) || 0
  if (!(n > 0)) return false
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

const LEASE_TTL_MS = 45_000
/**
 * 抢一份跨进程租约（文件 + pid + 心跳时间）。
 * 同一个 DSH_HOME 下只允许一个进程跑收件器/唤醒器：否则两个进程各自 read-modify-write
 * 同一个状态文件，消息会被投两遍。租约 45 秒没心跳就视为进程已死，可以被接管。
 */
function acquireLease(name) {
  const file = path.join(bridgeDir(), `lease-${name}.json`)
  const now = Date.now()
  let current = null
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    current = null
  }
  if (current && Number(current.pid) !== process.pid) {
    const fresh = now - (Number(current.at) || 0) < LEASE_TTL_MS
    if (fresh && processAlive(current.pid)) return false
  }
  try {
    writeJson(file, { pid: process.pid, at: now })
  } catch {
    return false
  }
  return true
}

/** 续租；返回 false 表示租约已被别的进程接管，本进程应该停下。 */
function renewLease(name) {
  return acquireLease(name)
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
}

// desktop.json 同时被两个进程写（宿主半 + 桥接）。整份覆盖会把对方刚写的字段冲掉
// —— links 和 devices 都因此丢过。所有写入统一走「先读盘上最新，再叠加自己的改动」。
export function patchConfig(changes) {
  const disk = readJson(configPath(), null) || {}
  const next = { ...disk, ...changes }
  if (next.pendingNewSession === null) delete next.pendingNewSession
  writeJson(configPath(), next)
  return next
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

// 统一的会话短 id：session-<uuid> 直接 slice(0,8) 会得到 "session-"，界面上全都长一样。
export function shortSession(id) {
  return String(id || '').replace(/^session-/, '').slice(0, 8)
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

// 面板 5 秒轮询一次，开几个标签页就有几个并发调用。原来每个调用都会往下走到
// spawn，抢在前面那几个 bridge 因为端口占用必然退出，desktop.lock 还会记下死 pid。
// 用同一个 Promise 去重「正在启动」的那一段。
let serverBooting = null
async function ensureServer(config) {
  if (serverBooting) return serverBooting
  serverBooting = (async () => {
    try {
      return await bootServer(config)
    } finally {
      serverBooting = null
    }
  })()
  return serverBooting
}

async function bootServer(config) {
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
  return `http://${first || '127.0.0.1'}:${config.port}/pair?t=${config?.token}`
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
      // 一行坏掉（进程被杀写半行）不能让整块对话变空白：坏行跳过，其余照读。
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
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
      sessionId: shortSession(item.sessionId),
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
      // 面板要按时间倒序显示「最近的」会话，丢了 at 就只能显示文件里的老条目。
      at: String(item.at || ''),
      // 三种：手机会话（session）/ 子智能体（subagent）/ 桌面模型（model）。
      // 以前 session 被并进 model，面板分不出哪些是手机开着来的会话。
      kind: item.kind === 'subagent' ? 'subagent' : item.kind === 'session' ? 'session' : 'model',
      // 手机会话的 running 是注册时写死的 true、永不复核（几天前的旧条目也显示「运行中」）；
      // 改按最后一次上报时间算：90 秒内上报过才算在跑。子智能体仍用 pid 探活。
      running:
        item.kind === 'session'
          ? (() => {
              const at = Date.parse(String(item.at || ''))
              return Number.isFinite(at) && Date.now() - at < 90_000
            })()
          : typeof item.running === 'boolean'
            ? item.running
            : pidAlive(item.pid),
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
  const thread = readThread(50)
  return {
    role: isPhone() ? 'phone' : 'desktop',
    online: Boolean(health?.online),
    device: health?.device || null,
    port: health?.port || background?.port || config.port,
    listen: `${config.host}:${config.port}`,
    background: background ? { pid: background.pid, port: background.port } : null,
    pairing: health?.pairing?.length ? health.pairing : Array.isArray(lock?.pairing) ? lock.pairing : [],
    pairUrl: health?.pairUrl || (config?.token ? fallbackPairUrl(config) : ''),
    workbenchUrl: health?.workbenchUrl || '',
    permitLeft: Number(health?.permitLeft || 0),
    pendingPair: health?.pendingPair || null,
    code: Number(health?.codeLeft || 0) > 0 ? '' : '',
    thread: thread.messages,
    threadTotal: thread.total,
    toggles: Object.fromEntries(TOGGLES.map((key) => [key, config[key] !== false])),
    devices: (config.devices || []).map((item) => ({
      id: shortSession(item.id),
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
    // 手机端：电脑那边同步过来的开关表。镜像写在 phone-links.json（桌面 links 的副本），
    // 旧版把同一份数据写在 phone.json.peerLinks 里，读的时候两个都认。
    peerLinks:
      readJson(path.join(bridgeDir(), 'phone-links.json'), null) ||
      readJson(phoneConfigPath(), null)?.peerLinks ||
      {},
    // 手机端「这个手机会话是否已和电脑联通」的唯一依据：电脑记的 phoneId + 本机映射的值。
    // 之前 client 直接拿 peerLinks[key].phoneId 去比，但手机侧那张表从来没人写，开关永远不亮。
    linkedPhoneIds: (() => {
      const ids = new Set()
      const mirror = readJson(path.join(bridgeDir(), 'phone-links.json'), null)
      if (mirror && typeof mirror === 'object' && !Array.isArray(mirror)) {
        for (const item of Object.values(mirror)) {
          if (item && typeof item === 'object' && item.phoneId) ids.add(String(item.phoneId))
        }
      }
      const peer = readJson(path.join(bridgeDir(), 'peer-links.json'), null)
      if (peer && typeof peer === 'object' && !Array.isArray(peer)) {
        for (const value of Object.values(peer)) if (value) ids.add(String(value))
      }
      return [...ids]
    })(),
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
    patchConfig({ [key]: Boolean(body.value) })
    return { text: `已${Boolean(body.value) ? '允许' : '关闭'} ${key}` }
  }
  if (body.action === 'token') {
    patchConfig({ token: crypto.randomBytes(16).toString('hex') })
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
    patchConfig({ wake })
    if (typeof body.text === 'string' && body.text.trim()) {
      const agents = wakeAgents()
      if (!agents) return { text: '设置已保存；引擎里还没挂上 agents 服务，等一会儿再试' }
      const target = wake.sessionId || readActive()?.sessionId || ''
      if (!target) throw new Error('还没有模型调用过互联工具，所以不知道唤哪个会话；让电脑模型用一次 peer_info 再试')
      const result = await wakeSession(agents, target, body.text.trim(), wake.mode)
      let state = null
      try {
        // 非 strict 读会把损坏/被占用的状态当空对象，紧接着整份写回 ——
        // cursor / delivered / giveUp 全被抹成初始值，下一轮「首次对齐」静默跳过积压。
        state = readWakeState({ strict: true })
      } catch {
        return { text: `已投进会话 ${shortSession(target)}…，但状态文件读不出来，这次没写回（避免把游标抹掉）` }
      }
      state.lastWake = result
      state.lastError = ''
      writeWakeState(state)
      return { text: `已把消息投进会话 ${shortSession(target)}…（${result.mode}）` }
    }
    const auto = wake.sessionId || readActive()?.sessionId || ''
    return { text: `唤醒：${wake.enabled ? '开' : '关'}${auto ? `，会话 ${shortSession(auto)}…` : '，还没记录到会话'}` }
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
    const row = await bridgePost(`http://127.0.0.1:${info.port}`, '/thread', config?.token, { from: 'desktop', to: target, text, level: body.level })
    return { text: `已发到 ${target}（#${row.seq ?? '?'}）` }
  }
  if (body.action === 'linkRemote') {
    // 手机端会话界面上的开关：写回电脑，真源在电脑。
    const conf = readJson(phoneConfigPath(), null)
    // 设备签名配对之后 phone.json 的 token 是空字符串，旧代码在这里强校验 token，
    // 结果手机面板上的「互联」开关永远报「手机还没连上电脑」。地址可以从 peer.json
    // 恢复，鉴权 bridgePost 会优先用设备签名。
    const remoteBase = phoneBase(conf)
    if (!remoteBase) throw new Error('手机还没连上电脑：先在电脑面板上配对')
    const phoneId = String(body.phoneId || '').trim()
    if (!phoneId) throw new Error('要指定哪个手机会话')
    const payload = { phoneId, desktopId: String(body.desktopId || '').trim(), off: !!body.off }
    const out = await bridgePost(remoteBase, '/collab', conf?.token, payload)
    if (!out || out.ok === false) throw new Error(String((out && out.text) || '电脑那边没同意'))
    try {
      // 只合并对端给的那几个键。这个文件同时还存着「自动分身映射」，
      // 整份覆盖会把自动建立的映射抹掉，下一条同源消息就会在手机上重开一个会话。
      writeJson(path.join(bridgeDir(), 'peer-links.json'), { ...readPeerLinks(), ...(out.links || {}) })
    } catch {}
    return { text: body.off ? '已断开这个会话的互联' : '已连上电脑上的会话' }
  }
  if (body.action === 'link') {
    // 面板上某个会话的「互联」开关：打开 = 配一个对端会话，关闭 = 删掉。
    let desktopId = String(body.desktopId || '').trim()
    if (!desktopId && !body.off) {
      // 用户 m04603：「一端打开互联另一端如果没有对应对话的话，新建对话的功能没实现」
      // desktopId 没给 = 对端要求这边开一个新会话接上。
      try {
        desktopId = await createFreshSession()
      } catch (error) {
        throw new Error(`${error?.message || error}（先在这个会话里手动开一个新对话也行）`)
      }
    }
    if (!desktopId) throw new Error('要指定是哪个电脑会话')
    const links = readLinks()
    if (body.off) {
      delete links[desktopId]
      writeLinks(links)
      return { text: '已断开这个会话的互联' }
    }
    // 没指定手机会话时就别硬接一个现成的：以前这里接「最近上报的那个」，
    // 结果每个新会话都被连到同一个老手机会话上，消息全串进去（用户实测踩到）。
    // 现在留空，让手机侧按 desktopId 自动开（或复用）它自己对应的那个会话。
    const phoneId = String(body.phoneId || '').trim()
    links[desktopId] = phoneId
      ? { phoneId, at: new Date().toISOString() }
      : { at: new Date().toISOString() }
    writeLinks(links)
    const short = (id) => String(id).replace(/^session-/, '').slice(0, 8)
    return { text: phoneId ? `已把这个会话连到手机 ${short(phoneId)}` : '已打开互联：手机会给这个会话开一个对应的对话' }
  }
  if (body.action === 'collab') {
    const collab = readCollab(config)
    if (typeof body.desktopSessionId === 'string') collab.desktopSessionId = body.desktopSessionId.trim()
    if (typeof body.phoneSessionId === 'string') collab.phoneSessionId = body.phoneSessionId.trim()
    if (typeof body.phoneName === 'string') collab.phoneName = body.phoneName.trim()
    config.collab = collab
    // 钉了电脑会话就等于告诉唤醒器「投给它」，不用再让用户去另一个开关里填一遍。
    const changes = { collab }
    if (collab.desktopSessionId) {
      const wake = readWake(config)
      wake.sessionId = collab.desktopSessionId
      wake.enabled = true
      config.wake = wake
      changes.wake = wake
    } else if (body.desktopSessionId === '') {
      // 解绑电脑会话时唤醒器必须一起熄：留着会把消息投给一个已经不互联的会话。
      const wake = readWake(config)
      wake.sessionId = ''
      wake.enabled = false
      config.wake = wake
      changes.wake = wake
    }
    patchConfig(changes)
    const parts = []
    parts.push(collab.desktopSessionId ? `电脑会话 ${shortSession(collab.desktopSessionId)}…` : '电脑会话未选')
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
  // 不再「取最近上报的手机会话」：用户要的是每个电脑会话对唯一一个手机会话，
  // 没有显式配对就是没有，不允许拿别的会话顶替。
  return ''
}

export function readLinks(config) {
  const raw = readJson(linksPath(), null)
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length) return raw
  // 兼容两种老来源：调用方传进来的 config.links（测试用）、以及迁移前存在
  // desktop.json 里的 links 字段。
  const passed = config && typeof config.links === 'object' && !Array.isArray(config.links) ? config.links : null
  const legacy = passed || (readJson(configPath(), {}) || {}).links
  return legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? legacy : {}
}

export function writeLinks(links) {
  writeJson(linksPath(), links && typeof links === 'object' ? links : {})
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
      short: shortSession(row.id),
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
      name: (cwd ? path.basename(cwd) : '') || shortSession(id),
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

function readWakeState({ strict = false } = {}) {
  let state = {}
  try {
    const { value } = readJsonStrict(wakeStatePath())
    state = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch (error) {
    // 损坏时：tick 用 strict 版本（本轮直接放弃、不动文件），展示用宽松版本。
    if (strict) throw error
    state = {}
  }
  return {
    cursor: Number(state.cursor || 0),
    lastWake: state.lastWake || null,
    lastError: String(state.lastError || ''),
    // 这两个字段以前被丢掉了：giveUp 每次从 0 开始（永不放弃重试）、
    // aligned 每次从 false 开始（每轮都要重新对齐游标）。
    giveUp: state.giveUp && typeof state.giveUp === 'object' ? state.giveUp : {},
    aligned: state.aligned === true,
    // 已投递成功的 seq。漏掉这个字段，busy 组钉住游标时同批消息会每轮重投（功能等于没修）。
    delivered: Array.isArray(state.delivered)
      ? state.delivered.map((n) => Number(n)).filter((n) => n > 0)
      : [],
    // blocked 的轮次计数。桌面侧以前根本没有这个字段：blockedSeqs 只声明、只 push，
    // 从没被读取，点名会话一关就把游标永久钉死（代码审查发现）。
    blocked: state.blocked && typeof state.blocked === 'object' ? { ...state.blocked } : {},
  }
}

function writeWakeState(value) {
  writeJson(wakeStatePath(), value)
}

/**
 * Deliver one user message into a live Session through the engine's own agent
 * service, the same path the Web UI uses.
 */
const BUSY_TIMEOUT_MS = Number(process.env.PHONE_BRIDGE_BUSY_MS || 120_000)
const busySince = new Map()

export async function wakeSession(agents, sessionId, text, mode = 'queue', options = {}) {
  const agent = agents?.get?.(sessionId)
  if (!agent) {
    // 会话没在这个引擎里打开（切走了、重启过、或者 id 记错了）就别硬投。
    // 但要让等待的一方知道：**是目标不在线，不是投递出错**。
    const open = listLiveSessions(agents)
    const hint = open.length
      ? `；当前开着 ${open.length} 个会话：${open.map((row) => shortSession(row.id)).join('、')}`
      : '；当前一个会话都没开'
    throw new Error(`会话 ${shortSession(sessionId)}… 没开在引擎里${hint}。先把它切到前台，或传完整 ID 重新指定`)
  }
  // 对方正在生成（一回合没跑完）时别 followup：那会排进 inbox，界面上就多出
  // 一条「等待发送」的消息气泡——用户的原话是「有时候会出现等待发送的对方模型
  // 消息」。等它空下来再投，反正消息留在工作台上不丢，3 秒后还会再试。
  //
  // 但状态有时会卡住（实测手机会话 status 一直是 running、实际早就没在干活），
  // 那就会永远投不进去。所以同一会话连续报忙超过 BUSY_TIMEOUT_MS 就强投一次。
  const status = String(agent.status || '')
  if (!options.force && status && status !== 'idle') {
    const since = busySince.get(sessionId) || Date.now()
    busySince.set(sessionId, since)
    const stuckFor = Date.now() - since
    if (stuckFor < BUSY_TIMEOUT_MS) {
      // 忙 = 这一批先放下，不是「投递失败」。调用方据此把游标推过去，
      // 否则每 3 秒重投一次、每次都唤醒对方——对端看到的就是同一条消息刷屏。
      const busy = new Error(`会话 ${shortSession(sessionId)}… 正忙（${status}），这条消息等它空下来再投`)
      busy.busy = true
      throw busy
    }
    console.log(`[phone-bridge] 会话 ${shortSession(sessionId)}… 报忙已 ${Math.round(stuckFor / 1000)}s，状态多半卡住了，这次强行投递`)
    busySince.delete(sessionId)
  } else {
    busySince.delete(sessionId)
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
  const auth = Buffer.from(JSON.stringify({ k: 'token', token: config?.token })).toString('base64url')
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
const PEEK_CHARS = 80

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
export function isNotice(text, item) {
  // 写入方显式打的标记优先：用户自己恰好发一句「（xx已连上xx）」时不能被当成系统通知吞掉。
  if (item && item.notice === true) return true
  if (item && item.notice === false) return false
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
  // 手机上这条会占一整屏（字体是 DSH/Flutter 那边渲染的，插件改不了字号），
  // 所以只能压内容：摘要 80 字 + 一行极短提示。
  return `${mark}【互联】${head}（${total} 字）${when}\n${peek}\n（全文：peer_read）`
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

// 用户要的「另一端没有对应对话就新建」：在这里真的把会话开出来。
// 新会话的模型：agents.create 不会自己继承默认模型，agentOptions 空着会报
// 「has no provider/model」。从本机 profile 的 agent-default-model 里读。
export function defaultModel() {
  const dir = path.join(dshHome(), 'profiles')
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  for (const name of names) {
    // 备份/临时 profile（desktop.backup-20261017-225734 这类）不算数：
    // 它可能带着一个早就换掉的模型配置，按 readdir 顺序挑到它就会用错模型。
    if (/\.(backup|bak)([-.]|$)/i.test(name)) continue
    let text = ''
    try {
      text = fs.readFileSync(path.join(dir, name, 'cordis.patch.yml'), 'utf8')
    } catch {
      continue
    }
    const match = text.match(
      /- id: agent-default-model[\s\S]{0,600}?provider:\s*['"]?([\w.-]+)['"]?[\s\S]{0,200}?model:\s*['"]?([\w.:-]+)['"]?/
    )
    if (match) return { provider: match[1], model: match[2] }
  }
  return null
}

// DSH 不许插件凭空建会话，但宿主进程里有 agents.create（AgentLoop 的工厂）。
// 两个坑：① 不给 meta.cwd 会落到 _no-cwd，App 打开就是「同步中断」；
// ② 不给 agentOptions.provider/model 会报「has no provider/model」，一跑就出错。
async function createFreshSession() {
  const agents = agentsRef
  if (!agents || typeof agents.create !== 'function') {
    throw new Error('这台电脑上的 DSH 不支持自动新开会话（agents.create 不可用）')
  }
  const id = `session-${crypto.randomUUID()}`
  const agentOptions = defaultModel() || {}
  await agents.create({ sessionId: id, meta: { cwd: process.cwd() }, agentOptions })
  return id
}

// 手机点了开关、但电脑上一个会话都没开：手机那边写了一张便签过来
// （desktop.json.pendingNewSession），这里看到就开一个新会话并接上。
async function fulfilPendingSession() {
  const config = readConfig()
  const pending = config.pendingNewSession
  if (!pending || !pending.phoneId) return null
  let id = ''
  try {
    id = await createFreshSession()
  } catch (error) {
    console.error(`[phone-bridge] 自动新开会话失败：${error?.message || error}`)
    return null
  }
  const links = readLinks()
  links[id] = { phoneId: String(pending.phoneId), at: new Date().toISOString() }
  writeLinks(links)
  // 两边都要亮：手机端那颗开关靠这个会话出现在 links 里，电脑端靠 desktopSessionId。
  patchConfig({
    pendingNewSession: null,
    collab: { ...(config.collab || {}), desktopSessionId: id, at: new Date().toISOString() },
  })
  return id
}

async function wakeTick(agents) {
  // 跨进程租约：被另一个 DSH 进程接管后就别再投，否则两边各投一遍。
  if (!renewLease('wake')) return
  const config = readConfig()
  const wake = readWake(config)
  let state
  try {
    state = readWakeState({ strict: true })
  } catch (error) {
    // 状态文件坏了 / 被占用读不出来：本轮什么都不做。
    // 绝不能当成「首次启动」——那会重新对齐到最新，积压消息全被跳过。
    return
  }
  // 手机端要求「电脑没有会话时自动开一个」：先把便签兑现，再正常跑唤醒。
  try {
    await fulfilPendingSession()
  } catch {
    // 开不出来不能拖住唤醒
  }
  // 先把开着的会话补进会话目录，session_list / session_note 才有的可选
  try {
    if (wake.enabled || config?.token) syncRegistry(agents)
  } catch {
    // 目录登记失败不影响唤醒
  }
  // 顺手写一份「这边开着哪些会话」的快照，桥接服务的 GET /collab 会带给对面。
  // 手机模型靠它才能 to: 'desktop:<名字>' 点名——它自己看不到电脑开了什么。
  try {
    if (config?.token) {
      writeJson(path.join(bridgeDir(), 'live.json'), {
        at: new Date().toISOString(),
        sessions: listLiveSessions(agents),
      })
    }
  } catch {
    // 快照失败不影响唤醒
  }
  if (!wake.enabled || !config?.token) return

  // 首次启动：把 cursor 对齐到「现在最后一条」，一条历史都不投。
  // 空工作台时 last 是 0，也要落一个 aligned 标记 —— 否则每个 tick 都重新对齐，
  // 等第一条消息落盘正好被对齐成「已处理」，消息就永远不投了。
  if (!state.aligned && !state.cursor) {
    try {
      const last = await alignCursor((query) => threadPath(config, query))
      state.cursor = Math.max(Number(state.cursor) || 0, last)
      state.aligned = true
      state.lastError = ''
      writeWakeState(state)
    } catch (error) {
      state.lastError = `对齐游标失败：${String(error?.message || error)}`
      writeWakeState(state)
    }
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

  const skipped = []
  // 已经投递成功的 seq。busy 组会让游标停住，若不记住「这条已经投过」，
  // 同批里已成功的组会被每 3 秒重投一次（真踩过：同一句刷了几十遍）。
  const delivered = new Set((Array.isArray(state.delivered) ? state.delivered : []).map((n) => Number(n)))
  // 已经被 agent_converse / peer_converse 当场读走的回复：同一个模型不该再看第二遍。
  const consumed = new Set(
    (readJson(path.join(bridgeDir(), 'consumed.json'), []) || []).map((n) => Number(n)),
  )
  const incoming = (data.messages || []).filter((item) => {
    if (!item) return false
    if (delivered.has(Number(item.seq))) {
      // 上一轮已经投给模型了，只是游标被同批的 busy 组挡住；跨过去，别重投。
      skipped.push(Number(item.seq) || 0)
      return false
    }
    // 漏掉自己的 seq 会让游标永远停在它前面，于是每 3 秒重读同一批、重复投递（真踩过）。
    if (item.from === 'desktop') {
      skipped.push(Number(item.seq) || 0)
      return false
    }
    // silent 行是文件变更日志：留在对话里给下次翻，但**不唤醒**。
    // 顺手把游标跨过去，否则每 3 秒都会把它们重读一遍。
    if (item.silent === true || consumed.has(Number(item.seq))) {
      skipped.push(Number(item.seq) || 0)
      return false
    }
    if (isNotice(item.text, item)) {
      // 系统通知不投递，但也得跨过去：留着会堵住 50 条的窗口。
      skipped.push(Number(item.seq) || 0)
      return false
    }
    const forDesktop = item.to === 'desktop' || String(item.to || '').startsWith('desktop:')
    if (!forDesktop) skipped.push(Number(item.seq) || 0)
    return forDesktop
  })
  if (!incoming.length) {
    if (skipped.length) {
      // 和手机端一致：只推进到「从 cursor 起连续处理过」的那段，直接取 max 会越过
      // 窗口里既没投也没跳过的 seq（= 永久丢消息）。
      const handledSeq = new Set(skipped)
      const allSeqs = (data?.messages || [])
        .map((item) => Number(item?.seq) || 0)
        .filter((n) => n > 0)
        .sort((a, b) => a - b)
      let cursorNow = Number(state.cursor) || 0
      for (const seq of allSeqs) {
        if (seq <= cursorNow) continue
        if (!handledSeq.has(seq)) break
        cursorNow = seq
      }
      state.cursor = cursorNow
    }
    // 没有新消息也要把 lastError 收干净，别让一条旧报错一直挂着。
    if (state.lastError || skipped.length) {
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
  // 优先级：会话开关（links）> 面板钉的协作对 > 卡片里的 sessionId。
  // **不再兜底到「最近活跃的那个会话」**——用户要的是「每一个会话一一对应」，
  // 兜底会把所有消息都灌进同一个会话。
  // 只认用户显式选的配对（面板 collab / 卡片配置）；**不再拿「最近点过开关的
  // 那个会话」兜底**——那是「沿用最近」的最后一个入口，会让所有消息挤进一个会话。
  const pinned = collab.desktopSessionId || wake.sessionId || ''
  const pickByPinned = pinned ? live.find((row) => row.id === pinned) : null

  // 同一个会话的消息合成一条投。用户的原话是「每次你俩发消息，出现一大串，
  // 影响我看回答」—— 逐条 followup 会把对话刷屏，而模型之间的话本来也不需要
  // 那么啰嗦：合并成一条，超长截断，全文仍留在工作台上可查。
  const groups = new Map()
  // 点名了、但那个电脑会话没开着 / 正忙：游标停在这一条等它，不能改投、也不能丢。
  const blockedSeqs = []
  for (const item of incoming) {
    const named = String(item.to || '').startsWith('desktop:') ? String(item.to).slice('desktop:'.length) : ''
    const fromDesktop = String(item.desktopId || '').trim()
    let sessionId = ''
    if (named) {
      // 点名优先，且必须真的投给点名对象：目标没开着就 blocked 等，不能悄悄改投到
      // pinned 的会话（以前那样做，用户以为发给了 A，实际进了 B）。
      const matched = matchSession(live, named) || resolveNamed(named)
      const alive = matched && live.some((row) => row.id === matched.id)
      if (!alive) {
        blockedSeqs.push(Number(item.seq) || 0)
        state.lastError = `点名的电脑会话 ${named} 没开着，等它打开再投`
        continue
      }
      sessionId = matched.id
    } else if (fromDesktop && live.some((row) => row.id === fromDesktop)) {
      // 消息自己带了「这条是跟哪个电脑会话说的」—— 唯一能真正一对一的依据。
      sessionId = fromDesktop
    } else {
      sessionId = pickByPinned?.id || ''
    }
    if (!sessionId) {
      // 没有一一对应的电脑会话（发消息的会话没点互联开关）。这条**投给谁都不对**，
      // 所以跳过并推进游标 —— 但必须留下能看见的提示，否则用户永远不知道这条没送到。
      // 不能用 blocked：结构性问题（没点开关）等 5 分钟也不会自己好，只会把后面
      // 所有正常消息一起卡住。用户点了开关之后的新消息会正常投递。
      state.lastError = `有第 ${Number(item.seq) || 0} 条消息没有对应的电脑会话（那个会话没开互联），已跳过；在电脑上给那个会话点「🔗 互联」后新消息才投得进去`
      skipped.push(Number(item.seq) || 0)
      continue
    }
    if (!groups.has(sessionId)) groups.set(sessionId, [])
    groups.get(sessionId).push(item)
  }

  const sentSeqs = []
  const failedSeqs = []
  for (const [sessionId, items] of groups) {
    const who = items[0].from === 'phone' ? '手机模型' : String(items[0].from || '对方')
    try {
      state.lastWake = await wakeSession(agents, sessionId, composeBatch(items, who), wake.mode)
      state.lastError = ''
      for (const item of items) {
        const seq = Number(item.seq) || 0
        sentSeqs.push(seq)
        delivered.add(seq)
      }
    } catch (error) {
      state.lastError = String(error?.message || error)
      // 「对方正忙」不是投递失败，也不是「可以丢掉」：wakeSession 忙时根本没投递，
      // 消息还在工作台上。此时既不 skipped（那会推游标把消息越过、永久丢）也不
      // failed（3 次就放弃），直接 continue 让游标停在这一条，等对方空下来再投。
      if (error?.busy) continue
      for (const item of items) failedSeqs.push(Number(item.seq) || 0)
      // 原来这里是 break：一个目标投不进去，排在它后面的组就永远没机会了，
      // 声音最大的那个坏会话会把整条链路堵死（代码审查发现）。
      continue
    }
  }
  // 同一条连续投不出去超过 3 次就放弃（消息留在工作台里，peer_read 仍能看到），
  // 否则游标不动、每 3 秒重投一遍，对端会看到同一条消息反复出现。
  const giveUp = state.giveUp || {}
  for (const seq of failedSeqs) {
    const times = (giveUp[seq] || 0) + 1
    if (times >= 3) {
      skipped.push(seq)
      delete giveUp[seq]
    } else {
      giveUp[seq] = times
    }
  }
  for (const seq of sentSeqs) delete giveUp[seq]
  // 只保留最近 500 条窗口内的计数，否则这两个对象随 seq 无限增长。
  const keepFrom = Math.max(0, (Number(state.cursor) || 0) - 500)
  for (const key of Object.keys(giveUp)) if (Number(key) < keepFrom) delete giveUp[key]
  state.giveUp = giveUp
  // blocked（点名目标没开着 / 对方正忙）不能无限等：满 100 轮（约 5 分钟）就跳过并说明。
  // 之前 blockedSeqs 只声明、只 push，从未被读取 —— 点名会话一关，游标就永久钉死在
  // 那条 seq 前面；而 /thread 只拉 [cursor, cursor+200]，落后超过 200 条再触发 rotate
  // 归档，中间那些消息既没投也没进 skipped，会成批永久丢失且不给任何信号。
  const blocked = state.blocked && typeof state.blocked === 'object' ? { ...state.blocked } : {}
  for (const seq of blockedSeqs) {
    if (!(seq > 0)) continue
    const times = (Number(blocked[seq]) || 0) + 1
    if (times >= 100) {
      skipped.push(seq)
      delete blocked[seq]
    } else {
      blocked[seq] = times
    }
  }
  for (const seq of [...sentSeqs, ...skipped]) delete blocked[seq]
  const blockedKeep = Math.max(0, (Number(state.cursor) || 0) - 500)
  for (const key of Object.keys(blocked)) if (Number(key) < blockedKeep) delete blocked[key]
  state.blocked = blocked
  // 只推进到「从当前 cursor 起连续处理过」的那一段，理由同 inboxTick：
  // 取 min(failedSeqs) 当边界会把失败组之后已成功的消息留在游标外，下一轮重投一遍。
  const handled = new Set([...sentSeqs, ...skipped])
  const seqs = (data.messages || [])
    .map((item) => Number(item.seq) || 0)
    .filter((seq) => seq > 0)
    .sort((a, b) => a - b)
  let cursorNow = Number(state.cursor) || 0
  for (const seq of seqs) {
    if (seq <= cursorNow) continue
    if (!handled.has(seq)) break
    cursorNow = seq
  }
  state.cursor = cursorNow
  // 只留 cursor 附近最近的 500 个，状态文件不会无限长。
  state.delivered = [...delivered].filter((seq) => seq > cursorNow - 500).sort((a, b) => a - b).slice(-500)
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
      // createdAt 是「这个会话哪时候建的」，用它判活跃会把刚说话的会话排到最后；
      // 文件 mtime 才是「最近一次有人在这里说话」。
      at: stamp || Number(record?.identity?.createdAt || 0) || 0,
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
    // agent 对象上没有 at/updatedAt 这些字段（实测全是 undefined，排序会全部并列 0），
    // 真正反映「这个会话最近有没有人说话」的是 projcache 文件的 mtime。
    // 来源会话要靠它推断，所以这里用两者取大。
    const touched = Number(item?.at || item?.updatedAt || item?.lastActivity || 0) || 0
    rows.push({
      id: String(id),
      at: Math.max(touched, sessionMeta(String(id)).at || 0),
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
          patchConfig({ wake })
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
  // 同 installInbox：一个进程只能有一个轮询，否则同一个游标被多份定时器抢着写。
  if (globalThis.__phoneBridgeWakeStarted) return
  globalThis.__phoneBridgeWakeStarted = true
  ctx.inject(['agents'], (scope) => {
    agentsRef = scope.agents
    bindLiveTarget(scope.agents)
    const start = () => {
      let busy = false
      const timer = setInterval(() => {
        if (busy) return
        busy = true
        wakeTick(scope.agents)
          .catch((error) => {
            // 以前这里是个空 catch：轮询一旦抛错，面板上什么都看不到。
            const message = String(error?.message || error)
            console.error(`[phone-bridge] wake poller: ${message}`)
            try {
              const current = readWakeState()
              current.lastError = `唤醒轮询出错：${message}`
              writeWakeState(current)
            } catch {}
          })
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

// 新版配对用设备签名（device.json 的私钥）；phone.json 里的 token 会被桥接清空。
// 这里优先签名，签名不可用才退回 token —— 否则手机侧收件器会因为「token 为空」静默停摆。
function deviceAuth() {
  try {
    const idf = readJson(path.join(bridgeDir(), 'device.json'), null)
    if (!idf || !idf.privatePem || !idf.id) return null
    const ts = Date.now()
    const sig = crypto.sign(null, Buffer.from(`${idf.id}:${ts}`), idf.privatePem).toString('base64')
    return { k: 'device', id: idf.id, ts, sig }
  } catch {
    return null
  }
}

const authQuery = (token) => {
  const auth = deviceAuth()
  return auth ? Buffer.from(JSON.stringify(auth)).toString('base64url') : phoneAuth(token)
}

async function bridgeGet(base, pathname, token, timeoutMs = 8000) {
  const sep = pathname.includes('?') ? '&' : '?'
  const res = await fetch(`${base}${pathname}${sep}auth=${authQuery(token)}`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

async function bridgePost(base, pathname, token, payload, timeoutMs = 8000, signal = null) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auth: deviceAuth() || { k: 'token', token }, ...payload }),
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  })
  if (!res.ok) {
    // 桥接把「不认识这个操作」「守卫为什么拦」写在 body 里，丢掉它只能说 HTTP 400。
    let detail = ''
    try {
      const body = await res.json()
      detail = String(body?.error || body?.text || '')
    } catch {
      /* body 不是 JSON 就算了 */
    }
    throw new Error(detail ? `HTTP ${res.status}：${detail}` : `HTTP ${res.status}`)
  }
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
            name: row.title || path.basename(row.cwd || '') || shortSession(row.id),
            host: 'phone',
            kind: 'session',
            note: `手机上开着的会话 · ${row.cwd || '目录未知'}`,
            running: true,
            at: new Date().toISOString(),
          },
        },
        5000,
      )
    } catch (error) {
      // 单个会话报不上不代表电脑离线：继续报后面的，别让排在第一的坏会话
      // 把其余会话永远挡在外面（面板下拉/peer_sessions 会一直缺会话）。
      const message = String(error?.message || error)
      if (/ECONNREFUSED|ENOTFOUND|fetch failed|aborted|timeout/i.test(message)) return
    }
  }
}

const lastSourcePath = () => path.join(bridgeDir(), 'last-desktop.json')
// peerLinks 单独存一个文件：phone.json 是手机 bridge 在维护的，它一写就把我们塞进去的
// 字段覆盖掉（实测第一版就是这样丢的）。
const peerLinksPath = () => path.join(bridgeDir(), 'peer-links.json')
const readPeerLinks = () => {
  const raw = readJson(peerLinksPath(), null) || (readJson(phoneConfigPath(), {}) || {}).peerLinks || {}
  // 只认「能当会话 id 用」的值：早期版本把电脑的 links 表（值形如 {phoneId, at}）
  // 也写进过这个文件，混在一起会让分身映射失效（见代码审查报告）。
  const out = {}
  for (const [key, value] of Object.entries(raw || {})) {
    if (typeof value === 'string' && value) out[key] = value
    else if (value && typeof value.phoneId === 'string' && value.phoneId) out[key] = value.phoneId
  }
  return out
}

// 手机侧按「来源电脑会话」分身：一个电脑会话对应一个手机会话。
// 第一次收到某个电脑会话的消息就新建一个，映射记在 peer-links.json（手机本地）。
async function ensureDesktopSession(agents, live, desktopId) {
  const links = readPeerLinks() || {}
  const known = links[desktopId]
  if (known && live.some((row) => row.id === known)) return { id: known, created: false }
  if (typeof agents?.create !== 'function') throw new Error('这台引擎不支持自动新开会话（agents.create 不可用）')
  // 映射里记着但会话已经不在了（应用重启过）——复用同一个 id 重新建，别让对话越开越多
  const id = known && /^session-/.test(known) ? known : `session-${crypto.randomUUID()}`
  // 会话头里必须有 cwd，否则 DSH 会把它丢进 _no-cwd，App 打开就是「同步中断」；
  // agentOptions 还必须给 provider/model，否则一跑就是「has no provider/model」。
  const cwd = live.map((row) => row && row.cwd).find((value) => typeof value === 'string' && value.startsWith('/')) || process.cwd()
  const agentOptions = defaultModel() || {}
  let created = id
  try {
    await agents.create({ sessionId: id, meta: { cwd }, agentOptions })
  } catch (error) {
    const message = String(error?.message || error)
    // 会话文件已经在了（上次建过、现在没打开）。**绝不能重建** —— 重建会让每一轮轮询
    // 都新开一个会话，同时把同一条消息反复重投（实测被投了 15 次以上）。
    // 直接沿用这个 id：投得进去就投，投不进去由上层记失败并最终放弃。
    // 错误信息可能被引擎本地化（中文「已存在」），别只认英文 ——
    // 认不出来就会 throw，上层记失败、3 次后放弃，下一轮又新建一个会话（越开越多）。
    if (/already exists|already-exists|已存在|重复创建|duplicate/i.test(message)) {
      // 会话文件在 ≠ 引擎里开着。文件残留但没打开时 wakeSession 必抛「没开在引擎里」，
      // 3 轮后进 skipped → 这个电脑会话之后每条消息都丢（映射不变，永远重走这条路）。
      if (typeof agents.get === 'function' && agents.get(id)) {
        writeJson(peerLinksPath(), { ...readPeerLinks(), [desktopId]: id })
        return { id, created: false }
      }
      const fresh = `session-${crypto.randomUUID()}`
      await agents.create({ sessionId: fresh, meta: { cwd }, agentOptions })
      writeJson(peerLinksPath(), { ...readPeerLinks(), [desktopId]: fresh })
      console.log(`[phone-bridge] 旧手机会话 ${String(id).replace(/^session-/, '').slice(0, 8)} 已失效，改投新会话 ${fresh.replace(/^session-/, '').slice(0, 8)}`)
      return { id: fresh, created: true }
    }
    throw error
  }
  writeJson(peerLinksPath(), { ...readPeerLinks(), [desktopId]: created })
  console.log(`[phone-bridge] 电脑会话 ${String(desktopId).replace(/^session-/, '').slice(0, 8)} → 手机会话 ${created.replace(/^session-/, '').slice(0, 8)}`)
  return { id: created, created: true }
}

// 配对信息在 peer.json 的 pairs 里；phone.json 的 url 会被桥接清空，不能只信它。
function phoneBase(config) {
  const direct = String(config?.url || '').replace(/\/+$/, '')
  if (direct) return direct
  try {
    const peer = readJson(path.join(bridgeDir(), 'peer.json'), null)
    const pair = Array.isArray(peer?.pairs) ? peer.pairs[0] : null
    if (pair && pair.host) return `http://${pair.host}:${Number(pair.port) || 8787}`
  } catch {}
  return ''
}

async function inboxTick(agents, lastReport) {
  const config = readJson(phoneConfigPath(), null)
  const base = phoneBase(config)
  if (!base) return lastReport
  // 会话列表上报要放在所有提前 return 之前：对齐失败、拉取失败、没活会话这几条路
  // 都会提前返回，原来放在末尾等于「一出问题就不再上报」，手机上新开的对话就再也
  // 同步不到电脑（实测踩过）。
  const now = Date.now()
  if (now - (Number(lastReport) || 0) > 30_000) {
    try {
      await reportPhoneSessions(agents, base, config?.token)
      lastReport = now
    } catch (error) {
      console.log(`[phone-bridge] 上报手机会话失败：${String(error?.message || error)}`)
    }
  }
  let state
  try {
    const { value } = readJsonStrict(inboxStatePath())
    state = value && typeof value === 'object' && !Array.isArray(value) ? value : { cursor: 0, lastError: '' }
  } catch (error) {
    // 和桌面侧一致：状态文件读坏了本轮直接放弃，别当「首次启动」把游标清零。
    return lastReport
  }

  // 和桌面侧一个规矩：第一次跑先把 cursor 对齐到最新，不把历史灌进会话。
  if (!state.aligned && !state.cursor) {
    try {
      const last = await alignCursor((query) => bridgeGet(base, `/thread?${query}`, config?.token, 8000), 'phone')
      // 工作台为空时 last 是 0，也要记下「已对齐」，否则每个 tick 都重对齐，
      // 等第一条消息落盘正好被对齐成已处理，永远不投。
      state.cursor = Math.max(Number(state.cursor) || 0, last)
      state.aligned = true
      state.lastError = ''
      writeJson(inboxStatePath(), state)
    } catch (error) {
      state.lastError = `对齐游标失败：${String(error?.message || error)}`
      writeJson(inboxStatePath(), state)
    }
    return lastReport
  }

  let data
  try {
    data = await bridgeGet(base, `/thread?since=${Number(state.cursor) || 0}&as=phone&limit=50`, config?.token)
  } catch (error) {
    const message = String(error?.message || error)
    if (message !== state.lastError) {
      state.lastError = message
      writeJson(inboxStatePath(), state)
    }
    return lastReport
  }

  // 接收方向不节流：这些本来就是该手机看见的消息，压住只会让对话卡住。

  const liveNow = listLiveSessions(agents)
  let collab = null
  let peerSessions = []
  let peerLinks = null
  try {
    const snapshot = await bridgeGet(base, '/collab', config?.token, 5000)
    collab = snapshot?.collab || null
    peerSessions = Array.isArray(snapshot?.desktopSessions) ? snapshot.desktopSessions : []
    peerLinks = snapshot?.links && typeof snapshot.links === 'object' ? snapshot.links : {}
  } catch (error) {
    // 拉不到配对表 → 本轮 pinned 为空，无 desktopId 的消息会被误判 blocked 卡住。
    // 记进 lastError 让面板能看到（原来这里是空白 catch，失败了完全没痕迹）。
    const message = `拉取配对表失败：${String(error?.message || error)}`
    if (message !== state.lastError) {
      state.lastError = message
      writeJson(inboxStatePath(), state)
    }
  }
  // 开关的真源在电脑上，手机这边只是镜像一份给会话顶部的按钮看。
  // 电脑上的 links 表只做 UI 镜像，**绝不能**写进 peer-links.json —— 那个文件存的是
  // 「电脑会话 → 手机会话」的分身映射（字符串值），两种结构混写会让映射全部失效，
  // 结果每批消息都新开一个手机会话（代码审查发现的真 bug）。
  if (peerLinks) {
    try {
      const mirrorPath = path.join(bridgeDir(), 'phone-links.json')
      const previous = readJson(mirrorPath, null)
      if (JSON.stringify(previous || {}) !== JSON.stringify(peerLinks)) {
        writeJson(mirrorPath, peerLinks)
      }
    } catch {}
  }
  // 电脑上点了某个会话的「互联」但还没说话时，先把对应的手机会话建出来，
  // 否则用户会觉得「点了没反应」，要等第一条消息才冒出新会话。
  if (peerLinks && Object.keys(peerLinks).length) {
    // 每轮最多建 2 个：agents.create 可能要几百毫秒，一口气建 6 个会把这一轮 tick
    // 拖过 3 秒，下一轮被 busy 直接跳过，反而更慢（剩余的下轮继续）。
    let built = 0
    for (const [desktopId, entry] of Object.entries(peerLinks)) {
      if (built >= 2) break
      // entry 是 links 表里的值：{at} 或 {phoneId, at}。只有已经有 phoneId 的才算已映射。
      // （早先写成 `if (entry) continue` —— 对象永远 truthy，结果一条都不预建。）
      if (!desktopId || entry?.phoneId) continue
      built += 1
      try {
        const made = await ensureDesktopSession(agents, liveNow, desktopId)
        if (made && made.id && made.created) {
          const line = `${new Date().toISOString()} 预建手机会话：${desktopId.replace(/^session-/, '').slice(0, 8)} → ${String(made.id).replace(/^session-/, '').slice(0, 8)}\n`
          console.log(`[phone-bridge] ${line.trim()}`)
          try { appendCappedLog('inbox-boot.log', line) } catch {}
        }
      } catch (error) {
        console.log(`[phone-bridge] 预建会话失败：${String(error?.message || error)}`)
        try { appendCappedLog('inbox-boot.log', `${new Date().toISOString()} 预建失败 ${desktopId}：${String(error?.message || error)}\n`) } catch {}
      }
    }
  }
  // 电脑上开着的会话也记进本机目录，手机模型才有得点名
  if (peerSessions.length) {
    try {
      syncPeerSessions(peerSessions)
    } catch {}
  }
  // 同上：只认用户显式选的配对，不再取「最近点过开关的那个」。
  const pinned = String(collab?.phoneSessionId || '')

  const skipped = []
  // 已投递过的 seq：同批里其它消息 blocked 时游标会停住，不记住就会每轮重投。
  const delivered = new Set((Array.isArray(state.delivered) ? state.delivered : []).map((n) => Number(n)))
  const incoming = (data?.messages || []).filter((item) => {
    if (!item) return false
    if (delivered.has(Number(item.seq))) {
      skipped.push(Number(item.seq) || 0)
      return false
    }
    // 同上：手机自己发的消息不投，但必须进 skipped，否则游标卡在它前面、每轮重投同一批。
    if (item.from === 'phone') {
      skipped.push(Number(item.seq) || 0)
      return false
    }
    // 和桌面侧一致：silent 的变更日志不唤醒，但游标要跨过去。
    if (item.silent === true) {
      skipped.push(Number(item.seq) || 0)
      return false
    }
    // 系统通知（「（手机已连上电脑）」）不唤醒模型，但游标必须跨过去，
    // 否则一窗全是通知时后面的真实消息会被饿死（和 wakeTick 保持一致）。
    if (isNotice(item.text, item)) {
      skipped.push(Number(item.seq) || 0)
      return false
    }
    const to = String(item.to || '')
    // 收「给手机」的，也收「点名某个手机会话」的：phone:<id | 名字 | 标题>
    const forPhone = to === 'phone' || to.startsWith('phone:')
    // 不是给手机的（比如 to='all' 的广播、发给电脑的消息）也要记进 skipped，
    // 否则一窗 50 条全是这类消息时，每轮读到同一批、cursor 永远不动，后面全堵死。
    if (!forPhone) skipped.push(Number(item.seq) || 0)
    return forPhone
  })

  if (!incoming.length && skipped.length) {
    // 只推进到「从当前 cursor 起连续处理过」的那一段，不能直接取 max ——
    // 窗口里若有既没投也没跳过的 seq，越过它就是永久丢消息。
    const handledSeq = new Set(skipped)
    const allSeqs = (data?.messages || [])
      .map((item) => Number(item?.seq) || 0)
      .filter((n) => n > 0)
      .sort((a, b) => a - b)
    let cursorNow = Number(state.cursor) || 0
    for (const seq of allSeqs) {
      if (seq <= cursorNow) continue
      if (!handledSeq.has(seq)) break
      cursorNow = seq
    }
    state.cursor = cursorNow
    // 没有新消息要投：把「上轮找不到会话」这类旧错误清掉，面板不该一直挂着过期提示。
    state.lastError = ''
    writeJson(inboxStatePath(), state)
  } else if (!incoming.length && state.lastError) {
    // 连可跳过的都没有：同样清掉过期错误（和桌面侧 wakeTick 一致）。
    state.lastError = ''
    writeJson(inboxStatePath(), state)
  }

  if (incoming.length) {
    const live = listLiveSessions(agents)
    // 一个活会话都没有时，只有「带来源」的消息还救得回来：按来源新建一个会话投进去。
    // 不带来源的没法判断该给谁，还是老规矩：不动 cursor、消息留在工作台。
    if (!live.length && !incoming.some((item) => item.desktopId)) {
      // 和桌面侧一个规矩：没会话就**不动 cursor**，消息留着，绝不吞。
      state.lastError = `手机上现在没有开着的会话，${incoming.length} 条消息留在工作台`
      writeJson(inboxStatePath(), state)
      return lastReport
    }
    // 只认「明确配对的」手机会话：pinned 来自用户显式选择（collab/link）。
    // 绝不退回 live[0]——那会把所有电脑会话的消息挤进同一个手机会话。
    const fallback = (pinned && live.find((row) => row.id === pinned)) || null
    // 分组：带 desktopId 的按「来源电脑会话」各自分身；没带的保持老规矩
    // （点名的投给点名那个，没点名的投给 pinned / 最近活会话）。
    const groups = new Map()
    for (const item of incoming) {
      const to = String(item.to || '')
      const src = item.desktopId ? String(item.desktopId) : ''
      const key = src ? `d:${src}` : (to.startsWith('phone:') ? to : 'phone')
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    }
    const sent = []
    const misses = []
    const fails = []
    const failedSeqs = []
    // 「目标还不在」和「投递失败」要分开：前者可以等，后者才该放弃。
    const blockedSeqs = []
    for (const [key, rows] of groups) {
      const src = key.startsWith('d:') ? key.slice(2) : ''
      const want = key.startsWith('phone:') ? key.slice('phone:'.length) : ''
      let target = null
      if (src) {
        try {
          target = await ensureDesktopSession(agents, live, src)
        } catch (error) {
          fails.push(`给电脑会话 ${src.replace(/^session-/, '').slice(0, 8)} 开分身失败：${error?.message || error}`)
          for (const item of rows) failedSeqs.push(Number(item.seq) || 0)
          continue
        }
      } else {
        target = want ? matchSession(live, want) : fallback
      }
      if (!target) {
        misses.push(want)
        // 找不到目标 ≠ 投递失败：目标可能过一会儿就开了。绝不能进 failedSeqs ——
        // 那条路会「连续 3 次放弃 → skip → 游标越过」，消息就永久丢了。
        // 放进 blockedSeqs，游标会停在它前面，等目标出现再投。
        for (const item of rows) blockedSeqs.push(Number(item.seq) || 0)
        continue
      }
      try {
        // 第一句告诉模型「这是哪个电脑会话的对话」，否则它不知道自己接的是谁的活
        const head = src ? `（这是电脑会话 ${src.replace(/^session-/, '').slice(0, 8)} 的对话）\n` : ''
        state.lastWake = await wakeSession(agents, target.id, head + composeBatch(rows, '电脑模型'), 'queue')
        for (const item of rows) {
          const seq = Number(item.seq) || 0
          sent.push(seq)
          delivered.add(seq)
        }
        // 记住来源：回话时 sendAs/say 会把不点名的 desktop 自动改成 desktop:<来源>
        if (src) writeJson(lastSourcePath(), { desktopId: src, phoneId: target.id, at: Date.now() })
      } catch (error) {
        // 「会话正忙」不是投递失败：wakeSession 明确用 error.busy 表示「等下再投」。
        // 原来一律进 failedSeqs，连续 3 次就 skipped 把游标越过 —— 手机发的消息就
        // 永久丢了（对方只是正在跑一回合，几秒后就能收）。所以 busy 走 blockedSeqs。
        if (error?.busy) {
          for (const item of rows) blockedSeqs.push(Number(item.seq) || 0)
          continue
        }
        fails.push(String(error?.message || error))
        for (const item of rows) failedSeqs.push(Number(item.seq) || 0)
      }
    }
    if (fails.length) state.lastError = fails[0]
    else if (misses.length) state.lastError = `找不到这些手机会话：${misses.join('、')}`
    else state.lastError = ''
    // 同一条连续投不出去超过 3 次就放弃（消息还留在工作台里，模型 peer_read 仍能看到，
    // 但没有必要每 3 秒重投一遍 —— 实测同一条被重放了 15 次以上，把对端刷屏了）。
    const giveUp = state.giveUp || {}
    for (const seq of failedSeqs) {
      const times = (giveUp[seq] || 0) + 1
      if (times >= 3) {
        skipped.push(seq)
        delete giveUp[seq]
      } else {
        giveUp[seq] = times
      }
    }
    for (const seq of sent) delete giveUp[seq]
    state.giveUp = giveUp
    // blocked（目标还没开 / 对方正忙）不能无限等：等够约 5 分钟就跳过并说明。
    // 否则一条无主消息会把游标钉死，后面已成功的消息永远在游标外、每轮重投（代码审查发现）。
    const blocked = state.blocked || {}
    for (const seq of blockedSeqs) {
      const times = (blocked[seq] || 0) + 1
      if (times >= 100) {
        skipped.push(seq)
        delete blocked[seq]
      } else {
        blocked[seq] = times
      }
    }
    for (const seq of [...sent, ...skipped]) delete blocked[seq]
    state.blocked = blocked
    // 只推进到「从当前 cursor 起连续处理过」的那一段。以前取 min(failedSeqs) 当边界，
    // 分组交错时（A 组 seq 1,3 成功、B 组 seq 2 失败）会把已经投成功的 3 留在游标外，
    // 下一轮重投一遍 —— 模型会看到重复消息（代码审查发现）。
    const handled = new Set([...sent, ...skipped])
    const seqs = (data?.messages || [])
      .map((item) => Number(item.seq) || 0)
      .filter((seq) => seq > 0)
      .sort((a, b) => a - b)
    let cursorNow = Number(state.cursor) || 0
    for (const seq of seqs) {
      if (seq <= cursorNow) continue
      if (!handled.has(seq)) break
      cursorNow = seq
    }
    state.cursor = cursorNow
    state.delivered = [...delivered].filter((seq) => seq > cursorNow - 500).sort((a, b) => a - b).slice(-500)
    writeJson(inboxStatePath(), state)
    // 投递循环的诊断：游标不动时靠这一行判断是哪一类消息把它钉住了。
    try {
      const seqList = (value) => (value.length > 6 ? `${value.slice(0, 6).join(',')}…(${value.length})` : value.join(','))
      appendCappedLog('inbox-boot.log',
        `${new Date().toISOString()} 本轮 msg=${seqs.length} in=${incoming.length} sent=${seqList(sent)} skip=${seqList(skipped)} fail=${seqList(failedSeqs)} block=${seqList(blockedSeqs)} cursor=${Number(state.cursor) || 0}\n`)
    } catch {}
  }

  return lastReport
}

function installInbox(ctx) {
  if (!isPhone()) return
  if (typeof ctx.inject !== 'function') return
  // 同一个引擎进程里 apply 可能被调用多次（热重载、多个入口），每多一个收件器就多一个
  // 3 秒轮询，它们各自持有自己的游标、互相覆盖 state —— 表现就是同一条消息被反复重投。
  if (globalThis.__phoneBridgeInboxStarted) return
  globalThis.__phoneBridgeInboxStarted = true
  if (!acquireLease('inbox')) {
    console.log('[phone-bridge] 另一个 DSH 进程已经在收消息了，本进程不重复起一个轮询')
    return
  }
  ctx.inject(['agents'], (scope) => {
    // 收件器出问题最难查：定时器里的错误会被吞掉，界面上只看到「消息没来」。
    // 所以启动和每次失败都留一行在 bridge 目录，出事了直接看文件。
    const notePath = () => path.join(bridgeDir(), 'inbox-boot.log')
    const note = (text) => {
      try {
        fs.appendFileSync(notePath(), `${new Date().toISOString()} ${text}\n`)
      } catch {}
    }
    note('收件器已启动（agents 已注入）')
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
          .catch((error) => {
            note(`这一轮失败: ${error?.stack || error}`)
          })
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
const ENGINE_BUNDLE = '@undertale11121/dsh-phone-bridge'
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
    '      disabled: true',
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
    // 只有 BEGIN 没有 END（手工删过/编辑器截断）：此时把 BEGIN 之后全当自注册段
    // 会把 profile 里后面的插件条目整片删掉 → DSH 起不来。宁可不动。
    if (end < 0) return patch
    const stop = end + AUTO_END.length
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
    const listed = Array.isArray(bundles) && (bundles.includes(ENGINE_BUNDLE) || bundles.includes('dsh-phone-bridge') || bundles.includes('dsh-phone-bridge-web'))
    const mentioned = /dsh-phone-bridge(-web)?\b/.test(patch)
    if (listed || mentioned) found.push({ patchFile, patch })
  }
  return found
}

// ── 宿主工具：把桥接工具在宿主进程里再注册一遍 ─────────────────────────────
//
// 为什么要有这一层：MCP 协议不告诉服务端「这次调用来自哪个会话」。MCP 半
// （src/desktop.mjs 的 serveMcp）拿不到 caller.sessionId，跨端守卫只能扫
// projcache 按 mtime 猜当前会话，猜错就会把已经开了互联的人挡在外面。宿主半
// 不一样：`execute(args, exec)` 里的 `exec.agent.session` 就是准确的当前会话。
// 所以同一批工具在宿主半再注册一次，调用时把 sessionId 一起带给桥接进程。
//
// 一次调用 = 一次 HTTP 往返 `POST /call {op, args, sessionId}`：手机连接状态只
// 有桥接进程里有，宿主半不能自己去碰；桥接没在跑时给一句能照着做的错误。
//
// 工具表是 src/desktop.mjs `desktopTools()` 的副本：web 半会被单独拷进 profile
// 的 node_modules（见文件头注释），import 不了 ../src/*，只能内联。改 src 里的
// 工具名/描述/参数时，这张表要跟着改，否则两边对不上。
const HOST_TOOLS = [
  {
    "name": "peer_info",
    "description": "查看手机端（dsh-go 所在设备）是否在线、设备信息；未连接时返回配对串，把配对串发到手机对话里让对方执行 bridge_pair 即可。",
    "parameters": {}
  },
  {
    "name": "bridge_setup",
    "description": "打开图形化配置页（浏览器地址）：查看手机/电脑连接状态、配对串、自动发现、权限开关。用户问「怎么配」「在哪设置」时给出这个地址即可。",
    "parameters": {}
  },
  {
    "name": "agent_list",
    "description": "列出工作台上可以对话的 agent：电脑模型、手机模型，以及双方启动的子智能体，带 id 和是否在跑。",
    "parameters": {}
  },
  {
    "name": "agent_send",
    "description": "给指定 agent 发消息（不执行任务）：to 写 agent_list 里的 id，省略/写 all 就是广播给所有人。适合找子智能体、给某个 agent 留言。level 标重要性，对方唤醒语里会带对应符号。",
    "parameters": {
      "to": {
        "type": "string",
        "description": "目标 agent id，例如 phone、review-1；省略=广播"
      },
      "text": {
        "type": "string",
        "description": "要说的内容",
        "required": true
      },
      "from": {
        "type": "string",
        "description": "发起方是谁：填你自己会话的短 id（session_list 里带「（当前）」那条）。对端靠它决定投进哪个对话、或为你单独开一个。可不填"
      },
      "level": {
        "type": "string",
        "description": "重要性：urgent(❗等你回) / question(❓要你决定) / alert(⚠️出问题) / done(✅做完了) / report(📋进度汇报不用回)；不写=普通"
      }
    }
  },
  {
    "name": "agent_converse",
    "description": "给指定 agent 发一句并等它回话（最多 waitSeconds 秒，默认 120）。对方是子智能体时它会自己动手并回报；没有回话就返回已有消息，不假装成功。",
    "parameters": {
      "to": {
        "type": "string",
        "description": "目标 agent id；省略=发给手机模型"
      },
      "text": {
        "type": "string",
        "description": "要说的话",
        "required": true
      },
      "waitSeconds": {
        "type": "number",
        "description": "最多等多少秒，5–600，默认 120"
      }
    }
  },
  {
    "name": "agent_read",
    "description": "读工作台对话（广播 + 发给你的 + 你说的），可选只看某段之后的新消息。",
    "parameters": {
      "since": {
        "type": "number",
        "description": "从第几条之后开始，默认 0"
      },
      "limit": {
        "type": "number",
        "description": "最多几条，默认 40"
      }
    }
  },
  {
    "name": "agent_spawn",
    "description": "像子智能体一样加一个自己干活的 agent：给它名字和任务，它会独立运行（可用同一套工作台工具），完成后把结果发回来。host=desktop 在本机跑，host=phone 在手机上跑。",
    "parameters": {
      "name": {
        "type": "string",
        "description": "名字，例如 构建手、审查员"
      },
      "task": {
        "type": "string",
        "description": "要它做的事，写清楚验收标准",
        "required": true
      },
      "host": {
        "type": "string",
        "description": "在哪台机器上跑，默认 desktop",
        "enum": [
          "desktop",
          "phone"
        ]
      }
    }
  },
  {
    "name": "agent_stop",
    "description": "停掉一个子智能体（内建的两个模型不能这样停）。",
    "parameters": {
      "id": {
        "type": "string",
        "description": "agent id",
        "required": true
      }
    }
  },
  {
    "name": "session_list",
    "description": "列出电脑上用过互联工具的会话：id 前 8 位、名字、用途、项目、调用次数、最近活跃。想知道「该唤醒哪个会话」时先看这里。",
    "parameters": {}
  },
  {
    "name": "session_note",
    "description": "给一个会话写清它是干什么的（用途/项目/名字），之后唤醒可以按用途选。target 省略或写 current = 正在调用你的这个会话。",
    "parameters": {
      "target": {
        "type": "string",
        "description": "会话 id、id 前几位、名字，或 current（默认）"
      },
      "name": {
        "type": "string",
        "description": "给会话起个短名字，比如「登录页」"
      },
      "purpose": {
        "type": "string",
        "description": "这个会话在做什么，一两句"
      },
      "project": {
        "type": "string",
        "description": "项目名，可选"
      }
    }
  },
  {
    "name": "peer_say",
    "description": "给对端模型发一句话，并立刻唤醒它一次（不执行任务，只是说话）：对方那边的收件器会在几秒内把这条投进它开着的会话。默认发给对端模型本人；要发给某个具体会话就写 phone:<会话名> / desktop:<会话名>。level 标重要性，对方的唤醒语里会带上对应符号（❗❓⚠️✅📋）。",
    "parameters": {
      "text": {
        "type": "string",
        "description": "要对对方模型说的话",
        "required": true
      },
      "to": {
        "type": "string",
        "description": "收件人：省略=对端模型；也可写 phone / phone:<会话名> / desktop / desktop:<会话名>"
      },
      "from": {
        "type": "string",
        "description": "发起方是谁：填你自己会话的短 id（session_list 里带「（当前）」那条）。想让对端为你这个会话单独开一个对话时必须带上，对端会按它分身"
      },
      "level": {
        "type": "string",
        "description": "这条有多要紧：urgent(❗等你回) / question(❓要你决定) / alert(⚠️出问题) / done(✅做完了) / report(📋进度汇报不用回)；不写=普通"
      }
    }
  },
  {
    "name": "peer_converse",
    "description": "发一条消息给手机模型，然后等它回话（最多 waitSeconds 秒）。用来跟手机那边一轮一轮商量：你问、它答、它也可以反问。等不到回复会把消息留在工作台上，之后用 peer_read 再看。",
    "parameters": {
      "text": {
        "type": "string",
        "description": "要对手机模型说的话",
        "required": true
      },
      "waitSeconds": {
        "type": "number",
        "description": "最多等多少秒，默认 120，最多 600"
      }
    }
  },
  {
    "name": "peer_read",
    "description": "读共享工作台上最近的对话（电脑模型和手机模型说的话都在里面）。配合 peer_say / peer_converse 使用。",
    "parameters": {
      "since": {
        "type": "number",
        "description": "从哪一条之后开始读，默认 0（从头）"
      },
      "limit": {
        "type": "number",
        "description": "最多几条，默认 40"
      }
    }
  },
  {
    "name": "phone_tools",
    "description": "列出手机端可用的操控工具（截图、点按、打开应用、查询应用列表等）及其参数说明。",
    "parameters": {}
  },
  {
    "name": "phone_tool",
    "description": "在手机上执行一个操控工具。常用 name：screen（读屏幕，image:true 可请求截图）、tap（点元素，需 screen 屏号+元素号）、tap_xy（按坐标点）、type（输入文字）、key（back/home/recents/notifications）、open（开应用或链接）、apps（列应用）、scroll、intent（闹钟/日程/导航等）、notify、clipboard、collect（长列表自动收集）、handoff（交给用户操作）。先用 phone_tools 查看当前可用的工具与参数。",
    "parameters": {
      "name": {
        "type": "string",
        "description": "手机工具名，如 screen",
        "required": true
      },
      "arguments": {
        "type": "object",
        "description": "该工具的参数，如 {\"image\":true}"
      }
    }
  },
  {
    "name": "peer_run",
    "description": "在手机的 Linux 环境里执行一条 shell 命令（bash -lc），返回 stdout/stderr/退出码。适合跑测试、看日志、装依赖。",
    "parameters": {
      "command": {
        "type": "string",
        "description": "要执行的命令",
        "required": true
      },
      "cwd": {
        "type": "string",
        "description": "工作目录，默认 /root/workspace"
      },
      "timeoutMs": {
        "type": "number",
        "description": "超时毫秒，默认 120000"
      }
    }
  },
  {
    "name": "peer_put",
    "description": "把桌面上的一个文件推到手机（适合把网页、APK、脚本送过去测试）。",
    "parameters": {
      "path": {
        "type": "string",
        "description": "桌面本地文件路径",
        "required": true
      },
      "destPath": {
        "type": "string",
        "description": "手机目标路径，默认 /sdcard/Download/DSH-Go/<文件名>"
      }
    }
  },
  {
    "name": "peer_get",
    "description": "把手机上的文件取回桌面（截图、日志、测试产物）。",
    "parameters": {
      "path": {
        "type": "string",
        "description": "手机上的文件路径",
        "required": true
      },
      "destPath": {
        "type": "string",
        "description": "桌面保存路径，默认当前目录下同名文件"
      }
    }
  },
  {
    "name": "phone_send_dir",
    "description": "把桌面上的整个项目目录打包推到手机（自动跳过 node_modules/.git/build 等），适合把网页源码送过去构建、起服务、测试。",
    "parameters": {
      "path": {
        "type": "string",
        "description": "桌面目录路径",
        "required": true
      },
      "destPath": {
        "type": "string",
        "description": "手机目标目录，默认 /sdcard/Download/DSH-Go/<目录名>"
      },
      "exclude": {
        "type": "array",
        "description": "额外排除的相对路径",
        "items": {
          "type": "string"
        }
      },
      "maxFiles": {
        "type": "number",
        "description": "最多发送多少个文件，默认 400"
      }
    }
  },
  {
    "name": "phone_build_apk",
    "description": "让手机自己构建 APK（在手机 Linux 环境里执行构建命令，如 gradle assembleDebug / ./gradlew assembleDebug），构建完自动把 .apk 取回桌面。适合电脑上没有 Android SDK 时。",
    "parameters": {
      "command": {
        "type": "string",
        "description": "在手机上执行的构建命令",
        "required": true
      },
      "cwd": {
        "type": "string",
        "description": "手机上的项目目录"
      },
      "destPath": {
        "type": "string",
        "description": "APK 在桌面的保存路径，默认当前目录下同名文件"
      },
      "timeoutMinutes": {
        "type": "number",
        "description": "最多等几分钟，默认 20"
      }
    }
  },
  {
    "name": "phone_install",
    "description": "把 APK 装到手机上：可先传本地文件（path），也可以给手机上的路径（remotePath），然后自动打开系统安装器并点过确认。遇到「未知来源」授权或密码框时会如实告诉你需要手动处理。装完可用 packageName 核对是否装好。",
    "parameters": {
      "path": {
        "type": "string",
        "description": "桌面上的 APK 路径（可选，给了就自动传到手机）"
      },
      "remotePath": {
        "type": "string",
        "description": "手机上已有的 APK 路径（可选）"
      },
      "packageName": {
        "type": "string",
        "description": "装完要核对的包名（可选）"
      },
      "auto": {
        "type": "boolean",
        "description": "是否自动点确认，默认 true；false 只打开安装器"
      },
      "destPath": {
        "type": "string",
        "description": "APK 传到手机的路径，默认 /sdcard/Download/DSH-Go/<文件名>"
      }
    }
  },
  {
    "name": "phone_test",
    "description": "一个工具完成「手机模型自测」：把目标、网页地址或 APK 路径交给手机模型，它自己开 App/浏览器、看截图、点按、跑命令，最后交回测试报告和截图（自动取回桌面）。写代码改一遍后直接再调一次即可形成自动循环。传 session 名（如「登录页」）可让同一项目的多次测试接在同一个手机会话里。",
    "parameters": {
      "goal": {
        "type": "string",
        "description": "测试目标，例如「打开首页，点登录，用错误密码，应提示错误且不崩溃」",
        "required": true
      },
      "app": {
        "type": "string",
        "description": "要测的应用：包名或应用名（可选）"
      },
      "apkPath": {
        "type": "string",
        "description": "要测的 APK 在手机上的路径（可选）"
      },
      "url": {
        "type": "string",
        "description": "要测的网页地址（可选）"
      },
      "instructions": {
        "type": "string",
        "description": "额外要求，例如「至少截 3 张图」"
      },
      "session": {
        "type": "string",
        "description": "项目会话名，同名共用同一个手机会话，默认 default"
      },
      "sessionId": {
        "type": "string",
        "description": "直接指定会话 id（可选）"
      },
      "artifactsDir": {
        "type": "string",
        "description": "截图在桌面的保存目录，默认 ./phone-artifacts"
      },
      "timeoutMinutes": {
        "type": "number",
        "description": "最多等几分钟，默认 20"
      }
    }
  },
  {
    "name": "phone_shell_target",
    "description": "在指定的一台对端机器上执行 shell（对方也是 dsh-phone-bridge 时就让它自己跑，否则经长轮询交给手机）。host 写 host:port；对端列表见 peer_info。",
    "parameters": {
      "host": {
        "type": "string",
        "description": "对端地址 host:port，例如 10.78.244.169:9000",
        "required": true
      },
      "command": {
        "type": "string",
        "description": "要执行的命令",
        "required": true
      },
      "cwd": {
        "type": "string",
        "description": "工作目录"
      },
      "timeoutMs": {
        "type": "number",
        "description": "超时毫秒，默认 120000"
      }
    }
  },
  {
    "name": "bridge_log",
    "description": "查看后台桥接服务的最近日志（手机连接、任务、错误都在这里）。",
    "parameters": {
      "lines": {
        "type": "number",
        "description": "最多多少行，默认 60"
      }
    }
  },
  {
    "name": "bridge_start",
    "description": "确保后台桥接服务在运行（不依赖当前对话），返回配对串与监听端口。手机还没连上、或换了一台电脑时先调它。",
    "parameters": {}
  },
  {
    "name": "phone_ask",
    "description": "把一段任务交给手机上的模型（它有自己的手机操控、shell 能力）去执行，返回它的最终答复。同一个项目反复派活用 session 名字（如 session:\"登录页\"），它会自动续着同一个手机会话，不会每次新开；不传 session 就用专用会话 default。",
    "parameters": {
      "task": {
        "type": "string",
        "description": "交给手机模型的任务，写清楚要做什么、成功标准",
        "required": true
      },
      "cwd": {
        "type": "string",
        "description": "手机上的工作目录，默认 /root/workspace"
      },
      "session": {
        "type": "string",
        "description": "项目会话名，例如「登录页」；同名共用同一个手机会话，默认 default"
      },
      "sessionId": {
        "type": "string",
        "description": "直接指定会话 id（可选，一般用 session 名字即可）"
      },
      "timeoutMinutes": {
        "type": "number",
        "description": "最多等几分钟，默认 15"
      }
    }
  }
]

// 工具可能跑很久（phone_test 要开手机模型、peer_run 要等远端），超时跟桥接侧
// 的 toolTimeoutMs 对齐，不能用面板那 8 秒。
const hostToolTimeoutMs = () => Number(readConfig().toolTimeoutMs) || 1800000

async function callBridgeTool(name, args, sessionId, signal = null) {
  const config = readConfig()
  const timeoutMs = hostToolTimeoutMs()
  let out
  try {
    out = await bridgePost(
      `http://127.0.0.1:${config.port}`,
      '/call',
      config?.token,
      {
        // 桥接侧按 op 找工具 handler；sessionId 给守卫用，也决定了投递到哪个会话。
        op: name,
        args: args && typeof args === 'object' ? args : {},
        sessionId: String(sessionId || ''),
      },
      // HTTP 比工具本身多给 15 秒：让工具自己的超时先生效，错误信息更具体。
      timeoutMs + 15_000,
      signal,
    )
  } catch (error) {
    throw new Error(`桥接服务没在跑：${error?.message || error}`)
  }
  if (out && out.ok === false) throw new Error(String(out.error || `${name} 执行失败`))
  return out || {}
}

const HOST_TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  // 手机截图走的是 phone_tool(screen) → 返回 { text, images:[{mimeType,data}] }。
  // 只渲染 text 的话图片被丢掉，模型只看到「截图：/root/shot.png」却拿不到像素。
  render: (_args, value) => {
    const blocks = [{ type: 'text', text: String(value?.text ?? '') }]
    for (const image of Array.isArray(value?.images) ? value.images : []) {
      if (!image || typeof image.data !== 'string' || !image.data) continue
      blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType || 'image/png' })
    }
    return blocks
  },
}

// defineTool 从哪来：先看 tools 服务自己有没有（cordis 服务的形状不止一种），
// 再退到官方包 @deepseek-ai/dsh-tools —— 已装插件 dsh-find-plugins、
// dsh-m 都是 `import { defineTool } from '@deepseek-ai/dsh-tools'`，宿主加载器
// 解得开这个 peer 依赖。这里用动态 import 包一层：解不开时只丢这一批工具，
// 不影响面板本身（静态 import 失败会让整个 web 半加载不起来）。
async function resolveDefineTool(service) {
  if (service && typeof service.defineTool === 'function') {
    return { defineTool: service.defineTool.bind(service), from: 'ctx.tools.defineTool' }
  }
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (mod && typeof mod.defineTool === 'function') return { defineTool: mod.defineTool, from: '@deepseek-ai/dsh-tools' }
    return { defineTool: null, reason: '@deepseek-ai/dsh-tools 里没有 defineTool 导出' }
  } catch (error) {
    return { defineTool: null, reason: `@deepseek-ai/dsh-tools 加载失败：${error?.message || error}` }
  }
}

/** defineTool 的作者侧简写（属性名 -> 子 schema，required 写在属性里）编译成完整 JSON Schema。
 *  宿主注册不经过 defineTool 的编译步骤，直接传简写等于把 26 个工具的参数声明废掉。 */
function toToolParameters(spec) {
  if (!spec || typeof spec !== 'object') return { type: 'object', properties: {}, additionalProperties: false }
  if (spec.type === 'object' && spec.properties) return spec
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec)) {
    if (!value || typeof value !== 'object') continue
    const copy = { ...value }
    if (copy.required === true) required.push(key)
    delete copy.required
    properties[key] = copy
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

async function registerHostTools(service) {
  // 不走 defineTool：它在 @deepseek-ai/dsh-tools 里，而插件跑在 profile 的
  // node_modules 下，解析不到宿主包。registry 只校验 output.schema 是合法
  // JSON Schema、output.render 是函数，手写一份即可。
  const timeoutMs = hostToolTimeoutMs()
  const names = []
  const skipped = []
  for (const spec of HOST_TOOLS) {
    try {
      service.register({
        name: spec.name,
        description: spec.description,
        parameters: toToolParameters(spec.parameters),
        output: HOST_TOOL_OUTPUT,
        timeoutMs,
        async execute(args, exec) {
          // 这一行就是这一层存在的理由：MCP 给不了，宿主给得了。
          const sessionId = String(exec?.agent?.session?.id || exec?.agent?.id || '')
          const result = await callBridgeTool(spec.name, args, sessionId, exec?.signal || null)
          const text = String(result?.text ?? '')
          const images = Array.isArray(result?.images) ? result.images.length : 0
          // 截图这条链路暂时带不过来（宿主工具的 render 只回文本），如实说一声，
          // 别让模型以为「没有截图」。
          const body = images ? `${text}\n\n（另有 ${images} 张图片没带过来，要看截图请改用 MCP 工具）` : text
          // execute 的返回值要符合 output.schema（对象）；渲染成 content block
          // 是 render(args, value) 的活。在这里回数组会被判成
          // 'tool "x" returned invalid output: "value" must be an object'。
          return { ok: true, text: body }
        },
      })
      names.push(spec.name)
    } catch (error) {
      // 同名工具已经注册过时不要让整批失败（MCP client 那边是 mcp__<server>__ 前缀，
      // 正常撞不上，但别的插件可能提前占了裸名）。
      skipped.push(`${spec.name}（${error?.message || error}）`)
    }
  }
  const tail = skipped.length ? `，跳过 ${skipped.length} 个：${skipped.join('；')}` : ''
  console.log(`[phone-bridge] 宿主工具 ${names.length}/${HOST_TOOLS.length} 个已注册${tail}`)
  return names.length
}

let hostToolsStarted = false

// 宿主半的工具都靠桥接进程的 /call 干活。MCP 行已经不注册了，没人替我们起桥接，
// 所以宿主半自己负责把它拉起来（ensureDesktopServer 会检测已有实例，不会起第二个）。
async function ensureBridgeRunning() {
  try {
    const mod = await import('../src/desktop.mjs')
    if (mod && typeof mod.ensureDesktopServer === 'function') await mod.ensureDesktopServer()
  } catch (error) {
    console.error(`[phone-bridge] 拉起桥接失败：${error?.message || error}`)
  }
}

// 宿主半注册工具的意义是「拿得到准确的当前会话」，所以只在桌面侧做；手机上
// 工具面由 MCP 半提供，再注册一遍只会让模型看到两套同名工具。
let hostToolsRegistering = false
function installHostTools(ctx) {
  if (isPhone()) return
  if (hostToolsStarted || hostToolsRegistering) return
  // 不在调用前置 hostToolsStarted：注册失败（tools 服务还没就绪）就再也不会重试。
  hostToolsRegistering = true
  // 注册这一步是黑盒：宿主没有可读日志，出问题时只能看有没有工具出现。
  // 落一份文件日志，重启后能直接判断卡在哪一环。
  const note = (line) => {
    try {
      fs.appendFileSync(path.join(bridgeDir(), 'host-tools.log'), `${new Date().toISOString()} ${line}\n`)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
  note('apply 里进入 installHostTools')
  // cordis：没在 inject 里声明过的服务，读 ctx.tools 会抛
  // cannot get property "tools" without inject —— 所以这里只能走 inject 那条路。
  const use = (service, how) => {
    note(`使用 ${how} 拿到的 service，register=${service && typeof service.register}`)
    if (!service || typeof service.register !== 'function') return
    // cordis 的 inject 回调不等待返回值，异步异常会变成 unhandled rejection，自己吃掉。
    Promise.resolve()
      .then(() => ensureBridgeRunning())
      .then(() => registerHostTools(service))
      .then((count) => {
        hostToolsStarted = true
        note(`注册成功：${count} 个`)
      })
      .catch((error) => note(`注册失败：${error?.stack || error?.message || error}`))
      .finally(() => {
        hostToolsRegistering = false
      })
  }
  let direct = null
  try {
    direct = ctx ? ctx.tools : null
  } catch (error) {
    note(`ctx.tools 取值抛错：${error?.message || error}`)
    direct = null
  }
  if (direct && typeof direct.register === 'function') {
    use(direct, 'ctx.tools 直取')
    return
  }
  if (typeof ctx.inject !== 'function') {
    note('ctx.inject 不可用，放弃')
    return
  }
  ctx.inject(['tools'], (scope) => {
    note(`inject 回调触发，scope.tools.register=${scope && scope.tools && typeof scope.tools.register}，键=${scope ? Object.keys(scope).slice(0, 12).join(',') : 'null'}`)
    use(scope?.tools, "ctx.inject(['tools'])")
  })
}

/** 幂等地把引擎行补进每个装了本 bundle 的 profile，返回改过的文件。 */
export function installEngineRow() {
  // 手机侧不跑 MCP 引擎：它自己是服务端，再补一行 MCP 会让手机多起一个桥接、
  // 和自己抢 8787。整包装在手机上时这条守卫必须先于 profile 扫描生效。
  if (isPhone()) return []
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
  // 探针：宿主里加载的到底是哪一份、跑到哪一步。绝对路径写死，绕开 dshHome 的不确定性。
  const trace = (line) => {
    void line // 发布版不再写探针文件
  }
  trace(`apply 进入 pid=${process.pid} cwd=${process.cwd()} dshHome=${process.env.DSH_HOME || ''} homedir=${os.homedir()} inject=${typeof ctx?.inject}`)
  // webServer exists only under the web profile, and cordis has no optional
  // inject form, so the route rides a scoped inject of its own.
  if (typeof ctx.inject !== 'function') return
  // 这个路由挂在 DSH 的 webServer 上，本机浏览器里的任何网页都能 POST 它。
  // 不校验来源的话，一个恶意页面就能 no-cors 发表单把 allowShell 打开。
  const localOnly = (req) => {
    const addr = String(req.socket?.remoteAddress || '')
    const host = String(req.headers.host || '')
      .replace(/:\d+$/, '')
      .replace(/^\[|\]$/g, '')
    const localHosts = ['127.0.0.1', 'localhost', '::1', '[::1]', '']
    const loopbackAddr = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
    return loopbackAddr && localHosts.includes(host)
  }
  const route = {
    name: 'phone-bridge-config',
    kind: 'exact',
    path: '/phone-bridge/config',
    handler: async (req, res) => {
      try {
        if (!localOnly(req)) {
          send(res, 403, { ok: false, error: '只允许本机访问' })
          return
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          send(res, 200, await snapshot())
          return
        }
        if (req.method !== 'POST') {
          send(res, 405, { error: '只支持 GET / POST' })
          return
        }
        const contentType = String(req.headers['content-type'] || '')
        if (!/application\/json/i.test(contentType)) {
          // no-cors 的跨源表单只能发 text/plain / form-data，挡掉这一类。
          send(res, 415, { ok: false, error: 'POST 需要 application/json' })
          return
        }
        const body = await readJsonBody(req)
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          send(res, 400, { ok: false, error: '请求体必须是对象' })
          return
        }
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
  trace('准备 installWake')
  try {
    installWake(ctx)
    trace('installWake 正常返回')
  } catch (error) {
    trace(`installWake 抛错：${error?.stack || error?.message || error}`)
  }
  // 手机侧的反方向：把电脑模型发的话直接投进手机上的会话。
  // 两端共用这一份代码，靠 isPhone() 分工，谁也不抢谁的活。
  try {
    installInbox(ctx)
  } catch (error) {
    console.error(`[phone-bridge] 收件器跳过: ${error}`)
  }
  // 桌面侧：同一批桥接工具在宿主半再注册一遍，好处是 execute 里能拿到准确的
  // 当前会话（MCP 协议不给），守卫不再靠 projcache mtime 猜。
  let toolsProbe = 'unreadable'
  try {
    toolsProbe = typeof ctx?.tools
  } catch (error) {
    // cordis 的服务是 getter，服务没就绪时取值可能抛，必须自己兜住。
    toolsProbe = `读取抛错：${error?.message || error}`
  }
  let phoneProbe = 'unknown'
  try {
    phoneProbe = String(isPhone())
  } catch (error) {
    phoneProbe = `读取抛错：${error?.message || error}`
  }
  trace(`准备调用 installHostTools，isPhone=${phoneProbe}，started=${hostToolsStarted}，ctx.tools=${toolsProbe}`)
  try {
    installHostTools(ctx)
    trace('installHostTools 正常返回')
  } catch (error) {
    trace(`installHostTools 抛错：${error?.stack || error?.message || error}`)
    console.error(`[phone-bridge] 宿主工具跳过: ${error}`)
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