import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { DEEP_PARTS, DEEP_VERSION, deepRule, sealDeep } from '../build/esm/deepseal.js'
import { detectBuild } from '../build/esm/env.js'
import { BROWSERS, dress, fakeWindow } from './fake-window.mjs'

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
/** The recipe of docs/SIGNALS.md, written out again here: r.audio and r.cg, then the fixed line r.ct=!ex, after "visito-deep:1". */
const recipe = (c) => sha(`visito-deep:${DEEP_VERSION}\nr.audio=${String(c['r.audio'])}\nr.cg=${String(c['r.cg'])}\nr.ct=!ex`)
const REAL = { 'r.audio': 'f4a05a170fb56b91', 'r.cg': '854eef72b056a878', 'r.cchk': 'ok', 'r.achk': 'ok' }
// a text value from a caller that still passes one: it never reaches the id
const TEXT = '905c1610c3750e8a'
const NONE = { engine: 'other', android: false, safari17: false, firefox143: false, brave: false }

test('the deep id has its own version, 1, and is built from r.audio and r.cg; the text it hashes keeps the line r.ct=!ex', () => {
  assert.equal(DEEP_VERSION, 1)
  assert.deepEqual(DEEP_PARTS, ['r.audio', 'r.cg'])
  assert.deepEqual([...DEEP_PARTS].sort(), DEEP_PARTS)
})

test('deepRule: Blink and Gecko desktop run both reads; WebKit, Android and Brave read nothing, and an unknown engine excludes everything', () => {
  assert.equal(deepRule({ ...NONE, engine: 'blink' }), '')
  assert.equal(deepRule({ ...NONE, engine: 'gecko', firefox143: true }), '')
  assert.equal(deepRule({ ...NONE, engine: 'gecko' }), '')
  assert.equal(deepRule({ ...NONE, engine: 'webkit', safari17: true }), 'webkit')
  assert.equal(deepRule({ ...NONE, engine: 'blink', android: true }), 'android')
  assert.equal(deepRule({ ...NONE, engine: 'gecko', android: true }), 'android')
  assert.equal(deepRule({ ...NONE, engine: 'blink', brave: true }), 'brave')
  assert.equal(deepRule(NONE), 'other')
})

test('deepRule: the first rule that matches wins: other, then webkit, then android, then brave', () => {
  assert.equal(deepRule({ ...NONE, android: true, brave: true }), 'other')
  assert.equal(deepRule({ ...NONE, engine: 'webkit', android: true, brave: true }), 'webkit')
  assert.equal(deepRule({ ...NONE, engine: 'blink', android: true, brave: true }), 'android')
})

test('deepRule from the engine detection: each browser shape gets its rule from features, a desktop Chromium emulating a phone included', () => {
  const expected = {
    chromeDesktop: '', chromeDesktopHttp: '', emulatedAndroid: '', emulatedAndroidHttp: '', firefoxDesktop: '', firefoxDesktopHttp: '', firefox142: '',
    chromeAndroid: 'android', chromeAndroidHttp: 'android', firefoxAndroid: 'android', braveAndroid: 'android',
    braveDesktop: 'brave', safari16: 'webkit', safari17: 'webkit', webkitWindows: 'webkit', edgeHtml: 'other',
  }
  for (const name of Object.keys(expected)) assert.equal(deepRule(detectBuild(dress(fakeWindow(), BROWSERS[name]))), expected[name], name)
})

test('sealDeep: with both parts real the id is SHA-256 of the documented text, which a server recomputes with node:crypto', () => {
  const c = { ...REAL }
  const seal = sealDeep(c, '')
  assert.equal(seal.id, recipe(REAL))
  assert.equal(seal.id, sha('visito-deep:1\nr.audio=f4a05a170fb56b91\nr.cg=854eef72b056a878\nr.ct=!ex'))
  assert.deepEqual(seal.flags, { partial: [], noise: [], excluded: [], weak: false })
  assert.deepEqual([c['r.ct'], c['x.rule']], ['!ex', ''])
})

test('sealDeep: r.ct is "!ex" whatever a caller passes for it, never listed in the flags, and never moves the id', () => {
  const base = sealDeep({ ...REAL }, '').id
  for (const text of [TEXT, '0000000000000000', '!noise', '!err', '!to']) {
    const c = { ...REAL, 'r.ct': text }
    const seal = sealDeep(c, '')
    assert.equal(seal.id, base, text)
    assert.equal(c['r.ct'], '!ex', text)
    assert.deepEqual(seal.flags, { partial: [], noise: [], excluded: [], weak: false }, text)
  }
})

test("sealDeep: Firefox's deep id is the one it had when the text was left out by the gecko rule: the same pixels give the same id", () => {
  // what Firefox 155 gave on this PC with DEEP_VERSION 1 under the old gecko rule: r.ct "!ex", deep id 106031540038051152...
  const firefox = { 'r.audio': 'ce1b4e2c6cf8dd4e', 'r.cg': '9dd1b9c29de552d0', 'r.cchk': 'ok', 'r.achk': 'ok' }
  assert.equal(sealDeep({ ...firefox }, '').id, sha('visito-deep:1\nr.audio=ce1b4e2c6cf8dd4e\nr.cg=9dd1b9c29de552d0\nr.ct=!ex'))
  assert.match(sealDeep({ ...firefox }, '').id, /^106031540038051152/)
})

test('sealDeep: the worked example in docs/SIGNALS.md is what the code computes', () => {
  const doc = readFileSync(new URL('../docs/SIGNALS.md', import.meta.url), 'utf8')
  const section = doc.slice(doc.indexOf('### How the deep id is computed'))
  const block = /```\n(visito-deep:1\n[^`]*?)\n```/.exec(section)
  assert.ok(block, 'the section has the hashed text in a code block')
  const values = {}
  for (const line of block[1].split('\n').slice(1)) values[line.slice(0, line.indexOf('='))] = line.slice(line.indexOf('=') + 1)
  assert.deepEqual(Object.keys(values), ['r.audio', 'r.cg', 'r.ct'])
  assert.equal(values['r.ct'], '!ex')
  const id = sealDeep({ ...values }, '').id
  assert.equal(id, sha(block[1]))
  assert.ok(section.includes(id), `the section states the id ${id}`)
})

test('sealDeep: hints and other keys never reach the id, and one changed part changes it', () => {
  const base = sealDeep({ ...REAL }, '').id
  assert.equal(sealDeep({ ...REAL, 'r.cchk': 'something else', 'r.math': 'aaaaaaaaaaaaaaaa', 'x.engine': 'blink' }, '').id, base)
  assert.notEqual(sealDeep({ ...REAL, 'r.cg': '0000000000000000' }, '').id, base)
  assert.notEqual(sealDeep({ ...REAL, 'r.audio': '0000000000000000' }, '').id, base)
})

test('sealDeep: a part that failed, timed out or showed noise leaves no id, and the flags name it', () => {
  for (const [status, list] of [['!err', 'partial'], ['!to', 'partial'], ['!noise', 'noise']]) {
    for (const key of DEEP_PARTS) {
      const seal = sealDeep({ ...REAL, [key]: status }, '')
      assert.equal(seal.id, null, `${key} ${status}`)
      assert.deepEqual(seal.flags[list], [key], `${key} ${status}`)
      assert.equal(seal.flags.weak, false)
    }
  }
  const noisy = sealDeep({ ...REAL, 'r.cg': '!noise', 'r.cchk': 'pattern' }, '')
  assert.deepEqual(noisy.flags, { partial: [], noise: ['r.cg'], excluded: [], weak: false })
})

test('sealDeep: the flag lists are sorted, without calling sort', () => {
  const saved = Array.prototype.sort
  let seal
  try {
    Array.prototype.sort = () => { throw new Error('page replaced it') }
    seal = sealDeep({ ...REAL, 'r.audio': '!err', 'r.cg': '!to' }, '')
  } finally {
    Array.prototype.sort = saved
  }
  assert.deepEqual(seal.flags.partial, ['r.audio', 'r.cg'])
})

test('sealDeep: an excluding rule sets every part and both checks to "!ex", lists them, and gives no id', () => {
  for (const rule of ['webkit', 'android', 'brave', 'other']) {
    const c = { ...REAL }
    const seal = sealDeep(c, rule)
    assert.equal(seal.id, null, rule)
    assert.deepEqual(seal.flags, { partial: [], noise: [], excluded: ['r.audio', 'r.cg'], weak: false }, rule)
    assert.deepEqual([c['r.audio'], c['r.cg'], c['r.ct'], c['r.cchk'], c['r.achk'], c['x.rule']], ['!ex', '!ex', '!ex', '!ex', '!ex', rule])
  }
})

test('sealDeep: no id when no part holds a real value, so every browser without the APIs does not share one id', () => {
  for (const values of [{ 'r.audio': '!na', 'r.cg': '!na' }, { 'r.audio': '!ex', 'r.cg': '!na' }]) {
    const seal = sealDeep({ ...values }, '')
    assert.equal(seal.id, null)
    assert.equal(seal.flags.weak, false)
    assert.deepEqual(seal.flags.partial, [])
  }
})

test('sealDeep: an id built while some part is "!na" or "!ex" is weak, and its text holds that status', () => {
  const noAudio = { ...REAL, 'r.audio': '!na', 'r.achk': '!na' }
  const seal = sealDeep({ ...noAudio }, '')
  assert.equal(seal.id, recipe(noAudio))
  assert.equal(seal.flags.weak, true)
  const excluded = sealDeep({ ...REAL, 'r.audio': '!ex' }, '')
  assert.equal(excluded.flags.weak, true)
  assert.deepEqual(excluded.flags.excluded, ['r.audio'])
  assert.match(excluded.id, /^[0-9a-f]{64}$/)
})

test('sealDeep: a part missing from the values is unread, "!to", and leaves no id', () => {
  const c = { 'r.cg': REAL['r.cg'] }
  const seal = sealDeep(c, '')
  assert.equal(seal.id, null)
  assert.deepEqual(seal.flags.partial, ['r.audio'])
  assert.equal(c['r.audio'], '!to')
})

test('sealDeep: keys a page put on Object.prototype are ignored, the part names included', () => {
  const base = sealDeep({ ...REAL }, '')
  try {
    Object.prototype.polluted = '!err'
    Object.prototype['r.zz'] = '!noise'
    const seal = sealDeep({ ...REAL }, '')
    assert.deepEqual(seal, base)
    Object.prototype['r.audio'] = 'ffffffffffffffff'
    const missing = sealDeep({ 'r.cg': REAL['r.cg'] }, '')
    assert.equal(missing.id, null, 'an inherited part is not a value that was read')
    assert.deepEqual(missing.flags.partial, ['r.audio'])
  } finally {
    delete Object.prototype.polluted
    delete Object.prototype['r.zz']
    delete Object.prototype['r.audio']
  }
})

test('sealDeep: when hashing is impossible the id is null, "x.id" says "!err", and nothing is thrown', () => {
  const saved = String.prototype.charCodeAt
  const c = { ...REAL }
  let seal
  try {
    String.prototype.charCodeAt = () => { throw new Error('broken') }
    seal = sealDeep(c, '')
  } finally {
    String.prototype.charCodeAt = saved
  }
  assert.equal(seal.id, null)
  assert.equal(c['x.id'], '!err')
})

test('sealDeep: when the digest the reads used failed its known-answer test, every part that holds a value is "!err", "x.id" says "!err", and there is no id', () => {
  const c = { ...REAL, 'r.audio': '!na', 'r.achk': '!na' }
  const seal = sealDeep(c, '', true)
  assert.equal(seal.id, null)
  assert.deepEqual([c['r.audio'], c['r.cg'], c['r.ct'], c['x.id']], ['!na', '!err', '!ex', '!err'])
  assert.deepEqual(seal.flags, { partial: ['r.cg'], noise: [], excluded: [], weak: false })
  // an excluded browser hashes nothing, so a broken digest changes nothing there
  const webkit = { ...REAL }
  assert.deepEqual(sealDeep(webkit, 'webkit', true).flags.excluded, ['r.audio', 'r.cg'])
  assert.equal(webkit['x.id'], undefined)
})

test('sealDeep: when the hash throws, the flags still say what c says: the values stand, r.ct is "!ex", and there is no id', () => {
  const saved = String.prototype.charCodeAt
  const c = { ...REAL }
  let seal
  try {
    String.prototype.charCodeAt = () => { throw new Error('broken') }
    seal = sealDeep(c, '')
  } finally {
    String.prototype.charCodeAt = saved
  }
  assert.equal(seal.id, null)
  assert.equal(c['x.id'], '!err')
  assert.deepEqual([c['r.audio'], c['r.cg'], c['r.ct']], [REAL['r.audio'], REAL['r.cg'], '!ex'])
  assert.deepEqual(seal.flags, { partial: [], noise: [], excluded: [], weak: false })
})

test('sealDeep: a page whose string built-ins compute something else gets no id, not a wrong one: the hashes are checked against known answers first', () => {
  const saved = String.prototype.charCodeAt
  const c = { ...REAL }
  let seal
  try {
    // returns a number, so nothing throws; every byte hashed becomes the same
    String.prototype.charCodeAt = () => -1
    seal = sealDeep(c, '')
  } finally {
    String.prototype.charCodeAt = saved
  }
  assert.equal(seal.id, null)
  assert.equal(c['x.id'], '!err')
  assert.equal(seal.flags.weak, false)
  // the same hash made the parts, so they are not values either
  assert.deepEqual([c['r.audio'], c['r.cg'], c['r.ct']], ['!err', '!err', '!ex'])
})
