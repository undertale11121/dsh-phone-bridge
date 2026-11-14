// 从 desktop profile 的 cordis.patch.yml 里抽出模型配置，生成 headless 用的补丁。
// 子智能体（dsh headless）不加载 profile，所以 provider/model/凭据必须单独给它。
import fs from 'node:fs'

const source = 'C:/Users/17735/.dsh/profiles/desktop/cordis.patch.yml'
const target = 'C:/Users/17735/.dsh/phone-bridge/headless.patch.yml'

const lines = fs.readFileSync(source, 'utf8').split(/\r?\n/)
const wanted = ['agent-default-model', 'llm-pi-ai']
const blocks = []
let current = null

for (const line of lines) {
  if (/^-\s+id:\s*/.test(line)) {
    if (current) blocks.push(current)
    current = { head: line, lines: [line] }
  } else if (current && line.length > 0 && !/^\s*#/.test(line)) {
    // 顶层（无缩进）且不是列表项 → 这一条结束
    if (!/^\s/.test(line) && !/^-\s/.test(line)) {
      current = null
      continue
    }
    current.lines.push(line)
  }
}
if (current) blocks.push(current)

const keep = blocks
  .filter((block) => wanted.some((id) => block.head.includes(`id: ${id}`)))
  .map((block) => block.lines.join('\n').replace(/\s+$/, ''))

if (keep.length !== 2) {
  console.error(`只找到 ${keep.length} 条（期望 2：agent-default-model + llm-pi-ai）`)
  process.exit(1)
}

const text = [
  '# 由 bin/make-headless-patch.mjs 从 desktop profile 生成：headless 会话的模型配置。',
  ...keep,
  '- id: credentials',
  '  disabled: false',
  '',
].join('\n')

fs.writeFileSync(target, text, 'utf8')
console.log(`已写入 ${target}（${text.length} 字节）`)
console.log(text.split('\n').slice(0, 8).join('\n'))