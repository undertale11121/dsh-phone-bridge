// thread.jsonl 的轮转：只增不减的文件迟早会拖垮每次 read。
//   node test/rotate.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbt-rotate-'))
process.env.PHONE_BRIDGE_THREAD = path.join(dir, 'thread.jsonl')
process.env.PHONE_BRIDGE_HOME = dir

const { append, readAll, MAX_ROWS, KEEP_ROWS } = await import('../src/thread.mjs')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const total = MAX_ROWS + 50
for (let index = 1; index <= total; index += 1) append('desktop', `msg ${index}`, 'phone')

const rows = readAll()
const archives = fs.readdirSync(dir).filter((name) => name.startsWith('thread-archive-'))
const archived = archives.length ? fs.readFileSync(path.join(dir, archives[0]), 'utf8').trim().split('\n').length : 0

check('超过上限后把老的挪走', archives.length === 1, archives[0] || '没有归档文件')
check('当前文件回到保留条数附近', rows.length <= MAX_ROWS && rows.length >= KEEP_ROWS, `保留 ${rows.length}`)
check('一条都没丢', rows.length + archived === total, `${rows.length} + ${archived} = ${rows.length + archived}`)
check('seq 单调递增（收件器靠它推 cursor）', rows.every((row, index) => index === 0 || row.seq > rows[index - 1].seq))
check('归档里是最老的那批', archived > 0 && Number(archives.length))

const firstArchived = archives.length
  ? JSON.parse(fs.readFileSync(path.join(dir, archives[0]), 'utf8').split('\n')[0])
  : null
check('归档从 seq 1 开始', firstArchived?.seq === 1, String(firstArchived?.seq))

fs.rmSync(dir, { recursive: true, force: true })
const passed = results.filter((item) => item.ok).length
console.log(`\n${passed}/${results.length} 通过`)
process.exit(passed === results.length ? 0 : 1)