// The page a phone lands on after scanning the desktop's QR code. It is served
// by the desktop bridge (the QR points at http://<lan-ip>:<port>/pair?t=token),
// so the token in the query string is the whole authorization: whoever can open
// the link can pair. From there the page talks to the phone's own setup server
// on 127.0.0.1, which is why src/setup.mjs sends CORS headers.
const SETUP_PORTS = [8789, 8790, 8791, 8792]

export function pairPageHtml({ token = '', host = '', port = 8787 } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>配对 dsh 手机桥接</title>
<style>
  :root { color-scheme: dark; --bg: #0f1115; --card: #171a21; --line: #262b36; --text: #e8ecf3; --muted: #98a2b3; --ok: #3ddc97; --bad: #ff7a7a; --accent: #6aa9ff; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 18px 48px; background: var(--bg); color: var(--text); font: 16px/1.6 -apple-system, "Noto Sans SC", system-ui, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 14px; margin-bottom: 20px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px; margin-bottom: 14px; }
  .big { font-size: 18px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .big .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); }
  .big.ok .dot { background: var(--ok); }
  .big.bad .dot { background: var(--bad); }
  .hint { color: var(--muted); font-size: 14px; margin-top: 6px; }
  ol { margin: 8px 0 0; padding-left: 20px; font-size: 14px; }
  li { margin: 4px 0; }
  code.pair { display: block; word-break: break-all; font-size: 12px; background: #0b0d11; border: 1px solid var(--line); border-radius: 10px; padding: 10px; margin: 10px 0; color: #b8c7e0; }
  button { font: inherit; border-radius: 10px; border: 1px solid var(--line); background: #1d2230; color: var(--text); padding: 10px 14px; margin: 4px 6px 0 0; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #08111f; font-weight: 600; }
  .hidden { display: none; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
  <h1>配对这台手机</h1>
  <div class="sub">${escapeHtml(host)} · 端口 ${escapeHtml(String(port))}</div>

  <div class="card">
    <div class="big" id="status"><span class="dot"></span><span id="status-text">正在连接本机 dsh-go…</span></div>
    <div class="hint" id="detail">页面会直接把配对信息写进手机上正在运行的桥接。</div>
  </div>

  <div class="card hidden" id="fallback">
    <div class="big bad"><span class="dot"></span>没连上手机上的 dsh-go</div>
    <div class="hint">多半是手机端桥接还没跑起来。手动配对也只要三步：</div>
    <ol>
      <li>打开 dsh-go，随便进一个对话。</li>
      <li>点输入框上方的「手机桥接」胶囊（没有就重启一次 App）。</li>
      <li>把下面这串粘进「配对串」，点「连接」。</li>
    </ol>
    <code class="pair mono" id="pair"></code>
    <button class="primary" id="copy">复制配对串</button>
    <button id="retry">再试一次</button>
  </div>

<script>
  const TOKEN = ${JSON.stringify(token)};
  const PORTS = ${JSON.stringify(SETUP_PORTS)};
  const pair = 'dshphone://' + location.hostname + ':' + (location.port || '8787') + '/' + TOKEN;
  document.getElementById('pair').textContent = pair;

  const statusEl = document.getElementById('status');
  const statusText = document.getElementById('status-text');
  const detail = document.getElementById('detail');
  const fallback = document.getElementById('fallback');

  function show(kind, text, extra) {
    statusEl.className = 'big ' + kind;
    statusText.textContent = text;
    if (extra) detail.textContent = extra;
  }

  async function tryPort(port) {
    const res = await fetch('http://127.0.0.1:' + port + '/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'pair', fields: { pair } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  }

  async function run() {
    fallback.classList.add('hidden');
    show('', '正在连接本机 dsh-go…', '页面会直接把配对信息写进手机上正在运行的桥接。');
    for (const port of PORTS) {
      try {
        const body = await tryPort(port);
        show('ok', '已配对', body.text || ('已写入 ' + pair));
        detail.textContent = '回到 dsh-go 就能让电脑调用这台手机了：截图、点按、跑命令、装 APK 都行。';
        return;
      } catch (error) {
        // try the next port; the setup server may be on a fallback one
      }
    }
    show('bad', '没连上手机上的 dsh-go', '换一种方式：把配对串给 App 里的「手机桥接」胶囊。');
    fallback.classList.remove('hidden');
    try { await navigator.clipboard.writeText(pair); detail.textContent = '配对串已复制，粘到手机上即可。'; } catch {}
  }

  document.getElementById('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(pair); statusText.textContent = '已复制'; } catch {}
  });
  document.getElementById('retry').addEventListener('click', run);
  run();
</script>
</body>
</html>`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character])
}