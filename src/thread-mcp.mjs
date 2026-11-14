// Stdio MCP server that gives a headless model the workbench: it can see who
// else is around (agent_list), message a particular agent (agent_send), wait for
// an answer (agent_converse) and read history (agent_read).
//
// Two modes:
//   --mode direct  the workbench file lives on this machine (desktop subagents)
//   --mode http    forward to the local setup server, which owns the link to the
//                  computer (phone subagents)
import { serveMcp } from './mcp.mjs'

function flag(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback
}

const AGENT = flag('agent', 'phone')
const NAME = flag('name', AGENT)
const MODE = flag('mode', 'http') === 'direct' ? 'direct' : 'http'
const SETUP = flag('setup', `http://127.0.0.1:${process.env.PHONE_BRIDGE_SETUP_PORT || 8789}`)

async function act(id, fields = {}, timeoutMs = 620_000) {
  const res = await fetch(`${SETUP}/api/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, fields }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const data = await res.json()
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`)
  return String(data?.text || '')
}

// ---------------------------------------------------------------- direct mode
let local = null
async function localModule() {
  if (!local) {
    const thread = await import('./thread.mjs')
    const agents = await import('./agents.mjs')
    local = { thread, agents }
  }
  return local
}

function formatRows(rows) {
  if (!rows.length) return '工作台上还没有消息。'
  return rows
    .map((row) => {
      const to = row.to && row.to !== 'all' ? ` → ${row.to}` : ''
      return `${row.seq}. ${row.from}${to}：${row.text}`
    })
    .join('\n')
}

async function directList() {
  const { agents } = await localModule()
  return agents
    .listAgents()
    .map((item) => {
      const state = item.running === false ? '（已停止）' : ''
      return `${item.id} · ${item.name} · ${item.host}${state}${item.note ? ` · ${item.note}` : ''}`
    })
    .join('\n')
}

// ------------------------------------------------------------------ tool defs
const tools = [
  {
    name: 'agent_list',
    description: '列出工作台上能对话的 agent（电脑模型、手机模型、以及各自启动的子智能体），返回 id 和状态。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'agent_send',
    description: '给指定的 agent 发消息（不执行任务）。to 省略或写 all 就是广播给所有 agent。用 agent_list 查 id。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'agent id，例如 desktop、phone、review-1；省略=广播' },
        text: { type: 'string', description: '要说的内容' },
      },
      required: ['text'],
    },
  },
  {
    name: 'agent_converse',
    description: '给指定 agent 发一句并等它回话（最多 waitSeconds 秒）。对方是模型 agent 时，它会在这段时间里被唤醒处理。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'agent id；省略=广播' },
        text: { type: 'string', description: '要说的话' },
        waitSeconds: { type: 'number', description: '最多等多少秒，默认 120' },
      },
      required: ['text'],
    },
  },
  {
    name: 'agent_read',
    description: '读工作台对话（只看广播和你自己收/发的消息）。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多几条，默认 20' },
        since: { type: 'number', description: '从第几条之后开始，默认 0' },
      },
    },
  },
  {
    name: 'peer_say',
    description: '（同 agent_send，默认发给电脑模型）在共享工作台上给电脑端的模型留一句话。',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'peer_converse',
    description: '（同 agent_converse，默认发给电脑模型）发一句给电脑模型并等它回话。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, waitSeconds: { type: 'number' } },
      required: ['text'],
    },
  },
  {
    name: 'peer_read',
    description: '（同 agent_read）读共享工作台上最近的对话。',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
]

serveMcp({
  name: 'phone-thread',
  version: '1.1.0',
  tools,
  call: async (name, args) => {
    const to = String(args?.to || '').trim()
    if (name === 'agent_list') {
      if (MODE === 'direct') return await directList()
      return await act('agent.list', { as: AGENT })
    }
    if (name === 'agent_send' || name === 'peer_say') {
      const text = String(args?.text ?? '')
      if (MODE === 'direct') {
        const { thread } = await localModule()
        const row = thread.append(AGENT, text, to || 'all')
        return `已发出（第 ${row.seq} 条${to ? ` → ${to}` : '，广播'}）。`
      }
      return await act('agent.send', { as: AGENT, name: NAME, to: to || 'all', text })
    }
    if (name === 'agent_converse' || name === 'peer_converse') {
      const text = String(args?.text ?? '')
      const waitSeconds = Number(args?.waitSeconds || 120)
      if (MODE === 'direct') {
        const { thread } = await localModule()
        const row = thread.append(AGENT, text, to || 'desktop')
        const result = await thread.waitFor(AGENT, row.seq - 1, waitSeconds * 1000)
        if (result.timeout) {
          const mine = thread.read(row.seq - 1, 50, AGENT).messages.filter((item) => item.from !== AGENT)
          return mine.length
            ? formatRows(mine)
            : '已发出，但对方还没回话（它可能正在忙，稍后用 agent_read 看有没有新消息）。'
        }
        return formatRows(result.messages.filter((item) => item.from !== AGENT))
      }
      return await act('agent.converse', { as: AGENT, name: NAME, to: to || 'desktop', text, waitSeconds })
    }
    if (name === 'agent_read' || name === 'peer_read') {
      if (MODE === 'direct') {
        const { thread } = await localModule()
        const rows = thread.read(Number(args?.since || 0), Number(args?.limit || 20), AGENT).messages
        return formatRows(rows)
      }
      return await act('agent.read', { as: AGENT, name: NAME, limit: Number(args?.limit || 20), since: Number(args?.since || 0) })
    }
    throw new Error(`未知工具：${name}`)
  },
})