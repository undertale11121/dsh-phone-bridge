#!/usr/bin/env node
// 手机↔电脑互联的自检脚本：不需要 GUI，一条命令告诉你「现在通到哪里、卡在哪」。
//
//   node scripts/self-check.mjs
//
// 它只读状态、不改配置、不重启任何东西，所以随时可以跑。
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const BRIDGE_DIR = path.join(HOME, 'phone-bridge')

const ok = (label, extra = '') => console.log(`  ✅ ${label}${extra ? `  ${extra}` : ''}`)
const bad = (label, extra = '') => console.log(`  ❌ ${label}${extra ? `  ${extra}` : ''}`)
const warn = (label, extra = '') => console.log(`  ⚠️  ${label}${extra ? `  ${extra}` : ''}`)
const head = (t) => console.log(`\n${t}`)

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function get(port, route, timeout = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: route, timeout }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body) })
        } catch {
          resolve({ status: res.statusCode, json: null, raw: body.slice(0, 120) })
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
  })
}

const cfg = readJson(path.join(BRIDGE_DIR, 'desktop.json'), {}) || {}
const port = Number(cfg.port) || 8090
const token = String(cfg.token || '')

head(`一、桥接服务（端口 ${port}）`)
const health = await get(port, '/health')
if (health.status !== 200 || !health.json?.ok) {
  bad('桥接没响应', health.error || `HTTP ${health.status}`)
  console.log('     → 跑一次：scripts\\start-bridge.bat（或 python scripts\\start-all.py）')
} else {
  ok('桥接在跑', `v=${health.json.v} name=${health.json.name}`)
  const at = Number(health.json.device?.at || 0)
  const age = at ? Math.round((Date.now() - at) / 1000) : -1
  if (health.json.online && age >= 0 && age < 90) ok('手机在线', `最后心跳 ${age}s 前`)
  else bad('手机不在线', at ? `最后心跳 ${age}s 前（>90s 视为离线）` : '从没连过')
}

head('二、端口占用')
// 探测 8080 必须用局域网 IP：Windows 允许 0.0.0.0:8080 与 127.0.0.1:8080 并存，
// 而 Steam 长期占着后者，回环地址永远打到 Steam、拿到 404，会把「转发器正常」误判成 down。
const lan = (() => {
  try {
    const row = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)
    return row ? row.address : ''
  } catch {
    return ''
  }
})()
async function getOn(host, p, route, timeout) {
  return new Promise((resolve) => {
    const req = http.get({ host, port: p, path: route, timeout }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }) } catch { resolve({ status: res.statusCode, json: null }) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
  })
}
for (const p of [8080, port]) {
  const host = p === 8080 && lan ? lan : '127.0.0.1'
  const res = await getOn(host, p, '/health', 2000)
  if (res.json?.ok) ok(`${p} → 桥接`, `经 ${host}，实际端口 ${res.json.port}`)
  else if (p === 8080) warn('8080 没转发到桥接', '手机若配对在 8080 会连不上 → 跑 scripts\\start-bridge.bat')
  else bad(`${p} 不通`)
}
if (port !== 8080) {
  const direct = await get(port, '/health', 1500)
  if (direct.json?.ok) ok(`直连 ${port} 正常`)
}

head('三、配置')
if (!String(cfg.collab?.desktopSessionId || '')) warn('没有钉住的电脑会话', '手机消息会按 links 映射找，找不到就跳过')
else ok('钉住的电脑会话', String(cfg.collab.desktopSessionId).slice(0, 22))

const links = readJson(path.join(BRIDGE_DIR, 'links.json'), {}) || {}
const mapped = Object.entries(links).filter(([, v]) => v && v.phoneId)
const wait = Object.entries(links).filter(([, v]) => v && !v.phoneId)
ok(`links 映射 ${Object.keys(links).length} 条`, `已配对手机会话 ${mapped.length}，待预建 ${wait.length}`)

head('四、投递状态（电脑侧）')
const wake = readJson(path.join(BRIDGE_DIR, 'wake-state.json'), {}) || {}
if (wake.lastError) bad('上次投递报错', String(wake.lastError).slice(0, 90))
else ok('没有投递错误')
ok(`游标 cursor=${wake.cursor}`, `aligned=${wake.aligned} delivered=${(wake.delivered || []).length}`)
const lw = wake.lastWake || null
if (lw?.at) ok('最后一次成功投递', `${String(lw.sessionId || '').slice(0, 22)} @ ${lw.at}`)
else warn('还没有成功投递过')

head('五、测试')
console.log('  跑全量：npm run test:all   （15 个文件，约 222 条断言）')
console.log('  只跑手机侧收件器：node test/inbox-tick.mjs')

head('六、结论')
const bridgeOk = health.status === 200 && health.json?.ok
const phoneOk = bridgeOk && health.json.online && Number(health.json.device?.at || 0) > Date.now() - 90_000
if (bridgeOk && phoneOk) {
  console.log('  看起来是通的。手机上新开一个对话 → 点「互联」→ 电脑上应该出现同名会话。')
} else if (bridgeOk) {
  console.log('  电脑侧正常，但手机没连上：打开手机 DSH Go，确认它连的是 192.168.1.10:8080。')
} else {
  console.log('  桥接没起来：先跑 scripts\\start-bridge.bat，再跑一遍这个脚本。')
}
console.log('')