// Shared helpers: config paths, logging, small file utilities, LAN discovery.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function bridgeDir() {
  return process.env.PHONE_BRIDGE_DIR || path.join(dshHome(), 'phone-bridge')
}

export function desktopConfigPath() {
  return path.join(bridgeDir(), 'desktop.json')
}

export function phoneConfigPath() {
  return path.join(bridgeDir(), 'phone.json')
}

export function activePath() {
  return path.join(bridgeDir(), 'active.json')
}

/** Remember which Session last called a bridge tool — the wake target. */
export function writeActive(sessionId, extra = {}) {
  if (!sessionId) return
  try {
    writeJson(activePath(), { sessionId: String(sessionId), at: new Date().toISOString(), ...extra })
  } catch {}
}

export function readActive() {
  try {
    return JSON.parse(fs.readFileSync(activePath(), 'utf8'))
  } catch {
    return null
  }
}

export function headlessPatchPath() {
  return path.join(bridgeDir(), 'headless.patch.yml')
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
  return p
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    // 只有「文件不存在」才算没有；权限/目录/内容损坏不能静默当空文件，
    // 否则调用方会把真实配置覆盖成空的（agents.json 曾这样整份丢过）。
    if (error?.code !== 'ENOENT') log(`读取 ${path.basename(file)} 失败：${error?.message || error}`)
    return fallback
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  // 这些文件里有配对 token，权限必须是 0600（以前 0644，同机别的用户能读走）。
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    // 先落盘再 rename：只 rename 不 fsync，断电后可能留下空文件。
    try {
      fs.fsyncSync(fd)
    } catch {
      /* 某些文件系统不支持 fsync，忽略 */
    }
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

export function randomToken() {
  return crypto.randomBytes(16).toString('hex')
}

const PREFIX = '[phone-bridge]'
const LOG_MAX = 512 * 1024
let logFile = null

// When a background server runs detached, stderr goes nowhere; also append to a
// rolling JSONL-ish text log so the MCP tools can show what happened.
export function setLogFile(file) {
  logFile = file || null
  if (!logFile) return
  try {
    ensureDir(path.dirname(logFile))
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > LOG_MAX) {
      fs.copyFileSync(logFile, `${logFile}.1`)
      fs.writeFileSync(logFile, '')
    }
  } catch {
    /* ignore */
  }
}

export function log(...parts) {
  const text = parts
    // JSON.stringify 对循环引用 / BigInt 会抛；log 又经常在 catch 里被调用，
    // 一抛就让「记录失败」变成「处理失败的那段代码二次崩掉」。
    .map((p) => {
      if (typeof p === 'string') return p
      try {
        return JSON.stringify(p)
      } catch {
        return String(p)
      }
    })
    .join(' ')
  const line = `${PREFIX} ${new Date().toISOString()} ${text}`
  try {
    process.stderr.write(`${line}\n`)
  } catch {
    /* stderr gone */
  }
  if (!logFile) return
  try {
    fs.appendFileSync(logFile, `${line}\n`)
  } catch {
    /* ignore */
  }
}

export function readLogTail(file, maxLines = 60) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split('\n').filter(Boolean)
    return lines.slice(-maxLines).join('\n')
  } catch {
    return ''
  }
}

// Small deterministic key so two halves pick the same direction for the link
// (the lower side polls the higher one). Returns 0/±1 like a comparator.
export function compareEndpoint(a, b) {
  const left = String(a).toLowerCase()
  const right = String(b).toLowerCase()
  if (left === right) return 0
  return left < right ? -1 : 1
}

// Constant-time-ish comparison for pairing tokens.
export function tokenEqual(a, b) {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  if (x.length !== y.length) return false
  return crypto.timingSafeEqual(x, y)
}

// 人可读的时钟。工作台上每条消息都带 ISO 的 `at`，但模型对账时看
// `22:31:05` 比看 `2026-11-14T14:31:05.123Z` 快得多，也不会把时区算错。
export function clockOf(at, withDate = false) {
  const d = new Date(at || Date.now())
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return withDate ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}` : time
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isInside(p) {
  const target = path.resolve(p)
  return (root) => {
    const r = path.resolve(root)
    return target === r || target.startsWith(r + path.sep)
  }
}

export function withinRoots(file, roots) {
  const target = path.resolve(file)
  return roots.some((root) => {
    const r = path.resolve(root)
    return target === r || target.startsWith(r + path.sep)
  })
}

// 接口名 → 网络类型。Android 上 wlan0 是 Wi-Fi，rmnet/pdp/ccmni 是移动数据；
// 这条信息决定「能不能扫局域网」，也决定面板上怎么跟用户解释。
export function ifaceKind(name) {
  const value = String(name || '').toLowerCase()
  if (/^(wlan|wl|wifi|ap\d)/.test(value)) return 'wifi'
  if (/^(rmnet|pdp|ccmni|wwan|eth\d|enp)/.test(value)) return /^(rmnet|pdp|ccmni|wwan)/.test(value) ? 'mobile' : 'wired'
  return 'other'
}

export function lanAddresses() {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces() || {})) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) out.push({ iface: name, address: item.address, kind: ifaceKind(name) })
    }
  }
  // Wi-Fi 排前面：配对串、自动连接都该优先用同一个局域网
  return out.sort((a, b) => (a.kind === 'wifi' ? -1 : 0) - (b.kind === 'wifi' ? -1 : 0))
}

export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

export function truncate(text, max = 12000) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n…[已截断 ${s.length - max} 字符]`
}

// Compact JSON for logs/progress.
export function brief(value, max = 300) {
  let text
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// Parse a pairing string. Accepted forms:
//   dshphone://HOST:PORT/TOKEN
//   HOST:PORT/TOKEN  or  http://HOST:PORT/TOKEN
export function parsePairUrl(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('配对串为空')
  const m = raw.match(/^(?:dshphone:\/\/|https?:\/\/)?([^/:]+|\[[^\]]+\]):(\d+)\/?(.*)$/)
  if (!m) throw new Error(`看不懂的配对串：${raw}`)
  const host = m[1].replace(/^\[|\]$/g, '')
  const port = Number(m[2])
  const token = m[3].replace(/\/+$/, '')
  if (!token) throw new Error('配对串里没有 token')
  return { host, port, token, url: `http://${host}:${port}` }
}

export function pairStringTo(host, port, token) {
  return `dshphone://${host}:${port}/${token}`
}

export function resolveHost(host) {
  const value = String(host || '').trim().replace(/^\[|\]$/g, '')
  if (!value) throw new Error('地址为空')
  if (/^[\d.]+$/.test(value) || net.isIP(value)) return value
  return value
}

export function nodeMajor() {
  return Number(process.versions.node.split('.')[0])
}
// ---------------------------------------------------------------- discovery
// One-shot /beacon probe over a raw socket: the desktop answers with a tiny
// JSON body, so discovery needs no HTTP client and no auth.
export function beaconProbe(host, port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let buffer = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => {
      socket.write(`GET /beacon HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > 4096) return finish(null)
      const idx = buffer.indexOf('\r\n\r\n')
      if (idx >= 0) {
        let value = null
        try {
          value = JSON.parse(buffer.slice(idx + 4).trim())
        } catch {
          value = null
        }
        finish(value?.v && value?.ok ? value : null)
      }
    })
    socket.on('timeout', () => finish(null))
    socket.on('error', () => finish(null))
    socket.on('close', () => finish(null))
    socket.connect(port, host)
  })
}

// Scans the local /24s (or an explicit host list) for /beacon answers.
export async function scanLan(ports, { timeoutMs = 400, concurrency = 24, onFound, hosts = null } = {}) {
  const targets = []
  const seen = new Set()
  if (Array.isArray(hosts) && hosts.length) {
    for (const host of hosts) {
      for (const port of ports) targets.push({ host: String(host), port: Number(port) })
    }
  } else {
    for (const item of lanAddresses()) {
      const prefix = item.address.split('.').slice(0, 3).join('.')
      if (!/^\d+\.\d+\.\d+$/.test(prefix)) continue
      for (let host = 1; host <= 254; host += 1) {
        for (const port of ports) {
          const key = `${prefix}.${host}:${port}`
          if (seen.has(key)) continue
          seen.add(key)
          targets.push({ host: `${prefix}.${host}`, port })
        }
      }
    }
  }
  const found = []
  let index = 0
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (index < targets.length) {
      const target = targets[index]
      index += 1
      const beacon = await beaconProbe(target.host, target.port, timeoutMs)
      if (index % 8 === 0) await sleep(20)
      if (beacon) {
        const row = { ...target, ...beacon }
        found.push(row)
        try {
          onFound?.(row)
        } catch {
          /* ignore listener errors */
        }
      }
    }
  })
  await Promise.all(workers)
  return found
}
