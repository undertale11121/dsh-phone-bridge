// Phone half: talks to the desktop bridge, executes operations locally and
// answers. Also exposes MCP tools so the phone model can pair, test in a loop,
// and push/pull files.
//
// Link modes (see peer.mjs): dial = this side polls the other side (default),
// listen = this side serves the HTTP API itself because the other side is the
// dialer (two phones, or a desktop that cannot be dialed).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import nodeCrypto from 'node:crypto'
import {
  bridgeDir,
  dshHome,
  ensureDir,
  humanSize,
  log,
  parsePairUrl,
  phoneConfigPath,
  scanLan,
  readJson,
  sleep,
  writeJson,
  truncate,
  clockOf,
} from './util.mjs'
import { alive, findAgent, nameOf, newAgentId } from './agents.mjs'
import { McpChild, readToolResult, serveMcp } from './mcp.mjs'
import { deviceIdOf, sign as signMsg } from './pubkey.mjs'
import { fileURLToPath } from 'node:url'
import { ensurePeerLink } from './peer.mjs'
import { loadCache, saveCache, threadPath as _threadPath } from './thread.mjs'
import { startSetup } from './setup.mjs'

const RELAY = process.env.PHONE_BRIDGE_RELAY || '/opt/dsh-app/phone/relay.cjs'
const RELAY_CONFIG = process.env.PHONE_BRIDGE_RELAY_CONFIG || '/var/lib/dsh-app/phone/bridge.json'
const PHONE_PATCH = process.env.PHONE_BRIDGE_PHONE_PATCH || '/opt/dsh-app/phone/phone.patch.yml'
const MAX_FILE = 16 * 1024 * 1024
const POLL_WAIT = 15_000
const ARTIFACT_DIR = process.env.PHONE_BRIDGE_ARTIFACTS || '/sdcard/Download/DSH-Go/phone-test'

function listDir(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => !name.startsWith('.'))
  } catch {
    return []
  }
}

// Screen text looks like "[12] 安装"; ids only live for the current screen.
function parseScreenRows(text) {
  const rows = []
  for (const line of String(text || '').split('\n')) {
    const match = /^\s*\[(\d+)\]\s*(.+?)\s*$/.exec(line)
    if (match) rows.push({ id: Number(match[1]), text: match[2] })
  }
  return rows
}

function safeSize(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}


// 错误文案：把 undici/fetch 的 cause 链展开，否则用户只看到 "fetch failed"。
export function explainError(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  const parts = []
  const seen = new Set()
  let current = error
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (typeof current === 'string') {
      parts.push(current)
      break
    }
    if (seen.has(current)) break
    seen.add(current)
    const message = String(current.message || '').trim()
    const code = String(current.code || '').trim()
    const text = code && !message.includes(code) ? `${message || '错误'}（${code}）` : message
    if (text) parts.push(text)
    current = current.cause
  }
  if (!parts.length) {
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return parts.join(' · ')
}

// dsh-go 把「relay 连接还开着」当成一轮手机操控仍在进行，于是那个「看桌面」
// 悬浮条一直挂在桌面上。空闲这么久就把连接断掉，让那一轮正常收尾。
const RELAY_IDLE_MS = Number(process.env.PHONE_BRIDGE_RELAY_IDLE_MS || 60_000)
// 「（手机已连上电脑）」提醒的冷却时间。
const ANNOUNCE_COOLDOWN_MS = Number(process.env.PHONE_BRIDGE_ANNOUNCE_MS || 30 * 60_000)

// Per-tool timeouts: some phone tools are allowed to block for a long time.
const TOOL_TIMEOUTS = {
  handoff: 11 * 60_000,
  collect: 6 * 60_000,
  screen: 90_000,
  type: 120_000,
  tap: 90_000,
  open: 120_000,
  intent: 120_000,
}

export function loadPhoneConfig() {
  return (
    readJson(phoneConfigPath(), null) || {
      url: '',
      token: '',
      autoconnect: true,
      createdAt: new Date().toISOString(),
    }
  )
}

// Ed25519 identity: created once, then the desktop remembers it by id, so no
// token or pairing action is needed on reconnects.
export function ensureIdentity() {
  const file = path.join(bridgeDir(), 'device.json')
  const existing = readJson(file, null)
  if (existing?.privatePem && existing?.publicKey) return existing
  const { generateKeyPairSync } = nodeCrypto
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const publicKeyB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const identity = {
    id: deviceIdOf(publicKeyB64),
    privatePem,
    publicKey: publicKeyB64,
    createdAt: new Date().toISOString(),
  }
  ensureDir(bridgeDir())
  fs.writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 })
  log(`已生成本机设备密钥：${identity.id.slice(0, 8)}…`)
  return identity
}



export function savePhoneConfig(config) {
  writeJson(phoneConfigPath(), config)
}

export function pair(string) {
  const target = parsePairUrl(string)
  if (!target) throw new Error(`看不懂的配对串：${string}`)
  const config = loadPhoneConfig()
  config.url = target.url
  config.token = target.token
  config.pairedAt = new Date().toISOString()
  savePhoneConfig(config)
  return config
}

const lastSourcePath = () => path.join(bridgeDir(), 'last-desktop.json')

// 手机模型回话时常常只写 `to: 'desktop'`，那会落到电脑侧的默认会话上，
// 结果在别的会话里根本看不到回复。收到消息时记下来源，15 分钟内回话自动点名回去。
export function lastDesktopSource() {
  const saved = readJson(lastSourcePath(), null)
  if (!saved?.desktopId) return ''
  if (Date.now() - Number(saved.at || 0) > 15 * 60_000) return ''
  return String(saved.desktopId)
}

// 只改「不点名的 desktop」；显式 desktop:<id>、phone:* 一概不动。
export function autoAddress(to) {
  const target = String(to || '').trim() || 'desktop'
  if (target !== 'desktop') return target
  const src = lastDesktopSource()
  return src ? `desktop:${src}` : target
}

function baseUrl(url) {
  return url.replace(/\/+$/, '')
}

export class PhoneBridge {
  constructor(config) {
    this.config = { ...config }
    this.identity = ensureIdentity()
    this.peer = null
    this.running = false
    this.relay = null
    this.relayBusy = Promise.resolve()
    this.relayPending = 0
    this.relayIdle = null
    this.authFailed = false
    this.connected = false
    this.desktop = null
    this.lastError = ''
  }

  get paired() {
    if (this.mode === 'listen') return Boolean(this.config.url && this.config.token)
    // After the first pairing the desktop remembers this device key, so a URL
    // alone is enough to reconnect — no token, no copy-paste again.
    return Boolean(this.config.url || this.config.autoUrl)
  }

  get mode() {
    return this.config.mode === 'listen' ? 'listen' : 'dial'
  }

  get endpoint() {
    return this.config.autoUrl || this.config.url
  }

  get authInfo() {
    return { id: this.identity.id, pub: this.identity.publicKey }
  }

  async setPair(pairString) {
    const cfg = pair(pairString)
    this.config = { ...this.config, ...cfg }
    this.config.autoUrl = ''
    this.authFailed = false
    this.connected = false
    if (!this.running) this.start()
    else this.peer?.reconfigure()
  }

  // Keep peers/pairs used by the discovery link (peer.json) for bridge_* tools.
  peers() {
    const link = readJson(path.join(bridgeDir(), 'peer.json'), null)
    return {
      mode: this.mode,
      self: this.config.asHost || null,
      url: this.config.url || '',
      auto: this.config.autoUrl || '',
      token: this.config.token ? `${this.config.token.slice(0, 4)}…` : '',
      pairs: link?.pairs || [],
    }
  }

  unpair() {
    const config = loadPhoneConfig()
    config.url = ''
    config.token = ''
    savePhoneConfig(config)
    this.config = { ...this.config, url: '', token: '' }
    this.connected = false
    this.desktop = null
  }

  start() {
    if (this.running) return
    this.running = true
    this.loop().catch((error) => log(`连接循环退出：${explainError(error)}`))
    this.peer = ensurePeerLink({
      config: this.config,
      identity: this.identity,
      isDial: () => this.mode === 'dial',
      endpoint: () => this.endpoint,
      onOpen: () => log('对端接入了本机（由对方发起轮询）'),
    })
    this.peer.start()
  }

  stop() {
    this.running = false
    if (this.relayIdle) {
      clearTimeout(this.relayIdle)
      this.relayIdle = null
    }
    try {
      this.relay?.stop()
    } catch {
      /* ignore */
    }
    this.relay = null
    this.peer?.stop()
  }

  async loop() {
    let backoff = 1000
    while (this.running) {
      if (!this.paired) {
        await sleep(2000)
        continue
      }
      if (!this.primary()) {
        await sleep(5000)
        continue
      }
      if (!this.endpoint) {
        await sleep(3000)
        continue
      }
      try {
        const hello = await this.post('/hello', {
          v: 2,
          token: this.config.token,
          device: this.describeDevice(),
          caps: this.caps(),
        })
        const challenge = String(hello?.challenge || '')
        const auth = challenge
          ? { k: 'device', id: this.identity.id, sig: signMsg(challenge, this.identity.privatePem) }
          : { k: 'token', token: this.config.token }
        await this.post('/auth', { challenge, device: this.describeDevice(), sig: auth.sig, token: this.config.token || '', auth })
        this.auth = auth
        this.connected = true
        this.desktop = { ...(hello?.desktop || {}), paired: Boolean(hello?.paired) }
        backoff = 1000
        await this.announceOnce('（手机已连上电脑）')
        log(
          `已连接桌面：${this.desktop?.name || '?'}（${this.desktop?.platform || '?'}）${
            hello?.paired ? '· 设备已记住' : ''
          } ${hello?.pending ? `· 有 ${hello.pending} 条未完成` : ''}`,
        )
        await this.pollForever()
      } catch (error) {
        this.connected = false
        const status = error?.status
        if (status === 401) {
          log('桌面端拒绝了 token，需要重新配对')
          this.authFailed = true
          this.running = false
          return
        }
        this.lastError = explainError(error)
        log(`连接失败（${this.lastError}），${Math.round(backoff / 1000)}s 后重试`)
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 15_000)
      }
    }
  }

  deviceName() {
    return os.hostname() || 'phone'
  }

  // 「（手机已连上电脑）」以前是实例内存里的布尔量：进程一重启就重置，watchdog
  // 每次拉起都往工作台刷一条，用户看到的就是「一直重连」。改成落盘冷却，
  // 半个小时内只提醒一次（真的断了很久再连上仍会有提示）。
  async announceOnce(text) {
    const file = path.join(bridgeDir(), 'announce.json')
    const last = Number(readJson(file, {})?.at || 0)
    if (Date.now() - last < ANNOUNCE_COOLDOWN_MS) return
    try {
      writeJson(file, { at: Date.now(), text })
    } catch {
      /* 冷却文件写不进去也不能挡住连接 */
    }
    try {
      await this.say(text)
    } catch {
      /* ignore */
    }
  }

  describeDevice() {
    const asHost = this.config.asHost
    return {
      id: this.identity.id,
      pub: this.identity.publicKey,
      name: this.deviceName(),
      platform: `${process.platform}/${process.arch}`,
      node: process.version,
      asHost: asHost && asHost.host && asHost.port ? { host: asHost.host, port: asHost.port, token: asHost.token } : null,
    }
  }

  caps() {
    return ['tool', 'shell', 'files', 'ask', 'test', 'plan']
  }

  // Single active link: the dialer we configured most recently (phases 1–2),
  // otherwise the DNS-like direction from the peer link (phase 3).
  primary() {
    const info = this.peer?.info?.()
    if (this.config.url && this.config.token) {
      return !this.config.autoUrl || this.config.url === this.config.autoUrl
    }
    if (!info) return true
    return info.primary
  }

  async pollForever() {
    let misses = 0
    while (this.running) {
      let data
      try {
        data = await this.get('/poll', { wait: String(POLL_WAIT) }, 25_000)
        misses = 0
        this.connected = true
      } catch (error) {
        // 手机流量下网络会抖：一两次超时先就地重试，别每次都重新握手
        misses += 1
        this.lastError = explainError(error)
        if (misses >= 3) {
          this.connected = false
          throw error
        }
        await sleep(Math.min(2000 * misses, 6000))
        continue
      }
      const reqs = data?.reqs || []
      if (!reqs.length) continue
      // Run sequentially: phone control is stateful and the screen is exclusive.
      for (const req of reqs) {
        if (!this.running) return
        await this.handleRequest(req)
      }
    }
  }

  async handleRequest(req) {
    const started = Date.now()
    try {
      const data = await this.dispatch(req.op, req.args || {}, req.id)
      await this.post('/res', { id: req.id, ok: true, data: data ?? {} })
      log(`执行 ${req.op} 完成（${Math.round((Date.now() - started) / 1000)}s）`)
    } catch (error) {
      await this.post('/res', { id: req.id, ok: false, error: { message: explainError(error) } }).catch(
        () => {},
      )
      log(`执行 ${req.op} 失败：${explainError(error)}`)
    }
  }

  authSuffix() {
    const auth = this.auth || { k: 'token', token: this.config.token }
    if (auth.k === 'device') {
      const ts = Date.now()
      return { k: 'device', id: auth.id, ts, sig: signMsg(`${auth.id}:${ts}`, this.identity.privatePem) }
    }
    return auth
  }

  async dispatch(op, args, id) {
    switch (op) {
      case 'ping':
        return { pong: true, device: this.deviceName() }
      case 'tools.list':
        return { tools: await this.listTools() }
      case 'tool': {
        const result = await this.callTool(args.name, args.arguments || {})
        // Some devices only answer screen{image:true} with text; fall back to a
        // real screencap so the desktop model still sees the screen.
        if (args.name === 'screen' && !result.images?.length && fs.existsSync('/sdcard')) {
          const shot = await this.screenshot({ name: `screen-${Date.now()}.png` })
          if (shot) return { text: result.text, images: shot.images, path: shot.path }
        }
        return result
      }
      case 'shell':
        return await this.shell(args)
      case 'file.put':
        return await this.putFile(args)
      case 'file.get':
        return await this.getFile(args)
      case 'ask':
        return await this.ask(args, id)
      case 'test':
        return await this.test(args, id)
      case 'discover':
        return { found: await this.discover(args) }
      case 'connect':
        return await this.connectTo(args)
      case 'request':
        return await this.requestPair(args)
      case 'install':
        return await this.install(args)
      case 'plan':
        return await this.plan(args)
      case 'self':
        return await this.selfCheck(args)
      case 'agent.list':
        return { agents: await this.remoteAgents() }
      case 'agent.send':
        return await this.sendAs(String(args?.as || 'phone'), String(args?.to || 'all'), String(args?.text ?? ''), args?.level)
      case 'agent.read':
        return { messages: (await this.readAs(String(args?.as || 'phone'), Number(args?.since || 0), Number(args?.limit || 20))).messages }
      case 'agent.converse':
        return await this.converseAs(String(args?.as || 'phone'), String(args?.to || 'desktop'), String(args?.text ?? ''), Number(args?.waitSeconds || 120))
      case 'agent.spawn':
        return { agent: await this.spawnAgentLocal(args) }
      case 'agent.stop':
        return this.stopAgentLocal(String(args?.id || ''))
      default:
        throw new Error(`不支持的 op：${op}`)
    }
  }

  async ensureRelay() {
    if (this.relay) return this.relay
    // 两个工具调用同时进来时，await child.start() 这段时间 this.relay 还是 null，
    // 会各起一个中继（手机上表现为两个 relay.cjs 抢同一份配置）。复用同一个 Promise。
    if (this.relayPending) return this.relayPending
    this.relayPending = (async () => {
      try {
        if (!fs.existsSync(RELAY)) throw new Error(`找不到手机桥接中继：${RELAY}`)
        if (!fs.existsSync(RELAY_CONFIG)) throw new Error(`找不到手机桥接配置：${RELAY_CONFIG}`)
        const child = new McpChild({
          command: process.execPath,
          args: [RELAY, RELAY_CONFIG],
          name: 'phone-relay',
          env: { ...process.env, DSH_PHONE_RELAY: '1' },
          requestTimeoutMs: 120_000,
        })
        await child.start()
        this.relay = child
        child.onExit = () => {
          this.relay = null
        }
        return child
      } finally {
        this.relayPending = null
      }
    })()
    return this.relayPending
  }

  // The relay/APK cannot run two tool calls at once; serialize them.
  async withRelay(fn) {
    const previous = this.relayBusy
    let release
    this.relayBusy = new Promise((resolve) => {
      release = resolve
    })
    await previous
    this.relayPending += 1
    try {
      return await fn()
    } finally {
      this.relayPending = Math.max(0, this.relayPending - 1)
      release()
      // 所有用到 relay 的路径（包括启动时的 tools/list）都要把空闲计时器续上，
      // 否则那条连接会一直挂着，dsh-go 的悬浮条就收不掉。
      this.scheduleRelayIdle()
    }
  }

  async listTools() {
    try {
      const relay = await this.ensureRelay()
      const tools = await relay.listTools(60_000)
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema || null,
      }))
    } finally {
      this.scheduleRelayIdle()
    }
  }

  async callTool(name, args) {
    if (!name) throw new Error('缺少工具名')
    const timeout = TOOL_TIMEOUTS[name] || 120_000
    try {
      return await this.withRelay(async () => {
        const relay = await this.ensureRelay()
        const result = await relay.callTool(name, args || {}, timeout)
        return readToolResult(result)
      })
    } finally {
      this.scheduleRelayIdle()
    }
  }

  // 一轮操控做完后起个计时器，空闲 RELAY_IDLE_MS 就断开 relay，让 dsh-go 那边
  // 判定这一轮结束、把悬浮条收掉。连续调用（screen → tap → tap）不会被拆断。
  scheduleRelayIdle() {
    if (this.relayIdle) clearTimeout(this.relayIdle)
    this.relayIdle = setTimeout(() => {
      this.relayIdle = null
      // 还有请求在路上就别断：断开会把 dsh-go 那边正在跑的一轮提前结束。
      if (this.relayPending > 0) {
        this.scheduleRelayIdle()
        return
      }
      const relay = this.relay
      this.relay = null
      try {
        relay?.stop()
      } catch {
        /* ignore */
      }
    }, RELAY_IDLE_MS)
    this.relayIdle.unref?.()
  }

  async shell(args) {
    if (!args?.command) throw new Error('缺少 command')
    const cwd = args.cwd || path.join(dshHome(), '..', 'workspace')
    const timeout = Math.max(1000, Number(args.timeoutMs) || 120_000)
    return await new Promise((resolve, reject) => {
      const child = spawn('bash', ['-lc', args.command], {
        cwd: fs.existsSync(cwd) ? cwd : undefined,
        env: { ...process.env, HOME: process.env.HOME || '/root' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve({ stdout, stderr: `${stderr}\n[超时 ${timeout}ms]`, code: 124, timedOut: true })
      }, timeout)
      child.stdout.on('data', (chunk) => {
        if (stdout.length < 512 * 1024) stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 128 * 1024) stderr += chunk
      })
      child.on('error', (error) => {
        if (done) return
        done = true
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ stdout: truncate(stdout, 400_000), stderr: truncate(stderr, 100_000), code: code ?? 0 })
      })
    })
  }

  async putFile(args) {
    if (Array.isArray(args?.files)) {
      let size = 0
      const saved = []
      for (const item of args.files) {
        if (!item?.path || !item?.b64) continue
        const data = Buffer.from(item.b64, 'base64')
        size += data.length
        if (size > MAX_FILE) throw new Error(`这一批文件太大：${humanSize(size)}`)
        const dest = path.posix.join(String(args.path || ''), item.path)
        ensureDir(path.dirname(dest))
        fs.writeFileSync(dest, data)
        saved.push(dest)
      }
      return { path: String(args.path || ''), files: saved.length, size }
    }
    if (!args?.path || !args?.b64) throw new Error('缺少 path 或 b64')
    const data = Buffer.from(args.b64, 'base64')
    if (data.length > MAX_FILE) throw new Error(`文件太大：${humanSize(data.length)}`)
    const dest = String(args.path)
    ensureDir(path.dirname(dest))
    fs.writeFileSync(dest, data)
    return { path: dest, size: data.length }
  }

  async getFile(args) {
    if (!args?.path) throw new Error('缺少 path')
    const file = String(args.path)
    if (!fs.existsSync(file)) throw new Error(`手机上没有这个文件：${file}`)
    const stat = fs.statSync(file)
    if (!stat.isFile()) throw new Error('只能取文件')
    if (stat.size > MAX_FILE) throw new Error(`文件太大：${humanSize(stat.size)}`)
    return { path: file, size: stat.size, b64: fs.readFileSync(file).toString('base64') }
  }

  async ask(args, id) {
    if (!args?.prompt) throw new Error('缺少 prompt')
    const home = askHome()
    const patch = ensureHeadlessPatch(home)
    // `--patch` must precede `--json`: the CLI parses global patch flags before
    // the subcommand's own options.
    const threadPatch = ensureThreadPatch(home)
    const cliArgs = ['--profile', 'headless', '--patch', patch]
    if (fs.existsSync(PHONE_PATCH)) cliArgs.push('--patch', PHONE_PATCH)
    cliArgs.push('--patch', threadPatch)
    cliArgs.push('--permission-mode', 'danger-full-access')
    const sessionName = String(args.session || 'default').trim() || 'default'
    log(`ask 开始：session=${sessionName}`)
    const sessionMap = loadSessions()
    const knownSession = args.sessionId || sessionMap[sessionName]?.sessionId || ''
    if (knownSession) cliArgs.push('--session-id', String(knownSession))
    const recent = this.threadContext(12)
    const bench = recent.length
      ? `【和电脑模型的共享工作台（最近 ${recent.length} 条）】\n` +
        recent.map((row) => `${row.seq}. ${clockOf(row.at)} ${row.from === 'desktop' ? '电脑模型' : '手机模型'}：${row.text}`).join('\n') +
        '\n（你可以用 peer_say 说话、peer_converse 提问并等回复、peer_read 看历史。有拿不准的地方就问电脑模型，不要自己猜。）\n\n'
      : '（你可以用 peer_say / peer_converse 和电脑模型商量；拿不准就问。）\n\n'
    cliArgs.push('--json', bench + String(args.prompt))
    const cwd = args.cwd || path.join(dshHome(), '..', 'workspace')
    const timeoutMs = Math.max(60_000, Number(args.timeoutMinutes || 15) * 60_000)

    const result = await new Promise((resolve) => {
      const child = spawn('dsh', cliArgs, {
        cwd: fs.existsSync(cwd) ? cwd : undefined,
        env: { ...process.env, HOME: process.env.HOME || '/root', DSH_HOME: askHome() },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let buffer = ''
      let stderr = ''
      let final = null
      let sessionId = knownSession || ''
      let done = false
      let lastProgress = 0
      const report = (text) => {
        if (!id || !text) return
        const now = Date.now()
        if (now - lastProgress < 1200) return
        lastProgress = now
        this.post('/prog', {
          id,
          data: { stage: 'phone-model', text: truncate(text, 300) },
        }).catch(() => {})
      }
      const timer = setTimeout(() => {
        if (done) return
        done = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve({ text: '', sessionId, error: `手机模型超时（${Math.round(timeoutMs / 60000)} 分钟）` })
      }, timeoutMs)
      let reasonKind = ''
      const handleLine = (line) => {
        if (!line.trim()) return
        let event
        try {
          event = JSON.parse(line)
        } catch {
          return
        }
        if (event.sessionId) sessionId = event.sessionId
        if (event.type === 'final') {
          final = event
          reasonKind = typeof event.reason === 'string' ? event.reason : event.reason?.kind || ''
        }
        const text = event.text || event.message?.text || event.delta || ''
        if (event.type !== 'final' && text) report(text)
      }
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
          handleLine(buffer.slice(0, index))
          buffer = buffer.slice(index + 1)
        }
      })
      if (buffer.trim()) handleLine(buffer)
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 64 * 1024) stderr += chunk
      })
      child.on('error', (error) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ text: '', sessionId, error: `无法启动 dsh：${error.message}` })
      })
      child.on('close', (code) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (buffer.trim()) handleLine(buffer)
        if (final) {
          resolve({
            text: final.text || '',
            sessionId: final.sessionId || sessionId,
            reason: reasonKind,
            error: reasonKind && reasonKind !== 'completed' ? reasonKind : undefined,
          })
        } else {
          const tail = truncate(stderr.trim() || '（没有输出）', 4000)
          resolve({ text: '', sessionId, error: `dsh 退出码 ${code}\n${tail}` })
        }
      })
    })
    log(`ask 结束：session=${sessionName} id=${result.sessionId || '-'} error=${result.error || '-'}`)
    if (result.sessionId) {
      sessionMap[sessionName] = {
        sessionId: result.sessionId,
        at: new Date().toISOString(),
        title: truncate(String(args.prompt), 80),
      }
      saveSessions(sessionMap)
    }
    return { ...result, session: sessionName, sessionId: result.sessionId }
  }

  // Runs the phone model once with a structured brief and collects artifacts
  // (screenshots/logs) it produced. This is the "one call = full test" loop.
  async test(args, id) {
    const prompt = args?.prompt || buildTestPrompt(args)
    const dir = ARTIFACT_DIR
    ensureDir(dir)
    const before = new Set(listDir(dir))
    const result = await this.ask(
      {
        prompt,
        session: args?.session,
        sessionId: args?.sessionId,
        timeoutMinutes: args?.timeoutMinutes || 20,
        cwd: args?.cwd,
      },
      id,
    )
    const fresh = listDir(dir).filter((name) => !before.has(name))
    const artifacts = (fresh.length ? fresh : listDir(dir).slice(-4))
      .map((name) => ({ path: path.posix.join(dir, name), size: safeSize(path.posix.join(dir, name)) }))
      .filter((item) => item.size > 0 && item.size < MAX_FILE)
      .slice(-8)
      .map((item) => ({ ...item, sizeText: humanSize(item.size) }))
    return {
      text: result.text,
      session: result.session,
      sessionId: result.sessionId,
      error: result.error,
      reason: result.reason,
      artifacts,
    }
  }

  // Install an APK end to end: push it, open the system installer, then click
  // through the confirm buttons. Some ROMs still stop for a password or a
  // "unknown sources" dialog; when that happens we say so instead of guessing.
  async install(args) {
    const apk = String(args?.apkPath || args?.path || '').trim()
    if (!apk) throw new Error('缺少 apkPath')
    if (!fs.existsSync(apk)) throw new Error(`手机上没有这个 APK：${apk}`)
    const pkg = String(args?.packageName || '').trim()
    const confirmWords = ['安装', '继续安装', '仍要安装', '确定', '打开']
    const steps = []
    const result = await this.withRelay(async (relay) => {
      const opened = await relay.callTool('open', { url: `file://${apk}` }, 120_000)
      steps.push(`打开安装器：${(opened?.text || '').trim().slice(0, 200)}`)
      let screenText = ''
      let tapped = 0
      for (let i = 0; i < 24; i += 1) {
        await sleep(1500)
        const screen = await relay.callTool('screen', {}, 90_000)
        screenText = (screen?.text || '').trim()
        const rows = parseScreenRows(screenText)
        const confirmed = rows.find((row) => confirmWords.some((word) => row.text.includes(word)) && row.text.length <= 24)
        if (!confirmed) {
          if (/已安装|安装完成|打开应用|应用已安装/.test(screenText)) break
          continue
        }
        if (confirmed.text.includes('打开') && tapped > 0) break
        await relay.callTool('tap', { id: confirmed.id }, 90_000)
        steps.push(`点了「${confirmed.text}」`)
        tapped += 1
        if (tapped >= 6) break
      }
      let installed = false
      if (pkg) {
        try {
          const apps = await relay.callTool('apps', { query: pkg }, 90_000)
          installed = String(apps?.text || '').includes(pkg)
        } catch {
          /* app list is best effort */
        }
      }
      return { installed, packageName: pkg, taps: tapped, screen: screenText.slice(-1200), steps }
    })
    const blocked = /未知来源|不允许|禁止|密码|验证|安全/.test(result.screen || '')
    return {
      ...result,
      needsUser: !result.installed && (blocked || result.taps === 0),
      note:
        result.installed || result.taps > 0
          ? '安装流程已自动点过确认；如果系统弹了「未知来源」或密码框，需要你在手机上自己处理一次。'
          : '安装器没有出现可点的确认按钮，可能需要你在手机上处理「未知来源」授权。',
    }
  }

  // Phone model writes its own test plan first, then executes it; returned as
  // text so the desktop model can approve/steer before the loop runs.
  async plan(args) {
    const goal = String(args?.goal || '').trim()
    if (!goal) throw new Error('缺少 goal')
    const prompt = [
      '你是手机端的测试负责人。请只写计划，不要执行操作。',
      `【目标】${goal}`,
      args?.piece ? `【被测对象】${args.piece}` : '',
      '【要求】3–6 步；每步写清「怎么操作 + 看什么算通过」；标出哪几步需要用户手动介入（登录/验证码/支付）。',
    ]
      .filter(Boolean)
      .join('\n')
    const result = await this.ask({ prompt, timeoutMinutes: Math.min(Number(args?.timeoutMinutes || 5), 15) })
    return { plan: result.text, sessionId: result.sessionId, error: result.error }
  }

  // What the desktop needs to know about this device without asking a model.
  async selfCheck() {
    const relayOk = fs.existsSync(RELAY) && fs.existsSync(RELAY_CONFIG)
    let tools = []
    if (relayOk) {
      try {
        tools = (await this.listTools()).map((t) => t.name)
      } catch (error) {
        tools = [`（读工具失败：${explainError(error)}）`]
      }
    }
    return {
      device: this.deviceName(),
      node: process.version,
      relay: relayOk,
      tools,
      headless: fs.existsSync(PHONE_PATCH),
      artifactDir: ARTIFACT_DIR,
    }
  }

  // Screenshot fallback for devices where screen{image:true} returns text only.
  async screenshot(args = {}) {
    if (!fs.existsSync('/sdcard')) return null
    const name = String(args.name || `${Date.now()}.png`).replace(/[^\w.\-]/g, '_')
    const target = path.posix.join(ARTIFACT_DIR, name)
    await this.shell({ command: `mkdir -p '${ARTIFACT_DIR}' && screencap -p '${target}' 2>&1` })
    if (fs.existsSync(target) && safeSize(target) > 1000) {
      const data = fs.readFileSync(target).toString('base64')
      return { path: target, b64: data, images: [{ mimeType: 'image/png', data }], text: `截图：${target}` }
    }
    // screencap 失败时常常留下一个 0 字节的文件，别让它冒充证据。
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target)
    } catch {}
    return null
  }

  // Ask the computer to do something (shell / files / info). Mirrors bridge.call()
  // so both sides use the same shape and neither is merely a tool of the other.
  async callDesktop(op, args = {}, timeoutMs = 120_000) {
    if (!this.endpoint) throw new Error('还没连上电脑，先配对或让它自动发现')
    const data = await this.post('/call', { op, args }, timeoutMs)
    if (data && data.ok === false) throw new Error(data.error || '电脑那边没做成')
    return data || {}
  }

  // ------------------------------------------------------- agent addressing
  async remoteAgents() {
    const data = await this.get('/agents')
    return data?.agents || []
  }

  async sendAs(from, to, text, level) {
    if (!String(text || '').trim()) throw new Error('消息是空的')
    return await this.post('/thread', { from, to: autoAddress(to), text, level })
  }

  async readAs(as, since = 0, limit = 20) {
    return await this.get('/thread', { since: String(since), as })
  }

  async converseAs(from, to, text, waitSeconds = 120) {
    const seconds = Math.min(Math.max(Number(waitSeconds || 120), 5), 600)
    const row = await this.sendAs(from, autoAddress(to), text)
    const deadline = Date.now() + seconds * 1000
    while (Date.now() < deadline) {
      const wait = Math.max(Math.min(deadline - Date.now(), 25_000), 1_000)
      const data = await this.get('/thread', { since: String(row.seq), as: from, wait: String(wait) }, wait + 10_000)
      const rows = (data?.messages || []).filter(
        (item) => item.from !== from && (to === 'all' || item.from === to || item.to === from),
      )
      if (rows.length) return { row, messages: rows }
      if (Date.now() >= deadline) break
    }
    return { row, messages: [], timedOut: true }
  }

  async spawnAgentLocal({ name, task } = {}) {
    const cleanTask = String(task || '').trim()
    if (!cleanTask) throw new Error('缺少 task：子智能体要做什么')
    const label = String(name || '').trim() || '子智能体'
    const id = `${(label.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'agent').slice(0, 18)}-${Math.random().toString(36).slice(2, 6)}`
    const logFile = path.join(bridgeDir(), 'agents', `${id}.log`)
    const script = fileURLToPath(new URL('./agent-run.mjs', import.meta.url))
    let child
    try {
      child = spawn(process.execPath, [script, '--id', id, '--name', label, '--task', cleanTask, '--mode', 'http', '--setup', `http://127.0.0.1:${process.env.PHONE_BRIDGE_SETUP_PORT || 8789}`, '--log', logFile], {
        detached: true,
        stdio: 'ignore',
      })
    } catch (error) {
      throw new Error(`子智能体进程起不来：${String(error?.message || error)}`)
    }
    // 不监听 'error' 的话，ENOENT/EACCES/EMFILE 会以未处理的 error 事件把整个
    // bridge 进程打死（桌面侧有这个监听，手机侧之前漏了）。
    child.on('error', (error) => {
      log(`子智能体 ${id} 进程出错：${String(error?.message || error)}`)
    })
    child.unref()
    this.subagents = this.subagents || new Map()
    this.subagents.set(id, child.pid)
    const record = { id, name: label, host: 'phone', kind: 'subagent', task: cleanTask, pid: child.pid, log: logFile, createdAt: new Date().toISOString() }
    await this.post('/agents/register', { agent: record }).catch(() => null)
    log(`子智能体已启动：${label}（${id}），pid ${child.pid}`)
    return record
  }

  stopAgentLocal(id) {
    const pid = this.subagents?.get(id)
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
      this.subagents.delete(id)
    }
    this.post('/agents/unregister', { id }).catch(() => null)
    return { stopped: id, pid: pid || null }
  }

  async get(route, params, timeoutMs = 45_000) {
    const url = new URL(baseUrl(this.endpoint) + route)
    const auth = this.authSuffix()
    url.searchParams.set('auth', Buffer.from(JSON.stringify(auth)).toString('base64url'))
    for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value)
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) {
      const error = new Error(`HTTP ${res.status} ${route}`)
      error.status = res.status
      throw error
    }
    return await res.json()
  }

  async post(route, body, timeoutMs = 30_000) {
    const payload = route === '/hello' || route === '/auth' ? body : { ...body, auth: this.authSuffix() }
    const res = await fetch(baseUrl(this.endpoint) + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const error = new Error(`HTTP ${res.status} ${route}`)
      error.status = res.status
      throw error
    }
    if (res.status === 204) return null
    const text = await res.text()
    return text ? JSON.parse(text) : null
  }

  // ------------------------------------------------------------ shared thread
  // Both models talk through one conversation stored on the desktop. The phone
  // keeps a cache so the last exchange survives a disconnect.
  async say(text, to = 'desktop') {
    const clean = String(text ?? '').trim()
    if (!clean) throw new Error('消息是空的')
    const target = autoAddress(to)
    const row = await this.post('/thread', { from: 'phone', text: clean, to: target })
    const cache = loadCache()
    saveCache({ ...cache, messages: [...(cache.messages || []), row.message].slice(-400), next: row.seq })
    return row
  }

  async sessions() {
    const data = await this.get('/sessions')
    return data?.sessions || []
  }

  async noteSession(args = {}) {
    const body = {}
    if (args.target) body.target = String(args.target)
    if (args.name) body.name = String(args.name)
    if (args.purpose) body.purpose = String(args.purpose)
    if (args.project) body.project = String(args.project)
    return this.post('/sessions', body)
  }

  async readThread(since = 0, wait = 0) {
    const cache = loadCache()
    const result = await this.get('/thread', { since: String(since), wait: String(wait) })
    if (result?.messages?.length) {
      const merged = [...(cache.messages || []), ...result.messages]
      const bySeq = new Map(merged.map((row) => [row.seq, row]))
      saveCache({ next: result.next, messages: [...bySeq.values()].slice(-400) })
    }
    return result
  }

  async converse(text, waitSeconds = 120) {
    const row = await this.say(text)
    const seconds = Math.min(Math.max(Number(waitSeconds) || 120, 5), 600)
    const result = await this.readThread(row.seq, seconds * 1000)
    const replies = (result?.messages || []).filter((item) => item.from === 'desktop')
    return { row, replies, timedOut: !replies.length }
  }

  // Recent lines for the phone model's prompt.
  threadContext(limit = 12) {
    const cache = loadCache()
    return (cache.messages || []).slice(-limit)
  }

  // One-shot POST to an explicit base URL (used before `this.config.url` is set).
  async postAt(base, route, body, timeoutMs = 30_000) {
    const res = await fetch(String(base).replace(/\/+$/, '') + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const error = new Error(res.status === 401 ? '电脑拒绝了这次配对（配对窗口过期了？）' : `HTTP ${res.status} ${route}`)
      error.status = res.status
      throw error
    }
    const text = await res.text()
    return text ? JSON.parse(text) : null
  }

  // Look for desktops on the LAN: no camera, no token, no typing.
  async discover({ timeoutMs = 700, hosts = null } = {}) {
    // 只有 Wi-Fi/有线地址才值得扫；手机用流量（rmnet）时扫 /24 是纯浪费，还会把面板卡住
    const local = lanAddresses().filter((row) => row.kind === 'wifi' || row.kind === 'wired')
    if (!local.length) {
      throw new Error('现在用的是手机流量（没有 Wi-Fi 地址），扫不到电脑。请连回同一个 Wi-Fi，或填电脑的隧道/公网地址')
    }
    // Two ports only: a full /24 scan × 4 ports is what makes cheap routers drop.
    const ports = [...new Set([8787, Number(this.config.port) || 0].filter(Boolean))]
    const found = await scanLan(ports, { timeoutMs: Number(timeoutMs) || 500, concurrency: 24, hosts })
    const self = os.hostname()
    return found
      .filter((row) => row.name !== self)
      .map((row) => ({
        host: row.host,
        port: row.port,
        name: row.name || '电脑',
        platform: row.platform || '',
        permit: Boolean(row.permit),
        url: `http://${row.host}:${row.port}`,
      }))
      .sort((a, b) => Number(b.permit) - Number(a.permit))
  }

  // Ask the computer to pair, without waiting: the computer's card shows the
  // request and its user taps 允许; our poll loop connects automatically after.
  async requestPairOnly({ host, port } = {}) {
    const address = String(host || '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
    if (!address) throw new Error('缺少电脑地址')
    const url = `http://${address.includes(':') ? address : `${address}:${Number(port) || 8787}`}`
    const res = await this.postAt(url, '/request', { v: 2, device: this.describeDevice() })
    if (!res?.ok) throw new Error(res?.error || '电脑没有接受配对请求')
    this.config = { ...this.config, autoUrl: url }
    writeJson(phoneConfigPath(), this.config)
    if (this.running) this.peer?.reconfigure()
    log(`已请求配对：${url}（等电脑上点允许）`)
    return { url, name: res.name || '' }
  }

  // One tap: ask the computer to pair. The computer shows "X 想连接" and its
  // user taps 允许 — the phone never types a code and never copies a token.
  async requestPair({ host, port, waitMs = 90_000 } = {}) {
    const address = String(host || '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
    if (!address) throw new Error('缺少电脑地址')
    const url = `http://${address.includes(':') ? address : `${address}:${Number(port) || 8787}`}`
    const device = this.describeDevice()
    await this.postAt(url, '/request', { v: 2, device })
    log(`已请求配对：${url}（等电脑上点「允许」）`)
    const deadline = Date.now() + Math.max(10_000, Math.min(Number(waitMs) || 90_000, 10 * 60_000))
    while (Date.now() < deadline) {
      await sleep(2000)
      let hello = null
      try {
        hello = await this.postAt(url, '/hello', { v: 2, token: '', device, caps: this.caps() })
      } catch {
        continue
      }
      if (!hello?.challenge) continue
      const sig = signMsg(hello.challenge, this.identity.privatePem)
      const done = await this.postAt(url, '/auth', {
        v: 2,
        challenge: hello.challenge,
        device,
        sig,
        token: '',
        auth: { k: 'device', id: this.identity.id, sig },
      }).catch(() => null)
      if (!done?.ok) continue
      this.config = { ...this.config, url, token: '', autoUrl: '', pairedAt: new Date().toISOString() }
      writeJson(phoneConfigPath(), this.config)
      this.authFailed = false
      this.connected = false
      if (!this.running) this.start()
      else this.peer?.reconfigure()
      log(`配对成功：${hello?.desktop?.name || address}`)
      return { url, desktop: done.desktop || hello.desktop || null, via: 'approve' }
    }
    throw new Error('电脑上还没点「允许」，再试一次吧（也可以让电脑生成配对码）')
  }

  // Pair with a discovered desktop: either its pairing window is open (phone
  // key is registered) or the user typed the 6-digit code.
  async connectTo({ host, port, code } = {}) {
    const address = String(host || '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
    if (!address) throw new Error('缺少电脑地址')
    const url = `http://${address.includes(':') ? address : `${address}:${Number(port) || 8787}`}`
    const device = this.describeDevice()
    let hello = null
    let helloError = null
    try {
      hello = await this.postAt(url, '/hello', { v: 2, token: this.config.token || '', device, caps: this.caps() })
    } catch (error) {
      helloError = error
      if (error.status !== 401) throw error
    }
    if (code) {
      const trimmed = String(code).trim()
      if (!/^\d{6}$/.test(trimmed)) throw new Error('配对码是 6 位数字')
      await this.postAt(url, '/auth', { device, auth: { k: 'code', code: trimmed } })
    } else if (hello?.permit === true && hello?.challenge) {
      const sig = signMsg(hello.challenge, this.identity.privatePem)
      await this.postAt(url, '/auth', {
        challenge: hello.challenge,
        device,
        sig,
        auth: { k: 'device', id: this.identity.id, sig },
      })
    } else {
      // Nothing open on the computer: ask it, the user taps 允许 there.
      return await this.requestPair({ host, port })
    }
    this.config = { ...this.config, url, token: '', autoUrl: '', pairedAt: new Date().toISOString() }
    writeJson(phoneConfigPath(), this.config)
    this.authFailed = false
    this.connected = false
    if (!this.running) this.start()
    else this.peer?.reconfigure()
    return { url, desktop: hello?.desktop || null }
  }

  formatRows(rows = []) {
    if (!rows || !rows.length) return '（没有新消息）'
    return rows
      .map((row) => {
        const to = row.to && row.to !== 'all' ? ` → ${nameOf(row.to)}` : ''
        return `${row.seq}. ${nameOf(row.from)}${to}：${String(row.text).slice(0, 2000)}`
      })
      .join('\n')
  }

  status() {
    return {
      endpointKind: endpointKindOf(this.endpoint),
      paired: this.paired,
      connected: this.connected,
      desktop: this.desktop,
      url: this.config.url,
      authFailed: this.authFailed,
      lastError: this.lastError,
      configFile: phoneConfigPath(),
    }
  }
}


// 端点是什么类型的地址：决定了「现在这条链路能不能通」以及为什么不通。
// 手机用流量（运营商 CGNAT）时，电脑的 192.168.x 是永远到不了的，必须走隧道/公网地址。
export function endpointKindOf(endpoint) {
  let host = ''
  try {
    host = new URL(String(endpoint || '')).hostname
  } catch {
    return 'unknown'
  }
  if (!host) return 'unknown'
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return 'loopback'
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return 'lan'
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return 'cgnat'
  if (/^169\.254\./.test(host)) return 'link-local'
  if (/^\[?fe80:/i.test(host)) return 'link-local'
  return 'public'
}

const ENDPOINT_HINT = {
  lan: '局域网地址：手机和电脑要在同一个 WiFi 下才通',
  cgnat: '运营商内网地址（100.64/10）：手机流量到不了，换 WiFi 或用隧道',
  'link-local': '链路本地地址：通常不可用，换隧道',
  public: '公网/隧道地址：走流量也能连',
  loopback: '本机回环：只能同机测试',
}

// The headless profile disables the local credential store and has no model
// configured, so we build a patch from the web profile's model setup.
// A second MCP server for the headless phone model: the shared workbench.
export function ensureThreadPatch(home = dshHome()) {
  const target = path.join(home, 'phone-bridge', 'thread.patch.yml')
  const server = fileURLToPath(new URL('./thread-mcp.mjs', import.meta.url))
  const yml = `# dsh-phone-bridge: lets the phone model talk with the desktop model.
- insert:
    - id: dsh-phone-thread
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: phone-thread
        transport: stdio
        command: !!js process.execPath
        args:
          - ${JSON.stringify(server)}
        toolCallTimeoutMs: 660000
        failOnStartupError: false
`
  ensureDir(path.dirname(target))
  fs.writeFileSync(target, yml)
  return target
}

// Headless sessions run in their own DSH_HOME so the phone's normal chat list
// stays clean (one dedicated session per project instead of one per task).
// 会话级开关在手机上这一侧：没开互联的会话，互联工具一律不可用。
// 手机端拿不到 caller（标准 MCP 没有这个概念），退一步用「电脑记下的互联表」判断：
// 一条都没有 = 用户从来没开过互联，这时不该让模型偷偷操作电脑。
// bridge_* 是诊断类，永远放行，不然出了问题连排查都做不了。
export function phoneGateMessage(tool, links) {
  if (!/^(peer_|phone_|agent_|session_)/.test(String(tool || ''))) return ''
  if (/^phone_bridge_/.test(String(tool || ''))) return ''
  if (links && Object.keys(links).length) return ''
  return '这个会话没开互联，互联工具现在不可用。先在电脑上任意会话顶部点「🔗 互联」（或让电脑模型用 peer_link 开一个），开了之后这些工具立刻能用。'
}

export function askHome() {
  if (process.env.PHONE_BRIDGE_ASK_HOME) {
    ensureDir(process.env.PHONE_BRIDGE_ASK_HOME)
    return process.env.PHONE_BRIDGE_ASK_HOME
  }
  const home = path.join(bridgeDir(), 'home')
  ensureDir(home)
  // 凭据有两种存法：老的 .credentials.yaml，以及新版 llm-deepseek/files-v3.json。
  // 只链了前者的话，手机上的子智能体会起得来但报 MISSING_CREDENTIAL。
  for (const name of ['.credentials.yaml', 'llm-deepseek']) {
    const source = path.join(dshHome(), name)
    const target = path.join(home, name)
    if (!fs.existsSync(source) || fs.existsSync(target)) continue
    try {
      fs.symlinkSync(source, target)
    } catch {
      try {
        if (fs.statSync(source).isDirectory()) fs.cpSync(source, target, { recursive: true })
        else fs.copyFileSync(source, target)
      } catch {
        /* 没凭据也能跑：patch 会从 DSH_HOME 里取 */
      }
    }
  }
  return home
}

export function sessionsPath() {
  return path.join(bridgeDir(), 'sessions.json')
}

export function loadSessions() {
  return readJson(sessionsPath(), {}) || {}
}

export function saveSessions(data) {
  writeJson(sessionsPath(), data)
}

export function ensureHeadlessPatch(home = dshHome()) {
  const target = path.join(home, 'phone-bridge', 'headless.patch.yml')
  if (fs.existsSync(target)) return target
  // The headless home is isolated from the phone's own DSH_HOME, so the model
  // config still has to be copied out of the real profile.
  const roots = [...new Set([home, dshHome(), path.join(os.homedir(), '.dsh')])]
  const candidates = roots
    .flatMap((root) => [path.join(root, 'profiles', 'web', 'cordis.patch.yml'), path.join(root, 'profiles', 'web', 'cordis.yml')])
    .filter((file) => fs.existsSync(file))
  for (const file of candidates) {
    try {
      const yaml = loadYaml()
      const text = fs.readFileSync(file, 'utf8')
      if (!yaml) {
        // 没装 yaml 库时（比如子进程只跑 bridge.mjs），退回文本抽取：
        // 按顶层 "- id:" 切块，只留 agent-default-model / llm-pi-ai，再补 credentials。
        const blocks = text.split(/^(?=-\s+id:)/m)
        const only = blocks.filter((block) => /^-\s+id:\s*['"]?(agent-default-model|llm-pi-ai)['"]?\s*$/m.test(block))
        if (!only.some((block) => /^-\s+id:\s*['"]?agent-default-model['"]?\s*$/m.test(block))) continue
        ensureDir(path.dirname(target))
        fs.writeFileSync(target, ['# 由 phone-bridge 自动生成：dsh headless 用的模型配置。', ...only.map((block) => block.trimEnd()), '- id: credentials', '  disabled: false', ''].join('\n'), 'utf8')
        log(`已从 ${file} 生成 headless 模型补丁（文本模式）：${target}`)
        return target
      }
      const parsed = yaml.parse(text)
      const entries = Array.isArray(parsed) ? parsed : []
      const keep = entries.filter((entry) => ['agent-default-model', 'llm-pi-ai'].includes(entry?.id))
      if (!keep.some((entry) => entry.id === 'agent-default-model')) continue
      keep.push({ id: 'credentials', disabled: false })
      ensureDir(path.dirname(target))
      fs.writeFileSync(target, yaml.stringify(keep), 'utf8')
      log(`已从 ${file} 生成 headless 模型补丁：${target}`)
      return target
    } catch (error) {
      log(`生成模型补丁失败：${explainError(error)}`)
    }
  }
  throw new Error(
    `没有可用的 headless 模型配置：请把 web profile 的 cordis.patch.yml 拷到 ${target}，或手动写 agent-default-model/llm-pi-ai/credentials 三项`,
  )
}

let yamlModule
function loadYaml() {
  if (yamlModule !== undefined) return yamlModule
  for (const base of ['/opt/dsh/package.json', path.join(dshHome(), 'package.json')]) {
    try {
      if (!fs.existsSync(base)) continue
      const require = createRequire(base)
      const candidate = require('yaml')
      if (candidate?.parse) {
        yamlModule = candidate
        return yamlModule
      }
    } catch {
      /* try next */
    }
  }
  yamlModule = null
  return null
}

function buildTestPrompt(args) {
  const lines = [
    '你在手机上代替用户做真机测试。用你自己的手机工具（screen/tap/type/open/key/apps/collect/handoff）和 shell 完成任务，然后给出报告。',
    '',
    `【测试目标】${args?.goal || ''}`,
  ]
  if (args?.app) lines.push(`【应用】${args.app}`)
  if (args?.apkPath) lines.push(`【APK 在手机上的路径】${args.apkPath}`)
  if (args?.url) lines.push(`【网页】${args.url}`)
  if (args?.instructions) lines.push(`【额外要求】${args.instructions}`)
  lines.push('')
  lines.push('【做法】先明确要验证的几个点；每一步操作后读屏确认结果。需要用户登录/验证码/支付时用 handoff 交给用户，别自己乱试。')
  lines.push('【截图】每个关键界面截一张：shell 执行 `mkdir -p /sdcard/Download/DSH-Go/phone-test && screencap -p /sdcard/Download/DSH-Go/phone-test/<序号>-<说明>.png`。')
  lines.push('【装应用】要先装 APK 的话，直接 open 对应 .apk 文件；装完打开。')
  lines.push('【商量】需要我确认或补充信息时，用 peer_say 说一句，或 peer_converse 直接问我并等我回话，别自己猜。')
  lines.push('【报告格式】最后一段：')
  lines.push('结论：通过 / 不通过')
  lines.push('检查点：')
  lines.push('- 检查点1 —— 结果 —— 证据（截图文件名）')
  lines.push('问题：无 / 逐条（现象、复现步骤、错误信息）')
  lines.push('建议：写代码的一方接下来该改什么')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// MCP entry: tools the phone model uses to manage the link
// ---------------------------------------------------------------------------
export function phoneTools(bridge) {
  return [
    {
      name: 'phone_test',
      description:
        '在本机（这台手机）上做真机测试：把目标、网页地址或 APK 路径交给本机模型，它自己开应用/浏览器、看截图、点按、跑命令，返回测试报告，截图存到 /sdcard/Download/DSH-Go/phone-test。',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: '测试目标与成功标准' },
          app: { type: 'string', description: '应用包名或名称（可选）' },
          apkPath: { type: 'string', description: '要测的 APK 路径（可选）' },
          url: { type: 'string', description: '要测的网页地址（可选）' },
          instructions: { type: 'string', description: '额外要求（可选）' },
          sessionId: { type: 'string', description: '接着上次会话（可选）' },
          timeoutMinutes: { type: 'number', description: '最多几分钟，默认 20' },
        },
        required: ['goal'],
        additionalProperties: false,
      },
    },
    {
      name: 'phone_plan',
      description: '让本机模型先写一份测试计划（不执行），用于和电脑端确认分工。',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: '要测什么' },
          piece: { type: 'string', description: '被测对象（网页地址/APK/应用名）' },
        },
        required: ['goal'],
        additionalProperties: false,
      },
    },
    {
      name: 'phone_screenshot',
      description: '直接截一张手机当前屏幕（绕过 screen 工具的图片限制），返回图片与保存路径。',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: '文件名（可选）' } },
        additionalProperties: false,
      },
    },
    {
      name: 'bridge_setup',
      description: '打开手机上的图形化配置页（浏览器地址）：配对、看连接状态、断开重连，不用手打命令。用户问「在哪配对」「怎么设置」时给出这个地址。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'bridge_doctor',
      description: '自检本机桥接：操控通道、模型补丁、连接模式、对端列表。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'bridge_status',
      description: '查看与电脑（DSH 桌面端）的桥接状态：是否已配对、是否在线、电脑名称。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'bridge_pair',
      description:
        '用电脑端给出的配对串（形如 dshphone://192.168.1.5:8787/xxxx 或 192.168.1.5:8787/xxxx）连接电脑，之后电脑就能调用本机的截图、点按、shell 和本机模型。',
      inputSchema: {
        type: 'object',
        properties: { pair: { type: 'string', description: '配对串' } },
        required: ['pair'],
        additionalProperties: false,
      },
    },
    {
      name: 'agent_list',
      description: '列出工作台上可以对话的 agent（电脑模型、手机模型、双方启动的子智能体）。拿到 id 后可用 agent_send / agent_converse 直接找它。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'agent_send',
      description: '给指定 agent 发一条消息（不执行任务）：to 写 agent_list 里的 id，省略=发给电脑模型。level 标重要性，对方唤醒语里会带对应符号。',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '目标 agent id，省略=desktop' },
          text: { type: 'string', description: '要说的内容' },
          level: { type: 'string', description: '重要性：urgent(❗等你回) / question(❓要你决定) / alert(⚠️出问题) / done(✅做完了) / report(📋汇报不用回)；不写=普通' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'agent_converse',
      description: '给指定 agent 发一句并等回话（默认 120 秒）；对方是子智能体时它会自己动手并回报，等不到就返回已有消息。',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '目标 agent id，省略=desktop' },
          text: { type: 'string', description: '要说的话' },
          waitSeconds: { type: 'number', description: '最多等多少秒，5–600，默认 120' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'agent_read',
      description: '读工作台对话（广播 + 发给你的 + 你说的）。',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'number', description: '从第几条之后开始，默认 0' },
          limit: { type: 'number', description: '最多几条，默认 40' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'agent_spawn',
      description: '在手机上启动一个子智能体：给名字和任务，它自己用工作台工具干活，完成后把结论发回来。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '名字，例如 测试手' },
          task: { type: 'string', description: '要它做的事，写清楚验收标准' },
        },
        required: ['task'],
        additionalProperties: false,
      },
    },
    {
      name: 'agent_stop',
      description: '停掉手机上的一个子智能体（内建的两个模型不能这样停）。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'agent id' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'peer_say',
      description:
        '在「共享工作台」上给电脑端留一句话（不执行任务，只是说话）。to 默认 desktop（最近用过互联的会话）；写 desktop:<名字> 可以指定唤醒哪个会话，比如 desktop:登录页。level 标重要性（❗❓⚠️✅📋），对方的唤醒语里会带上。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要对电脑模型说的话' },
          to: { type: 'string', description: '收件人：desktop（默认）或 desktop:<会话名>' },
          level: { type: 'string', description: '这条有多要紧：urgent(❗等你回) / question(❓要你决定) / alert(⚠️出问题) / done(✅做完了) / report(📋汇报不用回)；不写=普通' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'bridge_sessions',
      description: '列出电脑上记住的会话（名字、用途、项目、最近活跃），用来决定该把消息发给哪个会话。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'bridge_note',
      description: '给电脑上的某个会话写备注（它是干什么的），之后 peer_say 的 to 可以写 desktop:<名字> 直接找它。',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '会话 id/名字/current（默认最近活跃）' },
          name: { type: 'string', description: '短名字，比如「登录页」' },
          purpose: { type: 'string', description: '这个会话在做什么' },
          project: { type: 'string', description: '项目名，可选' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'peer_converse',
      description: '发一句话给电脑模型并等它回话（最多 waitSeconds 秒），适合一轮一轮商量。等不到就留在工作台上，之后用 peer_read 查看。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要对电脑模型说的话' },
          waitSeconds: { type: 'number', description: '最多等多少秒，默认 120' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'peer_read',
      description: '读共享工作台上最近的对话（电脑模型和手机模型说的话都在里面）。',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'number', description: '从哪一条之后开始读，默认 0' },
          limit: { type: 'number', description: '最多几条，默认 40' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'peer_info',
      description: '看电脑那台机器的状态：名字、平台、监听地址、权限开关、当前目录。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'peer_run',
      description: '在电脑上执行一条 shell 命令并拿到输出（对端需要允许执行命令）。电脑上能构建、跑测试、开服务，你在手机这边就能指挥它。',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          cwd: { type: 'string', description: '工作目录（可选）' },
          timeoutMs: { type: 'number', description: '超时毫秒，默认 120000' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    {
      name: 'peer_get',
      description: '把电脑上的一个文件取到手机（产物、日志、构建出来的 APK）。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '电脑上的文件路径' },
          destPath: { type: 'string', description: '手机保存路径，默认 /sdcard/Download/DSH-Go/<文件名>' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'peer_put',
      description: '把手机上的一个文件送到电脑（截图、录屏、日志、改好的文件）。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '手机上的文件路径' },
          destPath: { type: 'string', description: '电脑保存路径，默认当前目录下同名文件' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'bridge_unpair',
      description: '断开与电脑的桥接并清除配对信息。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ]
}

function handlerAliases(handlers) {
  // Old names stay callable, but they point at the current implementations.
  const map = {
    bridge_say: 'peer_say',
    bridge_converse: 'peer_converse',
    bridge_read: 'peer_read',
  }
  for (const [from, to] of Object.entries(map)) {
    if (!handlers[from] && handlers[to]) handlers[from] = handlers[to]
  }
}

// 单实例锁的第二个校验：pid 活着不代表它就是 bridge——系统会把回收的 pid
// 分给别的进程，只看 alive() 会让新实例永远拒绝启动（用户看到「桥接起不来」）。
function isBridgeProcess(pid) {
  if (process.platform !== 'linux') return true
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('bridge.mjs')
  } catch {
    return false
  }
}

// 手机端只允许一个桥接实例：pid 文件 + 存活检查 + cmdline 校验，进程没了自动接管。
function takeInstanceLock() {
  const file = path.join(bridgeDir(), 'bridge.pid')
  // 'wx' = 不存在才创建。两个进程同时抢时只有一个 openSync 能成功；
  // 原来用 writeJson（临时文件 + rename）是「后写的赢」，两个都会以为自己是主。
  const grab = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const fd = fs.openSync(file, 'wx')
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
    } finally {
      fs.closeSync(fd)
    }
  }
  const holderAlive = () => {
    try {
      const held = Number(readJson(file, {})?.pid || 0)
      return Boolean(held && held !== process.pid && alive(held) && isBridgeProcess(held))
    } catch {
      return false
    }
  }
  try {
    grab()
    return true
  } catch {
    if (holderAlive()) return false
    // 僵尸锁（进程没了 / pid 被别的程序复用）：删掉再抢一次
    try {
      fs.unlinkSync(file)
    } catch {}
    try {
      grab()
      return true
    } catch {
      return false
    }
  }
}

export async function runPhoneMcp({ withMcp = true } = {}) {
  // watchdog 可能同时拉起多个「auto」实例：多个进程一起长轮询，工作台里就会
  // 重复出现「（手机已连上电脑）」、同一条消息被投两次。只留一个。
  if (!takeInstanceLock()) {
    log('已经有一个桥接实例在跑，这个进程直接退出（避免重复连接）')
    return
  }
  const bridge = new PhoneBridge(loadPhoneConfig())
  const setupPort = Number(process.env.PHONE_BRIDGE_SETUP_PORT || '8789')
  const handlers = {
    async agent_list() {
      const list = (await bridge.remoteAgents()) || []
      if (!list.length) return '没有 agent'
      const lines = list.map((item) => {
        const bits = [item.id, item.name, item.host]
        if (item.kind === 'subagent') bits.push(item.running === undefined ? '状态未知' : item.running ? '运行中' : '已停止')
        if (item.note) bits.push(item.note)
        return bits.join(' · ')
      })
      return `${lines.join('\n')}\n\n用 agent_send / agent_converse 指定 id 对话；要加人手用 agent_spawn（在手机上跑）。`
    },
    async agent_send(args) {
      const to = String(args?.to || 'desktop')
      const row = await bridge.sendAs('phone', to, args?.text, args?.level)
      return `已发出（第 ${row.seq} 条 → ${nameOf(to)}，重要性 ${row.level === 'normal' ? '普通' : row.level}），对方下次运行时能看到。`
    },
    async agent_converse(args) {
      const to = String(args?.to || 'desktop')
      const result = await bridge.converseAs('phone', to, args?.text, Number(args?.waitSeconds || 120))
      if (result.timedOut) {
        return `已发出（第 ${result.row.seq} 条 → ${nameOf(to)}），${result.seconds} 秒内没有回话。\n\n${await bridge.readAs('phone', Math.max(0, result.row.seq - 3), 8).then((data) => bridge.formatRows(data.messages))}`
      }
      return bridge.formatRows(result.messages)
    },
    async agent_read(args) {
      const data = await bridge.readAs('phone', Number(args?.since || 0), Number(args?.limit || 40))
      return bridge.formatRows(data.messages)
    },
    async agent_spawn(args) {
      const record = await bridge.spawnAgentLocal({ name: args?.name, task: args?.task })
      return `已在手机上启动子智能体 ${record.name}（id: ${record.id}）。它会自己干活并把结论发到工作台，用 agent_read 看进度。`
    },
    async agent_stop(args) {
      const id = String(args?.id || '')
      await bridge.stopAgentLocal(id)
      return `已停掉 ${id}`
    },
    async bridge_status() {
      const s = bridge.status()
      const lines = [`配对：${s.paired ? '是' : '否'}`]
      if (s.paired) {
        lines.push(`在线：${s.connected ? '是' : '否'}`)
        lines.push(`电脑：${s.desktop?.name || '未知'}${s.desktop?.platform ? ` · ${s.desktop.platform}` : ''}`)
        lines.push(`地址：${s.url}`)
        lines.push(`地址类型：${s.endpointKind || 'unknown'} — ${ENDPOINT_HINT[s.endpointKind] || '未知类型'}`)
      }
      if (s.authFailed) lines.push('电脑端拒绝了这个 token，请重新配对。')
      if (s.lastError) lines.push(`最近错误：${s.lastError}`)
      lines.push(`配置文件：${s.configFile}`)
      return lines.join('\n')
    },
    async bridge_pair(args) {
      if (!args?.pair) throw new Error('缺少配对串')
      await bridge.setPair(args.pair)
      await sleep(300)
      const s = bridge.status()
      return s.connected ? `已连接电脑：${s.desktop?.name || s.url}` : `已保存配对，正在连接 ${s.url}…`
    },
    async peer_info() {
      const data = await bridge.callDesktop('info', {})
      return data.text || '（电脑没有返回信息）'
    },
    async peer_run(args) {
      if (!args?.command) throw new Error('缺少 command')
      const data = await bridge.callDesktop('shell', { command: args.command, cwd: args.cwd }, Number(args.timeoutMs || 120_000) + 10_000)
      return data.text || '（命令没有输出）'
    },
    async peer_get(args) {
      if (!args?.path) throw new Error('缺少 path')
      const data = await bridge.callDesktop('file.get', { path: args.path })
      const buf = Buffer.from(data.data, 'base64')
      const dest = String(args.destPath || path.join('/sdcard/Download/DSH-Go', data.name || path.basename(args.path)))
      ensureDir(path.dirname(dest))
      fs.writeFileSync(dest, buf)
      return `已取回：${dest}（${humanSize(buf.length)}）`
    },
    async peer_put(args) {
      if (!args?.path) throw new Error('缺少 path')
      const file = String(args.path)
      const stat = fs.statSync(file)
      if (stat.size > 16 * 1024 * 1024) throw new Error(`文件太大：${humanSize(stat.size)}（上限 16MB）`)
      const dest = String(args.destPath || path.basename(file))
      const data = await bridge.callDesktop('file.put', { path: dest, data: fs.readFileSync(file).toString('base64') }, 120_000)
      return data.text || `已送到电脑：${dest}`
    },
    async bridge_unpair() {
      bridge.unpair()
      return '已断开并清除配对。'
    },
    async peer_say(args) {
      const to = String(args?.to || 'desktop')
      const row = await bridge.say(args?.text, to)
      const where = to === 'desktop' ? '电脑模型' : `电脑上的「${to.replace(/^desktop:/, '')}」会话`
      return `已放到工作台上（第 ${row.seq} 条，给${where}）。`
    },
    async bridge_sessions() {
      const rows = await bridge.sessions()
      if (!rows.length) return '电脑上还没记住会话。让电脑模型随便用一次互联工具（比如 peer_info）就会自动登记。'
      const lines = rows.map((row) => {
        // 这张表是**电脑那边**的目录（经桥接服务 /sessions 取回），
        // 标清机器，否则和自己这边的会话混在一起，点名会点错。
        const where = row.host === 'phone' ? '手机上' : '电脑上'
        const bits = [`${row.short} · ${row.name || '未命名'} · ${where}${row.active ? '（当前）' : ''}`]
        if (row.purpose) bits.push(`  ${row.purpose}`)
        if (row.project) bits.push(`  项目 ${row.project}`)
        bits.push(`  ${row.calls || 0} 次调用${row.at ? `，最近 ${String(row.at).slice(5, 16).replace('T', ' ')}` : ''}`)
        return bits.join('\n')
      })
      return `${lines.join('\n')}\n\n这张表是电脑上的会话；发消息时 to 写 desktop:<名字> 或 desktop:<短 id> 就能直接找它。`
    },
    async bridge_note(args) {
      const result = await bridge.noteSession(args)
      const row = result?.session || {}
      return `已记下：${row.name || '未命名'}（${String(row.id || '').slice(0, 8)}）${row.purpose ? ` — ${row.purpose}` : ''}`
    },
    async peer_converse(args) {
      const result = await bridge.converse(args?.text, args?.waitSeconds)
      if (result.timedOut) return `已发出（第 ${result.row.seq} 条），但电脑模型 ${Math.round((args?.waitSeconds || 120))} 秒内没回话。`
      return result.replies.map((row) => `${row.seq}. 电脑模型：${row.text}`).join('\n')
    },
    async peer_read(args) {
      const data = await bridge.readThread(Number(args?.since || 0), 0)
      const rows = (data?.messages || []).slice(0, Number(args?.limit || 40))
      if (!rows.length) return '工作台上还没有对话。'
      return rows.map((row) => `${row.seq}. ${clockOf(row.at)} ${row.from === 'desktop' ? '电脑模型' : '手机模型'}：${row.text}`).join('\n')
    },
    async phone_test(args) {
      if (!args?.goal) throw new Error('缺少 goal')
      const result = await bridge.test(args)
      const lines = []
      if (result.artifacts?.length) {
        lines.push('截图/产物：')
        for (const item of result.artifacts) lines.push(`- ${item.path}（${item.sizeText}）`)
        lines.push('')
      }
      if (result.text) lines.push(result.text)
      if (result.sessionId) lines.push(`\n[session ${result.sessionId}]`)
      if (result.error) lines.push(`\n[失败] ${result.error}`)
      return lines.join('\n')
    },
    async phone_plan(args) {
      if (!args?.goal) throw new Error('缺少 goal')
      const result = await bridge.plan(args)
      if (result.error) throw new Error(result.error)
      return result.plan || '（没有返回计划）'
    },
    async phone_screenshot(args) {
      // proot 里跑的 agent 是应用 uid（10193），没有 READ_FRAME_BUFFER，screencap
      // 必然产出 0 字节；先问 relay（无障碍服务截图，不受这个限制），再退到 screencap。
      let relayText = ''
      let relayError = ''
      try {
        const result = await bridge.callTool('screen', { image: true }, 90_000)
        relayText = String(result?.text || '')
        if (result?.images?.length) return { text: result.text || '截图已附上', images: result.images }
      } catch (error) {
        relayError = explainError(error)
      }
      const shot = await bridge.screenshot(args)
      if (shot) return { text: shot.text, images: shot.images }
      const why = relayText || relayError || 'relay 没有返回图像'
      throw new Error(
        `这次截不到图：${why}\n` +
          '如果是银行、支付、密码输入这类页面，Android 禁止截图（FLAG_SECURE），换任何工具都拿不到；' +
          '如果提示「不允许读取的应用」，去 DSH Go 的权限设置里把那个应用加入允许名单再试。',
      )
    },
    async bridge_setup() {
      return `配置页：http://127.0.0.1:${setupPort}/  （在手机浏览器打开；电脑端也有自己的配置页）`
    },
    async bridge_doctor() {
      const info = bridge.peers()
      const self = await bridge.selfCheck().catch((error) => ({ error: explainError(error) }))
      const status = bridge.status()
      const lines = [
        `配对：${status.paired ? '是' : '否'} · 在线：${status.connected ? '是' : '否'} · 模式：${info.mode === 'listen' ? '本机被连接' : '本机主动连'}`,
        `电脑：${status.desktop?.name || '未知'}${status.desktop?.paired ? '（设备已被记住，免配对重连）' : ''}`,
        `地址：${bridge.endpoint || '（无）'}${info.self ? ` · 本机对外 ${info.self.host}:${info.self.port}` : ''}`,
        `地址类型：${status.endpointKind || 'unknown'} — ${ENDPOINT_HINT[status.endpointKind] || '未知类型'}`,
      ]
      if (status.authFailed) lines.push('电脑端拒绝了身份，请重新配对。')
      if (status.lastError) lines.push(`最近错误：${status.lastError}`)
      if (self.error) lines.push(`自检失败：${self.error}`)
      else {
        lines.push(`操控通道：${self.relay ? '可用' : '不可用'}（工具 ${self.tools?.length || 0} 个）`)
        lines.push(`本机模型补丁：${self.headless ? '已就绪' : '缺失'} · 截图目录：${self.artifactDir}`)
      }
      const pairs = info.pairs || []
      if (pairs.length) {
        lines.push('对端（自动连接的候选）：')
        for (const pair of pairs) lines.push(`- ${pair.host}:${pair.port}${pair.name ? `（${pair.name}）` : ''}`)
      }
      lines.push(`配置文件：${status.configFile}`)
      return lines.join('\n')
    },
  }

  if (withMcp) {
    // Hidden aliases: the neutral peer_* names are the public surface, the old
    // bridge_* ones still answer so existing prompts/tests keep working.
    handlerAliases(handlers)
    serveMcp({
      name: 'phone-bridge',
      version: '0.3.0',
      tools: phoneTools(bridge),
      call: async (name, args, caller) => {
        if (process.env.PHONE_BRIDGE_NO_GATE !== '1') {
          const links = readJson(path.join(bridgeDir(), 'peer-links.json'), {}) || {}
          const gate = phoneGateMessage(name, links)
          if (gate) throw new Error(gate)
        }
        const handler = handlers[name]
        if (!handler) throw new Error(`未实现：${name}`)
        return handler(args)
      },
      onShutdown: () => bridge.stop(),
    })
  }
  bridge.start()
  let pendingFound = []
  startSetup({
    role: 'phone',
    port: setupPort,
    host: '127.0.0.1',
    state: async () => {
      const s = bridge.status()
      const info = bridge.peers()
      const rows = [
        { label: '角色', value: '手机端（dsh-go）' },
        { label: '电脑', value: s.connected ? `已连接 · ${s.desktop?.name || ''}` : s.paired ? '还没有连上，正在重试' : '还没配对', tone: s.connected ? 'ok' : 'bad' },
        { label: '地址', value: bridge.endpoint || '（未设置）', mono: true },
        { label: '模式', value: info.mode === 'listen' ? '本机被连接' : '本机主动连电脑' },
      ]
      const pairs = info.pairs || []
      if (pairs.length) rows.push({ label: '自动连接', value: pairs.map((x) => `${x.host}:${x.port}`).join('、') })
      const bench = bridge.threadContext(4)
      const last = bench.filter((row) => row.from === 'desktop').slice(-1)[0]
      if (last) rows.push({ label: '电脑模型', value: String(last.text).slice(0, 80) })
      for (const item of pendingFound.slice(0, 3)) rows.push({ label: '发现', value: `${item.name} ${item.host}:${item.port}${item.permit ? '（可配对）' : ''}` })
      try {
        const sessions = loadSessions()
        const names = Object.keys(sessions)
        rows.push({ label: '专用会话', value: names.length ? names.map((name) => `${name}（${sessions[name].sessionId.slice(0, 8)}…）`).join('、') : '还没用过（第一次派活时自动建 default）' })
      } catch {
        /* sessions.json is optional */
      }
      try {
        const list = (await bridge.remoteAgents()) || []
        rows.push({ label: 'Agent', value: `${list.length} 个：${list.map((item) => item.name).join('、')}` })
      } catch {
        /* the desktop may be offline; the rest of the page still works */
      }
      if (s.authFailed) rows.push({ label: '状态', value: '电脑端拒绝了这个身份，重新配对一次', tone: 'bad' })
      if (s.lastError) rows.push({ label: '最近错误', value: String(s.lastError).slice(0, 120) })
      return {
        title: '手机桥接 · 手机端',
        subtitle: '点「找附近的电脑」自动配对；要粘配对串，用输入框上方的「连电脑」胶囊，或直接在这页的输入框里贴。',
        rows,
        fields: [
          { key: 'host', label: '电脑地址', placeholder: '192.168.1.5', value: pendingFound[0]?.host || '' },
          { key: 'code', label: '6 位配对码', placeholder: '电脑卡片上显示的 6 位数字' },
          { key: 'pair', label: '配对串（可选）', placeholder: 'dshphone://192.168.1.5:8787/xxxx' },
        ],
        link: s.connected && bridge.endpoint ? { href: `${bridge.endpoint}/workbench?t=${bridge.config.token}`, label: '打开「两个模型的对话」' } : null,
        log: bench.map((row) => `${row.seq}. ${clockOf(row.at)} ${row.from === 'desktop' ? '电脑模型' : '手机模型'}：${row.text}`),
        buttons: [
          { id: 'find', label: '找附近的电脑', primary: true },
          { id: 'agent.list', label: '看有哪些 agent' },
          { id: 'connect', label: '用地址 + 配对码连接' },
          { id: 'pair', label: '用配对串连接' },
          { id: 'ping', label: '测试一下' },
          { id: 'unpair', label: '断开并清除配对' },
        ],
      }
    },
    action: async (id, fields) => {
      if (id === 'pair') {
        if (!fields.pair) return { text: '先粘贴配对串' }
        await bridge.setPair(String(fields.pair).trim())
        await sleep(500)
        const s = bridge.status()
        return { text: s.connected ? `已连接：${s.desktop?.name || s.url}` : '已保存，正在连接…' }
      }
      if (id === 'ping') {
        const s = bridge.status()
        if (!s.paired) return { text: '还没配对' }
        return { text: s.connected ? `在线，对端为 ${s.desktop?.name || s.url}` : '电脑暂时没回应，会自动重试。' }
      }
      if (id === 'unpair') {
        bridge.unpair()
        return { text: '已断开并清除配对' }
      }
      if (id === 'agent.list') {
        const list = await bridge.remoteAgents()
        return { text: (list || []).map((item) => `${item.id} · ${item.name} · ${item.host}${item.running === false ? ' · 已停止' : ''}`).join('\n') || '没有 agent' }
      }
      if (id === 'agent.send') {
        if (!fields.text) return { text: '先写一句话' }
        const row = await bridge.sendAs(String(fields.as || 'phone'), String(fields.to || 'all'), String(fields.text), fields.level)
        return { text: `已发出（第 ${row.seq} 条，重要性 ${row.level === 'normal' ? '普通' : row.level}）` }
      }
      if (id === 'agent.read') {
        const data = await bridge.readAs(String(fields.as || 'phone'), Number(fields.since || 0), Number(fields.limit || 30))
        return { text: bridge.formatRows(data.messages) }
      }
      if (id === 'agent.converse') {
        if (!fields.text) return { text: '先写一句话' }
        const result = await bridge.converseAs(String(fields.as || 'phone'), String(fields.to || 'desktop'), String(fields.text), Number(fields.waitSeconds || 120))
        return { text: result.timedOut ? `已发出（第 ${result.row.seq} 条），${result.seconds} 秒内没有回话` : bridge.formatRows(result.replies) }
      }
      if (id === 'agent.spawn') {
        if (!fields.task) return { text: '先写任务：这个子智能体要做什么' }
        const record = await bridge.spawnAgentLocal({ name: String(fields.name || ''), task: String(fields.task) })
        return { text: `已在手机上启动 ${record.name}（${record.id}）` }
      }
      if (id === 'agent.stop') {
        await bridge.stopAgentLocal(String(fields.id || ''))
        return { text: `已停掉 ${fields.id}` }
      }
      if (id === 'say') {
        if (!fields.text) return { text: '先写一句话' }
        const row = await bridge.say(String(fields.text))
        return { text: `已发出（第 ${row.seq} 条）` }
      }
      if (id === 'converse') {
        if (!fields.text) return { text: '先写一句话' }
        const result = await bridge.converse(String(fields.text), fields.waitSeconds)
        if (result.timedOut) return { text: `已发出（第 ${result.row.seq} 条），电脑模型还没回话` }
        return { text: result.replies.map((row) => `${row.seq}. 电脑模型：${row.text}`).join('\n') }
      }
      if (id === 'read') {
        const data = await bridge.readThread(0, 0)
        const rows = (data?.messages || []).slice(-12)
        if (!rows.length) return { text: '工作台上还没有对话' }
        return { text: rows.map((row) => `${row.seq}. ${row.from === 'desktop' ? '电脑' : '手机'}：${row.text}`).join('\n') }
      }
      if (id === 'find') {
        const found = await bridge.discover()
        if (!found.length) return { text: '没找到电脑：确认两边在同一个 Wi-Fi、电脑上的 DSH 开着' }
        pendingFound = found
        return { text: `找到 ${found.length} 台：\n` + found.map((row, i) => `${i + 1}. ${row.name}  ${row.host}:${row.port}${row.permit ? '（已允许配对）' : ''}`).join('\n') }
      }
      if (id === 'connect') {
        let host = String(fields.host || pendingFound[0]?.host || '').trim()
        if (!host) {
          const found = await bridge.discover()
          if (found.length) {
            pendingFound = found
            host = found[0].host
          }
        }
        if (!host) return { text: '没找到电脑：确认两边在同一个 Wi-Fi、电脑上的 DSH 开着' }
        const port = Number(fields.port || pendingFound.find((row) => row.host === host)?.port || 8787)
        if (fields.code) {
          const result = await bridge.connectTo({ host, port, code: fields.code })
          return { text: `已连接：${result.desktop?.name || host}` }
        }
        await bridge.requestPairOnly({ host, port })
        return { text: '已发出配对请求：到电脑的「互联」卡片上点「允许」，这边会自动连上' }
      }
      return { text: `不认识的操作：${id}` }
    },
  }).on('error', () => {})
  if (!bridge.paired) {
    log('还没有配对：在手机对话里执行 bridge_pair，或运行 `node bridge.mjs pair <配对串>`')
  }
  process.on('SIGTERM', () => {
    bridge.stop()
    process.exit(0)
  })
  process.on('SIGINT', () => {
    bridge.stop()
    process.exit(0)
  })
  return bridge
}