import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { sealDeep } from '../build/esm/deepseal.js'
import { deepId, deepProblems } from '../lab/deep-schema.mjs'

/** A reading of the shape the entry returns, sealed by the library itself. */
function reading(values, rule = '', broken = false) {
  const c = { 'r.audio': 'f4a05a170fb56b91', 'r.cg': '854eef72b056a878', 'r.cchk': 'ok', 'r.achk': 'ok', ...values }
  const seal = sealDeep(c, rule, broken)
  return { v: 1, id: seal.id, c, flags: seal.flags, ms: 12.5, t: { 'canvas:pattern': 0.4, audio: 2 } }
}

test('deep schema: what the library seals passes, clean, noisy, excluded or weak, and its id is the one Node recomputes', () => {
  const clean = reading({})
  assert.deepEqual(deepProblems(clean), [])
  assert.equal(clean.id, deepId(clean.c))
  assert.deepEqual(deepProblems(reading({ 'r.cg': '!noise', 'r.cchk': 'pattern' })), [])
  assert.deepEqual(deepProblems(reading({ 'r.audio': '!to', 'r.achk': '!to' })), [])
  assert.deepEqual(deepProblems(reading({ 'r.audio': '!na', 'r.achk': '!na' })), [])
  for (const rule of ['webkit', 'android', 'brave', 'other']) assert.deepEqual(deepProblems(reading({}, rule)), [], rule)
  const broken = reading({}, '', true)
  assert.deepEqual(deepProblems(broken), [])
  assert.equal(broken.c['x.id'], '!err')
})

test('deep schema: the id Node recomputes is SHA-256 over r.audio, r.cg and the fixed line r.ct=!ex', () => {
  const c = { 'r.audio': 'f4a05a170fb56b91', 'r.cg': '854eef72b056a878' }
  assert.equal(deepId(c), createHash('sha256').update('visito-deep:1\nr.audio=f4a05a170fb56b91\nr.cg=854eef72b056a878\nr.ct=!ex', 'utf8').digest('hex'))
})

test('deep schema: a reading with a text value, a gecko rule or r.ct missing is a problem: the entry never reads the text scene', () => {
  const clean = reading({})
  assert.match(deepProblems({ ...clean, c: { ...clean.c, 'r.ct': '905c1610c3750e8a' } }).join(), /r\.ct/)
  const missing = { ...clean.c }
  delete missing['r.ct']
  assert.match(deepProblems({ ...clean, c: missing }).join(), /r\.ct/)
  assert.match(deepProblems({ ...clean, c: { ...clean.c, 'x.rule': 'gecko' } }).join(), /x\.rule/)
  assert.match(deepProblems({ ...clean, c: { ...clean.c, 'r.cchk': 'text' } }).join(), /r\.cchk/)
  assert.match(deepProblems({ ...clean, flags: { ...clean.flags, excluded: ['r.ct'] } }).join(), /flags\.excluded/)
})

test('deep schema: a wrong id, a missing id, an id where none is due, or wrong flags are problems', () => {
  const clean = reading({})
  assert.match(deepProblems({ ...clean, id: 'f'.repeat(64) }).join(), /not the one recomputed/)
  assert.match(deepProblems({ ...clean, id: null }).join(), /not the one recomputed/)
  const noisy = reading({ 'r.audio': '!noise', 'r.achk': 'pattern' })
  assert.match(deepProblems({ ...noisy, id: clean.id }).join(), /where none is due/)
  assert.match(deepProblems({ ...noisy, flags: { ...noisy.flags, noise: [] } }).join(), /flags\.noise/)
  assert.match(deepProblems({ ...clean, flags: { ...clean.flags, weak: true } }).join(), /flags\.weak/)
})

test('deep schema: inconsistent checks, an unknown rule or extra keys are problems', () => {
  assert.match(deepProblems(reading({ 'r.cchk': 'ok', 'r.cg': '!noise' })).join(), /canvas noise with r\.cchk ok|r\.cchk is ok without/)
  assert.match(deepProblems(reading({ 'r.achk': 'ok', 'r.audio': '!err' })).join(), /r\.achk is ok without/)
  assert.match(deepProblems({ ...reading({}), c: { ...reading({}).c, 'x.rule': 'firefox' } }).join(), /x\.rule/)
  assert.match(deepProblems({ ...reading({}), did: 'x' }).join(), /keys are/)
  assert.deepEqual(deepProblems(null), ['not a reading'])
})
