#!/usr/bin/env node
// 打个包，放在 dist/ 下，方便扔到 GitHub Release 或让别人的 dsh 直接装。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const out = path.join(root, 'dist')
fs.mkdirSync(out, { recursive: true })
const name = `${pkg.name}-${pkg.version}.tgz`
const target = path.join(out, name)

execFileSync('npm', ['pack', '--pack-destination', out, '--silent'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

const real = path.join(out, `${pkg.name.replace(/^@[^/]+\//, '')}-${pkg.version}.tgz`)
if (real !== target && fs.existsSync(real)) fs.renameSync(real, target)
console.log(`打包完成：${target}（${fs.statSync(target).size} 字节）`)