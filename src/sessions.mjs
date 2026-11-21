// 会话目录：让两端的模型知道「哪个会话是干什么的」，唤醒时按用途选，而不是只看最后一次调用。
//
// 存在 $DSH_HOME/phone-bridge/registry.json：
//   { sessions: { [sessionId]: { id, name, purpose, project, cwd, host, at, calls } } }
//
// - touchSession()：每次模型调用互联工具时被动登记（有 MCP caller 才知道 id）
// - noteSession()：模型自己写用途（"这个会话在改登录页"）
// - resolveSession()：把 "desktop:登录页" / "desktop:3f9a2b1c" / 名字 解析成一个 sessionId
import fs from 'node:fs'
import path from 'node:path'
import { bridgeDir, ensureDir, readJson, truncate, writeJson } from './util.mjs'

const MAX_SESSIONS = 80

export function registryPath() {
  return path.join(bridgeDir(), 'registry.json')
}

export function loadRegistry() {
  const data = readJson(registryPath(), null)
  if (!data || typeof data !== 'object' || typeof data.sessions !== 'object' || !data.sessions) return { sessions: {} }
  return data
}

export function saveRegistry(data) {
  const sessions = data?.sessions || {}
  const ids = Object.keys(sessions)
  if (ids.length > MAX_SESSIONS) {
    // 只留最近活跃的，避免文件无限长
    const keep = ids
      .sort((a, b) => String(sessions[b].ast || sessions[b].at || '').localeCompare(String(sessions[a].ast || sessions[a].at || '')))
      .slice(0, MAX_SESSIONS)
    const trimmed = {}
    for (const id of keep) trimmed[id] = sessions[id]
    data = { ...data, sessions: trimmed }
  }
  ensureDir(path.dirname(registryPath()))
  writeJson(registryPath(), data)
  return data
}

function basenameOf(dir) {
  if (!dir) return ''
  const parts = String(dir).replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

// 被动登记：模型用过一次互联工具，我们就知道这个会话存在、最近在哪个目录。
export function touchSession(sessionId, extra = {}) {
  const id = String(sessionId || '').trim()
  if (!id) return null
  const data = loadRegistry()
  const now = new Date().toISOString()
  const previous = data.sessions[id] || {}
  const cwd = extra.cwd || previous.cwd || ''
  const name = previous.name || extra.name || basenameOf(cwd) || '电脑会话'
  data.sessions[id] = {
    ...previous,
    id,
    name,
    cwd,
    host: extra.host || previous.host || 'desktop',
    tool: extra.tool || previous.tool || '',
    at: previous.at || now,
    ast: now,
    calls: (previous.calls || 0) + (extra.count === false ? 0 : 1),
  }
  saveRegistry(data)
  return data.sessions[id]
}

// 模型/用户写这个会话是干什么的。target 可以是 id、名字、id 前缀，或 'current'（最近一次调用桥接的会话）。
export function noteSession(target, patch = {}) {
  const data = loadRegistry()
  const resolved = resolveSession(target, data)
  if (!resolved) return { ok: false, error: `找不到会话：${target || '(空)'}` }
  const row = data.sessions[resolved.id] || { id: resolved.id, at: new Date().toISOString() }
  if (patch.name) row.name = truncate(String(patch.name).trim(), 40)
  if (patch.purpose !== undefined) row.purpose = truncate(String(patch.purpose).trim(), 300)
  if (patch.project !== undefined) row.project = truncate(String(patch.project).trim(), 80)
  row.ast = new Date().toISOString()
  if (!row.at) row.at = row.ast
  data.sessions[resolved.id] = row
  saveRegistry(data)
  return { ok: true, session: row }
}

// 解析 "desktop:名字" / "desktop:3f9a2b1c" / "3f9a2b1c" / "名字" / "current"
export function resolveSession(target, data = loadRegistry()) {
  const sessions = data.sessions || {}
  let value = String(target || '').trim()
  if (!value) return null
  if (value === 'desktop' || value === 'current' || value === 'auto') {
    const active = readActiveId()
    // 还没在目录里也能用：模型第一次写用途时允许按 active.json 现建一条
    if (active) return sessions[active] ? { id: active, ...sessions[active] } : { id: active }
    // 没有 active 就取最近活跃的那个
    const latest = Object.values(sessions).sort((a, b) => String(b.ast || '').localeCompare(String(a.ast || '')))[0]
    return latest ? { id: latest.id, ...latest } : null
  }
  value = value.replace(/^desktop:/, '').replace(/^peer:/, '')
  // 只给前缀（"desktop:"）时剥完就是空串；空串会让下面的 includes('')/startsWith('') 恒真，
  // 于是任何一次误传都静默落到「注册表里第一个会话」上，消息直接串会话。
  if (!value) return null
  if (sessions[value]) return { id: value, ...sessions[value] }
  const lowered = value.toLowerCase()
  const rows = Object.values(sessions)
  const byName = rows.find((row) => String(row.name || '').toLowerCase() === lowered)
  if (byName) return { id: byName.id, ...byName }
  const byPurpose = rows.find((row) => String(row.purpose || '').toLowerCase().includes(lowered))
  if (byPurpose) return { id: byPurpose.id, ...byPurpose }
  const byPrefix = rows.find((row) => String(row.id).startsWith(value))
  if (byPrefix) return { id: byPrefix.id, ...byPrefix }
  return null
}

function readActiveId() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(bridgeDir(), 'active.json'), 'utf8'))
    return String(raw?.sessionId || '')
  } catch {
    return ''
  }
}

export function listSessions() {
  const sessions = Object.values(loadRegistry().sessions || {})
  // active.json 那条路早就不写了（DSH 不给插件 caller，MCP 里拿不到会话 id），
  // 所以「当前」以「唤醒钉住的那个会话」为准，再回退到历史字段。
  const pinned = readJson(path.join(bridgeDir(), 'desktop.json'), {})?.wake?.sessionId
  const active = pinned || readActiveId()
  return sessions
    .sort((a, b) => String(b.ast || b.at || '').localeCompare(String(a.ast || a.at || '')))
    .map((row) => ({
      id: row.id,
      // session-<uuid>：前 8 位正好是 "session-"，显示出来等于没显示
      short: String(row.id).replace(/^session-/, '').slice(0, 8),
      name: row.name || '',
      purpose: row.purpose || '',
      project: row.project || '',
      cwd: row.cwd || '',
      host: row.host === 'phone' ? 'phone' : 'desktop',
      calls: row.calls || 0,
      at: row.ast || row.at || '',
      active: row.id === active,
    }))
}

export function formatSessions(rows = listSessions()) {
  if (!rows.length) return '还没记住任何会话。让电脑模型随便用一次互联工具（比如 peer_info），这里就会自动登记。'
  return rows
    .map((row) => {
      const flags = [row.active ? '当前' : '', row.purpose ? '' : '没写用途'].filter(Boolean).join('，')
      // 从对面同步来的会话也在这张表里，标清在哪台机器上，否则点名会点错
      const where = row.host === 'phone' ? '手机上' : '电脑上'
      const head = `${row.short} · ${row.name || '未命名'} · ${where}${flags ? `（${flags}）` : ''}`
      const detail = [row.purpose || '', row.project ? `项目 ${row.project}` : '', row.cwd ? `目录 ${row.cwd}` : '']
        .filter(Boolean)
        .join('；')
      const meta = `${row.calls} 次调用${row.at ? `，最近 ${row.at.slice(5, 16).replace('T', ' ')}` : ''}`
      return detail ? `${head}\n  ${detail}\n  ${meta}` : `${head}\n  ${meta}`
    })
    .join('\n')
}