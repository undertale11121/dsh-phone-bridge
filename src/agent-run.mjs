// One subagent process. Started by the desktop or the phone when a model asks
// for extra hands (`agent_spawn`). It runs a headless DSH session with the
// workbench tools, so the new agent can talk to the others and report back on
// its own.
//
//   node src/agent-run.mjs --id build-1 --name 构建手 --task "把网页打包" \
//        --mode direct|http --setup http://127.0.0.1:8789 --log /path/to.log
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ensureThreadPatch } from './threadpatch.mjs'
import { dshHome, ensureDir } from './util.mjs'

function flag(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback
}

const ID = flag('id', 'agent')
const NAME = flag('name', ID)
const TASK = flag('task', '')
const MODE = flag('mode', 'direct') === 'http' ? 'http' : 'direct'
const SETUP = flag('setup', `http://127.0.0.1:${process.env.PHONE_BRIDGE_SETUP_PORT || 8789}`)
const LOG = flag('log', '')

function writeLog(text) {
  if (!LOG) return
  try {
    ensureDir(path.dirname(LOG))
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${text}\n`)
  } catch {
    /* logging must never break the agent */
  }
}

async function say(from, to, text) {
  if (MODE === 'http') {
    const res = await fetch(`${SETUP}/api/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'agent.send', fields: { as: from, name: NAME, to, text } }),
      signal: AbortSignal.timeout(30_000),
    })
    return await res.json()
  }
  const { append } = await import('./thread.mjs')
  return append(from, text, to)
}

async function main() {
  if (!TASK) throw new Error('缺少 --task')
  await say(ID, 'all', `（子智能体 ${NAME} 上线，收到任务：${TASK}）`)

  if (process.env.PHONE_BRIDGE_AGENT_STUB === '1') {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.PHONE_BRIDGE_AGENT_STUB_DELAY || 300)))
    await say(ID, 'desktop', `（${NAME} 完成任务：${TASK}）`)
    writeLog(`stub done: ${TASK}`)
    return
  }

  const patch = ensureThreadPatch(dshHome(), { agent: ID, name: NAME, mode: MODE, setup: SETUP })
  const prompt = [
    `你是共享工作台上的一个子智能体，名字是「${NAME}」（id: ${ID}）。`,
    '你和一个电脑模型、一个手机模型在同一条工作台上，可以互相发消息。',
    '',
    `【任务】${TASK}`,
    '',
    '【工具】agent_list 看有哪些 agent；agent_send 给某个 agent 发消息；agent_converse 发消息并等回话；agent_read 看历史。',
    '先看一眼工作台上有什么上下文，然后动手。做完用 agent_send 把结论发给 desktop（需要商量就用 agent_converse）。',
  ].join('\n')

  const child = spawn(process.env.DSH_BIN || 'dsh', ['headless', '--patch', patch, '--json', prompt], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PHONE_BRIDGE_AGENT: ID, PHONE_BRIDGE_AGENT_NAME: NAME },
  })
  let out = ''
  child.stdout.on('data', (chunk) => {
    out += chunk.toString()
    writeLog(chunk.toString().trim())
  })
  child.stderr.on('data', (chunk) => writeLog(`stderr: ${chunk.toString().trim()}`))
  const code = await new Promise((resolve) => child.on('close', resolve))

  // Pull the final assistant text out of the NDJSON stream and put it on the
  // workbench, so the parent model sees the result even if it never asked again.
  let final = ''
  for (const line of out.split('\n')) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    try {
      const event = JSON.parse(text)
      if (event.type === 'final' && event.text) final = String(event.text)
      if (event.type === 'result' && event.text) final = String(event.text)
    } catch {
      /* not every line is JSON */
    }
  }
  const summary = final ? final.slice(0, 4000) : `（${NAME} 结束，退出码 ${code}，没拿到文本结果）`
  await say(ID, 'desktop', `（${NAME} 完成，退出码 ${code}）\n${summary}`)
  writeLog(`finished with code ${code}`)
}

main().catch(async (error) => {
  writeLog(`failed: ${error?.message || error}`)
  try {
    await say(ID, 'all', `（${NAME} 启动失败：${error?.message || error}）`)
  } catch {
    /* the workbench may be unreachable */
  }
  process.exitCode = 1
})