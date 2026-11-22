// 手机侧收件器（inboxTick）回归：这一侧以前完全没有测试覆盖，而用户的
// 「新建对话在手机上不出现」「点了互联没反应」几乎都出在这里。
//
// 覆盖点：
//   1. links 里还没有 phoneId 的电脑会话 → 预建一个手机会话（agents.create 被调用）
//   2. 建好后 peer-links.json 落映射，且写进 projcache 的标题（App 列表里不是空白条目）
//   3. 下一轮不再重复建（否则会话越开越多）
//   4. 电脑发来的消息投到对应的手机会话，且不重复投递
//
// 顺带钉死一个真实事故：`const titleOf` 曾在预建循环之后声明，
// 每轮预建都抛 "Cannot access 'titleOf' before initialization"，
// 导致一条手机会话都建不出来 —— 这条路径必须能跑通。
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = path.join(HERE, 'home-inbox')
const BRIDGE = path.join(HOME, 'phone-bridge')
const PORT = 8901
const TOKEN = 'inbox-token'

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
process.env.PHONE_BRIDGE_ROLE = 'phone'
process.env.PHONE_BRIDGE_TEST_FORCE_PHONE = '1'
process.env.PHONE_BRIDGE_NO_AUTOPATCH = '1'

// ---- 假电脑：/thread + /collab + /agents/register ----
const DESKTOP_OPEN = 'session-desktop-aaaa-1111'
const DESKTOP_CLOSED = 'session-desktop-bbbb-2222'
const messages = []       // 电脑 → 手机 的消息
let maxseq = 0
let collabHits = 0
let threadHits = 0
let pinnedPhoneId = ''

function addMessage(text, extra = {}) {
  maxseq += 1
  messages.push({ seq: maxseq, from: 'desktop', to: 'phone', text, at: new Date().toISOString(), ...extra })
  return maxseq
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (obj) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (url.pathname === '/thread' && req.method === 'GET') {
    threadHits += 1
    const since = Number(url.searchParams.get('since')) || 0
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200)
    const rows = messages.filter((m) => m.seq > since).slice(0, limit)
    send({ ok: true, messages: rows, next: rows.length ? rows[rows.length - 1].seq : since, total: maxseq })
    return
  }
  if (url.pathname === '/collab' && req.method === 'GET') {
    collabHits += 1
    send({
      ok: true,
      collab: pinnedPhoneId ? { phoneSessionId: pinnedPhoneId, at: new Date().toISOString() } : {},
      desktopSessions: [
        { id: DESKTOP_OPEN, title: '线条小狗情侣App规划', at: Date.now() },
        { id: DESKTOP_CLOSED, title: '已经关掉的会话', at: Date.now() },
      ],
      // 两条都没有 phoneId → 两条都应该被预建
      links: {
        [DESKTOP_OPEN]: { at: new Date().toISOString(), ...(pinnedPhoneId ? { phoneId: pinnedPhoneId } : {}) },
        [DESKTOP_CLOSED]: { at: new Date().toISOString() },
      },
    })
    return
  }
  if (url.pathname === '/agents/register' && req.method === 'POST') {
    send({ ok: true })
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"ok":false}')
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

// ---- phone.json 指向假电脑 ----
fs.writeFileSync(
  path.join(BRIDGE, 'phone.json'),
  JSON.stringify({ url: `http://127.0.0.1:${PORT}`, token: TOKEN, autoconnect: true }, null, 2),
)

// ---- 假 agents ----
const created = []
const followed = []
function mkAgent(id) {
  return {
    id,
    at: Date.now(),
    cwd: '/root/workspace',
    get status() {
      return 'idle'
    },
    session: { header: { cwd: '/root/workspace' } },
    followup(message) {
      followed.push({ id, text: typeof message === 'string' ? message : JSON.stringify(message) })
      return { ok: true }
    },
  }
}
const liveAgents = []
const agents = {
  roots: () => liveAgents,
  get: (id) => liveAgents.find((a) => a.id === id),
  async create({ sessionId, meta }) {
    created.push({ sessionId, meta })
    const a = mkAgent(sessionId)
    liveAgents.push(a)
    return a
  },
}

const { apply } = await import('../web/index.js')
apply({ inject: (names, cb) => cb({ agents }) })

// 首次 tick 只对齐游标，第二轮才预建。给足 3 轮的时间。
await sleep(10000)

// ---- 断言 ----
check('收件器真的跑了（拉过 /collab）', collabHits > 0, `hits=${collabHits}`)
check('预建调用了 agents.create', created.length >= 2, `created=${created.length}`)
check('新建的会话都带 cwd', created.every((c) => c.meta && typeof c.meta.cwd === 'string' && c.meta.cwd.length > 0), JSON.stringify(created[0]?.meta || {}))
// 引擎只在 create 那一刻读 meta.title，之后改 projcache 会被整份覆盖（试过三种写法都不行），
// 所以标题必须在这里就传进去，否则手机 App 列表里就是一条空白条目。
check(
  '新建的会话都带上了电脑会话的标题',
  created.length > 0 && created.every((c) => c.meta && typeof c.meta.title === 'string' && c.meta.title.length > 0),
  JSON.stringify(created.map((c) => c.meta?.title || '')),
)

const peerLinksFile = path.join(BRIDGE, 'peer-links.json')
const peerLinks = fs.existsSync(peerLinksFile) ? JSON.parse(fs.readFileSync(peerLinksFile, 'utf8')) : {}
check('peer-links.json 写入了两条映射', Object.keys(peerLinks).length === 2, JSON.stringify(peerLinks))
check('映射的值是 session- 开头', Object.values(peerLinks).every((v) => /^session-/.test(String(v))))

// 标题：预建时要把电脑会话的标题写进 projcache，否则 App 列表里是空白条目
const projDir = path.join(HOME, 'storages', 'session_projcache', 'sessions')
function titleOf(sessionId) {
  const file = path.join(projDir, `${sessionId}.json`)
  if (!fs.existsSync(file)) return null
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  return data?.record?.rows?.title?.val ?? null
}
const titleOpen = titleOf(peerLinks[DESKTOP_OPEN])
check('手机会话带上了电脑会话的标题', titleOpen === '线条小狗情侣App规划', `title=${titleOpen}`)

// 建过的不再重复建
const createdCount1 = created.length
await sleep(4000)
check('下一轮不重复建会话', created.length === createdCount1, `before=${createdCount1} after=${created.length}`)

// ---- 消息投递 ----
const phoneIdOpen = peerLinks[DESKTOP_OPEN]
pinnedPhoneId = String(phoneIdOpen || '')   // 电脑侧已经把 🔗 绑到这台手机的这个会话
await sleep(3500)                            // 让下一轮 tick 拿到新的 /collab
const before = followed.length
addMessage('第一条给打开着的会话')
addMessage('第二条给打开着的会话')
await sleep(7000)
const got = followed.slice(before)
check('电脑消息投到了对应手机会话', got.length >= 1 && got.every((f) => f.id === phoneIdOpen), JSON.stringify(got.map((g) => g.id)))
check('投递内容里有消息正文', got.map((g) => g.text).join('\n').includes('第一条给打开着的会话'))

// 同一批不重复投
const countAfterFirst = followed.length
await sleep(7000)
check('同一批不重复投递', followed.length === countAfterFirst, `before=${countAfterFirst} after=${followed.length}`)

const stateFile = path.join(BRIDGE, 'inbox-state.json')
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}
check('游标推进到最新', Number(state.cursor) >= maxseq, `cursor=${state.cursor} maxseq=${maxseq}`)
check('lastError 为空', !state.lastError, `lastError=${state.lastError || ''}`)

server.close()
console.log(failed ? `\n===== ${passed} 通过，${failed} 失败 =====` : `\n===== ${passed} 通过，0 失败 =====`)
process.exitCode = failed ? 1 : 0