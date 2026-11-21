// QR Code encoder, no dependencies: byte mode, error-correction level M,
// versions 1–10. That ceiling covers a pairing link (~100 bytes at v5) while
// keeping the tables small enough to read. Output is a boolean module matrix,
// plus SVG / PNG renderers for the setup pages and the DSH card.
import zlib from 'node:zlib'

// Format-info bits per level (the 2-bit field, then BCH(15,5)).
const LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 }

// Version -> block groups for level M: [blockCount, totalCodewords, dataCodewords].
const BLOCKS_M = {
  1: [[1, 26, 16]],
  2: [[1, 44, 28]],
  3: [[1, 70, 44]],
  4: [[2, 50, 32]],
  5: [[2, 67, 43]],
  6: [[4, 43, 27]],
  7: [[4, 49, 31]],
  8: [[2, 60, 38], [2, 61, 39]],
  9: [[3, 58, 36], [2, 59, 37]],
  10: [[4, 69, 43], [1, 70, 44]],
}

const ALIGN = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
}

const VERSION_INFO = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 }

function maxVersion(level) {
  if (level !== 'M') throw new Error('只实现了 M 级纠错')
  return 10
}

// ── GF(256), primitive polynomial 0x11d ─────────────────────────────────────
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(function buildTables() {
  let value = 1
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = value
    LOG[value] = i
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]
})()

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

function rsGenerator(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= mul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree)
  const remainder = new Array(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.shift()
    remainder.push(0)
    for (let i = 0; i < degree; i += 1) remainder[i] ^= mul(gen[i + 1], factor)
  }
  return remainder
}

// ── data codewords ──────────────────────────────────────────────────────────
function countBits(version) {
  return version < 10 ? 8 : 16
}

function capacityFor(version) {
  return BLOCKS_M[version].reduce((sum, [count, , data]) => sum + count * data, 0)
}

function pickVersion(byteLength) {
  for (let version = 1; version <= maxVersion('M'); version += 1) {
    const needed = 4 + countBits(version) + byteLength * 8
    if (needed <= capacityFor(version) * 8) return version
  }
  throw new Error(`内容太长（${byteLength} 字节），最多到版本 10`)
}

function dataCodewords(bytes, version) {
  const capacity = capacityFor(version)
  const bits = []
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4) // byte mode
  push(bytes.length, countBits(version))
  for (const byte of bytes) push(byte, 8)
  const limit = capacity * 8
  const terminator = Math.min(4, limit - bits.length)
  push(0, terminator)
  while (bits.length % 8 !== 0) bits.push(0)
  const words = []
  for (let i = 0; i < bits.length; i += 8) {
    let word = 0
    for (let j = 0; j < 8; j += 1) word = (word << 1) | bits[i + j]
    words.push(word)
  }
  const PAD = [0xec, 0x11]
  for (let i = 0; words.length < capacity; i += 1) words.push(PAD[i % 2])
  return words
}

function interleave(words, version) {
  const groups = BLOCKS_M[version]
  const blocks = []
  let offset = 0
  for (const [count, total, dataLength] of groups) {
    const ecLength = total - dataLength
    for (let i = 0; i < count; i += 1) {
      const data = words.slice(offset, offset + dataLength)
      offset += dataLength
      blocks.push({ data, ec: rsRemainder(data, ecLength) })
    }
  }
  const out = []
  const maxData = Math.max(...blocks.map((block) => block.data.length))
  for (let i = 0; i < maxData; i += 1) for (const block of blocks) if (i < block.data.length) out.push(block.data[i])
  const maxEc = Math.max(...blocks.map((block) => block.ec.length))
  for (let i = 0; i < maxEc; i += 1) for (const block of blocks) if (i < block.ec.length) out.push(block.ec[i])
  return out
}

// ── matrix ──────────────────────────────────────────────────────────────────
function blank(size) {
  return { size, modules: Array.from({ length: size }, () => new Array(size).fill(false)), reserved: Array.from({ length: size }, () => new Array(size).fill(false)) }
}

function setModule(matrix, x, y, dark) {
  matrix.modules[y][x] = dark
  matrix.reserved[y][x] = true
}

function placeFinder(matrix, left, top) {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const x = left + dx
      const y = top + dy
      if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) continue
      const inRing = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6
      const dark = inRing && ((dx === 0 || dx === 6 || dy === 0 || dy === 6) || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4))
      setModule(matrix, x, y, dark)
    }
  }
}

function placeAlignment(matrix, version) {
  const positions = ALIGN[version]
  for (const cy of positions) {
    for (const cx of positions) {
      // Skip the three finder corners.
      const nearFinder = (cx <= 8 && cy <= 8) || (cx >= matrix.size - 9 && cy <= 8) || (cx <= 8 && cy >= matrix.size - 9)
      if (nearFinder) continue
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1
          setModule(matrix, cx + dx, cy + dy, dark)
        }
      }
    }
  }
}

function placeTiming(matrix) {
  for (let i = 8; i < matrix.size - 8; i += 1) {
    const dark = i % 2 === 0
    if (!matrix.reserved[6][i]) setModule(matrix, i, 6, dark)
    if (!matrix.reserved[i][6]) setModule(matrix, 6, i, dark)
  }
}

function placeDarkModule(matrix) {
  setModule(matrix, 8, matrix.size - 8, true)
}

function formatBits(level, mask) {
  const data = (LEVEL_BITS[level] << 3) | mask
  let remainder = data
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
  return ((data << 10) | remainder) ^ 0x5412
}

function placeFormat(matrix, level, mask) {
  const bits = formatBits(level, mask)
  const bit = (index) => ((bits >>> index) & 1) === 1
  // Around the top-left finder.
  for (let i = 0; i <= 5; i += 1) setModule(matrix, 8, i, bit(i))
  setModule(matrix, 8, 7, bit(6))
  setModule(matrix, 8, 8, bit(7))
  setModule(matrix, 7, 8, bit(8))
  for (let i = 9; i <= 14; i += 1) setModule(matrix, 14 - i, 8, bit(i))
  // Split copy along the other two finders.
  for (let i = 0; i <= 7; i += 1) setModule(matrix, matrix.size - 1 - i, 8, bit(i))
  for (let i = 8; i <= 14; i += 1) setModule(matrix, 8, matrix.size - 15 + i, bit(i))
}

function placeVersion(matrix, version) {
  const bits = VERSION_INFO[version]
  if (!bits) return
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) === 1
    const a = Math.floor(i / 3)
    const b = i % 3
    setModule(matrix, matrix.size - 11 + b, a, dark)
    setModule(matrix, a, matrix.size - 11 + b, dark)
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

function placeData(matrix, codewords) {
  const bits = []
  for (const word of codewords) for (let i = 7; i >= 0; i -= 1) bits.push(((word >>> i) & 1) === 1)
  let index = 0
  let upward = true
  for (let right = matrix.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5 // the vertical timing pattern has no data
    for (let step = 0; step < matrix.size; step += 1) {
      const y = upward ? matrix.size - 1 - step : step
      for (let column = 0; column < 2; column += 1) {
        const x = right - column
        if (matrix.reserved[y][x]) continue
        const bit = index < bits.length ? bits[index] : false
        matrix.modules[y][x] = bit
        index += 1
      }
    }
    upward = !upward
  }
}

function penalty(matrix) {
  const size = matrix.size
  const at = (x, y) => matrix.modules[y][x]
  let score = 0
  const runScore = (run) => (run >= 5 ? 3 + (run - 5) : 0)
  for (let y = 0; y < size; y += 1) {
    let run = 0
    let color = at(0, y)
    for (let x = 0; x < size; x += 1) {
      if (at(x, y) === color) run += 1
      else {
        score += runScore(run)
        run = 1
        color = at(x, y)
      }
    }
    score += runScore(run)
  }
  for (let x = 0; x < size; x += 1) {
    let run = 0
    let color = at(x, 0)
    for (let y = 0; y < size; y += 1) {
      if (at(x, y) === color) run += 1
      else {
        score += runScore(run)
        run = 1
        color = at(x, y)
      }
    }
    score += runScore(run)
  }
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = at(x, y)
      if (at(x + 1, y) === color && at(x, y + 1) === color && at(x + 1, y + 1) === color) score += 3
    }
  }
  const pattern = [true, false, true, true, true, false, true, false, false, false, false]
  const reverse = [false, false, false, false, true, false, true, true, true, false, true]
  const matches = (x, y, dx, dy, want) => {
    for (let i = 0; i < want.length; i += 1) {
      const px = x + dx * i
      const py = y + dy * i
      if (px < 0 || py < 0 || px >= size || py >= size) return false
      if (at(px, py) !== want[i]) return false
    }
    return true
  }
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (matches(x, y, 1, 0, pattern) || matches(x, y, 1, 0, reverse)) score += 40
      if (matches(x, y, 0, 1, pattern) || matches(x, y, 0, 1, reverse)) score += 40
    }
  }
  let dark = 0
  for (const row of matrix.modules) for (const cell of row) if (cell) dark += 1
  const total = size * size
  score += 10 * Math.floor(Math.abs((dark * 100) / total - 50) / 5)
  return score
}

export function qrMatrix(text, { level = 'M' } = {}) {
  const bytes = Buffer.from(String(text), 'utf8')
  const version = pickVersion(bytes.length)
  const words = interleave(dataCodewords(bytes, version), version)
  const size = 17 + version * 4
  const matrix = blank(size)
  placeFinder(matrix, 0, 0)
  placeFinder(matrix, size - 7, 0)
  placeFinder(matrix, 0, size - 7)
  placeAlignment(matrix, version)
  placeTiming(matrix)
  placeDarkModule(matrix)
  const reservedFormat = blank(size)
  placeFormat(reservedFormat, level, 0)
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (reservedFormat.reserved[y][x]) matrix.reserved[y][x] = true
  placeVersion(matrix, version)
  // Reserve the version blocks too (placeVersion marks them).
  placeData(matrix, words)

  let best = null
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = { size, modules: matrix.modules.map((row) => row.slice()), reserved: matrix.reserved }
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (matrix.reserved[y][x]) continue
        if (MASKS[mask](x, y)) candidate.modules[y][x] = !candidate.modules[y][x]
      }
    }
    placeFormat(candidate, level, mask)
    const score = penalty(candidate)
    if (!best || score < best.score) best = { score, modules: candidate.modules, version }
  }
  return { ...best, size }
}

// ── renderers ───────────────────────────────────────────────────────────────
export function qrSvg(text, { margin = 4, dark = '#0b0c0e', light = '#ffffff', label = '' } = {}) {
  const { modules, size } = qrMatrix(text)
  const full = size + margin * 2
  const path = []
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) if (modules[y][x]) path.push(`M${x + margin} ${y + margin}h1v1h-1z`)
  }
  // label 为空时旧代码会输出 `<title<rect`（非法 SVG）；含引号时还能注入属性。
  const esc = (v) =>
    String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  const labelText = esc(label || 'QR')
  const title = label ? `<title>${labelText}</title>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${full * 8}" height="${full * 8}" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges" role="img" aria-label="${labelText}">${title}<rect width="${full}" height="${full}" fill="${light}"/><path d="${path.join('')}" fill="${dark}"/></svg>`
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

export function qrPng(text, { scale = 8, margin = 4 } = {}) {
  const { modules, size } = qrMatrix(text)
  const full = size + margin * 2
  const pixels = Buffer.alloc(full * scale * (full * scale + 1))
  let offset = 0
  for (let y = 0; y < full * scale; y += 1) {
    pixels[offset] = 0 // filter: none
    offset += 1
    for (let x = 0; x < full * scale; x += 1) {
      const mx = Math.floor(x / scale) - margin
      const my = Math.floor(y / scale) - margin
      const dark = mx >= 0 && my >= 0 && mx < size && my < size && modules[my][mx]
      pixels[offset] = dark ? 0 : 255
      offset += 1
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(full * scale, 0)
  header.writeUInt32BE(full * scale, 4)
  header[8] = 8 // bit depth
  header[9] = 0 // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export function qrDataUrl(text, options = {}) {
  const svg = qrSvg(text, options)
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}