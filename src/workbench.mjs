// A human-readable view of the shared workbench: both models' messages in one
// scrollable log. Served by the desktop bridge, so the user can open it from the
// computer or (same LAN) from the phone browser.

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function workbenchHtml({ token, name = '电脑' }) {
  const auth = Buffer.from(JSON.stringify({ k: 'token', token })).toString('base64url')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>两个模型的对话 · ${esc(name)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0f1115; color: #e6e8ee; font: 15px/1.55 -apple-system, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif; }
  header { position: sticky; top: 0; backdrop-filter: blur(8px); background: rgba(15,17,21,.92); border-bottom: 1px solid #222732; padding: 12px 14px; display: flex; align-items: center; gap: 10px; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header .meta { margin-left: auto; font-size: 12px; color: #8b93a7; }
  main { padding: 12px; max-width: 860px; margin: 0 auto 40px; }
  .row { display: flex; gap: 10px; padding: 9px 10px; border-radius: 10px; margin-bottom: 8px; background: #151922; border: 1px solid #1e2430; }
  .row.desktop { border-left: 3px solid #4c8dff; }
  .row.phone { border-left: 3px solid #45c98a; }
  .who { flex: none; width: 74px; font-size: 12px; color: #98a2b8; }
  .who b { display: block; color: #e6e8ee; font-size: 13px; font-weight: 600; }
  .bubble { flex: 1; min-width: 0; }
  .bubble .text { white-space: pre-wrap; word-break: break-word; }
  .bubble .time { margin-top: 4px; font-size: 11px; color: #6b7488; }
  .empty { color: #8b93a7; text-align: center; padding: 40px 10px; }
  footer { position: fixed; left: 0; right: 0; bottom: 0; padding: 8px 14px; text-align: center; font-size: 11px; color: #6b7488; background: rgba(15,17,21,.9); border-top: 1px solid #1c212b; }
  .note { font-size: 12px; color: #8b93a7; margin: 0 0 10px; }
</style>
</head>
<body>
<header>
  <h1>两个模型的对话</h1>
  <span class="meta" id="meta">连接中…</span>
</header>
<main>
  <p class="note">电脑模型和手机模型在同一个工作台上说话，这里是完整记录。${esc(name)} · 每 2 秒刷新。</p>
  <div id="log"><div class="empty">还没有对话。让电脑模型调 peer_say，或手机模型调 peer_say 就会出现在这里。</div></div>
</main>
<footer>只读视图 · 关掉页面即可</footer>
<script>
const AUTH = ${JSON.stringify(auth)};
let since = 0;
let lastCount = 0;
const log = document.getElementById('log');
const meta = document.getElementById('meta');

function esc(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function clock(at) {
  const d = new Date(at);
  return isNaN(d) ? '' : d.toLocaleTimeString('zh-CN', { hour12: false });
}
function rowHtml(m) {
  const who = m.from === 'phone' ? 'phone' : 'desktop';
  const label = who === 'phone' ? '手机模型' : '电脑模型';
  const emoji = who === 'phone' ? '📱' : '💻';
  return '<div class="row ' + who + '">' +
    '<div class="who">' + emoji + '<b>' + label + '</b></div>' +
    '<div class="bubble"><div class="text">' + esc(m.text) + '</div>' +
    '<div class="time">#' + m.seq + ' · ' + clock(m.at) + '</div></div></div>';
}

async function tick() {
  try {
    const res = await fetch('/thread?since=' + since + '&wait=0&auth=' + encodeURIComponent(AUTH), { cache: 'no-store' });
    if (res.status === 403) { meta.textContent = '配对令牌失效'; return; }
    const data = await res.json();
    const messages = data.messages || [];
    if (data.total === 0) {
      log.innerHTML = '<div class="empty">还没有对话。</div>';
    } else if (messages.length) {
      if (lastCount === 0) log.innerHTML = '';
      log.insertAdjacentHTML('beforeend', messages.map(rowHtml).join(''));
      since = data.next;
      lastCount = data.total;
      const nearBottom = window.innerHeight + window.scrollY > document.body.scrollHeight - 160;
      if (nearBottom) window.scrollTo({ top: document.body.scrollHeight });
    }
    meta.textContent = '共 ' + data.total + ' 条';
  } catch (error) {
    meta.textContent = '离线（' + (error.message || 'network') + '）';
  }
}
tick();
setInterval(tick, 2000);
</script>
</body>
</html>
`
}