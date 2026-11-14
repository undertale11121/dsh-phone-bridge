// QR encoder + scan-to-pair plumbing: no phone needed, everything is local.
//   node test/qr.mjs
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { qrMatrix, qrPng, qrSvg } from '../src/qr.mjs'
import { pairPageHtml } from '../src/pair.mjs'
import { startSetup } from '../src/setup.mjs'
import { sleep } from '../src/util.mjs'

const root = path.resolve(import.meta.dirname, '..')
const home = path.join(root, 'test', 'home-qr')
const PORT = Number(process.env.QR_PORT || 8897)
const SETUP_PORT = Number(process.env.QR_SETUP_PORT || 8898)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`)
}

async function waitFor(fn, timeoutMs = 15000) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      last = error
    }
    await sleep(150)
  }
  throw new Error(`超时${last ? `：${last.message}` : ''}`)
}

// ── encoder ────────────────────────────────────────────────────────────────
try {
  const matrix = qrMatrix('hello')
  check('版本 1 尺寸 21×21', matrix.size === 21 && matrix.version === 1, `${matrix.version}/${matrix.size}`)
  check('三个角是定位图案', matrix.modules[0][0] && matrix.modules[0][6] && matrix.modules[6][0] && !matrix.modules[1][1])

  const boundary = (length) => {
    try {
      return qrMatrix('x'.repeat(length)).version
    } catch {
      return 0
    }
  }
  check('M 级版本边界', boundary(14) === 1 && boundary(15) === 2 && boundary(26) === 2 && boundary(27) === 3, `14→${boundary(14)} 15→${boundary(15)} 27→${boundary(27)}`)
  check('版本 8–10 边界', boundary(122) === 7 && boundary(123) === 8 && boundary(152) === 8 && boundary(153) === 9 && boundary(180) === 9 && boundary(181) === 10, `123→${boundary(123)} 153→${boundary(153)} 181→${boundary(181)}`)
  check('超长会报错', boundary(400) === 0)

  const svg = qrSvg('dshphone://192.168.1.5:8787/abc')
  check('SVG 是矢量图', svg.startsWith('<svg') && svg.includes('shape-rendering="crispEdges"') && svg.includes('<path'))

  const pngText = 'dshphone://192.168.1.5:8787/abc'
  const png = qrPng(pngText, { scale: 4, margin: 2 })
  const size = png.readUInt32BE(16)
  const expected = (qrMatrix(pngText).size + 4) * 4
  check('PNG 头与尺寸正确', png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && size === expected, `${size}px / 期望 ${expected}px`)

  const page = pairPageHtml({ token: 'tok123', host: '192.168.1.5', port: 8787 })
  check('配对页含配对串与 setup 端口', page.includes('dshphone://') && page.includes('tok123') && page.includes('8789'))
} catch (error) {
  check('编码器不抛错', false, String(error?.message || error))
}

// ── desktop pair page + QR route ───────────────────────────────────────────
fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(path.join(home, 'phone-bridge'), { recursive: true })
const desktopLog = []
const desktop = spawn(process.execPath, [path.join(root, 'bridge.mjs'), 'desktop', '--serve', '--port', String(PORT)], {
  env: { ...process.env, DSH_HOME: home, PHONE_BRIDGE_NO_GATE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
desktop.stdout.on('data', (chunk) => desktopLog.push(String(chunk)))
desktop.stderr.on('data', (chunk) => desktopLog.push(String(chunk)))

let setupServer = null
try {
  const health = await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`)
    if (!res.ok) return null
    const body = await res.json()
    return body.ok ? body : null
  })
  check('/health 给出扫描地址', typeof health.pairUrl === 'string' && health.pairUrl.includes('/pair?t='), health.pairUrl)

  const config = JSON.parse(fs.readFileSync(path.join(home, 'phone-bridge', 'desktop.json'), 'utf8'))
  const pairUrl = new URL(health.pairUrl)

  const page = await fetch(`http://127.0.0.1:${PORT}/pair?t=${config.token}`)
  const html = await page.text()
  check('配对页可打开', page.status === 200 && html.includes(config.token) && html.includes('配对这台手机'))

  const wrong = await fetch(`http://127.0.0.1:${PORT}/pair?t=nope`)
  check('错的 token 被拒', wrong.status === 403)

  const qr = await fetch(`http://127.0.0.1:${PORT}/pair/qr.svg?t=${config.token}`)
  const qrBody = await qr.text()
  check('二维码路由返回 SVG', qr.status === 200 && String(qr.headers.get('content-type')).includes('image/svg+xml') && qrBody.startsWith('<svg'), `${qrBody.length} 字节`)
  check('二维码内容就是扫描地址', qrBody === qrSvg(health.pairUrl, { margin: 3, label: '配对手机' }))

  // The page is cross-origin relative to the phone's setup server, so that
  // server has to answer the preflight and the action.
  const played = []
  setupServer = startSetup({
    role: 'phone',
    port: SETUP_PORT,
    state: async () => ({ rows: [], title: 't', subtitle: 's', fields: [], buttons: [] }),
    action: async (id, fields) => {
      played.push({ id, fields })
      return { text: '已保存' }
    },
  })
  await sleep(200)
  const preflight = await fetch(`http://127.0.0.1:${SETUP_PORT}/api/action`, {
    method: 'OPTIONS',
    headers: { origin: pairUrl.origin, 'access-control-request-method': 'POST' },
  })
  check('配置页回答预检', preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === '*', String(preflight.headers.get('access-control-allow-private-network')))

  const posted = await fetch(`http://127.0.0.1:${SETUP_PORT}/api/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: pairUrl.origin },
    body: JSON.stringify({ id: 'pair', fields: { pair: 'dshphone://192.168.1.5:8787/tok' } }),
  })
  const body = await posted.json()
  check('配对动作写入配置', posted.status === 200 && body.ok && played.length === 1 && played[0].id === 'pair', body.text)
} catch (error) {
  check('配对流程跑通', false, String(error?.message || error))
} finally {
  setupServer?.close()
  desktop.kill('SIGTERM')
  await sleep(200)
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log(desktopLog.join('').slice(-1200))
  process.exit(1)
}