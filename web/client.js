// Browser half: a card on the Plugins page that talks to /phone-bridge/config.
// Hand-written in the lazy-CJS bundle protocol (no build step, no imports from
// dsh client packages) so the zip the user copies to Windows needs no toolchain.
// 按包名注册：桌面装的包叫 dsh-phone-bridge，手机上那个还叫 dsh-phone-bridge-web。
// 两个 id 挂同一份导出，但只构建一次 —— 否则 apply 跑两遍，每条消息投两次。
function __buildPhoneBridge(require) {
  if (window.__phoneBridgeModule) return window.__phoneBridgeModule
    var module = { exports: {} }
    var exports = module.exports

    var PACKAGE = 'dsh-phone-bridge-web'
    // The id of the sidebar row and of its `main` page. It must not collide
    // with the host's own panels (`plugins`, `dsh-market`, …).
    var PANEL_ID = 'phone-bridge'
    var TEXT = {
      zh: {
        title: '互联',
        subtitle: '电脑端 · 和手机上的模型一起干活：它截图、点按、跑真机测试，两边也能互相派活',
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
        collabHint: '选定之后，消息不再丢在工作台上等人来取，而是直接投进对方开着的会话——两边模型都能像人一样发话。',
        collabDesktop: '电脑上哪个会话',
        collabPhone: '手机上哪个会话',
        collabNone: '（还没选）',
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
        phoneNote: 'This machine is the phone side: pair it from the “Phone bridge” capsule in the app. This card is read-only here.',
        collab: 'Two sessions, straight through',
        collabHint: 'Once picked, a message is delivered into the session open on the other side instead of waiting on the workbench — both models can just talk.',
        collabDesktop: 'Desktop session',
        collabPhone: 'Phone session',
        collabNone: '(none yet)',
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
        var row = { display: 'flex', gap: 12, justifyContent: 'space-between', padding: '5px 0', fontSize: 14 }
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
              }),
            }, paired ? t.online : t.offline),
            h('span', { style: muted }, t.subtitle),
          ),
        )

        if (error) {
          children.push(h('div', { key: 'err', style: Object.assign({}, muted, { color: 'var(--dsw-alias-accent-red, #f28b82)', padding: '6px 0' }) }, error))
        }

        if (state && !onPhone) {
          children.push(
            h('div', { key: 'meta', style: { marginTop: 8 } },
              h('div', { style: row }, h('span', { style: muted }, t.device), h('span', null, state.device ? state.device.name + (state.device.platform ? ' · ' + state.device.platform : '') : '—')),
              h('div', { style: row }, h('span', { style: muted }, t.listen), h('span', { style: mono }, state.listen)),
              h('div', { style: row }, h('span', { style: muted }, t.background), h('span', { style: mono }, state.background ? 'pid ' + state.background.pid + ' · :' + state.background.port : '—')),
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
          children.push(h('div', { key: 'wake', style: { marginTop: 12 } },
            h('div', { style: muted }, t.wake),
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
              ? h('div', { style: Object.assign({}, muted, { color: 'var(--dsw-alias-accent-red, #f28b82)', padding: '6px 0 0' }) }, wake.lastError)
              : null,
            h('div', { style: { marginTop: 12, fontWeight: 600 } }, t.registryTitle),
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
          var live = state.live || []
          var phoneRows = (state.agents || []).filter(function (item) {
            return item && item.kind === 'session' && item.host === 'phone'
          })
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
            act({ action: 'say', to: to, text: text })
            setSayText('')
          }
          children.push(h('div', { key: 'collab', style: { marginTop: 16 } },
            h('div', { style: { fontSize: 14, fontWeight: 600 } }, t.collab),
            h('div', { style: Object.assign({}, muted, { padding: '2px 0 8px' }) }, t.collabHint),
            h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
              h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, flex: '1 1 220px', minWidth: 0 } },
                h('span', { style: muted }, t.collabDesktop),
                h('select', {
                  value: collab.desktopSessionId || '',
                  style: field,
                  onChange: function (event) { pickCollab({ desktopSessionId: event.target.value }) },
                },
                  h('option', { value: '' }, t.collabNone),
                  live.map(function (item) {
                    // 显示左侧栏里那个会话名字（title），没有才退到手动名字 / 目录名
                    var folder = String(item.cwd || '').split(/[\\/]/).filter(Boolean).pop() || ''
                    var label = item.title || item.name || folder || '会话'
                    if (item.title && item.name && item.name !== item.title) label += ' · ' + item.name
                    return h('option', { key: item.id, value: item.id, title: item.cwd || item.id }, label)
                  }),
                ),
                live.length ? null : h('div', { style: muted }, t.liveNone),
              ),
              h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, flex: '1 1 220px', minWidth: 0 } },
                h('span', { style: muted }, t.collabPhone),
                h('select', {
                  value: collab.phoneSessionId || '',
                  style: field,
                  onChange: function (event) { pickCollab({ phoneSessionId: event.target.value }) },
                },
                  h('option', { value: '' }, t.collabNone),
                  phoneRows.map(function (item) {
                    var label = item.name || (item.title || '手机会话')
                    return h('option', { key: item.id, value: String(item.id).replace(/^psess:/, ''), title: item.cwd || String(item.id).replace(/^psess:/, '') }, label)
                  }),
                ),
                phoneRows.length ? null : h('div', { style: muted }, t.phoneNone),
              ),
            ),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
              h('input', {
                value: sayText,
                placeholder: t.sayPlaceholder,
                style: Object.assign({}, field, { flex: '1 1 240px', width: 'auto' }),
                onChange: function (event) { setSayText(event.target.value) },
                onKeyDown: function (event) { if (event.key === 'Enter') send('phone') },
              }),
              h('button', { type: 'button', style: button, disabled: Boolean(busy) || !String(sayText || '').trim(), onClick: function () { send('phone') } }, t.sayToPhone),
            ),
          ))
        }

        if (!onPhone && state && state.thread && state.thread.length) {
          children.push(h('div', { key: 'thread', style: { marginTop: 12 } },
            h('div', { style: muted }, t.thread),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 } },
              state.thread.map(function (row) {
                return h('div', { key: 'thread-' + row.seq, style: { fontSize: 13 } },
                  (row.from === 'phone' ? '📱 ' : '💻 ') + String(row.text).slice(0, 160))
              }),
            ),
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
        if (!onPhone) children.push(h('div', { key: 'actions', style: { display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' } },
          h('button', { type: 'button', style: button, disabled: Boolean(busy), onClick: function () { act({ action: 'permit' }) } }, t.permit),
          h('button', { type: 'button', style: button, disabled: Boolean(busy), onClick: function () { act({ action: 'code' }) } }, t.code),
          h('button', { type: 'button', style: button, disabled: Boolean(busy), onClick: function () { act({ action: 'start' }) } }, t.start),
          h('button', { type: 'button', style: button, disabled: Boolean(busy), onClick: function () { act({ action: 'token' }) } }, t.newToken),
          h('button', { type: 'button', style: button, disabled: Boolean(busy), onClick: load }, t.refresh),
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
      })
    }

    exports.apply = apply
    exports.inject = []
    window.__phoneBridgeModule = module.exports
    return module.exports
}

;['dsh-phone-bridge', 'dsh-phone-bridge-web'].forEach(function (id) {
  window.__ModuleLoader__.load({ id: id, factory: __buildPhoneBridge })
})