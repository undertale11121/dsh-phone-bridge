#!/usr/bin/env node
// dsh-phone-bridge — 让 DSH 桌面端和手机端互通，两个模型协作完成一个任务。
//
//   bridge.mjs auto             自动识别手机/电脑，选对应角色（profile 里只写这个就行）
//   bridge.mjs desktop          桌面端：监听 HTTP + 给桌面模型注册工具（MCP stdio）
//   bridge.mjs desktop --serve  只监听，不开 MCP（本地调试用）
//   bridge.mjs phone            手机端：出站轮询 + 本机执行（MCP stdio）
//   bridge.mjs phone --no-mcp   只轮询，不开 MCP（本地调试用）
//   bridge.mjs pair <串>        在手机上保存配对信息
//   bridge.mjs doctor           自检两端环境
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bridgeDir,
  desktopConfigPath,
  dshHome,
  headlessPatchPath,
  log,
  phoneConfigPath,
  readJson,
} from './src/util.mjs'
import { loadDesktopConfig, runDesktopMcp, runDesktopServer } from './src/desktop.mjs'
import { loadPhoneConfig, pair, runPhoneMcp } from './src/phone.mjs'

const [, , command, ...rest] = process.argv

const USAGE = `用法：
  dsh-phone-bridge auto                              自动识别：手机→phone，电脑→desktop
  dsh-phone-bridge desktop [--serve] [--port 8787]   桌面端（在电脑上由 DSH 启动）
  dsh-phone-bridge phone [--no-mcp]                  手机端（在手机上由 DSH 启动）
  dsh-phone-bridge pair <配对串>                     在手机上保存配对信息
  dsh-phone-bridge doctor                            检查环境与两端状态
  dsh-phone-bridge print-patch                       打印要加进 profile 的补丁片段
  dsh-phone-bridge print-pair                        打印配对串（用当前配置的 token）
`

// 手机端自愈：DSH Go 重装/升级会把 profile 重置成空壳（没有我们的依赖和 bundle），
// 但 MCP 行是独立加载的，所以 bridge 仍能起来 —— 就在这里把注册补回去，用户只需再重启一次。
function ensurePhoneProfileRegistered() {
  const profileDir = path.join(dshHome(), 'profiles', 'web')
  const profileFile = path.join(profileDir, 'package.json')
  const root = path.dirname(fileURLToPath(import.meta.url))
  let self = null
  try {
    self = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  } catch {
    return false
  }
  const name = self?.name
  if (!name) return false
  let profile = null
  try {
    profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'))
  } catch {
    return false
  }
  const wanted = `link:${root}`
  let changed = false
  if (!profile.dependencies || typeof profile.dependencies !== 'object') profile.dependencies = {}
  if (profile.dependencies[name] !== wanted) {
    profile.dependencies[name] = wanted
    changed = true
  }
  const bundles = Array.isArray(profile?.dsh?.profile?.bundles) ? profile.dsh.profile.bundles : []
  if (!bundles.includes(name)) {
    bundles.push(name)
    profile.dsh = profile.dsh && typeof profile.dsh === 'object' ? profile.dsh : {}
    profile.dsh.profile = profile.dsh.profile && typeof profile.dsh.profile === 'object' ? profile.dsh.profile : {}
    profile.dsh.profile.bundles = bundles
    changed = true
  }
  const linkPath = path.join(profileDir, 'node_modules', name)
  let linked = false
  try {
    linked = fs.lstatSync(linkPath).isSymbolicLink() && fs.realpathSync(linkPath) === fs.realpathSync(root)
  } catch {
    linked = false
  }
  if (!linked) {
    try {
      fs.mkdirSync(path.dirname(linkPath), { recursive: true })
      let stale = null
      try {
        stale = fs.lstatSync(linkPath)
      } catch {
        stale = null
      }
      if (stale) {
        if (stale.isSymbolicLink()) {
          fs.unlinkSync(linkPath)
        } else if (stale.isDirectory()) {
          // 真目录（用户手工拷进去的旧版本）绝不能递归删：那是用户的数据。
          // 只能提示，让人自己决定移走还是保留。
          log(`自愈：${linkPath} 是一个真实目录，不是软链，跳过（请手动移走后重启）`)
          return changed
        } else {
          fs.unlinkSync(linkPath)
        }
      }
      fs.symlinkSync(root, linkPath, 'dir')
      changed = true
    } catch (error) {
      log(`自愈：建软链失败 ${error?.message || error}`)
    }
  }
  if (!changed) return false
  try {
    // 原子写：写一半被 App 杀掉会让 package.json 变成非法 JSON，
    // 之后自愈的 JSON.parse 永远失败 —— 插件再也起不来。
    const tmp = `${profileFile}.tmp-${process.pid}`
    fs.writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`)
    fs.renameSync(tmp, profileFile)
    return true
  } catch (error) {
    log(`自愈：写 profile 失败 ${error?.message || error}`)
    return false
  }
}

function takeFlag(name) {
  // 支持 `--port 8787` 和 `--port=8787`；缺值时报错而不是悄悄当成 '1'
  // （以前 `--port` 后面没值时会把端口设成 1，非 root 下 EACCES，桥接连不上还没提示）。
  const index = rest.findIndex((item) => item === name || item.startsWith(`${name}=`))
  if (index < 0) return null
  const token = rest[index]
  if (token.startsWith(`${name}=`)) {
    rest.splice(index, 1)
    const inline = token.slice(name.length + 1).trim()
    if (!inline) throw new Error(`${name} 需要一个值`)
    return inline
  }
  const value = rest[index + 1]
  if (value === undefined || value.startsWith('--')) {
    rest.splice(index, 1)
    throw new Error(`${name} 需要一个值（例如 ${name} 8787）`)
  }
  rest.splice(index, 2)
  return value
}

async function main() {
  let port = null
  let host = null
  try {
    port = takeFlag('--port')
    host = takeFlag('--host')
  } catch (error) {
    console.error(String(error?.message || error))
    process.exitCode = 2
    return
  }
  if (port) process.env.PHONE_BRIDGE_PORT = port
  if (host) process.env.PHONE_BRIDGE_HOST = host

  switch (command) {
    case 'auto': {
      const role = detectRole()
      log(`自动识别为${role === 'phone' ? '手机端' : '桌面端'}`)
      if (role === 'phone') {
        try {
          if (ensurePhoneProfileRegistered()) log('检测到手机 profile 缺了本插件，已补回（重启 DSH 后生效）')
        } catch (error) {
          log(`profile 自检失败：${error?.message || error}`)
        }
        await runPhoneMcp({ withMcp: true })
        await new Promise(() => {})
      } else {
        await runDesktopMcp()
      }
      return
    }
    case 'desktop': {
      const serve = rest.includes('--serve')
      if (serve) await runDesktopServer()
      else await runDesktopMcp()
      return
    }
    case 'phone': {
      const noMcp = rest.includes('--no-mcp')
      await runPhoneMcp({ withMcp: !noMcp })
      await new Promise(() => {})
      return
    }
    case 'pair': {
      const value = rest.join(' ').trim()
      if (!value) throw new Error('缺少配对串')
      const config = pair(value)
      console.log(`已保存配对：${config.url}`)
      try {
        const res = await fetch(config.url.replace(/\/+$/, '') + '/health', { signal: AbortSignal.timeout(5000) })
        const health = await res.json()
        console.log(`桌面：${health.name || '?'} · 在线：${health.online ? '是' : '否'}`)
      } catch (error) {
        console.log(`暂时连不上桌面（${error?.message || error}）；启动手机端后会自动重试`)
      }
      return
    }
    case 'doctor':
      await doctor()
      return
    case 'print-patch':
      printPatch()
      return
    case 'print-pair': {
      const config = loadDesktopConfig()
      const { lanAddresses, pairStringTo } = await import('./src/util.mjs')
      const list = lanAddresses()
      if (!list.length) {
        console.error('没找到局域网地址：先确认电脑已联网，或直接用配置页里的配对串。')
        process.exitCode = 1
        return
      }
      for (const item of list) console.log(pairStringTo(item.address, config.port, config.token))
      return
    }
    case undefined:
      // 被 MCP 客户端 spawn 但配置里漏了 `auto`：stdout 是 MCP 协议通道，
      // 往里打用法会直接破坏分帧，客户端只看到「工具不可用」。
      console.error(`缺少子命令（MCP 配置的 args 里应该有 auto）。\n\n${USAGE}`)
      process.exitCode = 2
      return
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE)
      return
    default:
      console.error(`未知命令：${command}\n\n${USAGE}`)
      process.exitCode = 1
  }
}

export function detectRole() {
  const relay = process.env.PHONE_BRIDGE_RELAY || '/opt/dsh-app/phone/relay.cjs'
  const relayConfig = process.env.PHONE_BRIDGE_RELAY_CONFIG || '/var/lib/dsh-app/phone/bridge.json'
  // 光有 /sdcard 不够：桌面 Linux 也可能挂着 /sdcard，会把自己误判成手机端。
  const android = fs.existsSync('/system/build.prop') || fs.existsSync('/system/bin/app_process') || fs.existsSync('/system/bin/app_process64')
  if (fs.existsSync(relay) || fs.existsSync(relayConfig) || (android && fs.existsSync('/sdcard'))) return 'phone'
  return 'desktop'
}

function printPatch() {
  const self = fileURLToPath(import.meta.url)
  const isPhone = detectRole() === 'phone'
  const timeout = isPhone ? 1800000 : 1800000
  console.log(`# 把下面这段加到 DSH 的 profile 补丁里（两端各一次）：`)
  console.log(`#   DSH_HOME/profiles/<profile>/cordis.patch.yml`)
  console.log(`# 这台机器上是「${isPhone ? '手机端' : '桌面端'}」；同一段在两端都能用（auto 自动识别）。改完重启 DSH。`)
  console.log('')
  console.log('- insert:')
  // id 不能和 bundle 自带的条目同名：cordis 按 id 挂载，同 id 只保留最后一行，
  // 撞上就会把 bundle 行顶掉、apply 不执行（面板/路由全部消失且无告警）。
  console.log('    - id: dsh-phone-bridge-engine')
  console.log(`      name: '@deepseek-ai/dsh-mcp-client'`)
  console.log('      config:')
  console.log('        serverName: phone-bridge')
  console.log('        transport: stdio')
  console.log('        command: !!js process.execPath')
  console.log('        args:')
  console.log(`          - ${self}`)
  console.log(`          - auto`)
  console.log(`        toolCallTimeoutMs: ${timeout}`)
  console.log('        failOnStartupError: false')
  console.log('        # 让桥接知道是哪个会话在调用它（自动唤醒要用）')
  console.log('        dshGoPhoneCaller: true')
  if (!isPhone) {
    // 桌面端的 26 个工具由宿主半注册（web/index.js），这条 MCP 行只负责把桥接拉起来；
    // 两者都注册会撞 already registered the same action。
    // 必须放在 config 的所有子项之后：`disabled` 是 config 的兄弟键（6 空格），
    // 写在这里之前会把后面 8 空格的 dshGoPhoneCaller 并进 `disabled` 的标量值，YAML 直接非法。
    console.log('      disabled: true')
  }
}

async function doctor() {
  const lines = []
  const ok = (label, value) => lines.push(`${value ? '✅' : '❌'} ${label}`)
  lines.push(`node ${process.version} · platform ${process.platform}/${process.arch}`)
  lines.push(`DSH_HOME ${dshHome()}`)
  lines.push(`数据目录 ${bridgeDir()}`)

  const relay = process.env.PHONE_BRIDGE_RELAY || '/opt/dsh-app/phone/relay.cjs'
  const relayConfig = process.env.PHONE_BRIDGE_RELAY_CONFIG || '/var/lib/dsh-app/phone/bridge.json'
  const phonePatch = process.env.PHONE_BRIDGE_PHONE_PATCH || '/opt/dsh-app/phone/phone.patch.yml'
  // proot Ubuntu on the phone reports platform=linux, so detect by the app's
  // own files instead of the platform string.
  // 和 detectRole 用同一套判断：桌面 Linux 也可能挂着 /sdcard，光看它会把桌面端误报成手机端。
  const onPhone = detectRole() === 'phone'
  const hasDesktop = fs.existsSync(desktopConfigPath())
  if (onPhone) {
    lines.push('—— 手机端 ——')
    ok(`手机操控中继 ${relay}`, fs.existsSync(relay))
    ok(`手机操控配置 ${relayConfig}`, fs.existsSync(relayConfig))
    ok(`手机操控补丁 ${phonePatch}`, fs.existsSync(phonePatch))
    const phoneConfig = loadPhoneConfig()
    ok(`配对信息 ${phoneConfigPath()}`, Boolean(phoneConfig.url && phoneConfig.token))
    if (phoneConfig.url) {
      lines.push(`   桌面地址：${phoneConfig.url}`)
      try {
        const res = await fetch(phoneConfig.url.replace(/\/+$/, '') + '/health', {
          signal: AbortSignal.timeout(5000),
        })
        const health = await res.json()
        ok(`能连上桌面（${health.name || '?'}）`, health.ok)
        lines.push(`   桌面认为手机在线：${health.online ? '是' : '否'}`)
      } catch (error) {
        ok(`能连上桌面（${error?.message || error}）`, false)
      }
    }
    const patch = headlessPatchPath()
    ok(`headless 模型补丁 ${patch}`, fs.existsSync(patch))
  }
  if (hasDesktop || !onPhone) {
    lines.push('—— 桌面端 ——')
    const config = loadDesktopConfig()
    ok(`桌面配置 ${desktopConfigPath()}`, true)
    lines.push(`   监听 ${config.host}:${config.port}，token ${config.token.slice(0, 6)}…`)
    lines.push(`   允许 shell：${config.allowShell ? '是' : '否'} · 允许手机模型：${config.allowAsk ? '是' : '否'} · 允许文件：${config.allowFiles ? '是' : '否'}`)
    const health = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(3000) }).catch(
      () => null,
    )
    if (health?.ok) {
      const body = await health.json()
      lines.push(`   已有实例在监听：${body.name}，手机在线：${body.online ? '是' : '否'}`)
    } else {
      lines.push('   （当前没有实例监听这个端口；在 DSH 里用桌面端 profile 启动后即可）')
    }
  }
  console.log(lines.join('\n'))
}

main().catch((error) => {
  log(`失败：${error?.stack || error}`)
  console.error(error?.message || error)
  process.exitCode = 1
})