// The cast of characters on the workbench: the two built-in models (desktop,
// phone) plus any subagents either side has spawned. One JSON file on the
// computer is the source of truth; the phone reads it through `/agents`.
import fs from 'node:fs'
import path from 'node:path'
import { bridgeDir, ensureDir, readJson, writeJson } from './util.mjs'

export const BUILTINS = [
  { id: 'desktop', name: '电脑模型', host: 'desktop', kind: 'model', note: '电脑上正在和你对话的 DSH 模型' },
  { id: 'phone', name: '手机模型', host: 'phone', kind: 'model', note: '手机上的 DSH 模型（真机截图/点按）' },
]

export function agentsPath() {
  return process.env.PHONE_BRIDGE_AGENTS || path.join(bridgeDir(), 'agents.json')
}

export function loadAgents() {
  const data = readJson(agentsPath(), { agents: [] })
  return Array.isArray(data?.agents) ? data.agents : []
}

export function saveAgents(list) {
  ensureDir(path.dirname(agentsPath()))
  writeJson(agentsPath(), { agents: list })
  return list
}

export function alive(pid) {
  const n = Number(pid)
  if (!n) return false
  try {
    process.kill(n, 0)
    return true
  } catch {
    return false
  }
}

function slug(name) {
  const base = String(name || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
  return base || 'agent'
}

export function newAgentId(name, existing = loadAgents()) {
  const taken = new Set([...BUILTINS.map((item) => item.id), ...existing.map((item) => item.id)])
  const base = slug(name)
  for (let i = 1; i < 100; i += 1) {
    const id = i === 1 ? base : `${base}-${i}`
    if (!taken.has(id)) return id
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`
}

export function addAgent(record) {
  const list = loadAgents().filter((item) => item.id !== record.id)
  list.push(record)
  saveAgents(list)
  return record
}

export function updateAgent(id, patch) {
  const list = loadAgents()
  const index = list.findIndex((item) => item.id === id)
  if (index < 0) return null
  list[index] = { ...list[index], ...patch }
  saveAgents(list)
  return list[index]
}

export function removeAgent(id) {
  const list = loadAgents()
  const next = list.filter((item) => item.id !== id)
  saveAgents(next)
  return list.length !== next.length
}

// Built-ins first, then subagents; running ones say so, dead ones are kept for
// history but flagged.
export function listAgents(host = '') {
  const custom = loadAgents().map((item) => ({
    ...item,
    // A pid only means something on the machine that started the agent.
    running: item.kind === 'subagent' ? (host && item.host === host ? alive(item.pid) : undefined) : undefined,
  }))
  return [...BUILTINS.map((item) => ({ ...item, running: true })), ...custom]
}

export function findAgent(id) {
  return listAgents().find((item) => item.id === id) || null
}

export function nameOf(id) {
  const agent = findAgent(String(id || ''))
  return agent ? agent.name : String(id || '')
}