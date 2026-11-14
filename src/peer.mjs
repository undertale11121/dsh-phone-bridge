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

export function ensurePeerLink({ config, identity, isDial, endpoint, onOpen }) {
  let runtime = null
  let timer = null
  let scanning = false

  return {
    info() {
      const cfg = loadPeerConfig()
      const myEndpoints = (cfg.pairs || []).filter((p) => p.host).map((p) => `${p.host}:${p.port}`)
      const selfPort = config.asHost?.port
      const target = [...myEndpoints].sort()[0]
      const primary = target ? compareEndpoint(`0.0.0.0:${selfPort || 0}`, target) > 0 : true
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
      /* next tick re-reads peer.json */
    },

    async tick() {
      if (scanning) return
      scanning = true
      try {
        const cfg = loadPeerConfig()
        const pairs = (Array.isArray(cfg.pairs) ? cfg.pairs : []).filter(
          // 回环地址是测试留下的噪音：连它等于连自己，会让手机一直「重试」
          (pair) => pair?.host && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(pair.host)),
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
              config.autoUrl = `http://${pair.host}:${pair.port}`
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
          if (host && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
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
