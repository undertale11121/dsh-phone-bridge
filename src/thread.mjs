// The conversation both models share. It is a plain JSONL file on the desk
// side of the link; the phone reaches it through `/thread` and keeps a cache so
// it can still show the last exchange while offline.
//
// Line shape: { seq, from, to, text, at } — from/to are agent ids: the two
// built-ins (desktop / phone) or a spawned subagent such as `review-1`. `to` is
// 'all' when the message is for everyone on the workbench.
import fs from 'node:fs'
import path from 'node:path'
import { bridgeDir, ensureDir, log, readJson, writeJson } from './util.mjs'

export const MAX_TEXT = 8000

export function threadPath() {
  return process.env.PHONE_BRIDGE_THREAD || path.join(bridgeDir(), 'thread.jsonl')
}

function lockPath() {
  return `${threadPath()}.lock`
}

// A tiny lock file keeps two DSH sessions from handing out the same seq.
function withLock(fn) {
  const file = lockPath()
  ensureDir(path.dirname(file))
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' })
      try {
        return fn()
      } finally {
        try {
          fs.rmSync(file, { force: true })
        } catch {
          /* ignore */
        }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // Break a lock left behind by a dead process after a few seconds.
      try {
        const age = Date.now() - fs.statSync(file).mtimeMs
        const pid = Number(fs.readFileSync(file, 'utf8').trim())
        if (age > 5000 && pid && !alive(pid)) fs.rmSync(file, { force: true })
      } catch {
        /* ignore */
      }
      const until = Date.now() + 15
      while (Date.now() < until) {
        /* spin briefly; the critical section is a couple of writes */
      }
    }
  }
  throw new Error('对话文件被别的进程占用，稍后再试')
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function readAll() {
  let raw = ''
  try {
    raw = fs.readFileSync(threadPath(), 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row.seq === 'number' && typeof row.text === 'string') out.push(row)
    } catch {
      /* skip a half-written line */
    }
  }
  return out.sort((a, b) => a.seq - b.seq)
}

// 两端约定的「暗号」：发消息时标一个 level，唤醒语里就会带对应符号，
// 对方一眼看出这条要不要放下手上的活。没有标就是普通消息。
export const LEVELS = {
  urgent: { mark: '❗', label: '重要，等你回' },
  question: { mark: '❓', label: '要你决定' },
  alert: { mark: '⚠️', label: '出问题了' },
  done: { mark: '✅', label: '做完了' },
  report: { mark: '📋', label: '进度汇报，不用回' },
  normal: { mark: '', label: '普通' },
}

// 一条消息里混了几种 level 时，按要紧程度取最高的那个。
export const LEVEL_ORDER = ['urgent', 'alert', 'question', 'done', 'report', 'normal']

export function normalizeLevel(value) {
  const key = String(value == null ? '' : value).trim().toLowerCase()
  if (LEVELS[key] && key !== 'normal') return key
  // 也接受直接发表情符号（模型可能懒得写英文）
  for (const [name, item] of Object.entries(LEVELS)) {
    if (item.mark && key === item.mark) return name
  }
  return 'normal'
}

// 对话文件只增不减：跑几个月就是几 MB，而且每次 read 都要整文件解析。
// 超过 MAX_ROWS 条就把最老的挪去 thread-archive-<时间>.jsonl，seq 不重置——
// 收件器靠 seq 单调推 cursor，一重置就会重投或漏投。
export const MAX_ROWS = 800
export const KEEP_ROWS = 400

// 写文件走「临时文件 + rename」：rename 在同一分区是原子的，中途断电/崩溃最多留下
// 一个 .tmp，不会出现「主文件被清空」或「归档写了一半」这种丢消息的状态。
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch {}
    throw error
  }
}

function rotate(all) {
  if (all.length <= MAX_ROWS) return all
  const cut = all.length - KEEP_ROWS
  const old = all.slice(0, cut)
  const keep = all.slice(cut)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const archive = path.join(path.dirname(threadPath()), `thread-archive-${stamp}.jsonl`)
  try {
    writeAtomic(archive, `${old.map((row) => JSON.stringify(row)).join('\n')}\n`)
    writeAtomic(threadPath(), `${keep.map((row) => JSON.stringify(row)).join('\n')}\n`)
    log(`对话文件轮转：${old.length} 条归档到 ${path.basename(archive)}，保留最近 ${keep.length} 条`)
  } catch (error) {
    log(`对话文件轮转失败（不影响收发）：${error?.message || error}`)
  }
  return keep
}

export function append(from, text, to = 'all', levelOrOptions = 'normal') {
  const clean = String(text ?? '').trim()
  if (!clean) throw new Error('消息是空的')
  // 第四参既可以是 level 字符串，也可以是一个对象。对象里能带 silent/kind：
  // silent 的行是「变更日志」——写进对话给模型下次翻，但**不唤醒**对方。
  const options = levelOrOptions && typeof levelOrOptions === 'object' ? levelOrOptions : { level: levelOrOptions }
  const sender = String(from || 'desktop').slice(0, 40)
  const target = String(to || 'all').slice(0, 40)
  return withLock(() => {
    const all = readAll()
    const row = {
      seq: (all[all.length - 1]?.seq || 0) + 1,
      from: sender,
      to: target,
      level: normalizeLevel(options.level),
      text: clean.slice(0, MAX_TEXT),
      at: new Date().toISOString(),
    }
    if (options.silent) row.silent = true
    if (options.kind) row.kind = String(options.kind).slice(0, 40)
    // 发起方身份：桌面侧拿不到 MCP caller（DSH 不传），只能让发消息的模型
    // 自己报上「我是哪个会话」。对端靠它决定投进哪个对话 / 要不要新开一个。
    if (options.desktopId) row.desktopId = String(options.desktopId).slice(0, 80)
    if (options.phoneId) row.phoneId = String(options.phoneId).slice(0, 80)
    ensureDir(path.dirname(threadPath()))
    fs.appendFileSync(threadPath(), `${JSON.stringify(row)}\n`)
    rotate(all.concat([row]))
    return row
  })
}

// `as` narrows the result to what that agent should see: broadcasts plus
// messages addressed to it (its own words included, so it can follow the flow).
export function read(since = 0, limit = 200, as = '') {
  const all = readAll()
  const viewer = String(as || '')
  const visible = viewer
    ? all.filter((row) => {
        const to = row.to || 'all'
        return to === 'all' || to === viewer || row.from === viewer
      })
    : all
  const messages = visible.filter((row) => row.seq > Number(since || 0)).slice(0, Number(limit) || 200)
  return { messages, next: messages.length ? messages[messages.length - 1].seq : Number(since || 0), total: visible.length }
}

// Waits until somebody (not this agent) writes something this agent can see,
// or the timeout expires.
export async function waitFor(from, since, timeoutMs = 90_000, step = 400) {
  const deadline = Date.now() + timeoutMs
  const viewer = String(from || '')
  for (;;) {
    const { messages, next } = read(since, 200, viewer)
    const incoming = messages.filter((row) => row.from !== viewer)
    if (incoming.length) return { messages: incoming, next: messages[messages.length - 1].seq }
    if (Date.now() >= deadline) return { messages: [], next: since, timeout: true }
    await new Promise((resolve) => setTimeout(resolve, step))
  }
}

export function reset() {
  try {
    fs.rmSync(threadPath(), { force: true })
  } catch (error) {
    log(`清空对话失败：${error?.message || error}`)
  }
}

// ---------------------------------------------------------------- phone cache
export function cachePath() {
  return process.env.PHONE_BRIDGE_THREAD_CACHE || path.join(bridgeDir(), 'thread-phone.json')
}

export function loadCache() {
  return readJson(cachePath(), { next: 0, messages: [] })
}

export function saveCache(cache) {
  writeJson(cachePath(), cache)
  return cache
}