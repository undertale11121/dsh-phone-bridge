// 投递压力验收：一批几十条混合消息（点名 / desktopId / 无依据 / 自己发的 / 广播），
// 跑几轮 tick 后必须满足「该投的一条不少、不该投的一条不多、同一条不投两次、游标推到最新」。
// 这是把「刷屏 / 丢消息」两个老毛病钉死在回归里的测试。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = path.join(HERE, 'home-stress')
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

const { apply } = await import('../web/index.js')

const PORT = 8899
const config = {
  token: 'stress-token',
  port: PORT,
  exactPort: true,
  wake: { enabled: true, mode: 'queue' },
  links: {},
}
const configFile = path.join(BRIDGE, 'desktop.json')
fs.writeFileSync(configFile, JSON.stringify(config, null, 2))

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
check('压力测试用的桌面桥接起得来', up, `port ${PORT}`)

async function say(text, to = 'desktop', from = 'phone', extra = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}/thread`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, to, text, ...extra, auth: { k: 'token', token: 'stress-token' } }),
  })
  const data = await res.json()
  return Number(data.seq || 0)
}

const calls = []
const busyIds = new Set()
function agent(id) {
  return {
    id,
    get status() {
      return busyIds.has(id) ? 'busy' : 'idle'
    },
    at: Date.now(),
    session: { header: { cwd: `/tmp/${id}` } },
    followup(message) {
      calls.push({ id, text: JSON.stringify(message) })
      return { ok: true }
    },
  }
}
const A = agent('session-a')
const B = agent('session-b')
const agents = {
  roots: () => [A, B],
  get: (id) => (id === 'session-a' ? A : id === 'session-b' ? B : undefined),
}

// 先塞 3 条历史，让首次启动只做对齐。
await say('历史 1')
await say('历史 2')
await say('历史 3')

const ctx = { inject: (names, cb) => cb({ agents }) }
apply(ctx)
await sleep(3800)

const stateFile = path.join(BRIDGE, 'wake-state.json')
const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'))
check('首次启动只对齐游标不投历史', calls.length === 0, `calls=${calls.length}`)

const state0 = readState()
const cursor0 = Number(state0.cursor) || 0
const maxSeq0 = Number(state0.maxseq) || 0
check('对齐后游标落在历史末尾', cursor0 >= 3, `cursor=${cursor0} maxseq=${maxSeq0}`)

// ---- 第一波：60 条混合 ----
const batch = []
for (let i = 0; i < 20; i += 1) batch.push({ text: `点名b-${i}`, to: 'desktop:session-b' })
for (let i = 0; i < 20; i += 1) batch.push({ text: `deskid-a-${i}`, to: 'desktop', extra: { desktopId: 'session-a' } })
for (let i = 0; i < 10; i += 1) batch.push({ text: `无依据-${i}`, to: 'desktop' })
for (let i = 0; i < 5; i += 1) batch.push({ text: `自己发的-${i}`, to: 'desktop', from: 'desktop' })
for (let i = 0; i < 5; i += 1) batch.push({ text: `广播-${i}`, to: 'all' })

let lastSeq = 0
for (const item of batch) lastSeq = (await say(item.text, item.to, item.from || 'phone', item.extra || {})) || lastSeq
await sleep(12000) // 4 个 tick

// 同一个会话的多条消息会被 composeBatch 合并成一条投递，所以这里断言的是
// 「内容一条不少、落到正确的会话、不重复」，而不是「调用次数等于消息条数」。
const textFor = (id) => calls.filter((c) => c.id === id).map((c) => c.text).join('\n')
const allText = calls.map((c) => c.text).join('\n')
const toB = calls.filter((c) => c.id === 'session-b').length
const toA = calls.filter((c) => c.id === 'session-a').length
// composeBatch 会把一批合并成「N 条（总字数）」+ 前 PEEK_CHARS 字预览，超出部分靠 peer_read，
// 所以这里断言的是合批头部正确、预览有内容、且没串到另一个会话。
const bText = textFor('session-b')
const aText = textFor('session-a')

check('第一波：点名 20 条合成一批给 B', toB >= 1 && bText.includes('【互联】') && bText.includes('20 条') && bText.includes('点名b-0'), `B 收到 ${toB} 次`)
check('第一波：desktopId 20 条合成一批给 A', toA >= 1 && aText.includes('【互联】') && aText.includes('20 条') && aText.includes('deskid-a-0'), `A 收到 ${toA} 次`)
check('第一波：B 没收到属于 A 的消息', !bText.includes('deskid-a-'), '')
check('第一波：A 没收到属于 B 的消息', !aText.includes('点名b-'), '')
check(
  '第一波：无依据/自己发的/广播一条都没投',
  !/无依据|自己发的|广播/.test(allText),
  `命中 ${(allText.match(/无依据|自己发的|广播/g) || []).length} 条`,
)
const dupes = calls.map((c) => c.text).filter((text, index, list) => list.indexOf(text) !== index)
check('第一波：没有重复投递', dupes.length === 0, `重复 ${dupes.length} 次`)
const state1 = readState()
check('第一波：游标推进到最新', Number(state1.cursor) >= lastSeq, `cursor=${state1.cursor} lastSeq=${lastSeq}`)

// ---- 第二波：再 20 条，验证不重投第一波 ----
const before = calls.length
const beforeText = calls.map((c) => c.text).join('\n')
for (let i = 0; i < 20; i += 1) lastSeq = (await say(`点名b-二波-${i}`, 'desktop:session-b')) || lastSeq
await sleep(9000)
const state2 = readState()
const wave2 = calls.slice(before).map((c) => c.text).join('\n')
check(
  '第二波：20 条合成一批送到、且没重投第一波',
  wave2.includes('20 条') && wave2.includes('点名b-二波-0') && !wave2.includes('点名b-0\n'),
  `新增 ${calls.length - before} 次投递`,
)
check('第二波：游标继续推进', Number(state2.cursor) >= lastSeq, `cursor=${state2.cursor} lastSeq=${lastSeq}`)

// ---- busy 场景：B 忙的时候发 3 条，忙完必须都补投、且不重复 ----
const beforeBusy = calls.length
busyIds.add('session-b')
for (let i = 0; i < 3; i += 1) lastSeq = (await say(`忙时-${i}`, 'desktop:session-b')) || lastSeq
await sleep(4000)
const stateBusy = readState()
check(
  '对方忙时游标不越过这几条',
  Number(stateBusy.cursor) < lastSeq,
  `cursor=${stateBusy.cursor} lastSeq=${lastSeq}`,
)
busyIds.delete('session-b')
await sleep(9000)
const stateIdle = readState()
const busyText = calls.slice(beforeBusy).map((c) => c.text).join('\n')
const busyMissing = ['忙时-0', '忙时-1', '忙时-2'].filter((t) => !busyText.includes(t))
check('忙完之后补投 3 条（可合并）', busyMissing.length === 0, `缺 ${busyMissing.length} 条`)
check(
  '忙完之后游标推过这几条',
  Number(stateIdle.cursor) >= lastSeq,
  `cursor=${stateIdle.cursor} lastSeq=${lastSeq}`,
)
const allTexts = calls.map((c) => c.text)
check('全程没有重复投递', new Set(allTexts).size === allTexts.length, `${allTexts.length} 条 / ${new Set(allTexts).size} 唯一`)

// ---- delivered 集合有上限、不会无限长 ----
const delivered = Array.isArray(stateIdle.delivered) ? stateIdle.delivered : []
check('delivered 集合有上限（≤500）', delivered.length <= 500, `${delivered.length} 条`)

server.kill()
fs.rmSync(HOME, { recursive: true, force: true })

console.log(`\n===== ${passed} 通过，${failed} 失败 =====`)
if (failed) process.exitCode = 1