// Desktop half: an HTTP server the phone polls, plus the MCP tools the desktop
// DSH host exposes to its model.
//
// Wire protocol (JSON over HTTP; every authenticated call carries `auth`):
//   GET  /beacon                               -> {v, name, platform, ok}   (no auth, for discovery)
//   POST /hello  {v, token?, device, caps}     -> {ok, desktop, caps, paired, challenge, toolTimeoutMs}
//   POST /auth   {challenge, device, sig, token?} -> {ok, desktop, toolTimeoutMs}
//   GET  /poll   ?wait=25000 (auth in header or query) -> {reqs:[{id, op, args}]}
//   POST /res    {id, ok, data|error}          -> 204
//   POST /prog   {id, data}                    -> 204
//   GET  /health                               -> {ok, online, device, serve}
//
// `auth` is either `{k:'token', token}` (first contact, from the pairing string)
// or `{k:'device', id, ts, sig}` where sig = Ed25519(challenge) and challenge is
// issued per connection — so after pairing the phone reconnects with no secret
// on the wire and no user action.
//
// The phone polls outbound, so the desktop never needs to reach the phone. Works
// on a LAN and through any HTTP tunnel (cloudflared, frp, tailscale…).
import http from 'node:http'
import net from 'node:net'
import fs, { statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID, randomBytes, randomInt } from 'node:crypto'
import {
  beaconProbe,
  bridgeDir,
  compareEndpoint,
  scanLan,
  desktopConfigPath,
  ensureDir,
  lanAddresses,
  log,
  pairStringTo,
  readJson,
  parsePairUrl,
  tokenEqual,
  truncate,
  writeJson,
  randomToken,
  humanSize,
  readLogTail,
  setLogFile,
  readActive,
  writeActive,
  clockOf,
} from './util.mjs'
import { serveMcp } from './mcp.mjs'
import { formatSessions, listSessions, noteSession, touchSession } from './sessions.mjs'
import { deviceIdOf, sign, verify } from './pubkey.mjs'
import { startSetup } from './setup.mjs'
import { qrSvg } from './qr.mjs'
import { pairPageHtml } from './pair.mjs'
import { workbenchHtml } from './workbench.mjs'
import { append as threadAppend, read as threadRead, waitFor as threadWait, LEVELS } from './thread.mjs'
import { addAgent, findAgent, listAgents, nameOf, newAgentId, removeAgent } from './agents.mjs'

const MAX_FILE_BYTES = 16 * 1024 * 1024
const VERSION = 2
const CHALLENGE_TTL = 10 * 60 * 1000

const MAX_BODY = 24 * 1024 * 1024

export function bridgeScriptPath() {
  return path.resolve(fileURLToPath(new URL('../bridge.mjs', import.meta.url)))
}

export function loadDesktopConfig() {
  const existing = readJson(desktopConfigPath(), null)
  // `bridge` lets other processes (the web card bundle) start the shared
  // server without guessing where bridge.mjs lives.
  if (existing && existing.token) return applyEnv({ ...defaults(), ...existing, bridge: bridgeScriptPath() })
  const config = { ...defaults(), bridge: bridgeScriptPath() }
  writeJson(desktopConfigPath(), config)
  log(`已生成桌面端配置：${desktopConfigPath()}`)
  return applyEnv(config)
}

function applyEnv(config) {
  if (process.env.PHONE_BRIDGE_PORT) config.port = Number(process.env.PHONE_BRIDGE_PORT)
  if (process.env.PHONE_BRIDGE_HOST) config.host = process.env.PHONE_BRIDGE_HOST
  if (process.env.PHONE_BRIDGE_EXACT_PORT === '1') config.exactPort = true
  return config
}

// 会话开关单独一个文件：desktop.json 两边进程都读写，混在一起会互相覆盖。
const linksPath = () => path.join(bridgeDir(), 'links.json')

export function readLinksFile() {
  const raw = readJson(linksPath(), null)
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  const legacy = readJson(desktopConfigPath(), {})?.links
  return legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? legacy : {}
}

export function writeLinksFile(links) {
  writeJson(linksPath(), links && typeof links === 'object' ? links : {})
}

// 手机模型习惯传短 id（0e47a423）；开关必须挂在完整的 session-<uuid> 上，
// 否则守卫能过、投递却找不到会话。名字/标题也一并认。
// 记下「这条回复已经被当场读走了」，宿主半的收件器就不会再投一遍。
function markConsumed(rows) {
  try {
    const file = path.join(bridgeDir(), 'consumed.json')
    const current = readJson(file, [])
    const seqs = new Set((Array.isArray(current) ? current : []).map((n) => Number(n) || 0))
    for (const row of rows || []) {
      const seq = Number(row && row.seq)
      if (seq) seqs.add(seq)
    }
    writeJson(file, [...seqs].filter(Boolean).sort((a, b) => a - b).slice(-300))
  } catch {
    // 记不下来最多多投一次，不值得让对话失败
  }
}

export function resolveDesktopSessionId(raw) {
  const want = String(raw == null ? '' : raw).trim()
  if (!want) return ''
  try {
    const reg = readJson(path.join(bridgeDir(), 'registry.json'), {})
    const rows = Object.values(reg?.sessions || {})
    const exact = rows.find((row) => row.id === want)
    if (exact) return exact.id
    // 裸 uuid → 补前缀
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(want)) return `session-${want}`
    const byShort = rows.find((row) => String(row.id).replace(/^session-/, '').startsWith(want))
    if (byShort) return byShort.id
    const byName = rows.find((row) => row.name === want)
    if (byName) return byName.id
  } catch {
    // 读不到目录就把原值当 id 用
  }
  return want
}

export function desktopLockPath() {
  return path.join(bridgeDir(), 'desktop.lock')
}

export function desktopLogPath() {
  return path.join(bridgeDir(), 'bridge.log')
}

function readLock() {
  return readJson(desktopLockPath(), null)
}

function writeLock(info) {
  ensureDir(bridgeDir())
  writeJson(desktopLockPath(), { ...info, at: new Date().toISOString() })
}

function removeLock() {
  try {
    const current = readLock()
    if (current && current.pid === process.pid) fs.rmSync(desktopLockPath(), { force: true })
  } catch {
    /* ignore */
  }
}

function isLoopback(req) {
  const address = String(req.socket?.remoteAddress || '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
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

// Describes the shared background server, starting it if needed. This is what
// makes "zero config" work: every desktop DSH session talks to one server, and
// whichever session starts first brings it up out of band.
export async function ensureDesktopServer() {
  const lock = readLock()
  if (lock && pidAlive(lock.pid)) {
    const health = await fetchHealth(`http://127.0.0.1:${lock.port}`, 2500)
    if (health?.ok) return { ...lock, pairing: Array.isArray(lock.pairing) ? lock.pairing : [] }
  }
  const config = loadDesktopConfig()
  const self = fileURLToPath(new URL('../bridge.mjs', import.meta.url))
  const logFile = desktopLogPath()
  ensureDir(bridgeDir())
  const child = spawn(process.execPath, [self, 'desktop', '--serve', '--port', String(config.port)], {
    detached: true,
    stdio: 'ignore',
    cwd: bridgeDir(),
    env: { ...process.env, PHONE_BRIDGE_LOG: logFile },
  })
  child.unref()
  const pid = child.pid
  writeLock({ pid, port: config.port, log: logFile })
  const started = Date.now()
  while (Date.now() - started < 8000) {
    const health = await fetchHealth(`http://127.0.0.1:${config.port}`, 1200)
    if (health?.ok) {
      const pairing = (config.peers || []).map((p) => pairStringTo(p.host, p.port, p.token))
      if (!pairing.length) for (const item of lanAddresses()) pairing.push(pairStringTo(item.address, health.port, config.token))
      writeLock({ pid, port: health.port, log: logFile, pairing })
      log(`后台桥接已启动：pid ${pid} 端口 ${health.port}`)
      return { pid, port: health.port, log: logFile, pairing }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`后台桥接没能在 8 秒内启动，看日志：${logFile}`)
}

export async function fetchHealth(base, timeoutMs = 2500) {
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function resolveTarget(host, config, bridge) {
  const cleaned = String(host).replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const [h, p] = cleaned.split(':')
  return { host: h.replace(/^\[|\]$/g, ''), port: Number(p || config.port || 8787) }
}

function defaults() {
  return {
    token: randomToken(),
    port: Number(process.env.PHONE_BRIDGE_PORT || 8787),
    host: process.env.PHONE_BRIDGE_HOST || '0.0.0.0',
    name: os.hostname(),
    allowShell: true,
    allowAsk: true,
    allowFiles: true,
    allowTest: true,
    toolTimeoutMs: 30 * 60 * 1000,
    devices: [],
    autostart: true,
  }
}

// Keys the phone learns during pairing; kept in phone.json, never on the wire.
function loadDeviceKeys(config) {
  if (!Array.isArray(config.devices)) config.devices = []
  return config.devices
}

class DesktopBridge {
  constructor(config) {
    this.config = config
    this.server = null
    this.port = null
    this.queue = []
    this.waiters = new Set()
    this.pending = new Map()
    this.device = null
    this.lastPoll = 0
    this.challenge = null
    this.auth = { k: 'token' }
    this.logFile = null
    this.pairWindowUntil = 0
    this.code = null
    this.pendingPair = null
    // 重启别把已经配对的手机当成陌生设备。devices 里记着就恢复出来，
    // 否则 /health 会一直 online:false，而手机其实在正常轮询——所有需要
    // 主动连手机的工具（peer_run / phone_tools / peer_put …）都会误报
    // 「手机还没连上」。
    const known = (config.devices || [])[config.devices.length - 1]
    if (known) this.device = { ...known, lastSeen: undefined }
  }

  get online() {
    const at = Math.max(this.lastPoll || 0, this.lastSeen || 0)
    return this.device !== null && Date.now() - at < 70_000
  }

  // 手机即使暂时没在轮询（切后台、换网络），只要还主动调 /call，
  // 就说明它在线，别让模型看到「online:false」误判。
  markSeen(id) {
    this.lastSeen = Date.now()
    if (!this.device && id) {
      const rec = (this.config.devices || []).find((item) => item.id === id)
      if (rec) this.device = { ...rec }
    }
  }

  // How long the "allow a new phone" window still runs (ms).
  get permitLeft() {
    return Math.max(0, this.pairWindowUntil - Date.now())
  }

  // How long the 6-digit code still works (ms).
  get codeLeft() {
    return this.code ? Math.max(0, this.code.until - Date.now()) : 0
  }

  // Local-only (127.0.0.1): the desktop user taps "allow a new phone" and any
  // phone on the LAN may register its key for a short window — nothing to copy.
  openPairWindow(ms = 120_000) {
    this.pairWindowUntil = Date.now() + Math.max(10_000, Math.min(Number(ms) || 120_000, 10 * 60_000))
    log(`已允许新手机配对：${Math.round(this.permitLeft / 1000)} 秒内有效`)
    return this.permitLeft
  }

  // 6-digit code for phones that cannot see the computer's screen.
  issueCode(ms = 120_000) {
    const value = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.code = { value, until: Date.now() + Math.max(10_000, Math.min(Number(ms) || 120_000, 10 * 60_000)) }
    log(`配对码：${value}（${Math.round(this.codeLeft / 1000)} 秒内有效）`)
    return { code: value, left: this.codeLeft }
  }

  // A phone on the LAN says "I want to pair": we keep its request and the
  // computer's card shows it. The user taps 允许 — no code to type.
  requestPair(incoming) {
    const id = String(incoming?.id || '')
    const pub = String(incoming?.pub || '')
    if (!id || !pub || deviceIdOf(pub) !== id) return { ok: false, error: '设备身份不对' }
    this.pendingPair = { id, name: String(incoming.name || '一台手机'), platform: String(incoming.platform || ''), pub, at: Date.now() }
    log(`收到配对请求：${this.pendingPair.name}`)
    return { ok: true, name: this.pendingPair.name }
  }

  get pendingPairLeft() {
    return this.pendingPair ? Math.max(0, 5 * 60_000 - (Date.now() - this.pendingPair.at)) : 0
  }

  approvePair() {
    const pending = this.pendingPair
    if (!pending || this.pendingPairLeft <= 0) {
      this.pendingPair = null
      return { ok: false, error: '没有待确认的配对请求' }
    }
    this.registerDevice({ id: pending.id, name: pending.name, platform: pending.platform, pub: pending.pub })
    this.pendingPair = null
    log(`已允许 ${pending.name} 连接`)
    return { ok: true, device: { id: pending.id, name: pending.name } }
  }

  denyPair() {
    const pending = this.pendingPair
    this.pendingPair = null
    if (pending) log(`已拒绝 ${pending.name} 的配对请求`)
    return { ok: true }
  }

  async start() {
    if (!this.logFile) {
      this.logFile = process.env.PHONE_BRIDGE_LOG || desktopLogPath()
      setLogFile(this.logFile)
    }
    const server = http.createServer((req, res) => {
      this.route(req, res).catch((error) => {
        log(`HTTP 处理失败：${error?.message || error}`)
        try {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'internal' }))
        } catch {
          /* ignore */
        }
      })
    })
    this.server = server
    const base = this.config.port
    // exactPort = this instance answers at exactly its configured port (undialed
    // side of a peer link), so it must never drift to another port.
    const anything = Boolean(process.env.PHONE_BRIDGE_ANY_PORT) || this.config.exactPort === true
    const attempts = anything ? 20 : 1
    for (let i = 0; i < attempts; i += 1) {
      const port = base + i
      try {
        await listen(server, port, this.config.host)
        this.port = port
        return port
      } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error
      }
    }
    throw new Error(`端口 ${base}..${base + 19} 都被占用了`)
  }

  stop() {
    try {
      this.server?.close()
    } catch {
      /* ignore */
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('桥接已关闭'))
    }
    this.pending.clear()
  }

  async route(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const route = url.pathname
    if (req.method === 'GET' && route === '/beacon') {
      return sendJson(res, 200, {
        v: VERSION,
        name: this.config.name,
        platform: process.platform,
        ok: true,
        permit: this.permitLeft > 0,
      })
    }
    if (req.method === 'GET' && route === '/health') {
      return sendJson(res, 200, {
        ok: true,
        v: VERSION,
        name: this.config.name,
        platform: process.platform,
        online: this.online,
        device: this.device,
        port: this.port,
        pairing: this.pairing(),
        pairUrl: this.pairUrl(),
        workbenchUrl: this.workbenchUrl(),
        permitLeft: this.permitLeft,
        codeLeft: this.codeLeft,
        pendingPair: this.pendingPair ? { name: this.pendingPair.name, platform: this.pendingPair.platform, left: this.pendingPairLeft } : null,
      })
    }
    if (req.method === 'POST' && route === '/hello') {
      const body = await readBody(req)
      const tokenOk = tokenEqual(body?.token, this.config.token)
      const caller = String(body?.device?.id || '')
      const known = Boolean(caller && loadDeviceKeys(this.config).some((d) => tokenEqual(d.id, caller)))
      const permit = this.permitLeft > 0
      if (!tokenOk && !known && !permit) {
        return sendJson(res, 401, { ok: false, error: 'token', permit: false })
      }
      this.challenge = { value: randomBytes(18).toString('base64url'), at: Date.now() }
      this.auth = { k: 'pending', deviceId: caller || '' }
      return sendJson(res, 200, {
        ok: true,
        v: VERSION,
        paired: this.isPaired(caller),
        challenge: this.challenge.value,
        desktop: { name: this.config.name, host: this.config.hostname || os.hostname(), platform: process.platform },
        caps: ['tool', 'shell', 'files', 'ask', 'test'],
        toolTimeoutMs: this.config.toolTimeoutMs,
        permit,
      })
    }
    if (req.method === 'POST' && route === '/auth') {
      const body = await readBody(req)
      // First contact with a valid token registers the device key, so later
      // reconnects only need the signature (nothing to copy again).
      if (body?.auth?.k === 'device' && body?.device?.pub && tokenEqual(body?.token, this.config.token)) {
        if (!this.challenge || body?.challenge === this.challenge.value) this.registerDevice(body.device)
      }

      const auth = body?.auth || {}
      const incoming = body?.device || {}
      const id = String(incoming?.id || '')
      const keyOk = Boolean(id && incoming?.pub && deviceIdOf(incoming.pub) === id)
      let authorized = false
      if (auth.k === 'code') {
        // Short numeric code, single use, typed by the user on the phone.
        if (keyOk && this.codeLeft > 0 && tokenEqual(auth.code, this.code?.value)) {
          this.registerDevice(incoming)
          this.code = null
          authorized = true
          log(`配对码验证通过：${incoming.name || 'phone'}`)
        }
      } else if (auth.k === 'device' && keyOk && this.permitLeft > 0) {
        // Pairing window: trust the key the caller presents, the signature only
        // proves it holds the private half.
        const message = this.challenge?.value || String(body?.challenge || '')
        if (message && verify(message, auth.sig, incoming.pub)) {
          this.registerDevice(incoming)
          authorized = true
          log(`配对窗口内登记新手机：${incoming.name || 'phone'}`)
        }
      }
      if (!authorized) authorized = this.checkAuth(body)
      if (!authorized) return sendJson(res, 401, { ok: false, error: 'auth' })
      this.challenge = null
      this.authenticate(body)
      log(`手机已连接：${this.device?.name || '?'} ${this.device?.platform || ''} caps=${(this.device?.caps || []).join(',')}`)
      return sendJson(res, 200, {
        ok: true,
        v: VERSION,
        desktop: { name: this.config.name, platform: process.platform },
        caps: ['tool', 'shell', 'files', 'ask', 'test'],
        toolTimeoutMs: this.config.toolTimeoutMs,
        pending: this.queue.length + this.pending.size,
      })
    }
    if (req.method === 'GET' && route === '/poll') {
      const auth = this.parseAuth(req, url)
      const ok =
        auth.k === 'token' ? tokenEqual(auth.token, this.config.token) : this.verifyDevice(`${auth.id}:${auth.ts}`, auth.sig, auth.id)
      if (!ok) return sendJson(res, 401, { ok: false })
      const wait = Math.min(Number(url.searchParams.get('wait') || 25000) || 25000, 60000)
      const wasOnline = this.online
      this.markSeen(auth.id)
      this.lastPoll = Date.now()
      if (!wasOnline && this.device) {
        // One line per connect event, so a sleeping desktop model reading the
        // workbench next turn knows the phone is back.
        try {
          threadAppend('desktop', `（${this.device.name || '手机'}已连上，可以派活了）`, 'all')
        } catch {}
      }
      const reqs = await this.nextRequests(wait)
      return sendJson(res, 200, { reqs })
    }
    if (req.method === 'POST' && route === '/res') {
      const body = await readBody(req)
      if (!this.checkAuth(body)) return sendJson(res, 401, { ok: false })
      this.settle(body)
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && route === '/call') {
      const body = await readBody(req)
      if (!this.checkAuth(body)) return sendJson(res, 401, { ok: false })
      this.markSeen(body?.auth?.id)
      try {
        const result = await this.handleCall(String(body?.op || ''), body?.args || {})
        return sendJson(res, 200, { ok: true, ...result })
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: String(error?.message || error) })
      }
      res.writeHead(204)
      return res.end()
    }
    if (req.method === 'POST' && route === '/prog') {
      const body = await readBody(req)
      if (!this.checkAuth(body)) return sendJson(res, 401, { ok: false })
      const entry = this.pending.get(body?.id)
      if (entry?.onProgress && body?.data) {
        try {
          entry.onProgress(body.data)
        } catch {
          /* ignore listener errors */
        }
      }
      res.writeHead(204)
      return res.end()
    }
    if (route === '/sessions') {
      if (req.method === 'GET') {
        const auth = this.parseAuth(req, url)
        const ok =
          auth.k === 'token' ? tokenEqual(auth.token, this.config.token) : this.verifyDevice(`${auth.id}:${auth.ts}`, auth.sig, auth.id)
        if (!ok) return sendJson(res, 401, { ok: false })
        return sendJson(res, 200, { ok: true, sessions: listSessions() })
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (!this.checkAuth(body)) return sendJson(res, 401, { ok: false })
        const result = noteSession(body?.target || 'current', { name: body?.name, purpose: body?.purpose, project: body?.project })
        if (!result.ok) return sendJson(res, 404, { ok: false, error: result.error })
        log(`会话备注：${result.session.name || ''} ${truncate(result.session.purpose || '', 40)}`.trim())
        return sendJson(res, 200, { ok: true, session: result.session })
      }
      return sendJson(res, 405, { ok: false })
    }
    // 协作对：手机侧的收件器要知道「投给哪个手机会话」。
    // 配置由桌面插件写进 desktop.json，这里只读文件，不做缓存，改完立刻生效。
    if (route === '/collab') {
      if (req.method === 'GET') {
        const auth = this.parseAuth(req, url)
        const ok =
          auth.k === 'token' ? tokenEqual(auth.token, this.config.token) : this.verifyDevice(`${auth.id}:${auth.ts}`, auth.sig, auth.id)
        if (!ok) return sendJson(res, 401, { ok: false })
        const stored = readJson(desktopConfigPath(), {})
        // 顺便把「电脑上开着哪些会话」带回去，否则手机模型无从点名：
        // 它只能看到自己那边的会话。快照由宿主半每 3 秒写进 live.json。
        const live = readJson(path.join(bridgeDir(), 'live.json'), {})
        return sendJson(res, 200, {
          ok: true,
          collab: stored?.collab || null,
          desktopSessions: Array.isArray(live?.sessions) ? live.sessions : [],
          // 手机端会话界面也要显示「互联」，所以把开关表一并带回去。
          links: readLinksFile(),
        })
      }
      // 手机端点那颗开关时写回来，真源始终在电脑上。
      if (req.method === 'POST') {
        const auth = this.parseAuth(req, url)
        const ok =
          auth.k === 'token' ? tokenEqual(auth.token, this.config.token) : this.verifyDevice(`${auth.id}:${auth.ts}`, auth.sig, auth.id)
        if (!ok) return sendJson(res, 401, { ok: false })
        const body = readBody(req)
        const desktopId = String(body?.desktopId || '').trim()
        const phoneId = String(body?.phoneId || '').trim()
        if (!desktopId && !phoneId) return sendJson(res, 400, { ok: false, text: '要指定是哪一边的会话' })
        const store = readJson(desktopConfigPath(), {})
        const links = readLinksFile()
        let key = desktopId || Object.keys(links).find((id) => String(links[id]?.phoneId || '') === phoneId) || ''
        if (!key && phoneId) {
          // 手机端点了开关但还没配对过：接到电脑上最近开着的那个会话。
          const liveNow = readJson(path.join(bridgeDir(), 'live.json'), {})
          key = String((Array.isArray(liveNow?.sessions) ? liveNow.sessions[0]?.id : '') || '')
        }
        if (!key) {
          // 用户 m04603：手机上点开互联、电脑上却一个会话都没开 —— 别报错，
          // 留张便签给宿主半，让它开一个新会话再接上。
          store.pendingNewSession = { phoneId, at: new Date().toISOString() }
          writeJson(desktopConfigPath(), store)
          return sendJson(res, 200, { ok: true, pending: true, text: '电脑上没有开着的会话，正在给你开一个新的…' })
        }
        if (body?.off) delete links[key]
        else links[key] = { phoneId: phoneId || String(links[key]?.phoneId || ''), at: new Date().toISOString() }
        writeLinksFile(links)
        return sendJson(res, 200, { ok: true, links })
      }
      return sendJson(res, 405, { ok: false })
    }
    if (route === '/thread') {
      if (req.method === 'GET') {
        const auth = this.parseAuth(req, url)
        const ok =
          auth.k === 'token' ? tokenEqual(auth.token, this.config.token) : this.verifyDevice(`${auth.id}:${auth.ts}`, auth.sig, auth.id)
        if (!ok) return sendJson(res, 401, { ok: false })
        const since = Number(url.searchParams.get('since') || 0)
        const as = String(url.searchParams.get('as') || '')
        const wait = Math.min(Number(url.searchParams.get('wait') || 0) || 0, 55_000)
        const data = wait > 0 ? await threadWait(as || 'phone', since, wait) : threadRead(since, 200, as)
        return sendJson(res, 200, { ok: true, ...data })
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (!this.checkAuth(body)) return sendJson(res, 401, { ok: false })
        const from = String(body?.from || 'phone').slice(0, 40)
        const known = findAgent(from)
        const sender = known ? from : from === 'desktop' ? 'desktop' : from === 'phone' ? 'phone' : ''
        if (!sender) return sendJson(res, 400, { ok: false, error: `不认识的 agent：${from}` })
        const to = String(body?.to || 'all').slice(0, 40)
        // 手机往工作台写消息也算「还活着」：它可能只发消息不轮询（切后台、
        // 换网络），这时 online 不该翻成 false。
        if (sender !== 'desktop') this.markSeen(body?.auth?.id)
        const row = threadAppend(sender, body?.text, to, {
          level: body?.level,
          silent: body?.silent === true,
          kind: body?.kind,
        })
        const label = known?.name || (sender === 'desktop' ? '电脑模型' : '手机模型')
        log(`对话 +1（${label}${to !== 'all' ? ` → ${to}` : ''}）${row.level !== 'normal' ? `[${row.level}]` : ''}：${truncate(row.text, 90)}`)
        return sendJson(res, 200, { ok: true, seq: row.seq, message: row })
      }
    }
    if (route === '/agents' || route === '/agents/spawn' || route === '/agents/stop' || route === '/agents/register' || route === '/agents/unregister') {
      if (req.method === 'GET' && route === '/agents') {
        const auth = this.parseAuth(req, url)
        const ok =
          auth.k === 'token' ? tokenEqual(auth.token, this.config.token) : this.verifyDevice(`${auth.id}:${auth.ts}`, auth.sig, auth.id)
        if (!ok) return sendJson(res, 401, { ok: false })
        return sendJson(res, 200, { ok: true, agents: listAgents('desktop') })
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (!this.checkAuth(body)) return sendJson(res, 401, { ok: false })
        try {
          if (route === '/agents/register') {
            const record = body?.agent || {}
            if (!record.id) throw new Error('缺少 agent.id')
            return sendJson(res, 200, { ok: true, agent: addAgent(record) })
          }
          if (route === '/agents/unregister') {
            return sendJson(res, 200, { ok: true, removed: removeAgent(String(body?.id || '')) })
          }
          if (route === '/agents/spawn') {
            const record = await this.spawnAgent({ name: body?.name, task: body?.task, host: body?.host || 'desktop' })
            return sendJson(res, 200, { ok: true, agent: record })
          }
          const stopped = this.stopAgent(String(body?.id || ''))
          return sendJson(res, 200, { ok: true, ...stopped })
        } catch (error) {
          return sendJson(res, 200, { ok: false, error: String(error?.message || error) })
        }
      }
    }
    if (req.method === 'GET' && (route === '/pair' || route === '/pair/')) {
      if (!tokenEqual(url.searchParams.get('t'), this.config.token)) {
        return sendJson(res, 403, { ok: false, error: '配对链接已失效，请在电脑上重新打开二维码' })
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(pairPageHtml({ token: this.config.token, host: url.hostname, port: this.port || this.config.port }))
    }
    if (req.method === 'POST' && (route === '/permit' || route === '/code')) {
      // Only the computer itself may widen access; a LAN peer must not.
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'local only' })
      const body = await readBody(req).catch(() => ({}))
      if (route === '/permit') {
        const left = this.openPairWindow(body?.ms)
        return sendJson(res, 200, { ok: true, permitLeft: left })
      }
      const issued = this.issueCode(body?.ms)
      return sendJson(res, 200, { ok: true, code: issued.code, codeLeft: issued.left })
    }
    if (req.method === 'POST' && route === '/request') {
      const body = await readBody(req).catch(() => ({}))
      const result = this.requestPair(body?.device)
      return sendJson(res, result.ok ? 200 : 400, result)
    }
    if (req.method === 'POST' && (route === '/pair/approve' || route === '/pair/deny')) {
      // Only the computer itself may approve; a LAN peer must not.
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'local only' })
      const result = route === '/pair/approve' ? this.approvePair() : this.denyPair()
      return sendJson(res, 200, result)
    }
    if (req.method === 'GET' && route === '/workbench') {
      const token = url.searchParams.get('t') || ''
      if (!tokenEqual(token, this.config.token)) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
        return res.end('<h1>链接已失效</h1><p>请在电脑端的插件卡片里重新打开「两个模型的对话」。</p>')
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(workbenchHtml({ token, name: this.config.name }))
    }
    if (req.method === 'GET' && route === '/pair/qr.svg') {
      if (!tokenEqual(url.searchParams.get('t'), this.config.token)) {
        return sendJson(res, 403, { ok: false, error: 'token' })
      }
      const svg = qrSvg(this.pairUrl(), { margin: 3, label: '配对手机' })
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(svg)
    }
    return sendJson(res, 404, { ok: false, error: 'not found' })
  }

  // ---------------------------------------------------------------- auth
  isPaired(deviceId) {
    if (!deviceId) return false
    return loadDeviceKeys(this.config).some((d) => tokenEqual(d.id, deviceId))
  }

  verifyDevice(message, sig, deviceId) {
    const row = loadDeviceKeys(this.config).find((d) => tokenEqual(d.id, deviceId))
    if (!row?.pub) return false
    if (deviceIdOf(row.pub) !== deviceId) return false
    return verify(message, sig, row.pub)
  }

  checkAuth(body) {
    if (!body) return false
    const auth = body.auth || {}
    if (auth.k === 'device') {
      // Two shapes: the one-off signature over the /hello challenge, and the
      // per-call `${id}:${ts}` signature used by /poll /res /prog.
      if (this.challenge && Date.now() - this.challenge.at <= CHALLENGE_TTL) {
        if (this.verifyDevice(this.challenge.value, auth.sig, String(auth.id || ''))) return true
      }
      if (!this.verifyDevice(`${auth.id}:${auth.ts}`, auth.sig, String(auth.id || ''))) return false
      return Math.abs(Date.now() - Number(auth.ts)) <= 5 * 60_000
    }
    if (auth.k === 'token') return tokenEqual(auth.token, this.config.token)
    return false
  }

  parseAuth(req, url) {
    const b64 = url.searchParams.get('auth')
    if (b64) {
      try {
        return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
      } catch {
        return { k: 'none' }
      }
    }
    const header = req.headers['x-phone-auth']
    let value = null
    if (header) {
      try {
        value = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8'))
      } catch {
        value = null
      }
    }
    if (!value) {
      const k = url.searchParams.get('k')
      if (k === 'device') {
        value = { k: 'device', id: url.searchParams.get('id'), ts: url.searchParams.get('ts'), sig: url.searchParams.get('sig') }
      } else if (k === 'token') {
        value = { k: 'token', token: url.searchParams.get('token') }
      }
    }
    return value || { k: 'none' }
  }

  registerDevice(incoming) {
    const id = String(incoming?.id || '')
    if (!id || !incoming?.pub || deviceIdOf(incoming.pub) !== id) return false
    const devices = loadDeviceKeys(this.config)
    const row = devices.find((d) => d.id === id)
    const next = { id, pub: String(incoming.pub), name: String(incoming.name || 'phone'), platform: String(incoming.platform || ''), lastSeen: new Date().toISOString() }
    if (row) Object.assign(row, next)
    else devices.push(next)
    try {
      writeJson(desktopConfigPath(), this.config)
      log(`已记住手机设备：${next.name} ${id.slice(0, 8)}…`)
    } catch (error) {
      log(`保存设备信息失败：${error?.message || error}`)
    }
    return true
  }

  // Called after a successful /auth; remembers the device and its keys.
  authenticate(body) {
    const incoming = body?.device || {}
    const id = String(incoming.id || '')
    this.device = {
      id,
      name: String(incoming.name || 'phone'),
      platform: String(incoming.platform || ''),
      asHost: incoming.asHost && typeof incoming.asHost === 'object' ? incoming.asHost : null,
      at: Date.now(),
    }
    this.auth = { k: 'device', deviceId: id }
    this.lastPoll = Date.now()
    const devices = loadDeviceKeys(this.config)
    const row = devices.find((d) => tokenEqual(d.id, id))
    const name = this.device.name
    if (row) {
      row.name = name
      row.platform = this.device.platform
      row.lastSeen = new Date().toISOString()
      if (incoming.pub) row.pub = String(incoming.pub)
    } else if (incoming.pub) {
      devices.push({ id, name, platform: this.device.platform, pub: String(incoming.pub), lastSeen: new Date().toISOString() })
    }
    if (this.device.asHost) {
      const existing = (this.config.peers || []).find((p) => pairStringTo(p.host, p.port, '').startsWith(pairStringTo(this.device.asHost.host, this.device.asHost.port, '')))
      if (!existing) {
        this.config.peers = [...(this.config.peers || []), { ...this.device.asHost, name, lastSeen: new Date().toISOString() }]
      }
    }
    try {
      writeJson(desktopConfigPath(), this.config)
    } catch (error) {
      log(`保存设备信息失败：${error?.message || error}`)
    }
    this.failPending('手机重新连接，打断未完成的任务')
  }

  nextRequests(waitMs) {
    if (this.queue.length) return Promise.resolve(this.takeQueued())
    return new Promise((resolve) => {
      // A waiter only resolves when it actually takes a request. Stale waiters
      // (an aborted poll from a phone that reconnected) must never swallow a
      // queued request, otherwise the caller waits forever.
      const waiter = () => {
        if (!this.queue.length) return
        clearTimeout(timer)
        this.waiters.delete(waiter)
        resolve(this.takeQueued())
      }
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        resolve([])
      }, waitMs)
      this.waiters.add(waiter)
    })
  }

  takeQueued() {
    return this.queue.splice(0, 8)
  }

  settle(body) {
    const entry = this.pending.get(body?.id)
    if (!entry) return
    this.pending.delete(body.id)
    clearTimeout(entry.timer)
    if (body.ok) entry.resolve(body.data)
    else entry.reject(new Error(body?.error?.message || '手机执行失败'))
  }

  failPending(reason) {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
  }

  // What the phone may ask this computer to do. Same vocabulary as bridge.call()
  // in the other direction, so neither side is "the tool" of the other.
  async handleCall(op, args) {
    // 手机端是 Flutter 原生界面，会话头部的 web 插槽在那边渲染不出来，
    // 所以手机面板上的开关走这条 MCP 通道，真源仍写在电脑的 desktop.json.links。
    if (op === 'link') {
      const links = readLinksFile()
      // 手机模型习惯传短 id（0e47a423），这里必须补成完整的 session-<uuid>，
      // 否则开关挂在错的 key 上——守卫能过，但投递时找不到会话。
      const desktopId = resolveDesktopSessionId(args?.desktopId)
      const phoneId = String(args?.phoneId || '').trim()
      if (!desktopId) throw new Error('要指定电脑上哪个会话（desktopId）')
      if (args?.off) delete links[desktopId]
      else links[desktopId] = { phoneId, at: new Date().toISOString() }
      writeLinksFile(links)
      return { text: args?.off ? '已断开这个会话的互联' : `已把这个会话和手机连起来（${desktopId.slice(0, 16)}…）`, links }
    }
    if (op === 'links') {
      const links = readLinksFile()
      return { text: Object.keys(links).length ? JSON.stringify(links) : '现在没有任何会话开着互联', links }
    }
    if (op === 'agent.spawn') {
      return { agent: await this.spawnAgent({ name: args?.name, task: args?.task, host: 'desktop' }) }
    }
    if (op === 'agent.stop') {
      return this.stopAgent(String(args?.id || ''))
    }
    if (op === 'agent.list') {
      return { text: this.agentLines().join('\n') }
    }
    if (op === 'info') {
      return {
        text: [
          `电脑：${this.config.name}`,
          `平台：${process.platform}`,
          `监听：${this.config.host}:${this.config.port}`,
          `允许命令：${this.config.allowShell !== false ? '是' : '否'}`,
          `允许文件：${this.config.allowFiles !== false ? '是' : '否'}`,
          `当前目录：${process.cwd()}`,
        ].join('\n'),
      }
    }
    if (op === 'shell') {
      if (this.config.allowShell === false) throw new Error('电脑端关闭了「让手机执行命令」')
      if (!args?.command) throw new Error('缺少 command')
      log(`手机要求执行命令：${truncate(String(args.command), 120)}`)
      return { text: await runLocalShell({ command: String(args.command), cwd: args.cwd }) }
    }
    if (op === 'file.get') {
      if (this.config.allowFiles === false) throw new Error('电脑端关闭了文件传输')
      const file = String(args?.path || '')
      if (!file) throw new Error('缺少 path')
      const stat = fs.statSync(file)
      if (stat.size > MAX_FILE_BYTES) throw new Error(`文件太大：${humanSize(stat.size)}（上限 ${humanSize(MAX_FILE_BYTES)}）`)
      return { name: path.basename(file), size: stat.size, data: fs.readFileSync(file).toString('base64') }
    }
    if (op === 'file.put') {
      if (this.config.allowFiles === false) throw new Error('电脑端关闭了文件传输')
      const dest = String(args?.path || '')
      if (!dest) throw new Error('缺少 path')
      const buf = Buffer.from(String(args?.data || ''), 'base64')
      if (buf.length > MAX_FILE_BYTES) throw new Error(`文件太大：${humanSize(buf.length)}`)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, buf)
      // 手机往电脑写文件：记一条变更日志（silent），但不唤醒电脑模型 ——
      // 它下次派活或看对话时能看到，没必要为一个文件改动打断它。
      try {
        threadAppend('phone', `📝 手机写了电脑上的 ${dest}（${humanSize(buf.length)}）`, 'all', {
          level: 'report',
          silent: true,
          kind: 'file-change',
        })
      } catch {
        // 记日志失败不能影响文件本身
      }
      return { text: `已写入 ${dest}（${humanSize(buf.length)}）`, path: dest, size: buf.length }
    }
    throw new Error(`不认识的操作：${op}`)
  }

  // ------------------------------------------------------------- subagents
  async spawnAgent({ name, task, host = 'desktop' } = {}) {
    const cleanTask = String(task || '').trim()
    if (!cleanTask) throw new Error('缺少 task：子智能体要做什么')
    const label = String(name || '').trim() || '子智能体'
    if (host === 'phone') {
      const result = await this.call('agent.spawn', { name: label, task: cleanTask }, { timeoutMs: 30_000 })
      if (result?.error) throw new Error(result.error)
      return result.agent
    }
    // 子智能体靠 `dsh headless` 跑一整轮，桌面 DSH 桌面版不一定带命令行，
    // 没有就直接说清楚，别留一条「已停止」的空记录让人以为它跑过了。
    if (!hasDshCli()) {
      throw new Error(
        '这台电脑上没找到 dsh 命令行，桌面子智能体起不来。两个办法：\n' +
          '· 设环境变量 DSH_BIN 指向 dsh 可执行文件后重试；\n' +
          "· 或改用 host:'phone'，在手机上跑（那边有 /opt/dsh 的 dsh）。",
      )
    }
    const id = newAgentId(label)
    const logFile = path.join(bridgeDir(), 'agents', `${id}.log`)
    ensureDir(path.dirname(logFile))
    const script = fileURLToPath(new URL('./agent-run.mjs', import.meta.url))
    // process.execPath 在这里是 Electron 的可执行文件，不带 ELECTRON_RUN_AS_NODE
    // 就会被当成 GUI 启动（参数被忽略、立刻退出），子智能体等于没跑；以前 stdio
    // 设成 ignore，失败完全静默，界面上只留下一条「已停止」的记录。
    const child = spawn(process.execPath, [script, '--id', id, '--name', label, '--task', cleanTask, '--mode', 'direct', '--log', logFile], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_BIN: dshBin() },
    })
    let failed = null
    child.on('error', (error) => (failed = error))
    child.unref()
    // 立刻看一眼：能起来的话 600ms 内不会退出。
    // 注意 exitCode === 0 是「跑得太快、已经正常结束了」，不是启动失败——
    // 手机模型指出的边界：把快速成功的运行误报成启动失败会让人白查半天。
    await new Promise((resolve) => setTimeout(resolve, 600))
    if (failed || (child.exitCode !== null && child.exitCode !== 0)) {
      const tail = readLogTail(logFile, 20)
      removeAgent(id)
      throw new Error(`子智能体没能启动（${failed?.message || `退出码 ${child.exitCode}`}）${tail ? `\n${tail}` : ''}`)
    }
    const record = addAgent({
      id,
      name: label,
      host: 'desktop',
      kind: 'subagent',
      task: cleanTask,
      pid: child.pid,
      log: logFile,
      createdAt: new Date().toISOString(),
    })
    log(`子智能体已启动：${label}（${id}），pid ${child.pid}`)
    return record
  }

  stopAgent(id) {
    const agent = findAgent(id)
    if (!agent) throw new Error(`没有这个 agent：${id}`)
    if (agent.kind !== 'subagent') throw new Error('内建模型不是从这里停的')
    if (agent.pid) {
      try {
        process.kill(agent.pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
    removeAgent(id)
    log(`子智能体已停止：${agent.name}（${id}）`)
    return { stopped: id, name: agent.name }
  }

  agentLines() {
    return listAgents('desktop').map((item) => {
      const bits = [item.id, item.name, item.host]
      if (item.kind === 'subagent') bits.push(item.running ? '运行中' : '已停止')
      if (item.note) bits.push(item.note)
      return bits.join(' · ')
    })
  }

  requirePhone() {
    if (!this.online) {
      const pairs = this.pairing()
      throw new Error(
        `手机还没连上。自动发现没连上时，把这一串发到手机对话里执行 bridge_pair 即可（之后自动重连）：${pairs[0] || '（桌面没有局域网地址，见 phone_status）'}`,
      )
    }
  }

  call(op, args, { timeoutMs, onProgress } = {}) {
    this.requirePhone()
    const id = randomUUID()
    const timeout = timeoutMs || this.config.toolTimeoutMs
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`等待手机执行 ${op} 超时（${Math.round(timeout / 1000)}s）`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer, onProgress })
      this.queue.push({ id, op, args: args || {} })
      for (const waiter of [...this.waiters]) waiter()
    })
  }

  pairing() {
    const port = this.port || this.config.port
    const out = []
    for (const item of lanAddresses()) {
      out.push(pairStringTo(item.address, port, this.config.token))
    }
    for (const peer of this.config.peers || []) {
      if (peer?.host && peer?.port && peer?.token) {
        const item = pairStringTo(peer.host, peer.port, peer.token)
        if (!out.includes(item)) out.push(item)
      }
    }
    return out
  }

  // What the QR code contains: opening it in a phone browser runs the pair
  // handshake against that phone's own setup page (see src/pair.mjs).
  workbenchUrl() {
    const base = this.pairBase()
    return base ? `${base}/workbench?t=${this.config.token}` : ''
  }

  pairBase() {
    const port = this.port || this.config.port
    const [first] = lanAddresses()
    return `http://${first?.address || '127.0.0.1'}:${port}`
  }

  pairUrl() {
    const port = this.port || this.config.port
    const [first] = lanAddresses()
    const host = first?.address || '127.0.0.1'
    return `http://${host}:${port}/pair?t=${this.config.token}`
  }

  status() {
    return {
      online: this.online,
      device: this.device,
      port: this.port,
      name: this.config.name,
      pairing: this.pairing(),
      peers: this.config.peers || [],
      auth: this.auth.k,
      configFile: desktopConfigPath(),
    }
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function sendJson(res, code, value) {
  const text = JSON.stringify(value)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function formatThread(data, { sinceSeq = 0 } = {}) {
  const rows = (data.messages || []).filter((row) => row.seq >= sinceSeq || sinceSeq === 0)
  if (!rows.length) return '（没有新消息）'
  const lines = rows.map((row) => {
    const to = row.to && row.to !== 'all' ? ` → ${nameOf(row.to)}` : ''
    // 带发送时间：两个人（模型）对账时，谁先谁后、隔了多久，一眼就看得出来。
    const when = row.at ? `${clockOf(row.at)} ` : ''
    return `${row.seq}. ${when}${nameOf(row.from)}${to}：${truncate(row.text, 2000)}`
  })
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// MCP tools for the desktop model
// ---------------------------------------------------------------------------
export function desktopTools(bridge) {
  return [
    {
      name: 'peer_info',
      description:
        '查看手机端（dsh-go 所在设备）是否在线、设备信息；未连接时返回配对串，把配对串发到手机对话里让对方执行 bridge_pair 即可。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'bridge_setup',
      description:
        '打开图形化配置页（浏览器地址）：查看手机/电脑连接状态、配对串、自动发现、权限开关。用户问「怎么配」「在哪设置」时给出这个地址即可。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'agent_list',
      description: '列出工作台上可以对话的 agent：电脑模型、手机模型，以及双方启动的子智能体，带 id 和是否在跑。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'agent_send',
      description:
        '给指定 agent 发消息（不执行任务）：to 写 agent_list 里的 id，省略/写 all 就是广播给所有人。适合找子智能体、给某个 agent 留言。level 标重要性，对方唤醒语里会带对应符号。',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '目标 agent id，例如 phone、review-1；省略=广播' },
          text: { type: 'string', description: '要说的内容' },
          level: {
            type: 'string',
            description:
              '重要性：urgent(❗等你回) / question(❓要你决定) / alert(⚠️出问题) / done(✅做完了) / report(📋进度汇报不用回)；不写=普通',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'agent_converse',
      description:
        '给指定 agent 发一句并等它回话（最多 waitSeconds 秒，默认 120）。对方是子智能体时它会自己动手并回报；没有回话就返回已有消息，不假装成功。',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '目标 agent id；省略=发给手机模型' },
          text: { type: 'string', description: '要说的话' },
          waitSeconds: { type: 'number', description: '最多等多少秒，5–600，默认 120' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'agent_read',
      description: '读工作台对话（广播 + 发给你的 + 你说的），可选只看某段之后的新消息。',
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
      description:
        '像子智能体一样加一个自己干活的 agent：给它名字和任务，它会独立运行（可用同一套工作台工具），完成后把结果发回来。host=desktop 在本机跑，host=phone 在手机上跑。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '名字，例如 构建手、审查员' },
          task: { type: 'string', description: '要它做的事，写清楚验收标准' },
          host: { type: 'string', enum: ['desktop', 'phone'], description: '在哪台机器上跑，默认 desktop' },
        },
        required: ['task'],
        additionalProperties: false,
      },
    },
    {
      name: 'agent_stop',
      description: '停掉一个子智能体（内建的两个模型不能这样停）。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'agent id' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'session_list',
      description:
        '列出电脑上用过互联工具的会话：id 前 8 位、名字、用途、项目、调用次数、最近活跃。想知道「该唤醒哪个会话」时先看这里。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'session_note',
      description:
        '给一个会话写清它是干什么的（用途/项目/名字），之后唤醒可以按用途选。target 省略或写 current = 正在调用你的这个会话。',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '会话 id、id 前几位、名字，或 current（默认）' },
          name: { type: 'string', description: '给会话起个短名字，比如「登录页」' },
          purpose: { type: 'string', description: '这个会话在做什么，一两句' },
          project: { type: 'string', description: '项目名，可选' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'peer_say',
      description:
        '给对端模型发一句话，并立刻唤醒它一次（不执行任务，只是说话）：对方那边的收件器会在几秒内把这条投进它开着的会话。默认发给对端模型本人；要发给某个具体会话就写 phone:<会话名> / desktop:<会话名>。level 标重要性，对方的唤醒语里会带上对应符号（❗❓⚠️✅📋）。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要对对方模型说的话' },
          to: { type: 'string', description: '收件人：省略=对端模型；也可写 phone / phone:<会话名> / desktop / desktop:<会话名>' },
          level: {
            type: 'string',
            description:
              '这条有多要紧：urgent(❗等你回) / question(❓要你决定) / alert(⚠️出问题) / done(✅做完了) / report(📋进度汇报不用回)；不写=普通',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'peer_converse',
      description:
        '发一条消息给手机模型，然后等它回话（最多 waitSeconds 秒）。用来跟手机那边一轮一轮商量：你问、它答、它也可以反问。等不到回复会把消息留在工作台上，之后用 peer_read 再看。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要对手机模型说的话' },
          waitSeconds: { type: 'number', description: '最多等多少秒，默认 120，最多 600' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'peer_read',
      description: '读共享工作台上最近的对话（电脑模型和手机模型说的话都在里面）。配合 peer_say / peer_converse 使用。',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'number', description: '从哪一条之后开始读，默认 0（从头）' },
          limit: { type: 'number', description: '最多几条，默认 40' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'phone_tools',
      description: '列出手机端可用的操控工具（截图、点按、打开应用、查询应用列表等）及其参数说明。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'phone_tool',
      description:
        '在手机上执行一个操控工具。常用 name：screen（读屏幕，image:true 可请求截图）、tap（点元素，需 screen 屏号+元素号）、tap_xy（按坐标点）、type（输入文字）、key（back/home/recents/notifications）、open（开应用或链接）、apps（列应用）、scroll、intent（闹钟/日程/导航等）、notify、clipboard、collect（长列表自动收集）、handoff（交给用户操作）。先用 phone_tools 查看当前可用的工具与参数。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '手机工具名，如 screen' },
          arguments: { type: 'object', description: '该工具的参数，如 {"image":true}' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    {
      name: 'peer_run',
      description: '在手机的 Linux 环境里执行一条 shell 命令（bash -lc），返回 stdout/stderr/退出码。适合跑测试、看日志、装依赖。',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          cwd: { type: 'string', description: '工作目录，默认 /root/workspace' },
          timeoutMs: { type: 'number', description: '超时毫秒，默认 120000' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    {
      name: 'peer_put',
      description: '把桌面上的一个文件推到手机（适合把网页、APK、脚本送过去测试）。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '桌面本地文件路径' },
          destPath: { type: 'string', description: '手机目标路径，默认 /sdcard/Download/DSH-Go/<文件名>' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'peer_get',
      description: '把手机上的文件取回桌面（截图、日志、测试产物）。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '手机上的文件路径' },
          destPath: { type: 'string', description: '桌面保存路径，默认当前目录下同名文件' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'phone_send_dir',
      description:
        '把桌面上的整个项目目录打包推到手机（自动跳过 node_modules/.git/build 等），适合把网页源码送过去构建、起服务、测试。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '桌面目录路径' },
          destPath: { type: 'string', description: '手机目标目录，默认 /sdcard/Download/DSH-Go/<目录名>' },
          exclude: { type: 'array', items: { type: 'string' }, description: '额外排除的相对路径' },
          maxFiles: { type: 'number', description: '最多发送多少个文件，默认 400' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'phone_build_apk',
      description:
        '让手机自己构建 APK（在手机 Linux 环境里执行构建命令，如 gradle assembleDebug / ./gradlew assembleDebug），构建完自动把 .apk 取回桌面。适合电脑上没有 Android SDK 时。',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '在手机上执行的构建命令' },
          cwd: { type: 'string', description: '手机上的项目目录' },
          destPath: { type: 'string', description: 'APK 在桌面的保存路径，默认当前目录下同名文件' },
          timeoutMinutes: { type: 'number', description: '最多等几分钟，默认 20' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    {
      name: 'phone_install',
      description:
        '把 APK 装到手机上：可先传本地文件（path），也可以给手机上的路径（remotePath），然后自动打开系统安装器并点过确认。遇到「未知来源」授权或密码框时会如实告诉你需要手动处理。装完可用 packageName 核对是否装好。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '桌面上的 APK 路径（可选，给了就自动传到手机）' },
          remotePath: { type: 'string', description: '手机上已有的 APK 路径（可选）' },
          packageName: { type: 'string', description: '装完要核对的包名（可选）' },
          auto: { type: 'boolean', description: '是否自动点确认，默认 true；false 只打开安装器' },
          destPath: { type: 'string', description: 'APK 传到手机的路径，默认 /sdcard/Download/DSH-Go/<文件名>' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'phone_test',
      description:
        '一个工具完成「手机模型自测」：把目标、网页地址或 APK 路径交给手机模型，它自己开 App/浏览器、看截图、点按、跑命令，最后交回测试报告和截图（自动取回桌面）。写代码改一遍后直接再调一次即可形成自动循环。传 session 名（如「登录页」）可让同一项目的多次测试接在同一个手机会话里。',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: '测试目标，例如「打开首页，点登录，用错误密码，应提示错误且不崩溃」' },
          app: { type: 'string', description: '要测的应用：包名或应用名（可选）' },
          apkPath: { type: 'string', description: '要测的 APK 在手机上的路径（可选）' },
          url: { type: 'string', description: '要测的网页地址（可选）' },
          instructions: { type: 'string', description: '额外要求，例如「至少截 3 张图」' },
          session: { type: 'string', description: '项目会话名，同名共用同一个手机会话，默认 default' },
          sessionId: { type: 'string', description: '直接指定会话 id（可选）' },
          artifactsDir: { type: 'string', description: '截图在桌面的保存目录，默认 ./phone-artifacts' },
          timeoutMinutes: { type: 'number', description: '最多等几分钟，默认 20' },
        },
        required: ['goal'],
        additionalProperties: false,
      },
    },
    {
      name: 'phone_shell_target',
      description:
        '在指定的一台对端机器上执行 shell（对方也是 dsh-phone-bridge 时就让它自己跑，否则经长轮询交给手机）。host 写 host:port；对端列表见 peer_info。',
      inputSchema: {
        type: 'object',
        properties: {
          host: { type: 'string', description: '对端地址 host:port，例如 10.78.244.169:9000' },
          command: { type: 'string', description: '要执行的命令' },
          cwd: { type: 'string', description: '工作目录' },
          timeoutMs: { type: 'number', description: '超时毫秒，默认 120000' },
        },
        required: ['host', 'command'],
        additionalProperties: false,
      },
    },
    {
      name: 'bridge_log',
      description: '查看后台桥接服务的最近日志（手机连接、任务、错误都在这里）。',
      inputSchema: {
        type: 'object',
        properties: { lines: { type: 'number', description: '最多多少行，默认 60' } },
        additionalProperties: false,
      },
    },
    {
      name: 'bridge_start',
      description: '确保后台桥接服务在运行（不依赖当前对话），返回配对串与监听端口。手机还没连上、或换了一台电脑时先调它。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'phone_ask',
      description:
        '把一段任务交给手机上的模型（它有自己的手机操控、shell 能力）去执行，返回它的最终答复。同一个项目反复派活用 session 名字（如 session:"登录页"），它会自动续着同一个手机会话，不会每次新开；不传 session 就用专用会话 default。',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '交给手机模型的任务，写清楚要做什么、成功标准' },
          cwd: { type: 'string', description: '手机上的工作目录，默认 /root/workspace' },
          session: { type: 'string', description: '项目会话名，例如「登录页」；同名共用同一个手机会话，默认 default' },
          sessionId: { type: 'string', description: '直接指定会话 id（可选，一般用 session 名字即可）' },
          timeoutMinutes: { type: 'number', description: '最多等几分钟，默认 15' },
        },
        required: ['task'],
        additionalProperties: false,
      },
    },
  ]
}

// Appended to every model-facing prompt: lets the model match the desktop's
// own view of "my machine" with the phone's (hostname/IPs/working dirs) without
// guessing.
function contextSnippet(ctx) {
  const lines = []
  const name = ctx.hostname || os.hostname()
  lines.push(`桌面机器名：${name}`)
  if (ctx.wsl) lines.push('提示：桌面 DSH 运行在 WSL 里，目标程序的端口在 Windows 上要用 localhost 访问。')
  if (ctx.clientUrl) lines.push(`桌面端直接可执行接口：${ctx.clientUrl}（对端是 dsh-phone-bridge 时用 phone_shell_target 让对端直接跑）`)
  else lines.push('桌面端直接可执行接口：不可用（对端只能经长轮询执行）')
  return lines.join('\n')
}

export async function runDesktopMcp() {
  const config = loadDesktopConfig()
  const bridge = new DesktopBridge(config)
  // Permission switches are written to desktop.json by the browser setup page
  // and by the Plugins card while this process runs, so read the file when it
  // changes instead of trusting the snapshot taken at startup.
  let stamp = 0
  try {
    stamp = statSync(desktopConfigPath()).mtimeMs
  } catch {}
  const cfg = () => {
    try {
      const next = statSync(desktopConfigPath()).mtimeMs
      if (next !== stamp) {
        stamp = next
        const fresh = readJson(desktopConfigPath(), null)
        if (fresh && fresh.token) Object.assign(config, fresh)
      }
    } catch {}
    return config
  }
  const port = await bridge.start()
  writeLock({ pid: process.pid, port, log: desktopLogPath(), foreground: true })
  const dropLock = () => removeLock()
  process.on('exit', dropLock)
  process.on('SIGTERM', dropLock)
  process.on('SIGINT', dropLock)
  ensureDir(bridgeDir())
  log(`桌面端桥接已监听 ${config.host}:${port}`)
  const pairs = bridge.pairing()
  if (pairs.length) log(`配对串（发到手机对话）：${pairs.join('  ')}`)
  else log('没有检测到局域网 IPv4；手机与电脑需在同一网络，或改用隧道地址')
  // Local graphical setup page (127.0.0.1 only): status, pairing string,
  // permission toggles and LAN discovery without editing any file by hand.
  const setupPort = Number(process.env.PHONE_BRIDGE_SETUP_PORT || config.setupPort || 8789)
  const setupUrl = `http://127.0.0.1:${setupPort}/`
  const setupServer = startSetup({
    role: 'desktop',
    port: setupPort,
    host: '127.0.0.1',
    state: async () => {
      const s = bridge.status()
      const rows = [
        { label: '角色', value: '电脑端（桌面 DSH）' },
        { label: '手机', value: s.online ? `在线 · ${s.device?.name || '手机'}` : s.device ? `记住过 ${s.device.name}，当前离线` : '还没连过', tone: s.online ? 'ok' : 'bad' },
        { label: '监听', value: `${config.host}:${config.port}` },
      ]
      for (const pair of (s.pairing || []).slice(0, 2)) rows.push({ label: '配对串', value: pair, mono: true })
      rows.push({ label: '配对窗口', value: bridge.permitLeft > 0 ? `打开中，还剩 ${Math.round(bridge.permitLeft / 1000)} 秒` : '没打开', tone: bridge.permitLeft > 0 ? 'ok' : '' })
      const agentList = listAgents('desktop')
      rows.push({ label: 'Agent', value: `${agentList.length} 个：${agentList.map((item) => `${item.name}${item.host === 'phone' ? '（手机）' : ''}`).join('、')}` })
      if (bridge.codeLeft > 0) rows.push({ label: '配对码', value: bridge.code?.value || '', mono: true })
      const bench = threadRead(0, 6).messages
      return {
        title: '手机桥接 · 电脑端',
        subtitle: '手机和电脑在同一网络时，这里会自动显示在线；不在线就把配对串发到手机对话里。',
        rows,
        toggles: [
          { key: 'allowShell', label: '允许手机在电脑上执行命令', value: config.allowShell !== false },
          { key: 'allowAsk', label: '允许手机调用电脑上的模型', value: config.allowAsk !== false },
          { key: 'allowFiles', label: '允许两边互传文件', value: config.allowFiles !== false },
          { key: 'allowTest', label: '允许手机自动跑测试', value: config.allowTest !== false },
        ],
        fields: [{ key: 'say', label: '对手机模型说一句', placeholder: '写在这儿，点「发到工作台」' }],
        link: bridge.workbenchUrl() ? { href: bridge.workbenchUrl(), label: '打开「两个模型的对话」（完整记录，自动刷新）' } : null,
        log: bench.length ? bench.map((row) => `${row.seq}. ${row.from === 'desktop' ? '电脑模型' : '手机模型'}：${row.text}`) : [],
        buttons: [
          { id: 'permit', label: '允许新手机配对（2 分钟）', primary: true },
          { id: 'code', label: '生成 6 位配对码' },
          { id: 'say', label: '发到工作台' },
          { id: 'thread', label: '看工作台对话' },
          { id: 'agent.list', label: '看有哪些 agent' },
          { id: 'scan', label: '扫描局域网里的手机' },
          { id: 'token', label: '换一个新的配对串' },
          { id: 'log', label: '看最近日志' },
        ],
        note: `共享工作台共 ${threadRead(0, 1).total} 条消息。改动会立即保存到 desktop.json，不用重启。`,
      }
    },
    action: async (id, fields) => {
      try { return await desktopSetupAction(id, fields) } catch (error) { return { text: `操作失败：${error?.message || error}` } }
    },
  })
  async function desktopSetupAction(id, fields) {
      if (id === 'permit') {
        bridge.openPairWindow(120_000)
        return { text: '已打开 2 分钟配对窗口：手机点「找附近的电脑」就能连上，不用扫二维码。' }
      }
      if (id === 'code') {
        const issued = bridge.issueCode(120_000)
        return { text: `配对码：${issued.code}（2 分钟内有效）。在手机的「手机桥接」面板输入，或直接对手机模型说这个码。` }
      }
      if (id === 'say') {
        if (!fields.say) return { text: '先写一句话' }
        const row = threadAppend('desktop', fields.say)
        return { text: `已放到工作台上（第 ${row.seq} 条）` }
      }
      if (id === 'agent.list') {
        return { text: bridge.agentLines().join('\n') }
      }
      if (id === 'agent.spawn') {
        if (!fields.task) return { text: '先写任务：这个子智能体要做什么' }
        const record = await bridge.spawnAgent({ name: fields.name, task: fields.task, host: fields.host || 'desktop' })
        return { text: `已启动 ${record.name}（${record.id}，${record.host}）` }
      }
      if (id === 'thread') {
        const data = threadRead(0, 20)
        if (!data.messages.length) return { text: '工作台上还没有对话' }
        return { text: data.messages.map((row) => `${row.seq}. ${row.from === 'desktop' ? '电脑' : '手机'}：${row.text}`).join('\n') }
      }
      if (id === 'scan') {
        const found = await scanLan([config.port, 9000], { timeoutMs: 500 })
        return { text: found.length ? found.map((f) => `${f.host}:${f.port} ${f.name || ''}`.trim()).join('\n') : '没扫到；确认手机和电脑在同一 Wi-Fi，或直接用配对串。' }
      }
      if (id === 'token') {
        config.token = randomToken()
        writeJson(desktopConfigPath(), config)
        return { text: `已生成新配对串；手机若还连得上会继续用设备密钥自动重连。\n${bridge.pairing().join('\n')}` }
      }
      if (id === 'log') {
        return { text: readLogTail(desktopLogPath(), 40).join('\n') || '还没有日志' }
      }
      if (id.startsWith('toggle:')) {
        const [, key, value] = id.split(':')
        if (key in config) {
          config[key] = value === '1'
          writeJson(desktopConfigPath(), config)
          return { text: `已${config[key] ? '开启' : '关闭'} ${key}` }
        }
      }
      return { text: `不认识的操作：${id}` }
  }
  setupServer.on('error', () => {})
  log(`配置页：${setupUrl}`)

  // The background server (if any) must not hold the "single server" claim while
  // this in-process instance is alive; the lock above still points at us for
  // logging purposes, and ensureDesktopServer() re-checks liveness.

  const ctx = { hostname: config.hostname || os.hostname(), clientUrl: process.env.PHONE_BRIDGE_CLIENT_URL || '', wsl: isWsl() }
  const handlers = {
    async session_list() {
      const rows = listSessions()
      return `${formatSessions(rows)}\n\n唤醒时把 to 写成 desktop:<名字>（例如 desktop:登录页），就会投给那个会话；不写名字只写 desktop，就投给最近用过互联的那个。`
    },
    async session_note(args) {
      const target = String(args?.target || 'current')
      const result = noteSession(target, { name: args?.name, purpose: args?.purpose, project: args?.project })
      if (!result.ok) throw new Error(result.error)
      const row = result.session
      const bits = [`${row.name || '未命名'}（${String(row.id).slice(0, 8)}）`]
      if (row.purpose) bits.push(`用途：${row.purpose}`)
      if (row.project) bits.push(`项目：${row.project}`)
      return `已记下：${bits.join(' · ')}。之后 peer_say 的 to 可以直接写 desktop:${row.name || String(row.id).slice(0, 8)}。`
    },
    async bridge_setup() {
      return `图形化配置页：${setupUrl} （在电脑浏览器打开）`
    },
    async agent_list() {
      const lines = listAgents().map((item) => {
        const bits = [item.id, item.name, item.host]
        if (item.kind === 'subagent') bits.push(item.running ? '运行中' : '已停止')
        if (item.note) bits.push(item.note)
        return bits.join(' · ')
      })
      return `${lines.join('\n')}\n\n用 agent_send / agent_converse 指定 id 对话；要加人手用 agent_spawn。`
    },
    async agent_send(args) {
      // 不给 to 就发给「对端模型」本身，而不是广播：对端收件器只认发给自己的
      // 消息（to === 'phone' / 'desktop'），广播的话它不会投递、也就不会唤醒。
      const to = String(args?.to || defaultPeerTarget())
      const row = threadAppend('desktop', args?.text, to, args?.level)
      const peer = to === 'all' ? '所有人（不会唤醒对端）' : nameOf(to)
      const mark = LEVELS[row.level]?.mark ? `${LEVELS[row.level].mark} ` : ''
      return `${mark}已发出（第 ${row.seq} 条 → ${peer}，重要性 ${LEVELS[row.level]?.label || '普通'}）。对方收件器几秒内会把它投进开着的会话并唤醒模型；要当场等回话用 agent_converse。`
    },
    async agent_converse(args) {
      const to = String(args?.to || 'phone')
      const seconds = Math.min(Math.max(Number(args?.waitSeconds || 120), 5), 600)
      // 名字打错时别让人干等两分钟：先确认这个收件人真的存在。
      const wellKnown = ['all', 'phone', 'desktop']
      const targeted = to.includes(':') || wellKnown.includes(to)
      if (!targeted && !listAgents().some((item) => item.id === to || item.name === to)) {
        throw new Error(`没有这个收件人：${to}（可写 all / phone / desktop / phone:<会话名> / desktop:<会话名>，或用 agent_list 看有哪些）`)
      }
      const row = threadAppend('desktop', args?.text, to)
      log(`等 ${nameOf(to)} 回话（最多 ${seconds}s）…`)
      const deadline = Date.now() + seconds * 1000
      while (Date.now() < deadline) {
        const remain = Math.max(Math.min(deadline - Date.now(), 25_000), 1_000)
        const result = await threadWait('desktop', row.seq, remain, 400)
        const rows = (result.messages || []).filter(
          (message) => message.from !== 'desktop' && (to === 'all' || message.from === to || message.to === 'desktop'),
        )
        if (rows.length) {
          markConsumed(rows)
          return formatThread({ messages: rows })
        }
        if (Date.now() >= deadline) break
      }
      return `已发出（第 ${row.seq} 条 → ${nameOf(to)}），${seconds} 秒内没有回话。\n\n${formatThread(threadRead(Math.max(0, row.seq - 3), 8))}`
    },
    async agent_read(args) {
      return formatThread(threadRead(Number(args?.since || 0), Number(args?.limit || 40)))
    },
    async agent_spawn(args) {
      const record = await bridge.spawnAgent({ name: args?.name, task: args?.task, host: args?.host })
      return `已启动子智能体 ${record.name}（id: ${record.id}，${record.host}）。它会自己干活，完成后把结论发到工作台；用 agent_read 看进度，agent_converse 可以直接问它。`
    },
    async agent_stop(args) {
      const result = bridge.stopAgent(String(args?.id || ''))
      return `已停掉 ${result.name}（${result.stopped}）`
    },
    async phone_say(args) {
      const row = threadAppend('desktop', args?.text)
      return `已放到工作台上（第 ${row.seq} 条）。手机模型下次运行时能看到；要立刻等它回话用 peer_converse。`
    },
    async phone_converse(args) {
      const row = threadAppend('desktop', args?.text)
      const seconds = Math.min(Math.max(Number(args?.waitSeconds || 120), 5), 600)
      log(`等待手机模型回话（最多 ${seconds}s）…`)
      const result = await threadWait('desktop', row.seq, seconds * 1000)
      if (result.timeout) {
        return `已发出（第 ${row.seq} 条），${seconds} 秒内手机没有回话。

${formatThread(threadRead(Math.max(0, row.seq - 4), 12))}`
      }
      markConsumed(result && result.messages)
      return formatThread(result, { sinceSeq: row.seq })
    },
    async phone_read(args) {
      const data = threadRead(Number(args?.since || 0), Number(args?.limit || 40))
      if (!data.messages.length) return '工作台上还没有对话。用 phone_say 或 phone_converse 先说一句。'
      return formatThread(data)
    },
    async peer_info(args) {
      let s = bridge.status()
      if (!s.online && !s.device) {
        // No phone yet: make sure the shared background server is up, because
        // that is the address the phone will keep reconnecting to.
        const server = await ensureDesktopServer().catch((error) => ({ error: error.message }))
        if (server && !server.error) {
          const health = await fetchHealth(`http://127.0.0.1:${server.port}`)
          if (health) {
            s = {
              ...s,
              background: { pid: server.pid, port: health.port, online: health.online, device: health.device },
              pairing: server.pairing?.length ? server.pairing : s.pairing,
              online: health.online,
              device: health.device,
            }
          }
        } else if (server?.error) {
          s.backgroundError = server.error
        }
      }
      if (args?.discover !== false && !s.online) {
        const auto = await autoConnect(config, bridge).catch(() => null)
        if (auto?.length) {
          await sleep(800)
          s = { ...s, autoConnect: auto }
        }
      }
      const lines = [`在线：${s.online ? '是' : '否'}`]
      if (s.device) lines.push(`设备：${s.device.name}${s.device.platform ? ` · ${s.device.platform}` : ''}${s.device.id ? ` · id ${s.device.id.slice(0, 8)}` : ''}`)
      lines.push(`桌面监听端口：${s.port}`)
      if (s.background) {
        lines.push(`后台桥接：pid ${s.background.pid} 端口 ${s.background.port}，手机${s.background.online ? '在线' : '不在线'}`)
      }
      if (s.autoConnect) lines.push(`刚才自动发现：${s.autoConnect.join('；')}`)
      if (s.backgroundError) lines.push(`后台桥接启动失败：${s.backgroundError}`)
      if (s.pairing.length) {
        lines.push('配对串（只有当手机没自动连上时才需要，发到手机对话让它执行 bridge_pair）：')
        for (const p of s.pairing.slice(0, 3)) lines.push(`  ${p}`)
      }
      if (s.configFile) lines.push(`配置文件：${s.configFile}`)
      const bench = threadRead(0, 200)
      const phoneLines = bench.messages.filter((row) => row.from === 'phone')
      if (bench.total) {
        lines.push(`共享工作台：共 ${bench.total} 条，手机模型说了 ${phoneLines.length} 条`)
        const last = phoneLines.slice(-2)
        for (const row of last) lines.push(`  · 手机模型（第 ${row.seq} 条）：${truncate(row.text, 160)}`)
        if (phoneLines.length) lines.push('  用 peer_read 看全文，peer_converse 直接回它。')
      }
      return lines.join('\n')
    },
    async phone_tools() {
      const data = await bridge.call('tools.list', {})
      const lines = [`手机端工具 ${data.tools.length} 个：`]
      for (const t of data.tools) lines.push(`- ${t.name}：${t.description || ''}`)
      return lines.join('\n')
    },
    async phone_tool(args) {
      if (!args?.name) throw new Error('缺少 name')
      const data = await bridge.call('tool', { name: args.name, arguments: args.arguments || {} })
      return { text: data.text || '（手机没有返回文本）', images: data.images || [] }
    },
    async peer_run(args) {
      if (!cfg().allowShell) throw new Error('桌面端配置禁用了「在手机上执行命令」')
      if (!args?.command) throw new Error('缺少 command')
      const data = await bridge.call('shell', {
        command: args.command,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs || 120000,
      })
      return formatShell(data)
    },
    async phone_shell_target(args) {
      if (!cfg().allowShell) throw new Error('桌面端配置禁用了「在手机上执行命令」')
      if (!args?.host) throw new Error('缺少 host')
      if (!args?.command) throw new Error('缺少 command')
      const target = resolveTarget(args.host, cfg(), bridge)
      const clientUrl = process.env.PHONE_BRIDGE_CLIENT_URL || ''
      const localBase = `http://${target.host}:${target.port}`
      const peer = await fetchHealth(localBase, 2000)
      // 指定的机器连不上时必须报错，不能悄悄退回到手机上执行——那样命令
      // 会跑在完全没被点名的设备上，输出还看着「成功」。
      if (!peer) throw new Error(`连不上那台机器：${localBase}（确认对端的 dsh-phone-bridge 在跑，host:port 没写错）`)
      const peerHasClient = peer.sshClient === true
      if (clientUrl && peerHasClient && compareEndpoint(`${target.host}:${target.port}`, clientUrl) < 0) {
        return `已在该主机上直接执行（它在自己的 DSH 里就跑着这条命令，不必走手机长轮询）。\n${await runLocalShell(args)}`
      }
      const data = await bridge.call(
        'shell',
        { command: args.command, cwd: args.cwd, timeoutMs: args.timeoutMs || 120000 },
        { timeoutMs: Math.max(60_000, Number(args.timeoutMs || 120000) + 30_000) },
      )
      // 那台机器上没跑 dsh 客户端时，命令只能落到手机上；说清楚，别让人以为
      // 是在点名的机器上执行的。
      const note = peerHasClient ? '' : `（${target.host}:${target.port} 上没跑 dsh 客户端，这条命令实际在手机上执行）\n`
      return note + formatShell(data)
    },
    async peer_put(args) {
      if (!cfg().allowFiles) throw new Error('桌面端配置禁用了文件传输')
      const source = path.resolve(args?.path || '')
      if (!args?.path || !fs.existsSync(source)) throw new Error(`桌面文件不存在：${args?.path}`)
      const stat = fs.statSync(source)
      if (!stat.isFile()) throw new Error('只能发送文件')
      if (stat.size > 16 * 1024 * 1024) throw new Error(`文件太大（${humanSize(stat.size)}），上限 16MB`)
      const data = await bridge.call(
        'file.put',
        {
          path: args.destPath || path.posix.join('/sdcard/Download/DSH-Go', path.basename(source)),
          b64: fs.readFileSync(source).toString('base64'),
        },
        { timeoutMs: 5 * 60 * 1000 },
      )
      return `已发送到手机：${data.path}（${humanSize(stat.size)}）`
    },
    async peer_get(args) {
      if (!cfg().allowFiles) throw new Error('桌面端配置禁用了文件传输')
      if (!args?.path) throw new Error('缺少手机文件路径')
      const data = await bridge.call('file.get', { path: args.path }, { timeoutMs: 5 * 60 * 1000 })
      const dest = path.resolve(args.destPath || path.basename(args.path))
      ensureDir(path.dirname(dest))
      fs.writeFileSync(dest, Buffer.from(data.b64, 'base64'))
      return `已取回：${dest}（${humanSize(data.size)}）`
    },
    async phone_send_dir(args) {
      if (!cfg().allowFiles) throw new Error('桌面端配置禁用了文件传输')
      if (!args?.path) throw new Error('缺少 path')
      const files = collectFiles(path.resolve(args.path), {
        exclude: args.exclude || defaultExcludes(),
        maxFiles: Math.min(Number(args.maxFiles) || 400, 2000),
      })
      if (!files.length) throw new Error('目录里没有可发送的文件（已跳过 node_modules/.git/build 等）')
      const dest = String(args.destPath || `/sdcard/Download/DSH-Go/${path.basename(path.resolve(args.path))}`)
      const data = await bridge.call(
        'file.put',
        { path: dest, files: files.map((f) => ({ path: `/${f.rel}`, b64: fs.readFileSync(f.abs).toString('base64') })) },
        { timeoutMs: 10 * 60 * 1000 },
      )
      const total = files.reduce((sum, f) => sum + f.size, 0)
      return `已发送 ${files.length} 个文件到手机：${data.path}（${humanSize(total)}）`
    },
    async phone_build_apk(args) {
      if (!cfg().allowShell) throw new Error('桌面端配置禁用了「在手机上执行命令」')
      if (!args?.command) throw new Error('缺少 command')
      const timeoutMs = Math.max(60_000, Number(args.timeoutMinutes || 20) * 60_000)
      const started = Date.now()
      log(`手机开始构建 APK：${args.command}`)
      const data = await bridge.call('shell', { command: args.command, cwd: args.cwd, timeoutMs }, { timeoutMs: timeoutMs + 60_000 })
      const apkPath = findApk(data.stdout || '')
      const lines = [formatShell(data)]
      if (apkPath) {
        const asFile = await bridge.call('file.get', { path: apkPath }, { timeoutMs: 5 * 60 * 1000 })
        const dest = path.resolve(args.destPath || path.basename(apkPath))
        ensureDir(path.dirname(dest))
        fs.writeFileSync(dest, Buffer.from(asFile.b64, 'base64'))
        lines.push(`\nAPK 已取回：${dest}（${humanSize(asFile.size)}）`)
        log(`APK 已取回：${dest}`)
      } else {
        lines.push('\n[输出里没有 .apk 路径；构建成功的话把 apk 路径打印出来]')
      }
      lines.push(`（用时 ${Math.round((Date.now() - started) / 1000)}s）`)
      return lines.join('\n')
    },
    async phone_install(args) {
      if (!cfg().allowFiles) throw new Error('桌面端配置禁用了文件传输')
      let remote = String(args?.remotePath || '').trim()
      let uploaded = ''
      if (args?.path) {
        const local = path.resolve(String(args.path))
        if (!fs.existsSync(local)) throw new Error(`桌面上没有这个文件：${local}`)
        const size = fs.statSync(local).size
        const dest = args.destPath || `/sdcard/Download/DSH-Go/${path.basename(local)}`
        const data = await bridge.call(
          'file.put',
          { path: dest, b64: fs.readFileSync(local).toString('base64') },
          { timeoutMs: Math.max(5 * 60 * 1000, Math.round(size / 1024) * 20) },
        )
        remote = data.path
        uploaded = `已传到手机：${remote}（${humanSize(size)}）`
        log(uploaded)
      }
      if (!remote) throw new Error('需要 path（桌面文件）或 remotePath（手机文件）之一')
      const result = await bridge.call(
        'install',
        { apkPath: remote, packageName: args?.packageName, auto: args?.auto !== false },
        { timeoutMs: 8 * 60 * 1000 },
      )
      const lines = [uploaded, ...(result.steps || []), result.note || ''].filter(Boolean)
      if (result.packageName) lines.push(`核对包名 ${result.packageName}：${result.installed ? '已安装' : '没查到'}`)
      if (result.needsUser) lines.push(`\n需要你在手机上处理一下。当前画面：\n${result.screen || '（没读到画面）'}`)
      return lines.join('\n')
    },
    async phone_test(args) {
      if (!cfg().allowTest) throw new Error('桌面端配置禁用了 phone_test')
      if (!args?.goal) throw new Error('缺少 goal')
      const prompt = buildTestPrompt(args, null)
      const timeoutMs = Math.max(1, Number(args.timeoutMinutes || 20)) * 60 * 1000
      const started = Date.now()
      const data = await bridge.call(
        'test',
        {
          goal: args.goal,
          app: args.app,
          apkPath: args.apkPath,
          url: args.url,
          instructions: args.instructions,
          prompt,
          session: args.session,
          sessionId: args.sessionId,
        },
        {
          timeoutMs: timeoutMs + 120_000,
          onProgress: (p) => log(`手机测试进度：${brief(p?.text || p)}`),
        },
      )
      const dir = path.resolve(args.artifactsDir || 'phone-artifacts')
      const lines = []
      const images = []
      if (data.artifacts?.length) {
        lines.push('截图/日志（已取回）：')
        for (const item of data.artifacts) {
          try {
            const file = await bridge.call('file.get', { path: item.path }, { timeoutMs: 60_000 })
            const dest = path.join(dir, path.basename(item.path))
            ensureDir(path.dirname(dest))
            fs.writeFileSync(dest, Buffer.from(file.b64, 'base64'))
            lines.push(`- ${dest}`)
            if (/\.(png|jpe?g|webp)$/i.test(dest)) images.push({ mimeType: 'image/png', data: file.b64 })
          } catch (error) {
            lines.push(`- ${item.path}（取回失败：${error?.message || error}）`)
          }
        }
      }
      if (data.text) lines.push(`\n${data.text}`)
      if (data.session || data.sessionId) lines.push(`\n[手机会话 ${data.session || 'default'}${data.sessionId ? ` · ${data.sessionId}` : ''}]`)
      if (data.error) lines.push(`\n[失败] ${data.error}`)
      lines.push(`\n（手机模型用时 ${Math.round((Date.now() - started) / 1000)}s）`)
      return { text: lines.join('\n'), images }
    },
    async phone_ask(args) {
      if (!cfg().allowAsk) throw new Error('桌面端配置禁用了 phone_ask')
      if (!args?.task) throw new Error('缺少 task')
      const timeoutMs = Math.max(1, Number(args.timeoutMinutes || 15)) * 60 * 1000
      const started = Date.now()
      const prompt = `${args.task}\n\n${contextSnippet(ctx)}`
      const data = await bridge.call(
        'ask',
        { prompt, cwd: args.cwd, session: args.session, sessionId: args.sessionId },
        { timeoutMs: timeoutMs + 60_000 },
      )
      const lines = []
      if (data.text) lines.push(data.text)
      if (data.session || data.sessionId) lines.push(`\n[手机会话 ${data.session || 'default'}${data.sessionId ? ` · ${data.sessionId}` : ''}]`)
      if (data.error) lines.push(`\n[失败] ${data.error}`)
      lines.push(`\n（手机模型用时 ${Math.round((Date.now() - started) / 1000)}s）`)
      return lines.join('\n')
    },
    async bridge_log(args) {
      const file = bridge.logFile || desktopLogPath()
      const lines = Math.min(Number(args?.lines) || 60, 400)
      const tail = readLogTail(file, lines)
      return tail ? `${file}\n\n${tail}` : `（还没有日志：${file}）`
    },
    async bridge_start() {
      const info = await ensureDesktopServer()
      // ensureDesktopServer 走的是 /health，那边不一定带 pairing；直接问
      // 本实例要，免得明明有 192.168.x.x 却说「没有局域网 IPv4」骗人。
      let pairs = info.pairing || []
      if (!pairs.length) {
        try {
          pairs = typeof this?.pairing === 'function' ? this.pairing() : []
        } catch {
          pairs = []
        }
      }
      return [
        `后台桥接已在运行（pid ${info.pid}，端口 ${info.port}）`,
        pairs.length ? `配对串：${pairs[0]}` : `（这台电脑没有局域网 IPv4 地址——手机和电脑要连同一个 Wi-Fi；地址见 ${desktopLogPath()}）`,
        `日志：${info.log || desktopLogPath()}`,
      ].join('\n')
    },
    async bridge_pair(args) {
      if (!args?.pair) throw new Error('缺少配对串')
      let saved = null
      for (const value of [].concat(args.pair)) {
        saved = savePeer(value)
      }
      return saved ? `已保存对端：${saved.host}:${saved.port}（之后会自动连上并记住对方设备）` : '没有可保存的配对串'
    },
  }

  // The neutral names are what both models see; the phone_* handlers below stay
  // as internal aliases so older prompts and tests keep working.
  Object.assign(handlers, {
    peer_say: handlers.agent_send,
    peer_converse: handlers.agent_converse,
    peer_read: handlers.agent_read,
    phone_say: handlers.agent_send,
    phone_converse: handlers.agent_converse,
    phone_read: handlers.agent_read,
  })
  Object.assign(handlers, {
    phone_status: handlers.peer_info,
    phone_shell: handlers.peer_run,
    phone_send_file: handlers.peer_put,
    phone_fetch_file: handlers.peer_get,
  })

  serveMcp({
    name: 'phone-bridge',
    version: '0.3.0',
    tools: desktopTools(bridge),
    call: async (name, args, caller) => {
      // The MCP client tells us which Session invoked us; that Session is the
      // natural wake target for messages arriving from the phone.
      if (caller?.sessionId) {
        writeActive(caller.sessionId, { tool: name, cwd: caller.cwd || '' })
        // 顺手登记：会话目录靠这个自动长出来，模型不用手动建
        try {
          touchSession(caller.sessionId, { cwd: caller.cwd || '', tool: name })
        } catch {
          // 登记失败不能挡住工具本身
        }
      }
      const handler = handlers[name]
      if (!handler) throw new Error(`未实现：${name}`)
      // 用户要求：会话没开互联，互联类工具就当不存在（告诉智能体去打开关）。
      // 只挡跨端工具；配置/诊断类（bridge_*、phone_bridge_*）照常可用，否则出问题时连诊断都做不了。
      if (/^(peer_|phone_|agent_|session_)/.test(name) && process.env.PHONE_BRIDGE_NO_GATE !== '1') {
        const links = readLinksFile()
        if (!links || Object.keys(links).length === 0) {
          throw new Error(
            '这个会话没开互联，互联工具现在不可用。先在这个会话顶部点「🔗 互联」（或让对端用 peer_link 开一个），开了之后这些工具立刻能用。',
          )
        }
      }
      return handler(args)
    },
    onShutdown: () => {
      bridge.stop()
      dropLock()
    },
  })
  process.on('SIGTERM', () => {
    bridge.stop()
    dropLock()
    process.exit(0)
  })
}

// 桌面子智能体需要 `dsh` 命令行（agent-run.mjs 用它跑 headless 会话）。
function dshBin() {
  // 配置里点名优先，其次环境变量，最后看 PATH。
  const configured = String(loadDesktopConfig()?.dshBin || '').trim()
  if (configured) return configured
  return process.env.DSH_BIN || 'dsh'
}

function hasDshCli() {
  const configured = String(loadDesktopConfig()?.dshBin || '').trim()
  if (configured) return fs.existsSync(configured)
  if (process.env.DSH_BIN) return true
  try {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8', timeout: 4000 })
    return probe.status === 0 && String(probe.stdout || '').trim() !== ''
  } catch {
    return false
  }
}

// 对端是谁：跑在 Android 上就是手机（对端=桌面），否则是桌面（对端=手机）。
// say 不给 to 时用它决定默认收件人 —— 只有发给「对端模型本人」的消息才会被
// 对方收件器认领并触发唤醒，广播（all）不会。
function defaultPeerTarget() {
  const android = process.platform === 'android' || fs.existsSync('/sdcard')
  return android ? 'desktop' : 'phone'
}

// Windows has no bash by default: pick a shell that exists. A missing binary
// used to kill the whole bridge process (spawn's 'error' event was unhandled),
// which showed up on the phone as ECONNRESET.
function localShellSpec(command) {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe'
    return { file: comspec, args: ['/d', '/s', '/c', command] }
  }
  return { file: process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : 'bash', args: ['-lc', command] }
}

function runLocalShell(args) {
  return new Promise((resolve) => {
    const spec = localShellSpec(String(args.command || ''))
    let child
    try {
      child = spawn(spec.file, spec.args, {
        cwd: args.cwd && fs.existsSync(args.cwd) ? args.cwd : undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve(formatShell({ stdout: '', stderr: `启动 shell 失败：${error.message}`, code: -1 }))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      resolve(formatShell({ stdout: truncate(stdout, 400_000), stderr: truncate(stderr, 100_000), ...payload }))
    }
    child.stdout?.on('data', (c) => (stdout += c))
    child.stderr?.on('data', (c) => (stderr += c))
    child.on('error', (error) => finish({ code: -1, stderr: `${stderr}启动 shell 失败：${error.message}` }))
    child.on('close', (code) => finish({ code }))
  })
}

// A model-facing test brief: what to test, how to report, where to put shots.
function buildTestPrompt(args, phone) {
  const lines = []
  lines.push('你在手机上代替用户做真机测试。用你自己的手机工具（screen/tap/type/open/key/apps/collect/handoff）和 shell 完成任务，然后给出报告。')
  lines.push('')
  lines.push(`【测试目标】${args.goal}`)
  if (args.app) lines.push(`【应用】${args.app}`)
  if (args.apkPath) lines.push(`【APK】${args.apkPath}`)
  if (args.url) lines.push(`【网页】${args.url}`)
  if (args.instructions) lines.push(`【额外要求】${args.instructions}`)
  lines.push('')
  lines.push('【做法】先明确要验证的几个点；每一步操作后读屏确认结果；遇到需要用户登录/验证码/支付时用 handoff 交给用户。')
  lines.push('【截图】关键界面用 shell 执行：mkdir -p /sdcard/Download/DSH-Go/phone-test && screencap -p /sdcard/Download/DSH-Go/phone-test/<序号>-<说明>.png')
  lines.push('【未安装的应用】先把 APK 装到手机：/sdcard/Download/DSH-Go/ 下找文件，装完打开；如果坏掉/崩溃，读 logcat：adb shell logcat 若没有 adb，用 pm/dumpsys 可用的命令有限，就记录现象。')
  lines.push('【报告格式】（最后一段，简洁）')
  lines.push('结论：通过 / 不通过')
  lines.push('检查点：')
  lines.push('- 检查点1 —— 结果 —— 证据（截图文件名）')
  lines.push('问题：无 / 逐条列出（现象、复现步骤、错误信息）')
  lines.push('建议：写代码的一方接下来该改什么')
  lines.push('截图目录：/sdcard/Download/DSH-Go/phone-test')
  return lines.join('\n')
}

function savePeer(pairString) {
  const target = parsePairUrlSafe(pairString)
  if (!target) throw new Error(`看不懂的配对串：${pairString}`)
  const config = loadDesktopConfig()
  const peers = config.peers || []
  const exists = peers.find((p) => p.host === target.host && p.port === target.port)
  if (exists) {
    exists.token = target.token
  } else {
    peers.push({ host: target.host, port: target.port, token: target.token })
  }
  config.peers = peers
  writeJson(desktopConfigPath(), config)
  return target
}

function parsePairUrlSafe(value) {
  try {
    return parsePairUrl(value)
  } catch {
    return null
  }
}

// Slice 3 lands here: describe the local endpoint of the reverse link.
export function localClientUrl() {
  return process.env.PHONE_BRIDGE_CLIENT_URL || ''
}

// If the phone can't reach us we cannot reach it either over HTTP, so the
// desktop side just reports what discovery found; answers come from the phone's
// own scan via the peer link.
async function autoConnect(config, bridge) {
  if (process.env.PHONE_BRIDGE_NO_DISCOVER === '1') return null
  const health = await fetchHealth(`http://127.0.0.1:${bridge.port || config.port}`)
  if (health?.online) return null
  const now = Number(globalThis.__phoneBridgeScanAt || 0)
  if (Date.now() - now < 60_000) return null
  globalThis.__phoneBridgeScanAt = Date.now()
  const found = await scanLan([config.port, 9000, 8787, 8788], { timeoutMs: 500 })
  const saved = []
  for (const item of found) {
    const beacon = await fetchHealth(`http://${item.host}:${item.port}`, 2000)
    if (!beacon?.ok) continue
    if (beacon.name === config.name && item.port === config.port) continue
    saved.push(`发现 ${item.name || '?'} @ ${item.host}:${item.port}`)
  }
  return saved
}

function isWsl() {
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', 'build', 'dist', '.next', '.cache', '.gradle', 'target'])

function defaultExcludes() {
  return ['.git', 'node_modules', '.venv', '__pycache__', '.idea', '.gradle', 'build/intermediates']
}

function collectFiles(root, { exclude = [], maxFiles = 400, maxBytes = 16 * 1024 * 1024 }) {
  const out = []
  let total = 0
  const stack = [root]
  const isExcluded = (rel) => exclude.some((e) => rel === e || rel.startsWith(`${e}/`) || rel.includes(`/${e}/`))
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.well-known') continue
      const abs = path.join(dir, entry.name)
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (isExcluded(rel)) continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        stack.push(abs)
        continue
      }
      if (!entry.isFile()) continue
      let stat
      try {
        stat = fs.statSync(abs)
      } catch {
        continue
      }
      if (total + stat.size > maxBytes) return out
      total += stat.size
      out.push({ abs, rel, size: stat.size })
      if (out.length >= maxFiles) return out
    }
  }
  return out
}

// The phone prints what it built; take the last .apk path it mentions.
function findApk(text) {
  const matches = String(text).match(/\/[^\s'"`]+\.apk\b/g) || []
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    if (fs.existsSync(matches[i])) return matches[i]
    if (i === matches.length - 1) return matches[i]
  }
  return ''
}

function formatShell(data) {
  const lines = []
  if (data.stdout) lines.push(data.stdout.trimEnd())
  if (data.stderr) lines.push(`[stderr]\n${data.stderr.trimEnd()}`)
  lines.push(`[exit ${data.code}]`)
  return truncate(lines.join('\n'), 20000)
}

// Discovery lives in util.mjs so the phone can scan without importing the desktop half.
export { beaconProbe, scanLan }

// Standalone (non-MCP) entry: `node bridge.mjs desktop --serve`
export async function runDesktopServer() {
  const config = loadDesktopConfig()
  const bridge = new DesktopBridge(config)
  const port = await bridge.start()
  writeLock({ pid: process.pid, port, log: desktopLogPath(), serve: true })
  const dropLock = () => removeLock()
  process.on('exit', dropLock)
  log(`桌面端桥接已监听 ${config.host}:${port}`)
  log(`日志：${desktopLogPath()}`)
  for (const p of bridge.pairing()) log(`配对串：${p}`)
  process.on('SIGTERM', () => {
    bridge.stop()
    process.exit(0)
  })
  await new Promise(() => {})
}