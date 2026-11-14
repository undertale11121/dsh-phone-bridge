// Checks for the desktop-UI bundle (web/): the host route on its own, then the
// browser half loaded the way the engine loads it (__ModuleLoader__ + a lazy
// CJS factory), with React replaced by a tiny recorder. No browser needed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-bridge-web-'))
process.env.DSH_HOME = home
process.env.PHONE_BRIDGE_PORT = '8793'
process.env.PHONE_BRIDGE_ROLE = 'desktop'
delete process.env.PHONE_BRIDGE_SETUP_PORT

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

// ── host half ────────────────────────────────────────────────────────────────
const registered = []
const effects = []
const scope = {
  webServer: { register(route) { registered.push(route); return () => {} } },
  effect(fn) { effects.push(fn); return () => {} },
}
const wokenMessages = []
const fakeAgents = { get: (id) => (id === 'sess-active-9' ? { followup: (m) => wokenMessages.push(m), steer: (m) => wokenMessages.push(m) } : undefined) }
const host = await import(pathToFileURL(path.join(root, 'web', 'index.js')).href)
host.apply({
  inject(names, fn) {
    fn(names.includes('agents') ? { ...scope, agents: fakeAgents } : scope)
  },
  effect(fn) { effects.push(fn) },
})
effects.forEach((fn) => fn())
check('注册了配置与二维码路由', registered.length === 2 && registered[0].path === '/phone-bridge/config' && registered[1].path === '/phone-bridge/qr.svg', JSON.stringify(registered.map((r) => r.path)))
const route = registered[0]
const qrRoute = registered[1]

function response() {
  return { status: 0, body: '', writeHead(status) { this.status = status }, end(body) { this.body = body } }
}
async function get() {
  const res = response()
  await route.handler({ method: 'GET', headers: {} }, res)
  return { res, data: JSON.parse(res.body) }
}
async function post(body) {
  const res = response()
  const req = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
  await route.handler(req, res)
  return { res, data: JSON.parse(res.body) }
}

const first = await get()
check('GET 200', first.res.status === 200, String(first.res.status))
check('payload 形状', ['role', 'online', 'device', 'port', 'listen', 'pairing', 'pairUrl', 'toggles', 'devices', 'log'].every((key) => key in first.data), Object.keys(first.data).join(','))
check('role=desktop', first.data.role === 'desktop')
check('listen 有值', /:\d+$/.test(first.data.listen), first.data.listen)
check('四个开关都在', ['allowShell', 'allowAsk', 'allowFiles', 'allowTest'].every((key) => typeof first.data.toggles[key] === 'boolean'))
check('没找到 bridge.mjs 时给明确提示', /还没找到 bridge\.mjs/.test(first.data.error || ''), first.data.error)

// Without a recorded bridge path the card cannot render the code yet, and the
// route says why instead of showing a broken image.
const qrMissing = response()
await qrRoute.handler({ method: 'GET', headers: {} }, qrMissing)
check('没记录 bridge 路径时二维码给出原因', qrMissing.status === 503 && /bridge\.mjs/.test(qrMissing.body), qrMissing.body)

const configFile = path.join(home, 'phone-bridge', 'desktop.json')
const stashed = JSON.parse(fs.readFileSync(configFile, 'utf8'))
fs.writeFileSync(configFile, JSON.stringify({ ...stashed, bridge: path.join(root, 'bridge.mjs') }))
const qrOk = response()
await qrRoute.handler({ method: 'GET', headers: {} }, qrOk)
check('二维码返回 SVG', qrOk.status === 200 && String(qrOk.body).startsWith('<svg'), `${String(qrOk.body).slice(0, 12)}… ${String(qrOk.body).length} 字节`)
fs.writeFileSync(configFile, JSON.stringify(stashed))

const off = await post({ action: 'toggle', key: 'allowShell', value: false })
check('关闭 allowShell 返回 ok', off.res.status === 200 && off.data.ok === true)
check('开关落盘', JSON.parse(fs.readFileSync(path.join(home, 'phone-bridge', 'desktop.json'), 'utf8')).allowShell === false)
const on = await post({ action: 'toggle', key: 'allowShell', value: true })
check('开关可以开回来', JSON.parse(fs.readFileSync(path.join(home, 'phone-bridge', 'desktop.json'), 'utf8')).allowShell === true)
const token = await post({ action: 'token' })
check('换配对串', token.data.ok === true && JSON.parse(fs.readFileSync(path.join(home, 'phone-bridge', 'desktop.json'), 'utf8')).token.length >= 16)
process.env.PHONE_BRIDGE_ROLE = 'phone'
const asPhone = await get()
// 这台是 Windows：没有 /sdcard，所以 ROLE=phone 不算数（见 isPhone 的注释）。
check('ROLE=phone 在非 Android 上不生效', asPhone.data.role === (fs.existsSync('/sdcard') ? 'phone' : 'desktop'))
process.env.PHONE_BRIDGE_ROLE = 'desktop'
const bad = await post({ action: 'nope' })
check('未知动作 400', bad.res.status === 400 && bad.data.ok === false)
const wrong = await post({ action: 'toggle', key: 'allowRoot', value: true })
check('未知开关 400', wrong.res.status === 400, wrong.res.body)

// ── browser half ─────────────────────────────────────────────────────────────
const source = fs.readFileSync(path.join(root, 'web', 'client.js'), 'utf8')
let loaded = null
const loadedIds = []
const fakeWindow = { __ModuleLoader__: { load(definition) { loaded = definition; loadedIds.push(definition.id) } } }
new Function('window', source)(fakeWindow)
check('客户端 bundle 调用 __ModuleLoader__.load', Boolean(loaded) && loaded.id === 'dsh-phone-bridge-web')
check('新旧两个包名都注册了 client', loadedIds.includes('dsh-phone-bridge') && loadedIds.includes('dsh-phone-bridge-web'), loadedIds.join(','))

// 只投一句唤醒语：全文留在工作台，模型自己 peer_read 去拿（用户的原话：
// 「可以对话发在后台，然后页面只发一点内容唤醒模型」）。
const batch = host.composeBatch([
  { from: 'phone', text: '第一条' },
  { from: 'phone', text: '第二条' },
], '手机模型')
check('多条消息合成一句提示', batch.includes('手机模型 2 条') && batch.includes('第一条') && batch.split('\n').length >= 2, batch)
check('提示里带 peer_read 的指引', batch.includes('peer_read'), batch)
const longOne = host.composeBatch([{ from: 'phone', text: 'x'.repeat(5000) }], '手机模型')
check('长消息只带摘要不贴全文', longOne.length < 600 && longOne.includes('5000 字'), `${longOne.length}:${longOne}`)

// 暗号：发送方标了 level，唤醒语头上就带符号，一眼看出要不要放下手上的活。
const urgentOne = host.composeBatch([{ from: 'phone', text: '快看', level: 'urgent' }], '手机模型')
// 符号就够了，不该再跟一句「（重要，等你回）」——那是用户明确嫌重复的。
check('urgent 带 ❗ 且不再加括号说明', urgentOne.startsWith('❗') && urgentOne.includes('要你回') === false, urgentOne)
const questionOne = host.composeBatch([{ from: 'phone', text: '选哪个', level: 'question' }], '手机模型')
check('question 带 ❓', questionOne.startsWith('❓'), questionOne)
const mixedOne = host.composeBatch([
  { from: 'phone', text: '汇报一下', level: 'report' },
  { from: 'phone', text: '出错了', level: 'alert' },
], '手机模型')
check('混着发取最要紧的那个', mixedOne.startsWith('⚠️'), mixedOne)
const plainOne = host.composeBatch([{ from: 'phone', text: '随口一说' }], '手机模型')
check('普通消息不带符号', !/^[❗❓⚠️✅📋]/.test(plainOne) && !plainOne.includes('（普通）'), plainOne)

const tree = []
const fakeDocument = { documentElement: { lang: 'zh-CN' } }
const React = {
  createElement(type, props, ...children) {
    const node = { type, props: props || {}, children: children.flat(9).filter((child) => child !== null && child !== undefined && child !== false) }
    tree.push(node)
    return node
  },
  useState(value) { return [value, () => {}] },
  useEffect() {},
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
}
const slotsSeen = []
let slotsDepth = 0
const ctx = {
  inject(names, fn) {
    if (names.includes('locale')) fn({ locale: { get: () => 'zh' } })
    if (names.includes('slots')) {
      fn({
        slots: {
          inject(_name, generator) {
            // 宿主每个 inject 各开一个 generator，各自 yield 一份注册；
            // 这里把整条 generator 跑完，才收得到全部槽位。
            const iterator = generator()
            let last
            for (let step = iterator.next(); !step.done; step = iterator.next()) last = step.value
            return last
          },
          register(descriptor, component) {
            slotsSeen.push({ descriptor, component })
            return null
          },
        },
      })
    }
  },
}
const client = loaded.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})
check('导出 apply 与 inject', typeof client.apply === 'function' && Array.isArray(client.inject))
// bundle 里读 document.documentElement.lang，测试环境补一个
globalThis.document = fakeDocument
client.apply(ctx)
const three = slotsSeen.length === 7
  && slotsSeen[0].descriptor.name === 'plugins.bundle.config' && slotsSeen[0].descriptor.key === 'dsh-phone-bridge-web'
  && slotsSeen[1].descriptor.name === 'plugins.bundle.config' && slotsSeen[1].descriptor.key === 'dsh-phone-bridge'
  && slotsSeen[2].descriptor.name === 'sidebar.panellist' && slotsSeen[2].descriptor.id === 'phone-bridge'
  && slotsSeen[3].descriptor.name === 'main' && slotsSeen[3].descriptor.key === 'phone-bridge'
  && ['conversation.session.header.actions', 'conversation.session.header.utilities', 'conversation.input.dock']
    .every((name) => slotsSeen.some((slot) => slot.descriptor.name === name && slot.descriptor.id === 'phone-bridge-link'))
check('两个卡片 + 侧栏 + 面板 + 三个会话插槽', three, JSON.stringify(slotsSeen.map((s) => s.descriptor)))
const headSwitch = slotsSeen.find((slot) => slot.descriptor.name === 'conversation.session.header.actions')
const headProps = headSwitch.descriptor.inject('session-abc')
check('会话头部开关拿到当前会话 id', headProps && headProps.sessionId === 'session-abc', JSON.stringify(headProps))
check('侧栏行写的是「互联」', slotsSeen[2] && slotsSeen[2].descriptor.label() === '互联', slotsSeen[2] && String(slotsSeen[2].descriptor.label()))
const icon = slotsSeen[2].component({ size: 18 })
check('侧栏图标是 svg', icon && icon.type === 'svg' && icon.props.width === 18, icon && icon.type)
let rendered = null
try {
  rendered = slotsSeen[0].component({})
} catch (error) {
  rendered = null
  check('卡片首帧能渲染', false, String(error?.stack || error))
}
check('卡片首帧能渲染', Boolean(rendered) && tree.length > 0)
const texts = []
;(function collect(node) {
  if (!node || typeof node !== 'object') return
  if (typeof node.children) {}
  for (const child of node.children || []) {
    if (typeof child === 'string') texts.push(child)
    else collect(child)
  }
})(rendered)
check('文案是中文', texts.some((text) => text.includes('互联')), texts.slice(0, 6).join(' | '))
// 侧栏那一页：同一个组件，但有独立滚动容器、没有卡片边框
const page = slotsSeen[3].component({})
check('面板页自带滚动容器', page && page.props.style && page.props.style.overflow === 'auto' && page.props.style.height === '100%', JSON.stringify(page && page.props.style))
check('面板页不再套卡片边框', !page.props.style.border, JSON.stringify(page.props.style))


// ── wake（唤醒会话）──────────────────────────────────────────────────────────
check('state 带 wake 字段', first.data.wake && first.data.wake.enabled === false && first.data.wake.sessionId === '', JSON.stringify(first.data.wake))
const wokeSave = await post({ action: 'wake', enabled: true, sessionId: 'sess-test-1', mode: 'queue' })
check('打开唤醒落盘', wokeSave.res.status === 200 && /唤醒：开/.test(wokeSave.data.text || ''), JSON.stringify(wokeSave.data))
const afterWake = await get()
check('wake 设置回读', afterWake.data.wake.enabled === true && afterWake.data.wake.sessionId === 'sess-test-1', JSON.stringify(afterWake.data.wake))

const calls = []
const probeAgents = { get: (id) => (id === 'sess-test-1' ? { followup: (m) => calls.push(m), steer: (m) => calls.push(m) } : undefined) }
const missing = await host.wakeSession(probeAgents, 'nope', 'hi').then(() => '', (error) => String(error.message || error))
check('未打开的会话给出提示', /没开在引擎里/.test(missing), missing)
const sent = await host.wakeSession(probeAgents, 'sess-test-1', '来自手机的消息')
check('followup 收到用户消息', calls.length === 1 && calls[0].role === 'user' && calls[0].content[0].type === 'text' && calls[0].content[0].text === '来自手机的消息' && calls[0].source.kind === 'user', JSON.stringify(calls[0]))
check('wakeSession 返回摘要', sent.sessionId === 'sess-test-1' && sent.mode === 'queue' && sent.preview.startsWith('来自手机'), JSON.stringify(sent))


// ── 自动目标：模型用过的会话就是唤醒对象 ─────────────────────────────────────
await post({ action: 'wake', enabled: true, sessionId: '' })
fs.mkdirSync(path.join(home, 'phone-bridge'), { recursive: true })
fs.writeFileSync(path.join(home, 'phone-bridge', 'active.json'), JSON.stringify({ sessionId: 'sess-active-9', at: new Date().toISOString(), tool: 'peer_info' }))
const withActive = await get()
check('state 暴露自动会话', withActive.data.wake.target === 'sess-active-9' && withActive.data.wake.ready === true, JSON.stringify(withActive.data.wake))
const autoWake = await post({ action: 'wake', text: '手机说：电脑在吗' })
check('不填会话也能投递', autoWake.res.status === 200 && /已把消息投进会话 sess-act/.test(autoWake.data.text || ''), JSON.stringify(autoWake.data))
check('followup 收到来自手机的消息', wokenMessages.length === 1 && wokenMessages[0].content[0].text === '手机说：电脑在吗', JSON.stringify(wokenMessages[0]))
const modeWake = await post({ action: 'wake', enabled: true, mode: 'steer' })
check('投递方式可切换', modeWake.data.state.wake.mode === 'steer', JSON.stringify(modeWake.data.state.wake))


// ── 会话目录：消息写 desktop:<名字> 时能解析到具体会话 ───────────────────────
fs.writeFileSync(
  path.join(home, 'phone-bridge', 'registry.json'),
  JSON.stringify({
    sessions: {
      'sess-active-9': { id: 'sess-active-9', name: '登录页', purpose: '改登录页的验证码流程', calls: 3, at: new Date().toISOString() },
      'sess-other-1': { id: 'sess-other-1', name: '支付', purpose: '订单支付的回归测试', calls: 1, at: new Date(Date.now() - 60000).toISOString() },
    },
  }),
)
check('按名字解析会话', host.resolveNamed('登录页')?.id === 'sess-active-9', JSON.stringify(host.resolveNamed('登录页')))
check('按用途关键词解析', host.resolveNamed('支付')?.id === 'sess-other-1', JSON.stringify(host.resolveNamed('支付')))
check('按 id 前缀解析', host.resolveNamed('sess-other')?.id === 'sess-other-1', JSON.stringify(host.resolveNamed('sess-other')))
check('没写过的名字解析不到', host.resolveNamed('不存在的会话') === null, String(host.resolveNamed('不存在的会话')))
const withRegistry = await get()
check('state 暴露会话目录', withRegistry.data.registry?.length === 2 && withRegistry.data.registry.some((row) => row.name === '登录页'), JSON.stringify(withRegistry.data.registry))

// ── 引擎半自注册：从市场装的 bundle 自己把 bridge.mjs 挂上去 ──────────────────
const profileDir = path.join(home, 'profiles', 'test-profile')
fs.mkdirSync(profileDir, { recursive: true })
const patchFile = path.join(profileDir, 'cordis.patch.yml')
fs.writeFileSync(patchFile, '# 用户自己的补丁\n- insert:\n    - id: phone-bridge-web\n      name: dsh-phone-bridge-web\n')
check('找得到 bridge.mjs', typeof host.enginePath() === 'string' && host.enginePath().endsWith('bridge.mjs'), String(host.enginePath()))
const patched = host.installEngineRow()
check('补进了引擎行', patched.length === 1 && path.resolve(patched[0]) === path.resolve(patchFile), JSON.stringify(patched))
const afterPatch = fs.readFileSync(patchFile, 'utf8')
check('引擎行是 mcp-client + stdio', /id: dsh-phone-bridge-engine\s*$/m.test(afterPatch) && /name: '@deepseek-ai\/dsh-mcp-client'/.test(afterPatch) && /serverName: phone-bridge/.test(afterPatch) && /transport: stdio/.test(afterPatch), afterPatch)
const yamlDecoded = (row) => {
  try {
    return JSON.parse(`"${row.replace(/^"/, '').replace(/"$/, '')}"`)
  } catch {
    return null
  }
}
const argsLine = (afterPatch.match(/^\s+- "(.+)"$/m) || [])[1] || ''
check('args 指向真实 bridge.mjs', yamlDecoded(argsLine) === host.enginePath() && /\\[^\\]/.test(argsLine), `${argsLine} => ${yamlDecoded(argsLine)}`)
check('不动用户原有内容', afterPatch.includes('id: phone-bridge-web') && afterPatch.includes('用户自己的补丁'))
const again = host.installEngineRow()
check('重复加载不重复写', again.length === 0 && fs.readFileSync(patchFile, 'utf8') === afterPatch)
// 回归 1：Windows 路径在 YAML 双引号里必须转义反斜杠，否则 eval 时 \U \. 会把路径吃掉
check('路径写成可解析的 YAML（反斜杠已转义）', yamlDecoded(argsLine) === host.enginePath(), argsLine)
// 回归 2：老版本把引擎行无脑追加到文件末尾，掉进别的条目中间会把整份补丁写坏
fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-phone-bridge'] } } }))
fs.writeFileSync(patchFile, '# 用户自己的补丁\n- insert:\n    - id: some-other-plugin\n      name: some-other-plugin\n      config:\n        a: 1\n')
host.installEngineRow()
const atHead = fs.readFileSync(patchFile, 'utf8')
check('引擎行插在开头而不是文件末尾', atHead.trimStart().startsWith('# >>> phone-bridge engine row') && atHead.trimEnd().endsWith('        a: 1'), atHead)
host.installEngineRow()
check('已有引擎行的文件不会被再动一次', fs.readFileSync(patchFile, 'utf8') === atHead)
fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-phone-bridge-web'] } } }))
fs.writeFileSync(patchFile, '# 空补丁\n')
check('只靠 bundles 列表也认得', host.installEngineRow().length === 1)
fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-phone-bridge'] } } }))
fs.writeFileSync(patchFile, '# 空补丁\n')
check('新包名也认得', host.installEngineRow().length === 1)
process.env.PHONE_BRIDGE_NO_AUTOPATCH = '1'
fs.writeFileSync(patchFile, '# 空补丁\n')
check('环境变量能关掉自注册', host.installEngineRow().length === 0)
delete process.env.PHONE_BRIDGE_NO_AUTOPATCH

// 角色判定：环境变量不能压过文件系统证据。桌面上误设 ROLE=phone 会把两个方向
// 都判成手机端（没有唤醒器，消息没人取），所以 ROLE=phone 必须还要 /sdcard 这类
// 证据才算数。
check('桌面上 ROLE=phone 也不认（没有 /sdcard）', (process.env.PHONE_BRIDGE_ROLE = 'phone') && host.isPhone() === fs.existsSync('/sdcard'))
process.env.PHONE_BRIDGE_ROLE = 'desktop'
check('ROLE=desktop 直接判桌面', host.isPhone() === false)
delete process.env.PHONE_BRIDGE_ROLE
check('不设变量时按文件系统判', host.isPhone() === (fs.existsSync('/sdcard') || fs.existsSync('/opt/dsh-app/phone/relay.cjs') || fs.existsSync('/var/lib/dsh-app/phone/bridge.json')))

fs.rmSync(home, { recursive: true, force: true })

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)