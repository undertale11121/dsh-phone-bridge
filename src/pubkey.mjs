// Ed25519 helpers: the phone signs, the desktop verifies. No shared secret needed
// after the first pairing.
import crypto from 'node:crypto'

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

export function sign(message, privatePem) {
  const key = crypto.createPrivateKey(privatePem)
  return crypto.sign(null, Buffer.from(message, 'utf8'), key).toString('base64')
}

export function verify(message, signatureB64, publicKeyB64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' })
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureB64, 'base64'))
  } catch {
    return false
  }
}

// Deterministic device id from the public key, so re-pairing keeps the same row.
export function deviceIdOf(publicKeyB64) {
  return sha256Hex(publicKeyB64).slice(0, 32)
}

// Default entry hint used by screen output: which app was in front.
export const DEFAULT_BUNDLE = 'io.github.dshgo.app'
