// test/render.mjs — 用假 React 通过 apply() 把 client.js 真正注册一遍，再把那两个组件渲染出来：
// 重启前先确认面板不会白屏、下拉和发送框都在。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(root, 'web', 'client.js')
const src = fs.readFileSync(file, 'utf8')

let registered = null
const registeredIds = []
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      registered = spec
      registeredIds.push(spec.id)
    },
  },
}
globalThis.document = { documentElement: { lang: 'zh' } }

// eslint-disable-next-line no-new-func
new Function(src)()
if (!registered) throw new Error('client.js 没有调用 __ModuleLoader__.load')
if (!registeredIds.includes('dsh-phone-bridge') || !registeredIds.includes('dsh-phone-bridge-web')) {
  throw new Error(`bundle id 不对：${registeredIds.join(',')}`)
}

const fakeReact = {
  createElement(type, props, ...children) {
    const flat = []
    for (const child of children) {
      if (Array.isArray(child)) flat.push(...child)
      else if (child !== null && child !== undefined && child !== false) flat.push(child)
    }
    return { type, props: { ...(props || {}), children: flat } }
  },
  useCallback: (fn) => fn,
  useEffect: () => {},
  // 外部队列：渲染前塞好值，组件里的 useState 按顺序取。
  useState: (init) => (queue.cursor < queue.values.length ? [queue.values[queue.cursor++], () => {}] : [init, () => {}]),
}
const queue = { values: [], cursor: 0 }
function renderWith(component, values) {
  queue.values = values
  queue.cursor = 0
  return component({})
}

const mod = registered.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error(`不应该 require：${name}`)
})
if (typeof mod.apply !== 'function') throw new Error('client.js 没导出 apply')

// 把 register 收到的东西留下来
const slots = []
const fakeSlots = {
  inject(name, gen) {
    for (const entry of gen()) slots.push({ ...entry, ownerSlot: name })
  },
  register(options, component) {
    return { options, component }
  },
}
const ctx = {
  inject(deps, cb) {
    if (deps.includes('locale')) cb({ locale: { get: () => 'zh' } })
    if (deps.includes('slots')) cb({ slots: fakeSlots })
  },
}
mod.apply(ctx)

console.log(`注册了 ${slots.length} 个槽位：`)
for (const slot of slots) {
  console.log(`  · ${slot.options.name}${slot.options.key ? ` key=${slot.options.key}` : ''}${slot.options.id ? ` id=${slot.options.id}` : ''}`)
}

const panel = slots.find((slot) => slot.options.name === 'main')
if (!panel) throw new Error('没有注册 main 面板')
const cards = slots.filter((slot) => slot.options.name === 'plugins.bundle.config')
if (cards.length !== 2) throw new Error(`卡片数量应为 2，实际 ${cards.length}`)
const sidebar = slots.find((slot) => slot.options.name === 'sidebar.panellist')
if (!sidebar) throw new Error('没有注册侧栏入口')

function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.props?.children || []) walk(child, out)
  return out
}
function textOf(tree) {
  return walk(tree)
    .map((node) => (typeof node.props?.children?.[0] === 'string' ? node.props.children[0] : ''))
    .join(' ')
}

// 1) 首帧（没有拉到 state）
{
  const tree = renderWith(panel.component, [])
  const text = textOf(tree)
  if (!text.includes('互联')) throw new Error('首帧没有标题')
  console.log('✓ 首帧（state=null）不白屏')
}

// 2) 有 state：两个下拉 + 输入框 + 发送
{
  const state = {
    role: 'desktop',
    device: { name: 'localhost', platform: 'linux/arm64' },
    listen: '0.0.0.0:8787',
    background: { pid: 1234, port: 8787 },
    pairing: ['dshphone://1.2.3.4:8787/tok'],
    permitLeft: 0,
    codeLeft: 0,
    pendingPair: null,
    wake: { enabled: true, mode: 'queue', target: 'abc123def', targetName: '工作区 · abc123de', ready: true, lastWake: null, lastError: '' },
    collab: { desktopSessionId: 'session-11111111-1111-1111-1111-111111111111', phoneSessionId: 'session-22222222-2222-2222-2222-222222222222', phoneName: '手机会话' },
    live: [
      { id: 'session-11111111-1111-1111-1111-111111111111', title: '工作区 A', cwd: 'D:\\c\\dsh\\workspace', at: Date.now() },
    ],
    agents: [
      { id: 'psess:session-22222222-2222-2222-2222-222222222222', name: '手机上的活', host: 'phone', kind: 'session', running: true },
      { id: 'peer-1', name: '手机模型', host: 'phone', running: true },
    ],
    sessions: [],
    registry: [],
    thread: [{ seq: 1, from: 'phone', text: '你好', at: new Date().toISOString() }],
    log: [],
    workbenchUrl: 'http://127.0.0.1:8787/workbench',
    toggles: {},
  }
  // Card 里 useState 的顺序：state, error, notice, busy, copied, wakeId, sayText
  const tree2 = renderWith(panel.component, [state, '', '', '', '', '', ''])
  const nodes = walk(tree2)
  const text = textOf(tree2)
  const selects = nodes.filter((node) => node.type === 'select')
  const inputs = nodes.filter((node) => node.type === 'input')
  const buttons = nodes.filter((node) => node.type === 'button')
  console.log(`  面板：${selects.length} 个下拉 / ${inputs.length} 个输入框 / ${buttons.length} 个按钮`)

  if (!text.includes('两个会话直连')) throw new Error('面板没有「两个会话直连」标题')
  // 会话手动选择区已去掉：现在只剩「暗号」一个下拉，配对完全靠会话顶部那颗开关。
  if (selects.length !== 1) throw new Error(`下拉数量不对：${selects.length}（应该只剩暗号那一个）`)
  if (!inputs.length) throw new Error('没有输入框')
  if (!buttons.some((b) => (b.props?.children || []).includes('发给手机'))) throw new Error('没有「发给手机」按钮')
  console.log('✓ 面板已无手动选会话区（只剩暗号下拉 + 发消息）')
  console.log('✓ 有 state 时面板渲染通过')
}

// 3) 侧栏图标不能炸
{
  // 会话头部那颗「互联」：注册上去的是 session 级列表插槽，inject 拿当前会话 id。
  const headerSwitch = slots.find((slot) => slot.options.name === 'conversation.session.header.actions')
  if (!headerSwitch) throw new Error('没有注册到会话头部的开关')
  const headerProps = headerSwitch.options.inject('session-abc')
  if (headerProps?.sessionId !== 'session-abc') throw new Error(`会话头部 inject 没拿到会话 id：${JSON.stringify(headerProps)}`)
  // 首帧（还没拉到配置）也必须是颗按钮，不能白屏。
  queue.values = [null, false, '']
  queue.cursor = 0
  const chip = headerSwitch.component(headerProps)
  if (!chip || chip.type !== 'button') throw new Error('会话头部开关首帧不是按钮')
  const chipText = String((chip.props?.children || []).join(''))
  if (!chipText.includes('互联')) throw new Error(`会话头部开关文案不对：${chipText}`)
  console.log(`  会话头部开关：${chipText}`)

  const icon = renderWith(sidebar.component, [])
  if (!icon) throw new Error('侧栏图标没渲染出来')
  console.log('✓ 侧栏图标渲染通过')
}

console.log('\n全部渲染检查通过')
// 让 `npm test` 也能跑：这里用 1..n 计数，不依赖 node:test。
process.exitCode = 0