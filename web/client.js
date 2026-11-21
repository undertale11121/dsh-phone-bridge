// Browser half: a card on the Plugins page that talks to /phone-bridge/config.
// Hand-written in the lazy-CJS bundle protocol (no build step, no imports from
// dsh client packages) so the zip the user copies to Windows needs no toolchain.
// 按包名注册：桌面装的包叫 dsh-phone-bridge，手机上那个还叫 dsh-phone-bridge-web。
// 两个 id 挂同一份导出，但只构建一次 —— 否则 apply 跑两遍，每条消息投两次。
function __buildPhoneBridge(require) {
  if (window.__phoneBridgeModule) return window.__phoneBridgeModule
    var module = { exports: {} }
    var exports = module.exports

    // 工作台上的每条消息都带 ISO 的 at，面板里显示成 HH:MM:SS，方便人工对账。
    function fmtClock(at) {
      var d = new Date(at || Date.now())
      if (isNaN(d.getTime())) return ''
      var pad = function (n) { return String(n).length < 2 ? '0' + n : String(n) }
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    }

    var PACKAGE = '@undertale11121/dsh-phone-bridge'
    // The id of the sidebar row and of its `main` page. It must not collide
    // with the host's own panels (`plugins`, `dsh-market`, …).
    var PANEL_ID = 'phone-bridge'
    var TEXT = {
      zh: {
        title: '互联',
        subtitle: '电脑端 · 和手机上的模型一起干活：它截图、点按、跑真机测试，两边也能互相派活',
        guideTitle: '怎么用（三步）',
        guide1: '① 随便挑一个会话，在它顶部点「🔗 互联」。',
        guide2: '② 手机那边会自动开一个对应的会话（已经有的就复用），一个电脑会话配一个手机会话，不会串。',
        guide3: '③ 之后两个模型直接说话就行，不用在这个面板里选。手机没连上时先扫码配对。',
        wakeFailed: '上次没投递成功（消息还在工作台，会继续重试）：',
        online: '手机在线',
        offline: '手机不在线',
        device: '设备',
        listen: '监听',
        background: '后台服务',
        scan: '让手机扫码',
        scanHint: '手机相机对着二维码扫一下，配对会自动写进手机上的 dsh-go。',
        scanAlt: '配对二维码',
        scanFail: '二维码没出来，先用下面的配对串',
        pairing: '配对串（手机没自动连上时，复制给手机上的「连接电脑」胶囊）',
        copy: '复制',
        copied: '已复制',
        toggles: '权限',
        allowShell: '允许手机在电脑上执行命令',
        allowAsk: '允许手机调用电脑上的模型',
        allowFiles: '允许两边互传文件',
        allowTest: '允许手机自动跑测试',
        start: '启动后台服务',
        permit: '允许新手机配对',
        pendingTitle: '有手机想连接',
        pendingHint: '在下面点「允许」就配好了，手机上不用输任何码',
        approve: '允许',
        deny: '拒绝',
        code: '生成配对码',
        allowOpen: '配对窗口已打开，手机上点「找电脑」即可',
        codeShown: '配对码',
        thread: '两个模型的对话',
        chatOpen: '看完整对话 ↗',
        newToken: '换新配对串',
        refresh: '刷新',
        log: '最近日志',
        devices: '已登记的手机',
        sessions: '手机会话',
        sessionsNone: '还没派过活（第一次 phone_ask 会创建 default）',
        agents: '能对话的 agent',
        agentsNone: '只有电脑模型和手机模型',
        running: '运行中',
        stopped: '已停止',
        none: '还没有手机登记过',
        failed: '读取失败',
        loading: '正在读取桥接状态…',
        retry: '重试',
        wake: '自动唤醒',
        wakeHint: '手机往电脑发消息时，自动把消息投进电脑上最近用互联的那个会话，让睡着的模型接着干。开着才会花 token。',
        wakeTarget: '目标会话（自动）',
        registryTitle: '电脑记住的会话',
        registryHint: '模型自己写的用途。手机发消息时 to 写 desktop:<名字> 就投给那个会话。',
        registryEmpty: '还没记住会话——让电脑模型用一次 peer_info',
        registryActive: '当前',
        wakeNone: '还没记录到——让电脑模型用一次 peer_info',
        wakeOn: '开启自动唤醒',
        wakeOff: '关闭自动唤醒',
        wakeQueue: '排队投递',
        wakeSteer: '插话投递',
        wakeTest: '试一次',
        wakeNotReady: '引擎里没挂上 agents 服务，唤醒不可用（重启 DSH 试试）',
        wakeOk: '已保存',
        phoneNote: '这台是手机端：连接和配对请用 App 输入框上方的「互联」胶囊，这里只显示状态。',
        collab: '两个会话直连',
        collabHint: '在会话顶部点「🔗 互联」，手机那边会自动开一个对应的会话（已有就复用）。开了之后两边模型直接说话，不用在这里选。',
        collabDesktop: '电脑上哪个会话',
        collabPhone: '手机上哪个会话',
        collabNone: '（还没选）',
        sessionClosed: '（未打开）',
        liveTitle: '电脑上开着的会话',
        liveNone: '电脑上现在没有开着的会话',
        phoneNone: '手机上还没报上来说开着的会话（手机要跑新版插件）',
        sayToPhone: '发给手机',
        sayToDesktop: '发给电脑',
        sayPlaceholder: '打一句话，直接送到对面的会话里',
      },
      en: {
        title: 'Link',
        subtitle: 'Desktop side · lets the phone model take over screenshots, taps and device tests',
        guideTitle: 'How to use (3 steps)',
        guide1: '1. Open any session and tap the 🔗 Link button in its header.',
        guide2: '2. The phone opens a matching conversation automatically (it reuses one if it exists) — one phone conversation per desktop session, so nothing gets mixed.',
        guide3: '3. Then just let the two models talk. No session picking in this panel. Pair with the QR code first if the phone is offline.',
        wakeFailed: 'Last delivery failed (the message is still on the workbench and will be retried):',
        online: 'Phone online',
        offline: 'Phone offline',
        device: 'Device',
        listen: 'Listening',
        background: 'Background server',
        scan: 'Scan with the phone',
        scanHint: 'Point the phone camera at this code; pairing lands in the phone’s dsh-go automatically.',
        scanAlt: 'Pairing QR code',
        scanFail: 'No QR code yet — use the pairing string below',
        pairing: 'Pairing string (copy it to the phone capsule when auto-connect fails)',
        copy: 'Copy',
        copied: 'Copied',
        toggles: 'Permissions',
        allowShell: 'Let the phone run commands here',
        allowAsk: 'Let the phone call this desktop’s model',
        allowFiles: 'Let both sides send files',
        allowTest: 'Let the phone run tests automatically',
        start: 'Start background server',
        permit: 'Allow a new phone',
        pendingTitle: 'A phone wants to connect',
        pendingHint: 'Tap Allow and it is paired — nothing to type on the phone',
        approve: 'Allow',
        deny: 'Deny',
        code: 'Pairing code',
        allowOpen: 'Window open — tap Find PC on the phone',
        codeShown: 'Code',
        thread: 'Model conversation',
        chatOpen: 'Open full conversation ↗',
        newToken: 'New pairing string',
        refresh: 'Refresh',
        log: 'Recent log',
        devices: 'Registered phones',
        sessions: 'Phone sessions',
        sessionsNone: 'Nothing dispatched yet (the first phone_ask creates default)',
        agents: 'Agents you can talk to',
        agentsNone: 'Only the desktop and phone models',
        running: 'running',
        stopped: 'stopped',
        none: 'No phone registered yet',
        failed: 'Failed to read',
        loading: 'Reading bridge state…',
        retry: 'Retry',
        phoneNote: 'This machine is the phone side: pair it from the “Phone bridge” capsule in the app. This card is read-only here.',
        collab: 'Two sessions, straight through',
        collabHint: 'Click the link button at the top of a session — the phone opens (or reuses) a matching session automatically. After that the two models just talk, no picking here.',
        collabDesktop: 'Desktop session',
        collabPhone: 'Phone session',
        collabNone: '(none yet)',
        sessionClosed: ' (closed)',
        liveTitle: 'Sessions open on this desktop',
        liveNone: 'Nothing is open on this desktop right now',
        phoneNone: 'The phone has not reported its sessions yet (it needs the newer build)',
        sayToPhone: 'Send to phone',
        sayToDesktop: 'Send to desktop',
        sayPlaceholder: 'Type a line; it lands straight in the session on the other side',
      },
    }

    function Card(React, pack, options) {
      var h = React.createElement
      var useCallback = React.useCallback
      var useEffect = React.useEffect
      var useState = React.useState
      // 'card' = the inline card on the plugin's own page; 'panel' = the page
      // behind the sidebar row, which gets its own title line and no box.
      var surface = (options && options.surface) || 'card'

      return function PhoneBridgeCard(props) {
        var locale = String((pack && pack.locale) || document.documentElement.lang || 'zh')
        var t = locale.toLowerCase().indexOf('en') === 0 ? TEXT.en : TEXT.zh
        var statePair = useState(null)
        var state = statePair[0]
        var setState = statePair[1]
        var errorPair = useState('')
        var error = errorPair[0]
        var setError = errorPair[1]
        var noticePair = React.useState('')
        var notice = noticePair[0]
        var setNotice = noticePair[1]
        var busyPair = useState('')
        var busy = busyPair[0]
        var setBusy = busyPair[1]
        var copiedPair = useState('')
        var copied = copiedPair[0]
        var setCopied = copiedPair[1]
        var wakeIdPair = useState('')
        var wakeId = wakeIdPair[0]
        var setWakeId = wakeIdPair[1]
        var sayPair = useState('')
        var sayText = sayPair[0]
        var setSayText = sayPair[1]
        var sayLevelPair = useState('normal')
        var sayLevel = sayLevelPair[0]
        var setSayLevel = sayLevelPair[1]
        // 用户说「会话还是太长，只保留紧要消息」：默认只显示带暗号的，
        // 普通消息折叠起来，要看得点一下「全部」。
        var showAllPair = useState(false)
        var showAll = showAllPair[0]
        var setShowAll = showAllPair[1]

        var load = useCallback(function () {
          fetch('/phone-bridge/config', { headers: { accept: 'application/json' } })
            .then(function (res) {
              if (!res.ok) throw new Error('HTTP ' + res.status)
              return res.json()
            })
            .then(function (data) {
              setState(data)
              setError('')
            })
            .catch(function (err) {
              setError(t.failed + '：' + err.message)
            })
        }, [])

        useEffect(function () {
          if (!wakeId && state && state.wake && state.wake.sessionId) setWakeId(state.wake.sessionId)
        }, [state, wakeId])

        useEffect(function () {
          load()
          var timer = setInterval(load, 5000)
          return function () {
            clearInterval(timer)
          }
        }, [load])

        function act(body) {
          setBusy(body.action + (body.key || ''))
          fetch('/phone-bridge/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
            .then(function (res) {
              return res.json()
            })
            .then(function (data) {
              if (data.state) setState(data.state)
              if (data.error) setError(data.error)
              else setError('')
              setNotice(data.text || '')
            })
            .catch(function (err) {
              setError(String(err.message || err))
            })
            .then(function () {
              setBusy('')
            })
        }

        function copy(text) {
          var done = function () {
            setCopied(text)
            setTimeout(function () {
              setCopied('')
            }, 1500)
          }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, done)
          } else {
            done()
          }
        }

        var muted = { color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', fontSize: 13 }
        // 不用 space-between：面板右边缘会被 DSH 的装饰挂件挡住，值贴右就看不全了。
        var row = { display: 'flex', gap: 12, alignItems: 'baseline', padding: '5px 0', fontSize: 14 }
        var label = { color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', fontSize: 13, minWidth: 62, flexShrink: 0 }
        var pill = { display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600 }
        var button = {
          appearance: 'none',
          font: 'inherit',
          fontSize: 13,
          cursor: 'pointer',
          padding: '7px 12px',
          borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
          background: 'transparent',
          color: 'inherit',
        }
        var mono = { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, wordBreak: 'break-all' }
        var field = {
          appearance: 'none',
          font: 'inherit',
          fontSize: 13,
          padding: '7px 10px',
          borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
          background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.08))',
          color: 'inherit',
          width: '100%',
          boxSizing: 'border-box',
        }
        // 分块卡片：面板再长也不会糊成一坨，每块自己能认出来。
        var card = {
          marginTop: 14,
          padding: '13px 15px',
          borderRadius: 12,
          border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.16))',
          background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.04))',
        }
        var cardTitle = {
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '0.04em',
          opacity: 0.62,
          marginBottom: 8,
        }
        var dot = function (ok) {
          return {
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: 999,
            marginRight: 6,
            background: ok ? 'var(--dsw-alias-accent-green, #46c07a)' : 'var(--dsw-alias-label-tertiary, #999)',
          }
        }
        // 暗号和 src/thread.mjs 的 LEVELS 一一对应：发消息时选一个，对方
        // 的唤醒语里就会带这个符号。
        var LEVELS = [
          { key: 'normal', mark: '', label: '普通' },
          { key: 'urgent', mark: '❗', label: '等你回' },
          { key: 'question', mark: '❓', label: '要你决定' },
          { key: 'alert', mark: '⚠️', label: '出问题了' },
          { key: 'done', mark: '✅', label: '做完了' },
          { key: 'report', mark: '📋', label: '汇报' },
        ]
        var markOf = function (level) {
          for (var i = 0; i < LEVELS.length; i += 1) if (LEVELS[i].key === level) return LEVELS[i].mark
          return ''
        }
        // ISO timestamps in sessions.json are unreadable in a narrow row; show a
        // short local minute stamp instead, and fall back to the raw value.
        function shortTime(value) {
          if (!value) return ''
          var date = new Date(value)
          if (isNaN(date.getTime())) return String(value)
          var pad = function (n) { return (n < 10 ? '0' : '') + n }
          return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
        }

        var paired = state && state.online
        var onPhone = Boolean(state && state.role === 'phone')
        var children = []
        // On its own page the sidebar already says "互联": the big heading
        // replaces the card's small one instead of stacking on top of it.
        var heading = surface === 'panel' ? t.title : null
        if (onPhone) {
          children.push(h('div', {
            key: 'phone',
            style: Object.assign({}, muted, { padding: '8px 10px', borderRadius: 8, background: 'rgba(127,127,127,0.1)' }),
          }, t.phoneNote))
        }
        children.push(
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
            h('div', { style: { fontSize: surface === 'panel' ? 18 : 14, fontWeight: surface === 'panel' ? 700 : 600 } }, heading || t.title),
            h('span', {
              style: Object.assign({}, pill, {
                background: paired ? 'rgba(52,168,83,0.16)' : 'rgba(242,139,130,0.16)',
                color: paired ? 'var(--dsw-alias-accent-green, #34a853)' : 'var(--dsw-alias-accent-red, #f28b82)',
                display: 'inline-flex',
                alignItems: 'center',
              }),
            }, h('span', { style: dot(paired) }, null), paired ? t.online : t.offline),
            h('span', { style: muted }, t.subtitle),
          ),
        )

        if (error) {
          children.push(h('div', { key: 'err', style: Object.assign({}, muted, { color: 'var(--dsw-alias-accent-red, #f28b82)', padding: '6px 0' }) }, error))
        }
        // 第一次 fetch 还没回来时 state 是 null。以前这里什么都不渲染，用户只看到
        // 一个空面板，以为坏了。给一句「正在读取」+ 重试按钮，至少知道在等什么。
        if (!state) {
          children.push(h('div', { key: 'loading', style: Object.assign({}, muted, { padding: '12px 0 4px', fontSize: 13 }) },
            h('span', null, error || t.loading),
            h('button', { type: 'button', style: Object.assign({}, button, { marginLeft: 10 }), onClick: load }, t.retry),
          ))
        }

        // 面板上东西多，先给一条三步上手，省得用户不知道从哪开始。
        children.push(
          h('details', { key: 'guide', style: { marginTop: 10 } },
            h('summary', { style: Object.assign({}, muted, { cursor: 'pointer', fontSize: 13 }) }, t.guideTitle),
            h('div', { style: { marginTop: 4, fontSize: 13, lineHeight: 1.75, opacity: 0.9 } },
              h('div', null, t.guide1),
              h('div', null, t.guide2),
              h('div', null, t.guide3),
            ),
          ),
        )

        if (state && !onPhone) {
          children.push(
            h('div', { key: 'meta', style: { marginTop: 8 } },
              h('div', { style: row }, h('span', { style: label }, t.device), h('span', null, state.device ? state.device.name + (state.device.platform ? ' · ' + state.device.platform : '') : '—')),
              h('div', { style: row }, h('span', { style: label }, t.listen), h('span', { style: mono }, state.listen)),
              h('div', { style: row }, h('span', { style: label }, t.background), h('span', { style: mono }, state.background ? 'pid ' + state.background.pid + ' · :' + state.background.port : '—')),
            ),
          )

          if (state.pairing && state.pairing.length) {
            children.push(h('div', { key: 'pair', style: { marginTop: 10 } },
              h('div', { key: 'scan', style: { display: 'flex', gap: 14, alignItems: 'center', marginTop: 6, marginBottom: 10, flexWrap: 'wrap' } },
                h('img', {
                  src: '/phone-bridge/qr.svg',
                  width: 132,
                  height: 132,
                  alt: t.scanAlt,
                  style: { borderRadius: 10, background: '#fff', padding: 6, flex: '0 0 auto' },
                }),
                h('div', { key: 'scanText', style: { minWidth: 160, flex: 1 } },
                  h('div', { style: { fontSize: 13, fontWeight: 600 } }, t.scan),
                  h('div', { style: muted }, t.scanHint),
                ),
              ),
              h('div', { style: muted }, t.pairing),
              state.pairing.slice(0, 3).map(function (text) {
                return h('div', { key: text, style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
                  h('code', { style: Object.assign({}, mono, { flex: 1, padding: '6px 8px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.08))' }) }, text),
                  h('button', { type: 'button', style: button, onClick: function () { copy(text) } }, copied === text ? t.copied : t.copy),
                )
              }),
            ))
          }

          var wake = (state && state.wake) || {}
          var wakeTarget = String(wake.target || '')
          children.push(h('div', { key: 'wake', style: card },
            h('div', { style: cardTitle }, t.wake),
            h('div', { style: Object.assign({}, muted, { padding: '2px 0 6px' }) }, t.wakeHint),
            h('div', { style: Object.assign({}, row, { padding: '2px 0' }) },
              h('span', { style: muted }, t.wakeTarget),
              h('span', { style: mono }, wakeTarget ? (wake.targetName || wakeTarget.replace(/^session-/, '').slice(0, 8)) : t.wakeNone),
            ),
            wake.ready === false
              ? h('div', { style: Object.assign({}, muted, { color: 'var(--dsw-alias-accent-red, #f28b82)' }) }, t.wakeNotReady)
              : null,
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 } },
              h('button', { type: 'button', style: button, disabled: Boolean(busy), onClick: function () { act({ action: 'wake', enabled: !wake.enabled }) } }, wake.enabled ? t.wakeOff : t.wakeOn),
              h('button', { type: 'button', style: Object.assign({}, button, wake.mode === 'steer' ? { borderColor: 'var(--dsw-alias-brand-primary, #4c8dff)' } : null), disabled: Boolean(busy), onClick: function () { act({ action: 'wake', enabled: Boolean(wake.enabled), mode: wake.mode === 'steer' ? 'queue' : 'steer' }) } }, wake.mode === 'steer' ? t.wakeSteer : t.wakeQueue),
              h('button', { type: 'button', style: button, disabled: Boolean(busy) || !wakeTarget, onClick: function () { act({ action: 'wake', enabled: true, text: '（来自互联的测试消息）现在能看到吗？' }) } }, t.wakeTest),
            ),
            wake.lastWake
              ? h('div', { style: Object.assign({}, muted, { padding: '6px 0 0' }) }, '✓ ' + shortTime(wake.lastWake.at) + ' · ' + String(wake.lastWake.preview || '').slice(0, 80))
              : null,
            wake.lastError
              ? h('div', { style: { color: 'var(--dsw-alias-accent-red, #f28b82)', padding: '6px 0 0', fontSize: 12, lineHeight: 1.55 } },
                  h('div', null, t.wakeFailed),
                  h('div', { style: { opacity: 0.8, marginTop: 2 } }, wake.lastError))
              : null,
            h('div', { style: cardTitle }, t.registryTitle),
            h('div', { style: Object.assign({}, muted, { padding: '2px 0 6px' }) }, t.registryHint),
            state.registry && state.registry.length
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                  state.registry.slice(0, 5).map(function (row) {
                    return h(
                      'div',
                      { key: row.id, style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
                      h('span', { style: mono }, row.short),
                      h('span', {}, row.name || '—'),
                      row.active ? h('span', { style: { color: 'var(--dsw-alias-accent-green, #81c995)' } }, t.registryActive) : null,
                      h('span', { style: muted }, (row.purpose || '') + (row.calls ? ' · ' + row.calls + '×' : '')),
                    )
                  }),
                )
              : h('div', { style: muted }, t.registryEmpty),
          ))

          children.push(h('div', { key: 'toggles', style: { marginTop: 12 } },
            h('div', { style: muted }, t.toggles),
            ['allowShell', 'allowAsk', 'allowFiles', 'allowTest'].map(function (key) {
              return h('label', { key: key, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 14, cursor: 'pointer' } },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(state.toggles && state.toggles[key]),
                  disabled: Boolean(busy),
                  onChange: function (event) { act({ action: 'toggle', key: key, value: event.target.checked }) },
                }),
                t[key],
              )
            }),
          ))

          var devices = state.devices || []
          children.push(h('div', { key: 'devices', style: { marginTop: 12 } },
            h('div', { style: muted }, t.devices),
            devices.length
              ? devices.map(function (item) {
                  return h('div', { key: item.id + item.at, style: row },
                    h('span', null, item.name + (item.platform ? ' · ' + item.platform : '')),
                    h('span', { style: mono }, item.id),
                  )
                })
              : h('div', { style: Object.assign({}, muted, { padding: '4px 0' }) }, t.none),
          ))

          // Read-only lists straight from the bridge folder: the sessions the
          // phone reuses per project, and the agents it may hand work to.
          var sessions = state.sessions || []
          children.push(h('div', { key: 'sessions', style: { marginTop: 12 } },
            h('div', { style: muted }, t.sessions),
            sessions.length
              ? sessions.slice(0, 6).map(function (item) {
                  return h('div', { key: 'session-' + item.name, style: row },
                    h('span', null, item.name),
                    h('span', { style: mono }, [item.sessionId, shortTime(item.at)].filter(Boolean).join(' · ')),
                  )
                })
              : h('div', { style: Object.assign({}, muted, { padding: '4px 0' }) }, t.sessionsNone),
          ))

          var agents = state.agents || []
          children.push(h('div', { key: 'agents', style: { marginTop: 12 } },
            h('div', { style: muted }, t.agents),
            agents.length
              ? agents.slice(0, 8).map(function (item, index) {
                  return h('div', { key: 'agent-' + (item.id || index), style: row },
                    h('span', null, item.name),
                    h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                      h('span', { style: mono }, item.host === 'phone' ? 'phone' : 'desktop'),
                      h('span', {
                        style: Object.assign({}, pill, {
                          background: item.running ? 'rgba(52,168,83,0.16)' : 'rgba(127,127,127,0.16)',
                          color: item.running ? 'var(--dsw-alias-accent-green, #34a853)' : 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                        }),
                      }, item.running ? t.running : t.stopped),
                    ),
                  )
                })
              : h('div', { style: Object.assign({}, muted, { padding: '4px 0' }) }, t.agentsNone),
          ))

          if (state.log && state.log.length) {
            children.push(h('details', { key: 'log', style: { marginTop: 12 } },
              h('summary', { style: Object.assign({}, muted, { cursor: 'pointer' }) }, t.log),
              h('pre', { style: Object.assign({}, mono, { whiteSpace: 'pre-wrap', margin: '6px 0 0', maxHeight: 180, overflow: 'auto' }) }, state.log.join('\n')),
            ))
          }
        }

        // ── 两个会话直连 ────────────────────────────────────────────────────
        // 这是这一页的主功能：挑一个电脑上的会话、一个手机上的会话，然后直接
        // 说话。消息走的是模型自己用的那条 /thread 管道，所以人和模型发出去的
        // 东西没有区别。
        if (!onPhone && state) {
          var collab = state.collab || {}
          var live = state.allSessions || state.live || []
          // 手机会话上报的 id 一律是 psess:<session-id>，host 为 phone。
          // 别按 kind 筛——readAgents 会把 kind 归成 subagent/model，'session' 不会出现。
          var phoneRows = (state.agents || []).filter(function (item) {
            return item && item.host === 'phone' && String(item.id || '').indexOf('psess:') === 0
          })
          var links = state.links || {}
          var linkTarget = String(
            collab.phoneSessionId
            || (phoneRows[0] ? String(phoneRows[0].id).replace(/^psess:/, '') : '')
            || ''
          )
          var pickCollab = function (patch) {
            var next = {
              action: 'collab',
              desktopSessionId: collab.desktopSessionId || '',
              phoneSessionId: collab.phoneSessionId || '',
              phoneName: collab.phoneName || '',
            }
            Object.keys(patch).forEach(function (key) {
              next[key] = patch[key]
            })
            act(next)
          }
          var send = function (to) {
            var text = String(sayText || '').trim()
            if (!text) return
            act({ action: 'say', to: to, text: text, level: sayLevel })
            setSayText('')
          }
          // 会话里那颗开关到底挂上没有：挂载结果由 client 顶部记在 window 上，
          // 这里如实显示，免得「没出现」时只能猜。
          var slotTries = window.__PB_SLOT_TRIES__ || []
          children.push(h('div', { key: 'slotdiag', style: card },
            h('div', { style: cardTitle }, '会话里的开关'),
            h('div', { style: Object.assign({}, muted, { padding: '2px 0 4px' }) },
              slotTries.length ? '注册尝试：' + slotTries.map(function (row) {
                return (row.ok ? '✓ ' : '✗ ') + row.name + (row.ok ? '' : '（' + row.error + '）')
              }).join('；') : 'client 还没跑到会话插槽这一段（可能要重启 DSH 让新前端生效）'),
            h('div', { style: Object.assign({}, muted, { padding: '2px 0 0' }) },
              '按钮在会话界面右上角工具栏。这里没有任何 ✓ 说明这个 DSH 版本的会话插槽对第三方插件不开放，那就只能走这个侧栏面板。')))
          children.push(h('div', { key: 'collab', style: card },
            h('div', { style: cardTitle }, t.collab),
            // 手机没连上时给出可操作的排查步骤（最常见的三种原因）。
            paired ? null : h('div', { style: Object.assign({}, muted, { padding: '2px 0 6px', lineHeight: 1.75 }) },
              h('div', { style: { color: 'var(--dsw-alias-accent-red, #e5484d)', marginBottom: 4 } },
                '手机现在没连上。按顺序查这三步：'),
              h('div', {}, '① 手机和电脑连的是同一个 WiFi'),
              h('div', {}, '② 电脑防火墙放行 8787 端口（管理员 PowerShell 跑一次，命令在下面）'),
              h('div', {}, '③ 手机上 DSH Go 开着，并且点过「连电脑」')),
            paired ? null : h('div', {
              style: {
                fontSize: 11,
                fontFamily: 'ui-monospace, Consolas, monospace',
                background: 'rgba(127,127,127,0.12)',
                padding: '7px 9px',
                borderRadius: 6,
                marginBottom: 9,
                wordBreak: 'break-all',
                lineHeight: 1.5,
              },
            }, "New-NetFirewallRule -DisplayName 'dsh-phone-bridge' -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private"),
            h('div', { style: Object.assign({}, muted, { padding: '2px 0 8px' }) }, t.collabHint),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'stretch' } },
              h('select', {
                value: sayLevel,
                title: '这条消息有多要紧：对方的唤醒语里会带这个符号',
                style: Object.assign({}, field, { width: 'auto', flex: '0 0 auto', minWidth: 108 }),
                onChange: function (event) { setSayLevel(event.target.value) },
              },
                LEVELS.map(function (item) {
                  return h('option', { key: item.key, value: item.key }, (item.mark ? item.mark + ' ' : '') + item.label)
                }),
              ),
              h('input', {
                value: sayText,
                placeholder: t.sayPlaceholder,
                style: Object.assign({}, field, { flex: '1 1 200px', width: 'auto' }),
                onChange: function (event) { setSayText(event.target.value) },
                onKeyDown: function (event) { if (event.key === 'Enter') send('phone') },
              }),
              h('button', { type: 'button', style: button, disabled: Boolean(busy) || !String(sayText || '').trim(), onClick: function () { send('phone') } }, t.sayToPhone),
            ),
          ))
        }

        // 没有对话时也留一块：空着会让人以为功能坏了。
        if (!onPhone && state) {
          // 只渲染最近 24 条：面板是给人扫一眼的，不是聊天记录管理器。
          var allThread = state.thread || []
          var marked = allThread.filter(function (row) { return markOf(row.level) !== '' })
          var visible = (showAll ? allThread : marked).slice(-24)
          // 用户要「一个会话一个专用」：对话按电脑会话分组，一眼分清哪句属于哪边。
        var bubble = function (row) {
          var mine = row.from !== 'phone'
          var mark = markOf(row.level)
          return h('div', {
            key: 'thread-' + row.seq,
            style: {
              alignSelf: mine ? 'flex-end' : 'flex-start',
              maxWidth: '88%',
              padding: '7px 10px',
              borderRadius: 10,
              fontSize: 13,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: mine ? 'rgba(76,141,255,0.14)' : 'rgba(127,127,127,0.10)',
            },
          },
            h('div', { style: { fontSize: 11, opacity: 0.6, marginBottom: 2 } },
              (mark ? mark + ' ' : '') + (mine ? '💻 我' : '📱 手机') + (row.at ? ' · ' + fmtClock(row.at) : '')),
            String(row.text).slice(0, 400),
          )
        }
        var sessionLabel = function (id) {
          var list = state.allSessions || []
          for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) {
              var row = list[i]
              return row.title || row.name || (row.cwd ? String(row.cwd).split(/[\\/]/).filter(Boolean).pop() : '') || String(id).replace(/^session-/, '').slice(0, 8)
            }
          }
          return String(id).replace(/^session-/, '').slice(0, 8)
        }
        children.push(h('div', { key: 'thread', style: card },
            h('div', { style: Object.assign({}, cardTitle, { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }) },
              h('span', null, t.thread),
              h('span', { style: { fontWeight: 400, display: 'flex', gap: 8, alignItems: 'baseline' } },
                h('button', {
                  type: 'button',
                  style: Object.assign({}, button, { padding: '2px 8px', fontSize: 12, opacity: 0.75 }),
                  onClick: function () { setShowAll(!showAll) },
                }, showAll ? '只看紧要' : '全部 ' + allThread.length + ' 条'),
                h('span', null, visible.length + ' / ' + (showAll ? allThread.length : marked.length)),
              ),
            ),
            visible.length ? null : h('div', { style: Object.assign({}, muted, { padding: '6px 0 2px' }) },
              showAll ? '还没有对话。上面选好两边会话，在输入框里说一句试试。' : '最近没有紧要消息（带 ❗❓⚠️✅📋 的那种）。点上面「全部」看完整对话。'),
            (function () {
              var groups = []
              var index = {}
              visible.forEach(function (row) {
                var key = row.desktopId || ''
                if (!index[key]) { index[key] = { key: key, rows: [] }; groups.push(index[key]) }
                index[key].rows.push(row)
              })
              if (!groups.length) return null
              return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, marginTop: 4, maxHeight: 340, overflowY: 'auto', paddingRight: 4 } },
                groups.map(function (group) {
                  return h('div', { key: 'grp-' + (group.key || 'none'), style: { display: 'flex', flexDirection: 'column', gap: 7 } },
                    h('div', { style: { fontSize: 11, fontWeight: 700, opacity: 0.5, letterSpacing: '0.04em', margin: '2px 0', alignSelf: 'flex-start' } },
                      group.key ? '会话 · ' + sessionLabel(group.key) : '未分会话'),
                    group.rows.map(bubble),
                  )
                }),
              )
            })(),
            state.workbenchUrl
              ? h('a', { key: 'chat-open', href: state.workbenchUrl, target: '_blank', rel: 'noreferrer', style: { display: 'inline-block', marginTop: 6, fontSize: 13, color: 'var(--dsw-alias-brand-primary, #4c8dff)' } }, t.chatOpen)
              : null,
          ))
        }
        if (!onPhone && state && state.pendingPair) {
          children.push(h('div', {
            key: 'pending',
            style: { marginTop: 12, padding: '10px 12px', borderRadius: 10, background: 'rgba(76,141,255,0.12)' },
          },
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, t.pendingTitle),
            h('div', { style: Object.assign({}, muted, { marginTop: 2 }) },
              (state.pendingPair.name || '一台手机') + (state.pendingPair.platform ? ' · ' + state.pendingPair.platform : '')),
            h('div', { style: muted }, t.pendingHint),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
              h('button', { type: 'button', style: button, disabled: Boolean(busy), onClick: function () { act({ action: 'approve' }) } }, t.approve),
              h('button', { type: 'button', style: button, disabled: Boolean(busy), onClick: function () { act({ action: 'deny' }) } }, t.deny),
            ),
          ))
        }
        if (notice) children.push(h('div', { key: 'notice', style: { marginTop: 10, fontSize: 13, color: 'var(--dsw-alias-label-secondary, #666)' } }, notice))
        // 这几个是偶尔才点的维护动作，默认收起来，别让它们抢走日常操作的注意力。
        if (!onPhone) children.push(h('details', { key: 'actions', style: { marginTop: 14 } },
          h('summary', { style: { cursor: 'pointer', fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', opacity: 0.62 } }, '维护'),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
            h('button', { type: 'button', style: button, disabled: Boolean(busy), onClick: function () { act({ action: 'permit' }) } }, t.permit),
            h('button', { type: 'button', style: button, disabled: Boolean(busy), onClick: function () { act({ action: 'code' }) } }, t.code),
            h('button', { type: 'button', style: button, disabled: Boolean(busy), onClick: function () { act({ action: 'start' }) } }, t.start),
            h('button', { type: 'button', style: button, disabled: Boolean(busy), onClick: function () { act({ action: 'token' }) } }, t.newToken),
            h('button', { type: 'button', style: button, disabled: Boolean(busy), onClick: load }, t.refresh),
          ),
        ))

        if (surface === 'panel') {
          // A sidebar page: scrolls on its own, no border, readable measure.
          return h('div', {
            style: {
              height: '100%',
              overflow: 'auto',
              padding: '18px 22px 28px',
              boxSizing: 'border-box',
              fontSize: 14,
            },
          }, h('div', { style: { maxWidth: 760, margin: '0 auto' } }, children))
        }

        return h('div', {
          style: {
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
            borderRadius: 12,
            padding: '14px 16px',
            background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
          },
        }, children)
      }
    }

    // Sidebar row icon. The host renders a panel's icon through its
    // `sidebar.panel.icon` factory, which passes only { size, active }, so the
    // glyph has to fit either sidebar width: a phone next to a desktop, drawn
    // with currentColor so it follows the row's rest/hover/active colour.
    function Icon(React, owner) {
      var h = React.createElement
      var size = Number(owner && owner.size) || 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { display: 'block' },
      },
        h('rect', { key: 'desk', x: 2, y: 6, width: 12, height: 8, rx: 1.8 }),
        h('path', { key: 'stand', d: 'M6 18h5' }),
        h('rect', { key: 'phone', x: 16, y: 8, width: 6, height: 11, rx: 1.4 }),
        h('path', { key: 'dot', d: 'M18.8 16.6h.4' }),
      )
    }

    // 会话头部的小开关。用户 m04337：「直接做到会话里面，一端打开另一端同步，
    // 不用手动选」。挂进 session-scoped 插槽 conversation.session.header.actions，
    // 该插槽注册时用 inject: sessionId => ... 把当前会话 id 递过来。
    function LinkSwitch(React, pack) {
      var h = React.createElement
      var useEffect = React.useEffect
      var useState = React.useState
      return function PhoneBridgeLink(props) {
        var sessionId = String((props && props.sessionId) || '')
        var statePair = useState(null)
        var state = statePair[0]
        var setState = statePair[1]
        var busyPair = useState(false)
        var busy = busyPair[0]
        var setBusy = busyPair[1]
        var tipPair = useState('')
        var tip = tipPair[0]
        var setTip = tipPair[1]

        function load() {
          fetch('/phone-bridge/config', { headers: { accept: 'application/json' } })
            .then(function (res) { return res.ok ? res.json() : null })
            .then(function (data) { if (data) setState(data) })
            .catch(function () {})
        }
        useEffect(function () { load() }, [sessionId])

        if (!sessionId) return null
        // 手机端的开关表是从电脑同步过来的（peerLinks），键仍是电脑会话 id。
        var onPhone = String((state && state.role) || '').toLowerCase() === 'phone'
        var links = (state && (onPhone ? state.peerLinks : state.links)) || {}
        var linkedKey = onPhone
          ? Object.keys(links).filter(function (key) { return String((links[key] || {}).phoneId) === sessionId })[0]
          : (links[sessionId] ? sessionId : '')
        var on = !!linkedKey

        function toggle() {
          if (busy) return
          setBusy(true)
          setTip('')
          var body = onPhone
            ? { action: 'linkRemote', phoneId: sessionId, off: on }
            : { action: 'link', desktopId: sessionId, off: on }
          if (!onPhone && !on && state && state.collab && state.collab.phoneSessionId) {
            body.phoneId = state.collab.phoneSessionId
          }
          return fetch('/phone-bridge/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }).then(function (res) { return res.json() })
            .then(function (data) {
              setBusy(false)
              if (!data || data.ok === false) {
                setTip(String((data && (data.text || data.error)) || '没成功'))
                return
              }
              setTip(String(data.text || ''))
              load()
            })
            .catch(function (err) { setBusy(false); setTip(String((err && err.message) || err)) })
        }

        var color = on ? 'var(--dsw-alias-accent-blue, #4c8dff)' : 'inherit'
        return h('button', {
          type: 'button',
          onClick: toggle,
          disabled: busy,
          title: tip || (on ? '这个会话已和手机上的会话互联，点一下断开' : '把这个会话和手机上的会话连起来，之后两边模型直接对话'),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            height: 26,
            padding: '0 9px',
            borderRadius: 13,
            cursor: busy ? 'default' : 'pointer',
            fontSize: 12,
            lineHeight: 1,
            whiteSpace: 'nowrap',
            border: '1px solid ' + (on ? color : 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))'),
            background: on ? 'rgba(76,141,255,0.14)' : 'transparent',
            color: color,
            opacity: busy ? 0.6 : 1,
          },
        }, (on ? '\u{1F517} ' : '') + (on ? '互联中' : '互联'))
      }
    }

    function apply(ctx) {
      if (typeof ctx.inject !== 'function') return
      var pack = { locale: '' }
      ctx.inject(['locale'], function (scope) {
        if (scope.locale && typeof scope.locale.get === 'function') {
          try {
            pack.locale = scope.locale.get()
          } catch (error) {
            pack.locale = ''
          }
        }
      })
      ctx.inject(['slots'], function (scope) {
        var React
        try {
          React = require('react')
        } catch (error) {
          console.error('[phone-bridge] card skipped: ' + error)
          return
        }
        // The bundle now carries the package name dsh-phone-bridge (0.6.3+); older
        // installs mounted the card under the old web package name.
        scope.slots.inject('plugins.bundle.config', function* () {
          yield scope.slots.register({ name: 'plugins.bundle.config', key: PACKAGE }, Card(React, pack, { surface: 'card' }))
          yield scope.slots.register({ name: 'plugins.bundle.config', key: 'dsh-phone-bridge' }, Card(React, pack, { surface: 'card' }))
        })
        // The same page as a sidebar entry (next to 插件 / 插件市场), so the
        // bridge is one click away instead of buried in a plugin detail page.
        scope.slots.inject('sidebar.panellist', function* () {
          yield scope.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 2, label: function () { return pack.locale && String(pack.locale).toLowerCase().indexOf('en') === 0 ? 'Phone bridge' : '互联' }, locale: '' }, function (owner) {
            return Icon(React, owner || {})
          })
          yield scope.slots.register({ name: 'main', key: PANEL_ID, inject: function () { return {} } }, Card(React, pack, { surface: 'panel' }))
        })
        // 会话界面里的「互联」开关。host 版本之间可用插槽不完全一样，
        // 所以按优先级逐个试，谁先挂上算谁的；挂载结果记在 window 上，
        // 侧栏面板会把它显示出来（看不见按钮时直接看面板就知道卡在哪）。
        var TRIES = window.__PB_SLOT_TRIES__ || (window.__PB_SLOT_TRIES__ = [])
        var Switch = LinkSwitch(React, pack)
        // 诊断时三个都挂过：确认第三方包能注册会话插槽，但也因此一次冒出三个按钮。
        // 收敛成一个 —— 会话顶部工具栏那颗。
        var candidates = [
          { name: 'conversation.session.header.actions', order: 40 },
        ]
        candidates.forEach(function (candidate) {
          try {
            scope.slots.inject(candidate.name, function* () {
              yield scope.slots.register({
                name: candidate.name,
                id: 'phone-bridge-link',
                order: candidate.order,
                locale: '',
                inject: function (sessionId) { return { sessionId: sessionId } },
              }, Switch)
            })
            TRIES.push({ name: candidate.name, ok: true, at: Date.now() })
          } catch (error) {
            TRIES.push({ name: candidate.name, ok: false, error: String((error && error.message) || error), at: Date.now() })
            console.error('[phone-bridge] ' + candidate.name + ' skipped: ' + error)
          }
        })
      })
    }

    exports.apply = apply
    exports.inject = []
    window.__phoneBridgeModule = module.exports
    return module.exports
}

;['@undertale11121/dsh-phone-bridge', 'dsh-phone-bridge', 'dsh-phone-bridge-web'].forEach(function (id) {
  window.__ModuleLoader__.load({ id: id, factory: __buildPhoneBridge })
})