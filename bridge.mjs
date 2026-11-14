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

function takeFlag(name) {
  const index = rest.indexOf(name)
  if (index < 0) return null
  const value = rest[index + 1]
  rest.splice(index, value && !value.startsWith('--') ? 2 : 1)
  return value && !value.startsWith('--') ? value : '1'
}

async function main() {
  const port = takeFlag('--port')
  const host = takeFlag('--host')
  if (port) process.env.PHONE_BRIDGE_PORT = port
  if (host) process.env.PHONE_BRIDGE_HOST = host

  switch (command) {
    case 'auto': {
      const role = detectRole()
      log(`自动识别为${role === 'phone' ? '手机端' : '桌面端'}`)
      if (role === 'phone') {
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
      for (const item of lanAddresses()) console.log(pairStringTo(item.address, config.port, config.token))
      return
    }
    case undefined:
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
  if (fs.existsSync(relay) || fs.existsSync(relayConfig) || fs.existsSync('/sdcard')) return 'phone'
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
  console.log('    - id: dsh-phone-bridge')
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
  const onPhone = fs.existsSync(relay) || fs.existsSync(relayConfig) || fs.existsSync('/sdcard')
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