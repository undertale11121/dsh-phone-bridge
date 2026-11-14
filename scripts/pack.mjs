// Build the distributable zip without external deps (no zip binary on the phone).
//   node scripts/pack.mjs [out.zip]
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const root = path.resolve(import.meta.dirname, '..')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const out = process.argv[2] || `/sdcard/Download/DSH-Go/dsh-phone-bridge-${version}.zip`

const SKIP = new Set(['node_modules', '.git', 'phone-artifacts', 'kit'])
const files = []
;(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    const rel = path.relative(root, full).split(path.sep).join('/')
    if (rel.startsWith('test/home')) continue
    if (entry.isDirectory()) walk(full)
    else files.push({ rel, data: fs.readFileSync(full) })
  }
})(root)

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    let c = (crc ^ buf[i]) & 0xff
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

const chunks = []
const central = []
let offset = 0
for (const file of files) {
  const name = Buffer.from(file.rel)
  const body = zlib.deflateRawSync(file.data, { level: 9 })
  const crc = crc32(file.data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6) // UTF-8 names
  local.writeUInt16LE(8, 8) // deflate
  local.writeUInt16LE(0, 10)
  local.writeUInt16LE(0x21, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(file.data.length, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(0, 28)
  chunks.push(local, name, body)

  const row = Buffer.alloc(46)
  row.writeUInt32LE(0x02014b50, 0)
  row.writeUInt16LE(20, 4)
  row.writeUInt16LE(20, 6)
  row.writeUInt16LE(0x0800, 8)
  row.writeUInt16LE(8, 10)
  row.writeUInt16LE(0, 12)
  row.writeUInt16LE(0x21, 14)
  row.writeUInt32LE(crc, 16)
  row.writeUInt32LE(body.length, 20)
  row.writeUInt32LE(file.data.length, 24)
  row.writeUInt16LE(name.length, 28)
  row.writeUInt32LE(0, 38)
  row.writeUInt32LE(offset, 42)
  central.push(row, name)
  offset += local.length + name.length + body.length
}

const directory = Buffer.concat(central)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(files.length, 8)
end.writeUInt16LE(files.length, 10)
end.writeUInt32LE(directory.length, 12)
end.writeUInt32LE(offset, 16)

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, Buffer.concat([...chunks, directory, end]))
console.log(`${out}（${files.length} 个文件，${(fs.statSync(out).size / 1024).toFixed(1)} KB）`)