// defaultModel() 从 profiles/*/cordis.patch.yml 里用正则抓默认模型。
// 正则一旦写歪，新建的会话就会「本轮出错了（has no provider/model）」——
// 这个测试专门守住那段解析。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-model-'))
process.env.DSH_HOME = home
const { defaultModel } = await import('../web/index.js')

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass += 1
    console.log('PASS', name)
  } catch (error) {
    fail += 1
    console.log('FAIL', name, '·', error.message)
  }
}

function writeProfile(name, body) {
  const dir = path.join(home, 'profiles', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), body)
}

check('没有 profiles 目录时返回 null', () => {
  assert.equal(defaultModel(), null)
})

writeProfile('web', [
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  '    provider: custom-apitogo',
  '    model: deepseek-flash',
  '    rememberLastSelection: true',
  '    reasoningEffort: high',
  '',
].join('\n'))

check('能抓到 provider 与 model', () => {
  const got = defaultModel()
  assert.equal(got?.provider, 'custom-apitogo')
  assert.equal(got?.model, 'deepseek-flash')
})

writeProfile('web', [
  '- id: something-else',
  '  name: x',
  '  config:',
  '    provider: wrong-provider',
  '    model: wrong-model',
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  '    provider: apigo',
  '    model: deepseek-flash',
  '',
].join('\n'))

check('不会被前面的别的插件骗到', () => {
  const got = defaultModel()
  assert.equal(got?.provider, 'apigo')
  assert.equal(got?.model, 'deepseek-flash')
})

writeProfile('web', [
  '- id: agent-default-model',
  '  config:',
  '    provider: "apigo"',
  "    model: 'deepseek.vision-v1'",
  '',
].join('\n'))

check('引号包着的值也能抓，model 里的点和横线保留', () => {
  const got = defaultModel()
  assert.equal(got?.provider, 'apigo')
  assert.equal(got?.model, 'deepseek.vision-v1')
})

writeProfile('web', [
  '- id: agent-default-model',
  '  config:',
  '    provider: custom-apitogo',
  '    model: deepseek-chat',
  '',
].join('\n'))
writeProfile('desktop', [
  '- id: agent-default-model',
  '  config:',
  '    provider: apigo',
  '    model: deepseek-flash',
  '',
].join('\n'))

check('多个 profile 时都能解析（顺序不限）', () => {
  const got = defaultModel()
  assert.ok(got, '应该解析出模型')
  assert.ok(['custom-apitogo', 'apigo'].includes(got.provider))
})

fs.rmSync(path.join(home, 'profiles', 'desktop'), { recursive: true, force: true })
writeProfile('web', [
  '- id: agent-default-model',
  '  config:',
  '    provider: custom-apitogo',
  '    model: deepseek-chat',
  '',
].join('\n'))

check('只有一个 profile 时结果稳定', () => {
  assert.deepEqual(defaultModel(), { provider: 'custom-apitogo', model: 'deepseek-chat' })
})

writeProfile('web', [
  '- id: agent-default-model',
  '  config:',
  '    reasoningEffort: high',
  '',
].join('\n'))

check('没有 provider/model 时不能瞎编', () => {
  assert.equal(defaultModel(), null)
})

fs.rmSync(home, { recursive: true, force: true })
console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)