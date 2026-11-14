import { phoneGateMessage } from '../src/phone.mjs'
const links = {}
const has = { 'session-a': 'session-b' }
const cases = [
  ['peer_say + 空互联表', 'peer_say', links],
  ['peer_run + 空互联表', 'peer_run', links],
  ['phone_ask + 空互联表', 'phone_ask', links],
  ['agent_send + 空互联表', 'agent_send', links],
  ['session_list + 空互联表', 'session_list', links],
  ['bridge_log + 空互联表（诊断类，放行）', 'bridge_log', links],
  ['phone_bridge_config + 空互联表（放行）', 'phone_bridge_config', links],
  ['peer_say + 有互联', 'peer_say', has],
]
let ok = 0
for (const [name, tool, table] of cases) {
  const msg = phoneGateMessage(tool, table)
  const blocked = !!msg
  const expectBlocked = name.includes('空互联表') && !name.includes('放行')
  const pass = blocked === expectBlocked
  if (pass) ok++
  console.log(`${pass ? '✓' : '✗'} ${name} → ${blocked ? '拦住' : '放行'}`)
}
console.log(`\n${ok}/${cases.length} 通过`)
