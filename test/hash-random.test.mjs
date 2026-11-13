import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { sha256, short } from '../build/esm/hash.js'

// A fixed-seed generator (xorshift32), so a failure names an input that can be replayed.
function generator(seed) {
  let x = seed >>> 0
  return function next(n) {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    return x % n
  }
}

// Code units drawn from every UTF-8 length class, with paired, lone and reversed surrogates.
function randomString(next) {
  const length = next(8) === 0 ? next(2000) : next(200)
  let s = ''
  for (let i = 0; i < length; i++) {
    switch (next(7)) {
      case 0: s += String.fromCharCode(next(0x80)); break
      case 1: s += String.fromCharCode(0x80 + next(0x780)); break
      case 2: s += String.fromCharCode(0x800 + next(0xd000)); break
      case 3: s += String.fromCharCode(0xe000 + next(0x2000)); break
      case 4: s += String.fromCharCode(0xd800 + next(0x400), 0xdc00 + next(0x400)); break
      case 5: s += String.fromCharCode(0xd800 + next(0x800)); break
      default: s += 'visito:'.charAt(next(7))
    }
  }
  return s
}

const reference = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')

// FNV-1a over the low byte, then the high byte when it is set, of each code unit; 32-bit, from the published definition.
function fnvReference(s, offset) {
  let h = offset >>> 0
  const step = (byte) => { h = Math.imul(h ^ byte, 16777619) >>> 0 }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    step(c & 255)
    if (c > 255) step(c >>> 8)
  }
  return h.toString(16).padStart(8, '0')
}

test('sha256 matches node:crypto on 4,000 seeded random strings of mixed length and script', () => {
  const next = generator(0x5eed1234)
  for (let n = 0; n < 4000; n++) {
    const input = randomString(next)
    assert.equal(sha256(input), reference(input), 'input ' + n + ': ' + JSON.stringify(input.slice(0, 80)))
  }
})

test('sha256 matches node:crypto at every length from 0 to 300 bytes', () => {
  for (let length = 0; length <= 300; length++) {
    const input = 'aé中'.repeat(length).slice(0, length)
    assert.equal(sha256(input), reference(input), 'length ' + length)
  }
})

test('short is two 32-bit FNV-1a passes on 4,000 seeded random strings', () => {
  const next = generator(0xf00dcafe)
  for (let n = 0; n < 4000; n++) {
    const input = randomString(next)
    assert.equal(short(input), fnvReference(input, 0x811c9dc5) + fnvReference(input, 0x01000193), 'input ' + n)
  }
})
