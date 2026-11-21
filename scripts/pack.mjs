#!/usr/bin/env node
// 打个包，放在 dist/ 下，方便扔到 GitHub Release 或让别人的 dsh 直接装。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const out = path.join(root, 'dist')
fs.mkdirSync(out, { recursive: true })
// npm 会把 scoped 包平铺成 `<scope>-<name>-<version>.tgz`，所以不能自己拼名字，
// 直接读 `npm pack --json` 的产物名再改成人能认的短名。
const target = path.join(out, `${pkg.name.replace(/^@[^/]+\//, '')}-${pkg.version}.tgz`)

const raw = execFileSync('npm', ['pack', '--pack-destination', out, '--json'], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
})
let produced = ''
try {
  const info = JSON.parse(raw.slice(raw.indexOf('[')))
  produced = path.join(out, info[0].filename)
} catch {
  produced = ''
}
if (!produced || !fs.existsSync(produced)) {
  const found = fs.readdirSync(out).filter((f) => f.endsWith('.tgz')).sort()
  if (!found.length) throw new Error('npm pack 没有产出 tgz')
  produced = path.join(out, found[found.length - 1])
}
if (produced !== target) fs.renameSync(produced, target)
console.log(`打包完成：${target}（${fs.statSync(target).size} 字节）`)