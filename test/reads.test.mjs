import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safe } from '../build/esm/guard.js'
import { language, memory, tzOffset } from '../build/esm/reads.js'

const throwing = (name) =>
  Object.defineProperty({}, name, {
    get() {
      throw new Error('blocked')
    },
  })

test('safe: a value passes through, a missing value is "!na", a throw is "!err"', () => {
  assert.equal(safe(() => 'fr-FR'), 'fr-FR')
  assert.equal(safe(() => 0), 0)
  assert.equal(safe(() => false), false)
  assert.equal(safe(() => undefined), '!na')
  assert.equal(safe(() => null), '!na')
  assert.equal(safe(() => NaN), '!na')
  assert.equal(
    safe(() => {
      throw new Error('boom')
    }),
    '!err',
  )
})

test('language: the primary language as the browser reports it', () => {
  assert.equal(language({ navigator: { language: 'hi-IN', languages: ['hi-IN', 'en'] } }), 'hi-IN')
})

test('language: missing, wrong type and throwing navigator', () => {
  assert.equal(language({ navigator: {} }), '!na')
  assert.equal(language({ navigator: { language: 42 } }), '!na')
  assert.equal(language({}), '!err')
  assert.equal(language({ navigator: throwing('language') }), '!err')
})

test('memory: bucketed to 2, 4 or 8 so a browser update that changes the reported steps changes nothing', () => {
  const bucket = (deviceMemory) => memory({ navigator: { deviceMemory } })
  assert.deepEqual([0.25, 0.5, 1, 2, 3].map(bucket), [2, 2, 2, 2, 2])
  assert.deepEqual([4, 6].map(bucket), [4, 4])
  assert.deepEqual([8, 16, 32].map(bucket), [8, 8, 8])
})

test('memory: absent (Safari, Firefox), spoofed type and throwing getter', () => {
  assert.equal(memory({ navigator: {} }), '!na')
  assert.equal(memory({ navigator: { deviceMemory: '4' } }), 4)
  assert.equal(memory({ navigator: { deviceMemory: 'lots' } }), '!na')
  assert.equal(memory({ navigator: { deviceMemory: -1 } }), '!na')
  assert.equal(memory({ navigator: throwing('deviceMemory') }), '!err')
})

test('tzOffset: minutes from UTC', () => {
  assert.equal(tzOffset(), new Date().getTimezoneOffset())
})
