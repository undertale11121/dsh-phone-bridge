// Pairing without typing anything: the phone asks, the computer's card shows
// "a phone wants to connect", its user taps 允许, and the key is remembered.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { deviceIdOf } from '../src/pubkey.mjs'

const root = path.resolve(import.meta.dirname, '..')
const home = path.join(root, 'test', 'home-approve')
const PORT = Number(process.env.APPROVE_PORT || 8903)

fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(path.join(home, 'phone-bridge'), { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`)
}

const post = async (route, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}
const health = async () => (await fetch(`http://127.0.0.1:${PORT}/health`)).json()

let child = null
try {
  child = spawn(process.execPath, [path.join(root, 'bridge.mjs'), 'desktop', '--serve', '--port', String(PORT)], {
    env: { ...process.env, DSH_HOME: home, PHONE_BRIDGE_LOG: path.join(home, 'bridge.log') },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const started = Date.now()
  while (Date.now() - started < 15_000) {
    try {
      if ((await health()).ok) break
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  const { publicKey } = crypto.generateKeyPairSync('ed25519')
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const device = { id: deviceIdOf(pub), name: '测试机', platform: 'android', pub }

  const asked = await post('/request', { device })
  check('手机能发起配对请求', asked.status === 200 && asked.data?.ok === true, JSON.stringify(asked.data))

  const pending = (await health()).pendingPair
  check('电脑端看得到「有手机想连接」', pending?.name === '测试机', JSON.stringify(pending))

  const before = await post('/hello', { v: 2, token: '', device })
  check('没允许之前连不上', before.status === 401, String(before.status))

  const approved = await post('/pair/approve', {})
  check('电脑上点「允许」就登记这台手机', approved.data?.ok === true && approved.data?.device?.name === '测试机', JSON.stringify(approved.data))

  const after = await post('/hello', { v: 2, token: '', device })
  check('允许之后直接连上（不用配对码）', after.status === 200 && after.data?.paired === true && Boolean(after.data?.challenge), JSON.stringify(after.data))

  await post('/request', { device })
  await post('/pair/deny', {})
  check('拒绝后待确认消失', (await health()).pendingPair === null)
} catch (error) {
  check('免输码配对测试', false, error?.message || String(error))
} finally {
  child?.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 300))
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)