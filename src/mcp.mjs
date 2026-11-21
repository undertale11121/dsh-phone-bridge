// Minimal MCP (Model Context Protocol) plumbing over stdio.
//  - serveMcp(): expose tools to the DSH host that spawned this process
//  - McpChild:  speak MCP to a child process (the dsh-app phone relay)
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { log } from './util.mjs'

const PROTOCOL_VERSION = '2024-11-05'

export function serveMcp({ name, version, tools, call, onShutdown }) {
  const send = (message) => {
    try {
      process.stdout.write(`${JSON.stringify(message)}\n`)
    } catch {
      /* stdout closed */
    }
  }
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

  const rl = readline.createInterface({ input: process.stdin })
  let inFlight = 0
  let closing = false
  const maybeExit = () => {
    if (closing && inFlight === 0) {
      try {
        onShutdown?.()
      } finally {
        process.exit(0)
      }
    }
  }
  rl.on('close', () => {
    closing = true
    // Give in-flight tool calls a moment to finish, then leave.
    setTimeout(() => {
      if (inFlight === 0) maybeExit()
    }, 250)
  })

  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      log('忽略无法解析的 stdin 行')
      return
    }
    const { id, method } = msg
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: msg.params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, experimental: { 'dsh-go/phone-caller': { v: 1 } } },
        serverInfo: { name, version },
      })
      return
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
    if (method === 'ping') {
      reply(id, {})
      return
    }
    if (method === 'tools/list') {
      reply(id, { tools })
      return
    }
    if (method === 'tools/call') {
      const toolName = msg.params?.name
      const args = msg.params?.arguments || {}
      const caller = msg.params?._meta?.['dsh-go/phone-caller'] || null
      const tool = tools.find((t) => t.name === toolName)
      if (!tool) {
        reply(id, { content: [{ type: 'text', text: `未知工具：${toolName}` }], isError: true })
        return
      }
      inFlight += 1
      Promise.resolve()
        .then(() => call(toolName, args, caller))
        .then((result) => {
          reply(id, normalizeResult(result))
        })
        .catch((error) => {
          reply(id, {
            content: [{ type: 'text', text: `执行失败：${errorText(error)}` }],
            isError: true,
          })
        })
        .finally(() => {
          inFlight -= 1
          maybeExit()
        })
      return
    }
    if (id !== undefined) fail(id, -32601, `unknown method: ${method}`)
  })
}

// A tool may return: string | { text, images?, isError? } | { content: [...] }
// 错误可能不是 Error（手机那边回的是 {ok:false,error:'…'}），直接拼进模板
// 字符串会变成「执行失败：[object Object]」，模型拿不到任何线索。
export function errorText(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message) return error.message
  if (error.error) return errorText(error.error)
  try {
    const text = JSON.stringify(error)
    return text && text !== '{}' ? text : String(error)
  } catch {
    return String(error)
  }
}

export function normalizeResult(result) {
  if (typeof result === 'string') return { content: [{ type: 'text', text: result }] }
  if (result && Array.isArray(result.content)) return result
  const content = []
  if (result?.text) content.push({ type: 'text', text: String(result.text) })
  for (const image of result?.images || []) {
    content.push({ type: 'image', data: image.data, mimeType: image.mimeType || 'image/png' })
  }
  if (content.length === 0) content.push({ type: 'text', text: '（无返回内容）' })
  return result?.isError ? { content, isError: true } : { content }
}

export class McpChild {
  constructor({ command, args, env, cwd, name = 'mcp-child', onStderr, onWelcome }) {
    this.name = name
    this.command = command
    this.args = args
    this.env = env
    this.cwd = cwd
    this.child = null
    this.pending = new Map()
    this.nextId = 0
    this.ready = null
    this.stderrTail = []
    this.onStderr = onStderr
    // DSH MCP clients send the desktop half a `*_welcome` JSON-RPC request
    // carrying the live host endpoint; we answer it and keep the info.
    this.onWelcome = onWelcome
    this.context = null
  }

  start() {
    if (this.child) return this.ready
    const child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env || process.env,
      cwd: this.cwd,
    })
    this.child = child
    // spawn 失败（ENOENT/EACCES/ENOMEM）会发 'error' 事件，没有监听时 Node 直接
    // 抛未捕获异常把整个桥接进程带走。这里收尸并让等待中的请求立刻失败。
    child.on('error', (error) => {
      for (const entry of this.pending.values()) entry.reject(error)
      this.pending.clear()
      if (this.child === child) this.child = null
      this.ready = null
      log(`子进程启动失败（${this.name}）：${error?.message || error}`)
    })
    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      let msg
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }
      if (msg.method && typeof msg.method === 'string' && msg.method.endsWith('_welcome') && msg.id !== undefined) {
        const params = msg.params || {}
        this.context = {
          method: msg.method,
          transport: params.transport || null,
          agents: Array.isArray(params.agents) ? params.agents : [],
          at: Date.now(),
        }
        try {
          this.onWelcome?.(this.context)
        } catch {
          /* ignore listener errors */
        }
        try {
          this.child.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } })}\n`,
          )
        } catch {
          /* ignore */
        }
        return
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) entry.reject(new Error(msg.error.message || 'MCP error'))
        else entry.resolve(msg.result)
      }
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim()
      if (!text) return
      this.stderrTail.push(text)
      if (this.stderrTail.length > 20) this.stderrTail.shift()
      try {
        this.onStderr?.(text)
      } catch {
        /* ignore listener errors */
      }
    })
    child.on('exit', (code) => {
      for (const entry of this.pending.values()) entry.reject(new Error(`${this.name} 已退出（code ${code}）`))
      this.pending.clear()
      this.child = null
      this.ready = null
      try {
        this.onExit?.(code)
      } catch {
        /* ignore */
      }
    })
    this.ready = this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-phone-bridge', version: '0.2.0' },
    }).then(() => {
      this.notify('notifications/initialized', {})
    })
    // 初始化失败要收尸：否则每次失败都留一个孤儿 relay.cjs 占着 RELAY_CONFIG。
    this.ready.catch(() => {
      try {
        this.stop()
      } catch {
        /* ignore */
      }
    })
    return this.ready
  }

  notify(method, params) {
    if (!this.child) return
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    } catch {
      /* ignore */
    }
  }

  request(method, params, timeoutMs = 60000) {
    if (!this.child) return Promise.reject(new Error(`${this.name} 未启动`))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.name} 请求超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  async callTool(name, args, timeoutMs = 120000) {
    const result = await this.request('tools/call', { name, arguments: args || {} }, timeoutMs)
    return result
  }

  async listTools(timeoutMs = 60000) {
    const result = await this.request('tools/list', {}, timeoutMs)
    return result?.tools || []
  }

  stop() {
    try {
      this.child?.kill()
    } catch {
      /* ignore */
    }
    this.child = null
  }
}

// Convert an MCP tools/call result into { text, images }.
export function readToolResult(result) {
  const texts = []
  const images = []
  for (const item of result?.content || []) {
    if (item.type === 'text') texts.push(item.text || '')
    else if (item.type === 'image' && item.data) {
      images.push({ mimeType: item.mimeType || 'image/png', data: item.data })
    }
  }
  return { text: texts.join('\n').trim(), images, isError: Boolean(result?.isError) }
}