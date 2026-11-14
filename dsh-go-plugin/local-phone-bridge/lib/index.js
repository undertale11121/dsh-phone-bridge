// 手机桥接面板：把 phone-bridge 的状态和配对操作放进 dsh-go 原生界面。
// 数据来自本机桥接进程的配置页接口（默认 http://127.0.0.1:8789），
// 桥接没在跑时退回去读配置文件，尽量让界面说人话。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SETUP = process.env.PHONE_BRIDGE_SETUP_URL || 'http://127.0.0.1:8789'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PHONE_CONFIG = path.join(DSH_HOME, 'phone-bridge', 'phone.json')

export const name = 'local-phone-bridge'

const brief = (text, max = 40) => {
  const one = String(text || '').replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

async function api(pathname, method = 'GET', body) {
  const attempt = async () => {
    const res = await fetch(SETUP + pathname, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(2500),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }
  try {
    return await attempt()
  } catch (error) {
    // 首次安装/刚重启时 bridge 正在被引擎拉起来，这一两秒里点按钮会白失败。
    // 等 700ms 再试一次，能救掉大部分「第一次找电脑说桥接没运行」。
    await new Promise((resolve) => setTimeout(resolve, 700))
    return attempt()
  }
}

function offlineState() {
  let endpoint = ''
  let paired = false
  try {
    const config = JSON.parse(fs.readFileSync(PHONE_CONFIG, 'utf8'))
    endpoint = config.url || config.autoUrl || ''
    paired = Boolean(endpoint)
  } catch {
    // 没配置也算正常：还没配对过。
  }
  return {
    banner: '桥接进程没在运行：在 App 的「引擎」页重启一次引擎就会起来',
    tone: 'warn',
    role: '手机端',
    desktop: '未知',
    url: endpoint || '（未设置）',
    self: '—',
    hint: paired ? '配置里有地址，但桥接没跑，连不上电脑。' : '点输入框上方的「连电脑」自动搜索并配对（电脑上点「允许」即可）。',
    found: [],
    foundHint: '桥接没在运行，找到电脑也连不上。',
    agents: [],
  }
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    // 胶囊：一键连电脑（先自动找，再让电脑上点「允许」）。
    ctx.dshGo.on('bridge-connect', async () => {
      try {
        const result = await api('/api/action', 'POST', { id: 'connect', fields: {} })
        return { toast: brief(result?.text || '已发出配对请求', 44), open: 'panel:phone-bridge' }
      } catch {
        return { toast: '没找到电脑：先让电脑开着桥接，两边同一个 Wi-Fi' }
      }
    })

    // 胶囊：打开面板。
    ctx.dshGo.on('bridge-panel', () => ({ open: 'panel:phone-bridge' }))

    ctx.dshGo.panel('phone-bridge', {
      view: (scope, caps) => {
        const zh = !String(caps?.locale || '').startsWith('en')
        return {
          v: 1,
          type: 'stack',
          title: zh ? '互联' : 'Link',
          children: [
            { type: 'callout', text: { $: 'data.banner' }, tone: { $: 'data.tone' } },
            {
              type: 'keyValue',
              items: [
                [zh ? '角色' : 'Role', { $: 'data.role' }],
                [zh ? '电脑' : 'Desktop', { $: 'data.desktop' }],
                [zh ? '地址' : 'Address', { $: 'data.url' }],
                [zh ? '本机对外' : 'This device', { $: 'data.self' }],
              ],
            },
            { type: 'text', text: { $: 'data.hint' }, tone: 'muted' },
            {
              type: 'actions',
              items: [
                { label: zh ? '找电脑' : 'Find PC', action: 'find', style: 'primary' },
                { label: zh ? '连第一台' : 'Connect', action: 'connect' },
                { label: zh ? '测试连接' : 'Test', action: 'ping' },
                { label: zh ? '断开配对' : 'Disconnect', action: 'unpair' },
              ],
            },
            { type: 'text', text: zh ? '找到的电脑' : 'Found PCs', size: 'caption', tone: 'muted' },
            { type: 'list', items: { $: 'data.found' } },
            { type: 'text', text: { $: 'data.foundHint' }, tone: 'muted' },
            { type: 'text', text: zh ? '可以对话的 agent' : 'Agents', size: 'caption', tone: 'muted' },
            { type: 'list', items: { $: 'data.agents' } },
          ],
        }
      },
      data: (scope, emit) => {
        const zh = !String(scope?.locale || process.env.DSH_GO_LOCALE || '').startsWith('en')
        let stopped = false
        const push = () => {
          api('/api/state')
            .then((state) => {
              if (stopped) return
              const value = (label) => {
                const row = (state.rows || []).find((item) => item.label === label)
                return row ? String(row.value) : '—'
              }
              const pairs = (state.rows || []).filter((item) => item.label === '自动连接').map((item) => item.value)
              const found = (state.rows || [])
                .filter((item) => item.label === '发现')
                .map((item) => ({ title: String(item.value).replace(/\s+/g, ' '), subtitle: zh ? '局域网里发现的电脑' : 'found on the LAN' }))
              const agentRow = (state.rows || []).find((item) => item.label === 'Agent')
              const agentItems = agentRow
                ? String(agentRow.value)
                    .replace(/^\d+ 个：/, '')
                    .split('、')
                    .filter(Boolean)
                    .map((name) => ({ title: name, subtitle: zh ? '可以让手机模型找它对话' : 'an agent you can talk to' }))
                : []
              emit({
                found,
                foundHint: found.length
                  ? zh
                    ? '点「连第一台」：电脑的「互联」卡片会冒出「有手机想连接」，在那边点「允许」就配好了。'
                    : 'Tap Connect: the desktop card asks “A phone wants to connect” — tap Allow there.'
                  : zh
                    ? '点「找电脑」会自动搜索同一网络里的电脑（电脑端开着桥接就行）。'
                    : 'Tap Find PC to search this network for a desktop running the bridge.',
                agents: agentItems,
                banner: state.rows?.find((r) => r.tone === 'bad')
                  ? '还没连上电脑：点下方「找电脑」，选中后电脑上点「允许」就配好了（不用输配对码）'
                  : '已连上电脑，可以直接派活给手机了',
                tone: state.rows?.find((r) => r.tone === 'bad') ? 'warn' : 'good',
                role: '手机端（dsh-go）',
                desktop: value('电脑'),
                url: value('地址'),
                self: pairs.join('、') || value('模式'),
                hint: state.subtitle || '',
              })
            })
            .catch(() => {
              if (!stopped) emit(offlineState())
            })
        }
        push()
        const timer = setInterval(push, 5000)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      },
      actions: {
        find: async () => {
          try {
            const result = await api('/api/action', 'POST', { id: 'find', fields: {} })
            return { toast: brief(String(result?.text || '').split('\n')[0], 44), refresh: true }
          } catch {
            return { toast: '桥接还没起来：等两秒再点一次，或重启手机引擎' }
          }
        },
        connect: async () => {
          try {
            const result = await api('/api/action', 'POST', { id: 'connect', fields: {} })
            return { toast: brief(result?.text || '已连接', 40), refresh: true }
          } catch {
            return { toast: '没连上：先在电脑上点「允许新手机配对」' }
          }
        },
        refresh: async () => {
          try {
            await api('/api/state')
            return { refresh: true }
          } catch {
            return { toast: '桥接还没起来：等两秒再点一次，或重启手机引擎' }
          }
        },
        ping: async () => {
          try {
            const result = await api('/api/action', 'POST', { id: 'ping', fields: {} })
            return { toast: brief(result?.text || '已发送'), refresh: true }
          } catch {
            return { toast: '桥接还没起来，重启一下手机引擎' }
          }
        },
        unpair: async () => {
          try {
            await api('/api/action', 'POST', { id: 'unpair', fields: {} })
            return { toast: '已断开并清除配对', refresh: true }
          } catch {
            return { toast: '桥接还没起来：等两秒再点一次，或重启手机引擎' }
          }
        },
      },
    })
  })
}