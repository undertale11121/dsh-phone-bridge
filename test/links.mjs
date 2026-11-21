// 「每个会话一一对应」的验收：消息只能落到它明确对应的会话（点名 / desktopId / pinned），
// 没有依据时**一条都不投**，但游标必须跨过去——否则每 3 秒重投同一条，用户看到的就是刷屏。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = path.join(HERE, 'home-links')
const BRIDGE = path.join(HOME, 'phone-bridge')

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`PASS ${name}${detail ? ` · ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`FAIL ${name}${detail ? ` · ${detail}` : ''}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(BRIDGE, { recursive: true })
process.env.DSH_HOME = HOME
process.env.PHONE_BRIDGE_ROLE = 'desktop'
process.env.PHONE_BRIDGE_NO_AUTOPATCH = '1'

const { apply, recentLink, isNotice, composeBatch, matchSession, wakeSession } = await import('../web/index.js')

const PORT = 8897
const config = {
  token: 'links-token',
  port: PORT,
  exactPort: true,
  wake: { enabled: true, mode: 'queue' },
  // 开关只是「这个会话配过对」的记录；新语义下它不再是不点名消息的默认去处。
  links: { 'session-a': { phoneId: 'p1', at: new Date().toISOString() } },
}
const configFile = path.join(BRIDGE, 'desktop.json')
fs.writeFileSync(configFile, JSON.stringify(config, null, 2))

// wakeTick 通过 HTTP 从桥接服务读工作台，所以测试里真起一个桌面端（不连手机）。
const server = spawn(process.execPath, [path.join(HERE, '..', 'bridge.mjs'), 'desktop', '--serve'], {
  env: { ...process.env, DSH_HOME: HOME, PHONE_BRIDGE_LOG: path.join(BRIDGE, 'bridge.log') },
  stdio: 'ignore',
})
let up = false
for (let i = 0; i < 50; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`)
    if (r.ok) {
      up = true
      break
    }
  } catch {}
  await sleep(200)
}
check('测试用的桌面桥接起得来', up, `port ${PORT}`)

// extra 用来把 desktopId 塞进 POST body —— 这是新语义里「这条消息属于哪个电脑会话」的依据。
async function say(text, to = 'desktop', from = 'phone', extra = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}/thread`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, to, text, ...extra, auth: { k: 'token', token: 'links-token' } }),
  })
  const data = await res.json()
  return Number(data.seq || 0)
}

const calls = []
function agent(id, at) {
  return {
    id,
    status: 'idle',
    at,
    session: { header: { cwd: `/tmp/${id}` } },
    followup(message) {
      calls.push({ id, text: JSON.stringify(message) })
      return { ok: true }
    },
  }
}
const agents = {
  roots: () => [agent('session-a', Date.now()), agent('session-b', Date.now() - 5000)],
  get: (id) => (id === 'session-a' || id === 'session-b' ? agent(id) : undefined),
}

// 历史三条：首次启动只对齐 cursor，不投
await say('历史 1')
await say('历史 2')
await say('历史 3')

const ctx = { inject: (names, cb) => cb({ agents }) }
apply(ctx)
await sleep(3800)

const stateFile = path.join(BRIDGE, 'wake-state.json')
const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const stateAfterAlign = readState()
check('首次启动只对齐游标不投历史', calls.length === 0 && Number(stateAfterAlign.cursor) === 3, `cursor=${stateAfterAlign.cursor}`)

// 1. 不点名、也没有 pinned（collab.desktopSessionId / wake-state 的 sessionId）：
//    没有「一一对应」的依据，一条都不能投；但游标必须跨过去，避免每 3 秒重投。
//    注意此时 links 里还开着 session-a —— 新语义下开关本身不再是兜底去处。
const s4 = await say('不点名-没有配对-不该投')
await sleep(3600)
const stateIdle = readState()
check(
  '不点名且没有 pinned 时不投、游标前进',
  calls.length === 0 && Number(stateIdle.cursor) >= s4,
  `calls=${calls.length} cursor=${stateIdle.cursor} 最后一条=${s4}`,
)

// 2. 点名 desktop:session-b：点名压过一切，投给 session-b 且正文带原文。
const s5 = await say('点名-应该给 b', 'desktop:session-b')
await sleep(3600)
check(
  '点名 desktop:session-b 投给 session-b 且正文带原文',
  calls.length === 1 && calls[0].id === 'session-b' && calls[0].text.includes('点名-应该给 b'),
  `落到 ${calls[0]?.id || '无'}`,
)

// 3. body 里带 desktopId：这是真正能一对一的依据，投给对应会话并带原文。
const s6 = await say('带 desktopId-应该给 a', 'desktop', 'phone', { desktopId: 'session-a' })
await sleep(3600)
check(
  '带 desktopId 的消息投给对应会话且正文带原文',
  calls.length === 2 && calls[1].id === 'session-a' && calls[1].text.includes('带 desktopId-应该给 a'),
  `落到 ${calls[1]?.id || '无'}`,
)

const stateNow = readState()
check('投递后游标前进到最新', Number(stateNow.cursor) >= s6, `cursor=${stateNow.cursor} 最后一条=${s6}`)

// 4. 关掉所有 link 且不点名：不投，但游标照样前进（不能每 3 秒重投）。
config.links = {}
fs.writeFileSync(configFile, JSON.stringify(config, null, 2))
const beforeClosed = calls.length
const s7 = await say('全关-不点名-不该投')
await sleep(3600)
const stateClosed = readState()
check(
  '关掉所有 link 且不点名时不投、游标仍前进',
  calls.length === beforeClosed && Number(stateClosed.cursor) >= s7,
  `calls=${calls.length} cursor=${stateClosed.cursor} 最后一条=${s7}`,
)

// 5. 纯函数：recentLink 取最近打开的那条
const two = { links: { a: { phoneId: 'p', at: '2026-11-14T10:00:00Z' }, b: { phoneId: 'q', at: '2026-11-14T12:00:00Z' } } }
check('recentLink 取最近打开的一条', recentLink(two)?.desktopId === 'b')
check('没有开关时 recentLink 返回 null', recentLink({ links: {} }) === null)
check('点名的 session-b 能被 matchSession 认出来', matchSession([{ id: 'session-b', name: '副标题' }], 'session-b')?.id === 'session-b')

// 6. 通知类不投进会话
check('「手机已连上电脑」被识别为通知', isNotice('（手机已连上电脑）') === true)
check('普通对话不算通知', isNotice('帮我看下这个布局') === false)

// 7. 一个活会话都没了：不能投，也**不能推游标**——推了这条消息就永久丢了。
//    把轮询器拿到的 agents 改成空，模拟用户把会话全关了（同一个对象引用，作用域里立刻生效）。
agents.roots = () => []
agents.get = () => undefined
const beforeDead = readState().cursor
const beforeDeadCalls = calls.length
const s8 = await say('没人开着-要留痕')
await sleep(3600)
const afterDead = readState()
check(
  '没有活会话时不投、游标不前进',
  calls.length === beforeDeadCalls && Number(afterDead.cursor) === Number(beforeDead),
  `cursor=${afterDead.cursor} before=${beforeDead} 最后一条=${s8}`,
)

// 8. 投给不存在的会话要报错，而不是静默吞掉。
const deadAgents = { roots: () => [], get: () => undefined }
try {
  await wakeSession(deadAgents, 'session-zzz', 'x')
  check('投给不存在的会话会报错', false)
} catch (error) {
  check('投给不存在的会话会报错', /没开在引擎里/.test(String(error?.message || error)))
}

server.kill()
console.log(`\n${passed}/${passed + failed} 通过`)
process.exit(failed ? 1 : 0)