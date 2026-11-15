import { gateMessage } from '../src/desktop.mjs'

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = String(got) === String(want)
  if (ok) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}\n      要 ${JSON.stringify(want)}\n      得到 ${JSON.stringify(got)}`) }
}

console.log('gateMessage：会话级互联开关')

// 1) 没开互联的会话 -> 拦
check('没开互联时 peer_say 被拦', Boolean(gateMessage('peer_say', {}, 'session-aaa')), true)
check('没开互联时 phone_tool 被拦', Boolean(gateMessage('phone_tool', {}, 'session-aaa')), true)
check('没开互联时 agent_spawn 被拦', Boolean(gateMessage('agent_spawn', {}, 'session-aaa')), true)
check('没开互联时 session_list 被拦', Boolean(gateMessage('session_list', {}, 'session-aaa')), true)

// 2) 开了互联的会话 -> 放行
const links = { 'session-aaa': { phoneId: 'session-bbb', at: '2026-11-15T00:00:00.000Z' } }
check('开了互联时 peer_say 放行', gateMessage('peer_say', links, 'session-aaa'), '')
check('开了互联时 phone_shot 放行', gateMessage('phone_screenshot', links, 'session-aaa'), '')

// 3) 别的会话开了 -> 放行（MCP 拿不到 caller，推断不可靠，宁可判松也不误拦）
check('只要有会话开着互联就放行', Boolean(gateMessage('peer_say', links, 'session-zzz')), false)

// 4) 诊断类永远放行
check('bridge_health 不拦', gateMessage('bridge_health', {}, 'session-aaa'), '')
check('phone_bridge_config 不拦', gateMessage('phone_bridge_config', {}, 'session-aaa'), '')
check('非互联工具不拦', gateMessage('read_file', {}, 'session-aaa'), '')

// 5) 拿不到当前会话时退化：有任意一条 link 就放行（否则连排查都做不了）
check('推断不出会话但有 link 时放行', gateMessage('peer_say', links, ''), '')
check('推断不出会话且无 link 时拦', Boolean(gateMessage('peer_say', {}, '')), true)

// 6) 文案里带短 id，方便用户知道是哪个会话
const msg = gateMessage('peer_say', {}, 'session-9f8e7d6c-1111-2222-3333-444455556666')
check('文案不点名具体会话（推断不可靠）', msg.includes('9f8e7d6c'), false)
check('文案提示去点开关', msg.includes('🔗 互联'), true)

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
