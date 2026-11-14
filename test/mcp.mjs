// The MCP layer must advertise the dsh-go/phone-caller capability and hand the
// caller metadata (which Session invoked the tool) to the tool implementation —
// that is what lets the desktop UI wake the right Session without the user
// filling in an id.
import path from 'node:path'
import { spawn } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const code = `
import { serveMcp } from ${JSON.stringify(path.join(root, 'src', 'mcp.mjs'))}
serveMcp({
  name: 'probe',
  version: '1',
  tools: [{ name: 'who', description: 'echo caller', inputSchema: { type: 'object', properties: {} } }],
  call: async (name, args, caller) => ({ text: JSON.stringify({ name, args, caller }) }),
})
`
const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] })
const seen = []
let buffer = ''
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) seen.push(JSON.parse(line))
    index = buffer.indexOf('\n')
  }
})
function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}
const waitFor = async (id, ms = 5000) => {
  const started = Date.now()
  while (Date.now() - started < ms) {
    const hit = seen.find((row) => row.id === id)
    if (hit) return hit
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return null
}

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } })
const init = await waitFor(1)
check('initialize 成功', Boolean(init?.result), JSON.stringify(init))
const caps = init?.result?.capabilities?.experimental?.['dsh-go/phone-caller']
check('声明 dsh-go/phone-caller 能力', caps && caps.v === 1, JSON.stringify(init?.result?.capabilities))

send({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'who', arguments: { hint: 'x' }, _meta: { 'dsh-go/phone-caller': { v: 1, sessionId: 'sess-abc', runId: 'run-1', callId: 'call-1' } } },
})
const called = await waitFor(2)
const payload = JSON.parse(called?.result?.content?.[0]?.text || '{}')
check('caller 元数据传到实现', payload.caller && payload.caller.sessionId === 'sess-abc' && payload.caller.runId === 'run-1', JSON.stringify(payload))
check('arguments 原样传到实现', payload.args && payload.args.hint === 'x', JSON.stringify(payload.args))

send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'who', arguments: {} } })
const plain = await waitFor(3)
const plainPayload = JSON.parse(plain?.result?.content?.[0]?.text || '{}')
check('没有 caller 时为 null', plainPayload.caller === null, JSON.stringify(plainPayload))

child.kill()
console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)