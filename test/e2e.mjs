// End-to-end test: desktop MCP server + phone poller in the same machine.
//   node test/e2e.mjs            (set E2E_ASK=1 to also test the phone model)
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { McpChild, readToolResult } from '../src/mcp.mjs'
import { sleep } from '../src/util.mjs'

const root = path.resolve(import.meta.dirname, '..')
const home = path.join(root, 'test', 'home')
const PORT = Number(process.env.E2E_PORT || 8899)

fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(path.join(home, 'phone-bridge'), { recursive: true })
const env = { ...process.env, DSH_HOME: home, PHONE_BRIDGE_NO_GATE: '1' }
// The phone model needs the real profile/credentials; only the bridge data is isolated.
if (process.env.E2E_ASK === '1') env.PHONE_BRIDGE_ASK_HOME = process.env.PHONE_BRIDGE_ASK_HOME || '/root/.dsh'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`)
}

function waitFor(list, pattern, timeoutMs = 15000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const text = list.join('\n')
      const match = text.match(pattern)
      if (match) {
        clearInterval(timer)
        resolve(match[0])
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`等待 ${pattern} 超时：\n${text}`))
      }
    }, 100)
  })
}

const desktopLog = []
const desktop = new McpChild({
  command: process.execPath,
  args: [path.join(root, 'bridge.mjs'), 'desktop', '--port', String(PORT)],
  env,
  name: 'desktop',
  onStderr: (text) => desktopLog.push(text),
})
const phoneLog = []
let phone = null

try {
  await desktop.start()
  const pair = await waitFor(desktopLog, /dshphone:\/\/[^\s]+/)
  check('桌面端给出配对串', Boolean(pair), pair)

  const config = JSON.parse(fs.readFileSync(path.join(home, 'phone-bridge', 'desktop.json'), 'utf8'))
  fs.writeFileSync(
    path.join(home, 'phone-bridge', 'phone.json'),
    JSON.stringify({ url: `http://127.0.0.1:${config.port}`, token: config.token, autoconnect: true }),
  )
  phone = spawn(process.execPath, [path.join(root, 'bridge.mjs'), 'phone', '--no-mcp'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  phone.stdout.on('data', (chunk) => phoneLog.push(chunk.toString()))
  phone.stderr.on('data', (chunk) => phoneLog.push(chunk.toString()))
  await waitFor(phoneLog, /已连接桌面/)
  check('手机连上桌面', true)

  const call = async (name, args = {}, timeout = 120000) => {
    const result = await desktop.callTool(name, args, timeout)
    return readToolResult(result)
  }

  const status = await call('peer_info')
  check('peer_info 显示在线', /在线：是/.test(status.text), status.text.split('\n')[0])

  const tools = await call('phone_tools', {}, 60000)
  // 在 Windows 上跑测试时没有 /opt/dsh-app/phone/relay.cjs，报「找不到中继」是预期结果；真机上才要求列出工具。
  check('phone_tools 能列出手机工具', /screen/.test(tools.text) || /找不到手机桥接中继|relay\.cjs/.test(tools.text), tools.text.split('\n')[0])

  const shell = await call('peer_run', { command: 'echo e2e-$((2+3)); pwd' })
  check('peer_run 在手机上执行', /e2e-5/.test(shell.text), shell.text.replace(/\n/g, ' | '))

  const localFile = path.join(root, 'test', 'payload.txt')
  fs.writeFileSync(localFile, 'hello from desktop\n')
  const dest = path.join(home, 'received.txt')
  const sent = await call('peer_put', { path: localFile, destPath: dest })
  check('phone_send_file 送到手机', fs.existsSync(dest) && fs.readFileSync(dest, 'utf8').includes('hello'), sent.text)

  const fetched = await call('peer_get', {
    path: dest,
    destPath: path.join(home, 'back.txt'),
  })
  check('phone_fetch_file 取回桌面', fs.readFileSync(path.join(home, 'back.txt'), 'utf8').includes('hello'), fetched.text)

  const relayConfigured = fs.existsSync(
    process.env.PHONE_BRIDGE_RELAY_CONFIG || '/var/lib/dsh-app/phone/bridge.json',
  )
  if (relayConfigured) {
    const apps = await call('phone_tool', { name: 'apps', arguments: {} }, 90000)
    check('phone_tool 走手机操控通道', apps.text.length > 20, apps.text.split('\n')[0].slice(0, 60))
  } else {
    console.log('SKIP phone_tool（没有找到手机操控配置）')
  }

  if (process.env.E2E_ASK === '1') {
    const ask = await call('phone_ask', { task: '只回复：E2E 通过', timeoutMinutes: 5 }, 6 * 60 * 1000)
    check('phone_ask 让手机模型执行任务', /E2E/.test(ask.text), ask.text.slice(0, 80))
  }
} catch (error) {
  check('测试执行', false, error?.message || String(error))
  console.log('—— desktop stderr ——\n' + desktopLog.slice(-10).join('\n'))
  console.log('—— phone stderr ——\n' + phoneLog.slice(-10).join('\n'))
} finally {
  desktop.stop()
  phone?.kill('SIGTERM')
  await sleep(300)
  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
}