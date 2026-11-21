// Peer link: keeps `phone.json.peers` alive without the user doing anything.
//
//  * when there is no explicit pairing (url+token), the side that the phone tool
//    reports as "itself" can be autoconnected without a token at all:
//    `asHost` (an address this device serves) + `peers` (addresses to try).
//  * the link between two dsh-phone-bridge halves is deterministic: the lower
//    endpoint dials the higher one, the higher one listens. That needs no shared
//    secret beyond the per-connection challenge signature.
//
// All state lives in $DSH_HOME/phone-bridge/peer.json so both tools can show it.
import fs from 'node:fs'
import path from 'node:path'
import { bridgeDir, compareEndpoint, ensureDir, lanAddresses, log, readJson, writeJson } from './util.mjs'

export function peerConfigPath() {
  return path.join(bridgeDir(), 'peer.json')
}

export function loadPeerConfig() {
  return readJson(peerConfigPath(), {}) || {}
}

export function savePeerConfig(value) {
  writeJson(peerConfigPath(), value)
}

// 回环/任意地址都不是「对端」：连它等于连自己，写进 pairs 会让自动重连永远失败。
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', '::', '[::]']

export function ensurePeerLink({ getConfig, identity, isDial, endpoint, onOpen, onAutoUrl }) {
  let runtime = null
  let timer = null
  let scanning = false

  return {
    info() {
      const config = getConfig() || {}
      const cfg = loadPeerConfig()
      // 必须用真实本机地址比较：0.0.0.0 比任何真实 IP 都小，会让 primary 恒 false，
      // 于是手机连过一次、pairs 里有记录之后，就再也不主动拨号
      // （切 Wi-Fi / 电脑重启后必须手动重新配对，就是这么来的）。
      const myEndpoints = (cfg.pairs || []).filter((p) => p.host).map((p) => `${p.host}:${p.port}`)
      const selfHost = String(config.asHost?.host || '')
      const selfPort = Number(config.asHost?.port || 0)
      const mine = selfHost && selfPort ? `${selfHost}:${selfPort}` : ''
      const target = [...myEndpoints].sort()[0]
      const primary = target && mine ? compareEndpoint(mine, target) > 0 : true
      return { pairs: cfg.pairs || [], primary, self: config.asHost || null }
    },

    start() {
      const cfg = loadPeerConfig()
      if (cfg.enabled === false) return
      timer = setInterval(() => {
        this.tick().catch((error) => log(`链路维护失败：${error?.message || error}`))
      }, 30_000)
      timer.unref?.()
      // 首轮失败也要留痕：否则「配对好了但连不上」会完全没有日志可查。
      this.tick().catch((error) => log(`首轮链路检查失败：${error?.message || error}`))
    },

    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },

    reconfigure() {
      // 立即重读配置并重扫一遍：换 Wi-Fi / 用户改了地址后不用等下一个 30 秒。
      this.tick().catch((error) => log(`重新配置后检查失败：${error?.message || error}`))
    },

    async tick() {
      if (scanning) return
      scanning = true
      try {
        const config = getConfig() || {}
        const cfg = loadPeerConfig()
        // 运行中把 peer.json 改成 enabled:false 也要真的停下（以前只 start() 检查一次）。
        if (cfg.enabled === false) {
          this.stop()
          return
        }
        const pairs = (Array.isArray(cfg.pairs) ? cfg.pairs : []).filter(
          // 回环地址是测试留下的噪音：连它等于连自己，会让手机一直「重试」
          (pair) => pair?.host && !LOOPBACK_HOSTS.includes(String(pair.host)),
        )
        let changed = false
        for (const pair of pairs) {
          if (!pair.host || !pair.port) continue
          const beacon = await probe(pair.host, pair.port)
          if (beacon?.ok) {
            pair.name = beacon.name
            pair.lastSeen = new Date().toISOString()
            changed = true
            if (!config.url && !config.autoUrl && !config.asHost) {
              const auto = `http://${pair.host}:${pair.port}`
              config.autoUrl = auto
              // 只改内存不落盘的话，App 重启后又变回「配对过但永不拨号」。
              try {
                onAutoUrl?.(auto)
              } catch (error) {
                log(`自动连接地址落盘失败：${error?.message || error}`)
              }
              log(`自动连接对端：${beacon.name || pair.host}（${pair.host}:${pair.port}）`)
            }
          }
        }
        // Refresh our advertised address so the other side can reach us.
        if (config.asHost) {
          const iface = lanAddresses()[0]
          if (iface && iface.address !== config.asHost.host) config.asHost.host = iface.address
        }
        // Remember who was in front of us so reconnects keep working after a wifi change.
        if (isDial() && endpoint() && pairs.length === 0) {
          const url = new URL(endpoint())
          const host = url.hostname
          // 回环不是「对端」：写进去会让手机永远连自己（旧版本的测试残留就是这样来的）
          if (host && !LOOPBACK_HOSTS.includes(host)) {
            cfg.pairs = [{ host, port: Number(url.port || 8787), name: '已配对的对象', lastSeen: new Date().toISOString() }]
            changed = true
          }
        }
        if (changed) savePeerConfig(cfg)
      } finally {
        scanning = false
      }
    },
  }
}

function probe(host, port, timeoutMs = 1500) {
  return fetch(`http://${host}:${port}/beacon`, { signal: AbortSignal.timeout(timeoutMs) })
    .then(async (res) => (res.ok ? await res.json() : null))
    .catch(() => null)
}
