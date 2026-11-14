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

export function append(from, text, to = 'all') {
  const clean = String(text ?? '').trim()
  if (!clean) throw new Error('消息是空的')
  const sender = String(from || 'desktop').slice(0, 40)
  const target = String(to || 'all').slice(0, 40)
  return withLock(() => {
    const all = readAll()
    const row = {
      seq: (all[all.length - 1]?.seq || 0) + 1,
      from: sender,
      to: target,
      text: clean.slice(0, MAX_TEXT),
      at: new Date().toISOString(),
    }
    ensureDir(path.dirname(threadPath()))
    fs.appendFileSync(threadPath(), `${JSON.stringify(row)}\n`)
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