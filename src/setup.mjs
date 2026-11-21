// Tiny local setup page: one HTTP server, a generic state/action contract, so
// both the desktop and the phone can show a graphical configuration screen
// without depending on a web framework.
import http from 'node:http'
import os from 'node:os'
import { log } from './util.mjs'

// The page is rendered on the server: the browser needs no JavaScript at all,
// so a broken/old bundle or a blocked script can never produce a blank page.
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function pageHtml(state, notice = '') {
  const rows = (state.rows || [])
    .map((r) => `<div class="row"><span>${esc(r.label)}</span><span class="${r.mono ? 'mono ' : ''}${esc(r.tone || '')}">${esc(r.value)}</span></div>`)
    .join('')
  const fields = (state.fields || [])
    .map((f) => `<div class="f"><label>${esc(f.label)}</label><input type="text" name="${esc(f.key)}" placeholder="${esc(f.placeholder || '')}" value="${esc(f.value || '')}"></div>`)
    .join('')
  const toggles = (state.toggles || [])
    .map((t) => `<form method="post" action="/act"><input type="hidden" name="id" value="toggle:${esc(t.key)}:${t.value ? '0' : '1'}">
      <button class="wide"><span>${esc(t.label)}</span><span class="${t.value ? 'ok' : 'bad'}">${t.value ? '已开启 · 点此关闭' : '已关闭 · 点此开启'}</span></button></form>`)
    .join('')
  const buttons = (state.buttons || []).length
    ? `<form method="post" action="/act">${allFields(state)}${(state.buttons || [])
        .map((b) => `<button name="id" value="${esc(b.id)}" class="${b.primary ? 'primary' : ''}">${esc(b.label)}</button>`)
        .join('')}</form>`
    : ''
  const link = state.link && state.link.href
    ? `<div class="card"><a href="${esc(state.link.href)}" target="_blank" rel="noreferrer">${esc(state.link.label || '打开')}</a></div>`
    : ''
  const log = state.log && state.log.length ? `<div class="card mono pre">${esc(state.log.join('\n'))}</div>` : ''
  const note = state.note ? `<div class="card muted">${esc(state.note)}</div>` : ''
  const msg = notice ? `<div class="card ${notice.startsWith('失败') ? 'bad' : 'ok'}">${esc(notice)}</div>` : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(state.title || '手机桥接')}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 20px 16px 48px; font: 15px/1.55 -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif; background: #14161a; color: #e8eaed; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .sub { color: #9aa0a6; font-size: 13px; margin-bottom: 16px; }
  .card { background: #1d2025; border: 1px solid #2a2e35; border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; align-items: baseline; }
  .row span:first-child { color: #9aa0a6; flex: 0 0 auto; }
  .row span:last-child { text-align: right; word-break: break-all; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
  .pre { white-space: pre-wrap; }
  .muted { color: #9aa0a6; font-size: 13px; }
  .ok { color: #81c995; } .bad { color: #f28b82; }
  input[type=text] { width: 100%; box-sizing: border-box; padding: 10px; border-radius: 8px; border: 1px solid #3a3f47; background: #14161a; color: #e8eaed; font-family: ui-monospace, monospace; font-size: 13px; }
  .f { margin-bottom: 10px; } .f label { display: block; color: #9aa0a6; font-size: 13px; margin-bottom: 4px; }
  button { width: 100%; margin-top: 8px; padding: 11px 14px; border-radius: 8px; border: 1px solid #3a3f47; background: #2a2f37; color: #e8eaed; font-size: 14px; text-align: center; }
  button.primary { background: #2d5bd1; border-color: #2d5bd1; }
  button.wide { display: flex; justify-content: space-between; align-items: center; }
  a { color: #8ab4f8; }
</style>
</head>
<body>
<h1>${esc(state.title || '手机桥接')}</h1>
<div class="sub">${esc(state.subtitle || '')}</div>
${msg}
${rows ? `<div class="card">${rows}</div>` : ''}
${toggles}
${buttons}
${link}
${log}
${note}
<script>setTimeout(function () { location.reload() }, 5000)</script>
</body>
</html>`
}

function allFields(state) {
  return (state.fields || [])
    .map((f) => `<input type="text" name="${esc(f.key)}" placeholder="${esc(f.placeholder || '')}" value="${esc(f.value || '')}">`)
    .join('')
}

// The desktop's /pair page posts here from another origin (the LAN address of
// the computer), so allow any origin; the server only listens on 127.0.0.1 and
// still requires a valid pairing payload.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, access-control-request-private-network, access-control-request-method',
  'access-control-allow-private-network': 'true',
  'access-control-max-age': '600',
}

// 本机的非回环 IPv4 地址集合：用来判断跨源请求是不是「从本机另一个端口」来的。
let localAddressCache = null
function localAddresses() {
  if (localAddressCache) return localAddressCache
  const set = new Set()
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const item of list || []) {
        if (item && item.family === 'IPv4' && !item.internal) set.add(item.address)
      }
    }
  } catch {
    /* 取不到网卡就当没有 */
  }
  localAddressCache = set
  return set
}

// POST body 读入带上限：任意本机页面都能往 127.0.0.1:8789 灌超大 body 把进程内存打爆。
const MAX_BODY = 1 << 20
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) {
      const error = new Error('请求体太大')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function startSetup({ role, port, host = '127.0.0.1', state, action }) {
  const server = http.createServer(async (req, res) => {
    // 一条 `GET //` 就会让 new URL 抛 ERR_INVALID_URL；放在 try 外等于任何本机进程
    // 都能用一条请求把这个进程打挂（unhandled rejection → 进程退出）。
    let url = null
    // 配置页只给本机浏览器用：跨源请求必须是同 Host、或本机回环地址。
    // 以前固定 `*`，任意网页都能跨源读 /api/state（里面含配对串）并 POST /api/action。
    const origin = String(req.headers.origin || '')
    let allowOrigin = !origin
    if (origin) {
      try {
        const parsed = new URL(origin)
        // 本机所有地址都算自己人：电脑上的 /pair 页面跑在另一个端口（如 8897），
        // 它会跨源 POST 到这个配置页（8789），所以要按「主机是本机」放行、不限端口。
        allowOrigin =
          parsed.host === String(req.headers.host || '') ||
          parsed.hostname === '127.0.0.1' ||
          parsed.hostname === 'localhost' ||
          parsed.hostname === '[::1]' ||
          localAddresses().has(parsed.hostname)
      } catch {
        allowOrigin = false
      }
    }
    // 仍然回 `*`：真正的守门是上面的 Origin 校验（坏来源在写响应前就 403 了）。
    const cors = allowOrigin ? CORS : {}
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...cors })
      res.end(body)
    }
    if (!allowOrigin) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ ok: false, error: 'origin not allowed' }))
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      return res.end()
    }
    try {
      url = new URL(req.url, 'http://localhost')
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const snapshot = { role, ...(await state()) }
        return send(200, pageHtml(snapshot, url.searchParams.get('msg') || ''), 'text/html; charset=utf-8')
      }
      if (req.method === 'POST' && url.pathname === '/act') {
        const form = new URLSearchParams(await readBody(req))
        const id = String(form.get('id') || '')
        const fields = {}
        for (const [key, value] of form) if (key !== 'id') fields[key] = value
        let notice = ''
        try {
          const result = (await action(id, fields)) || {}
          notice = result.text || '完成'
        } catch (error) {
          notice = `失败：${error?.message || error}`
        }
        res.writeHead(303, { location: `/?msg=${encodeURIComponent(notice)}`, ...CORS })
        return res.end()
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return send(200, JSON.stringify({ role, ...(await state()) }))
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const result = (await action(String(body.id || ''), body.fields || {})) || {}
        return send(200, JSON.stringify({ ok: true, text: result.text || '完成', state: { role, ...(await state()) } }))
      }
      return send(404, JSON.stringify({ ok: false, error: 'not found' }))
    } catch (error) {
      log(`配置页请求失败：${error?.message || error}`)
      const code = Number(error?.status) || 500
      return send(code, JSON.stringify({ ok: false, error: error?.message || String(error) }))
    }
  })
  server.on('error', (error) => log(`配置页没启动：${error?.message || error}`))
  server.listen(port, host, () => {
    log(`配置页：http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`)
  })
  return server
}