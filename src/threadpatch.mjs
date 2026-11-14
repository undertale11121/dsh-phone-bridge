// Generates the `--patch` file that gives a headless DSH session the workbench
// tools. Identity is passed as argv (not env) because the MCP client config only
// guarantees command/args.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome, ensureDir } from './util.mjs'

const SERVER = fileURLToPath(new URL('./thread-mcp.mjs', import.meta.url))

export function ensureThreadPatch(home = dshHome(), options = {}) {
  const agent = String(options.agent || 'phone')
  const name = String(options.name || agent)
  const mode = options.mode === 'direct' ? 'direct' : 'http'
  const setup = String(options.setup || `http://127.0.0.1:${process.env.PHONE_BRIDGE_SETUP_PORT || 8789}`)
  const target = path.join(home, 'phone-bridge', `thread-${agent}.patch.yml`)
  const args = [SERVER, '--agent', agent, '--name', name, '--mode', mode, '--setup', setup]
  const extra = options.args || []
  const yml = `# dsh-phone-bridge: workbench tools for headless agents (${agent}).
- insert:
    - id: dsh-phone-thread
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: phone-thread
        transport: stdio
        command: !!js process.execPath
        args:
${[...args, ...extra].map((item) => `          - ${JSON.stringify(item)}`).join('\n')}
        toolCallTimeoutMs: 660000
        failOnStartupError: false
`
  ensureDir(path.dirname(target))
  fs.writeFileSync(target, yml)
  return target
}