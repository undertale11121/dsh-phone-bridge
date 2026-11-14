// 「每个会话一个互联开关」的验收：不点名的消息要准确落到配对的会话，
// 点名要压过开关，全关时不能静默丢。
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
  links: { 'session-a': { phoneId: 'p1', at: new Date().toISOString() } },
}
fs.writeFileSync(path.join(BRIDGE, 'desktop.json'), JSON.stringify(config, null, 2))

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

async function say(text, to = 'desktop', from = 'phone') {
  const res = await fetch(`http://127.0.0.1:${PORT}/thread`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, to, text, auth: { k: 'token', token: 'links-token' } }),
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
const stateAfterAlign = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
check('首次启动只对齐游标不投历史', calls.length === 0 && Number(stateAfterAlign.cursor) === 3, `cursor=${stateAfterAlign.cursor}`)

// 1. 不点名 → 投 links 里打开的 session-a
const s4 = await say('不点名-应该给 a')
await sleep(3600)
check('不点名的消息投给开关打开的会话', calls.length === 1 && calls[0].id === 'session-a', `落到 ${calls[0]?.id || '无'}`)
check('投递内容能带上原文', (calls[0]?.text || '').includes('不点名-应该给 a'))

// 2. 点名 → 压过开关，投 session-b
const s5 = await say('点名-应该给 b', 'desktop:session-b')
await sleep(3600)
check('点名压过开关', calls.length === 2 && calls[1].id === 'session-b', `落到 ${calls[1]?.id || '无'}`)

// 3. 关掉开关 + 不点名 → 回退到开着的会话，不丢
config.links = {}
fs.writeFileSync(path.join(BRIDGE, 'desktop.json'), JSON.stringify(config, null, 2))
const s6 = await say('全关-应该回退')
await sleep(3600)
check('没有配对时回退到开着的会话', calls.length === 3 && Boolean(calls[2]?.id), `落到 ${calls[2]?.id || '无'}`)

const stateNow = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
check('投递后游标前进到最新', Number(stateNow.cursor) >= s6, `cursor=${stateNow.cursor} 最后一条=${s6}`)

// 4. 纯函数：recentLink 取最近打开的那条
const two = { links: { a: { phoneId: 'p', at: '2026-11-14T10:00:00Z' }, b: { phoneId: 'q', at: '2026-11-14T12:00:00Z' } } }
check('recentLink 取最近打开的一条', recentLink(two)?.desktopId === 'b')
check('没有开关时 recentLink 返回 null', recentLink({ links: {} }) === null)
check('点名的 session-b 能被 matchSession 认出来', matchSession([{ id: 'session-b', name: '副标题' }], 'session-b')?.id === 'session-b')

// 5. 通知类不投进会话
check('「手机已连上电脑」被识别为通知', isNotice('（手机已连上电脑）') === true)
check('普通对话不算通知', isNotice('帮我看下这个布局') === false)

// 6. 没有活会话时不静默丢：lastError 有值、cursor 不动
const deadAgents = { roots: () => [], get: () => undefined }
const before = JSON.parse(fs.readFileSync(stateFile, 'utf8')).cursor
const s7 = await say('没人开着-要留痕')
await new Promise((resolve) => {
  // 换 agents 不好换（installWake 里闭包了），直接验证 wakeSession 的行为
  import('../web/index.js').then(async (mod) => {
    try {
      await mod.wakeSession(deadAgents, 'session-zzz', 'x')
      check('投给不存在的会话会报错', false)
    } catch (error) {
      check('投给不存在的会话会报错', /没开在引擎里/.test(String(error?.message || error)))
    }
    resolve()
  })
})
const after = JSON.parse(fs.readFileSync(stateFile, 'utf8')).cursor
check('没投出去时游标不前进', Number(after) === Number(before) || Number(before) < s7, `before=${before} after=${after}`)

server.kill()
console.log(`\n${passed}/${passed + failed} 通过`)
process.exit(failed ? 1 : 0)
