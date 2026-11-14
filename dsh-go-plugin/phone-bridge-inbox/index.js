// 手机侧的收件器：把电脑模型发来的话，直接投进手机上的某个 DSH 会话。
//
// 桌面的 web/index.js 里有对称的另一半（installWake）：它轮询工作台，把手机
// 发来的消息投进电脑会话。这一半做反方向，所以模型之间才像人一样『直接说
// 话』——不用谁去工作台上捞。
//
// 平时它很安静：没有绑定手机会话、没有新消息时，一次 tick 只发一个 GET。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'phone-bridge-inbox'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const BRIDGE_DIR = path.join(DSH_HOME, 'phone-bridge')
const PHONE_CONFIG = path.join(BRIDGE_DIR, 'phone.json')
const STATE_PATH = path.join(BRIDGE_DIR, 'inbox-state.json')
const TICK_MS = 3000
const REPORT_MS = 30_000

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
    fs.renameSync(tmp, file)
  } catch {}
}

// 桌面桥接的两种鉴权：GET 走 ?auth=<base64url{...}>，POST 走 body.auth。
const authOf = (token) => Buffer.from(JSON.stringify({ k: 'token', token })).toString('base64url')

async function jget(base, urlPath, token, timeoutMs = 8000) {
  const res = await fetch(`${base}${urlPath}${urlPath.includes('?') ? '&' : '?'}auth=${authOf(token)}`, {
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

async function jpost(base, urlPath, token, payload, timeoutMs = 8000) {
  const res = await fetch(`${base}${urlPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auth: { k: 'token', token }, ...payload }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

// 和桌面 web/index.js 里的实现保持一致：roots 优先（只认顶层 agent），
// list() 会吐出 mnemon 这类跑在子 agent 里的会话，拿它当目标等于丢进黑洞。
function listLiveSessions(agents) {
  const rows = []
  const push = (id, item) => {
    if (!id) return
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
        if (Array.isArray(item)) push(item[0], item[1])
        else push(item?.id || item?.sessionId, item)
      }
      return
    }
    if (typeof value === 'object') for (const [id, item] of Object.entries(value)) push(id, item)
  }
  try {
    for (const key of ['roots', 'list', 'array', 'all', 'values', 'entries', 'sessions']) {
      if (typeof agents?.[key] !== 'function') continue
      try {
        feed(agents[key]())
        if (rows.length) break
      } catch {}
    }
  } catch {}
  const real = rows.filter((row) => !/^mnemon-run-/.test(row.id))
  return (real.length ? real : rows).sort((a, b) => b.at - a.at)
}

// 投递：和桌面侧 wakeSession 用同一套 agent 协议（followup 排进当前轮，steer 插话）。
function deliver(agents, sessionId, text, mode = 'queue') {
  const agent = agents?.get?.(sessionId)
  if (!agent) throw new Error(`会话 ${String(sessionId).slice(0, 8)}… 没开在这个引擎里`)
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: `phone-bridge-inbox-${randomUUID()}` },
  }
  if (mode === 'steer' && typeof agent.steer === 'function') agent.steer(message)
  else agent.followup(message)
}

// 把手机上的活会话报给电脑，面板和 peer_sessions 才能列出「手机有哪些会话」。
async function reportSessions(agents, base, token) {
  const rows = listLiveSessions(agents)
  for (const row of rows.slice(0, 12)) {
    try {
      await jpost(
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

async function tick(agents, lastReport) {
  const config = readJson(PHONE_CONFIG, null)
  if (!config?.url || !config?.token) return lastReport
  const base = String(config.url).replace(/\/+$/, '')
  const state = readJson(STATE_PATH, { cursor: 0, lastError: '' })

  let data
  try {
    data = await jget(base, `/thread?since=${Number(state.cursor) || 0}&as=phone&limit=50`, config.token)
  } catch (error) {
    const message = String(error?.message || error)
    if (message !== state.lastError) {
      state.lastError = message
      writeJson(STATE_PATH, state)
    }
    return lastReport
  }

  let collab = null
  try {
    collab = (await jget(base, '/collab', config.token, 5000))?.collab || null
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
      // 和桌面侧一样：一个会话都没开就**不动 cursor**，消息留着，别吞掉。
      state.lastError = `手机上现在没有开着的会话，${incoming.length} 条消息留在工作台`
      writeJson(STATE_PATH, state)
      return lastReport
    }
    for (const item of incoming) {
      const text = `【来自电脑模型的消息】\n${item.text}`
      try {
        deliver(agents, target.id, text, collab?.phoneSessionId === target.id ? 'queue' : 'queue')
        state.lastWake = { sessionId: target.id, preview: String(item.text).slice(0, 120), at: new Date().toISOString() }
        state.lastError = ''
        state.cursor = Number(data?.next || state.cursor)
      } catch (error) {
        state.lastError = String(error?.message || error)
        break
      }
    }
    writeJson(STATE_PATH, state)
  }

  const now = Date.now()
  if (now - (Number(lastReport) || 0) > REPORT_MS) {
    await reportSessions(agents, base, config.token)
    return now
  }
  return lastReport
}

export function apply(ctx) {
  if (typeof ctx?.inject !== 'function') return
  ctx.inject(['agents'], (scope) => {
    const agents = scope.agents
    if (!agents) return
    let stopped = false
    let lastReport = 0
    let running = false
    const loop = async () => {
      // 上一轮还没跑完就跳过，别让慢请求堆成雪球。
      if (stopped || running) return
      running = true
      try {
        lastReport = await tick(agents, lastReport)
      } catch {}
      running = false
    }
    const timer = setInterval(loop, TICK_MS)
    loop()
    const stop = () => {
      stopped = true
      clearInterval(timer)
    }
    // cordis 的清理：effect 的回调返回 dispose 函数；老版本退化到 dispose 事件。
    if (typeof scope.effect === 'function') scope.effect(() => stop, 'phone-bridge inbox tick')
    else if (typeof scope.on === 'function') scope.on('dispose', stop)
  })
}