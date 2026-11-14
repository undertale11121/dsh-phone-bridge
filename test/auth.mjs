// 签名时间窗的回归测试。
//
// 起因：手机没走 NTP，实测时钟比电脑慢两个多小时。原来 5 分钟的窗口会把手机的
// 每个签名请求都判过期，表现是「连不上但也不报错」——最难查的那种。
// 这里锁死「宽到能容忍时钟偏差、窄到挡得住陈年重放」。
import { authFresh } from '../src/desktop.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const now = Date.now()

check('刚刚的时间戳通过', authFresh({ ts: now }))
check('5 分钟前通过（旧窗口的边界）', authFresh({ ts: now - 5 * 60_000 }))
check('1 小时前通过（时钟偏差）', authFresh({ ts: now - 60 * 60_000 }))
check('两个半小时前通过（实测过的手机偏差）', authFresh({ ts: now - 2.5 * 60 * 60_000 }))
check('未来 1 小时通过（对方时钟走快了）', authFresh({ ts: now + 60 * 60_000 }))
check('7 小时前拒绝（陈年重放）', !authFresh({ ts: now - 7 * 60 * 60_000 }))
check('7 小时后拒绝（伪造未来）', !authFresh({ ts: now + 7 * 60 * 60_000 }))
check('没有 ts 拒绝', !authFresh({}))
check('ts 不是数字拒绝', !authFresh({ ts: 'abc' }))
check('null 拒绝', !authFresh(null))
check('自定义窗口生效', authFresh({ ts: now - 2000 }, 1000) === false)

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)