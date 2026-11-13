import { test } from 'node:test'
import assert from 'node:assert/strict'
import { match } from '../build/esm/match.js'

// Shapes taken from a real phone session; stored ids shortened.
const seen = (over = {}, c = {}) => ({
  did: 'd-chrome', os: 'android', osVer: null, app: 'chrome', appVer: '157.0.0.0',
  ...over,
  c: { 'hw.model': 'Pixel 10', 'hw.mem': 8, 'p.lang': 'en-US', 'p.txt': 1.15, ...c },
})
const instagram = (over = {}, c = {}) => seen({ did: 'd-insta', osVer: '17', app: 'instagram', appVer: '455.0.0.51.72', ...over }, c)
const safari = (over = {}) => ({ did: 'd-safari', os: 'ios', osVer: '27.2', app: 'safari', appVer: '27.2', ...over, c: { 'hw.model': '!na', 'hw.mem': '!na', 'p.lang': 'en-GB', 'p.txt': 17, 'hw.scr': '!ex', 'hw.cores': 4 } })

test('the stored id decides alone, whatever else changed', () => {
  const later = seen({ appVer: '158.0.0.0' }, { 'p.lang': 'fr-FR', 'p.txt': 1.3 })
  assert.deepEqual(match(later, [instagram(), seen()]), { result: 'same', rule: 'stored id', index: 1 })
})

test('one phone seen in Chrome and then in an in-app browser: likely, through the model and the settings', () => {
  assert.deepEqual(match(instagram(), [seen()]), { result: 'likely', rule: 'model and settings', index: 0 })
})

test('several earlier readings of one stored id are one device, not a tie', () => {
  assert.deepEqual(match(instagram(), [seen(), seen({ appVer: '156.0.0.0' })]), { result: 'likely', rule: 'model and settings', index: 1 })
})

test('two stored ids that fit equally well are a tie: unknown, never a guess', () => {
  assert.deepEqual(match(instagram(), [seen(), seen({ did: 'd-other-phone' })]), { result: 'unknown', rule: 'tie', index: -1 })
})

test('a browser that names no model can be neither confirmed nor ruled out', () => {
  const sameIphoneInApp = { ...safari({ did: 'd-insta', app: 'instagram', appVer: '437.2.0.25.50' }), c: { 'hw.model': 'iPhone15,2', 'hw.mem': '!na', 'p.lang': 'en-GB', 'p.txt': 17 } }
  assert.deepEqual(match(sameIphoneInApp, [safari()]), { result: 'unknown', rule: 'no model to compare', index: -1 })
})

test('a different model, language, memory size or text size is a different device', () => {
  assert.equal(match(seen({ did: 'x' }, { 'hw.model': 'SM-A155F' }), [seen()]).rule, 'hw.model')
  assert.equal(match(seen({ did: 'x' }, { 'p.lang': 'pt-BR' }), [seen()]).rule, 'p.lang')
  assert.equal(match(seen({ did: 'x' }, { 'hw.mem': 4 }), [seen()]).rule, 'hw.mem')
  assert.deepEqual(match(seen({ did: 'x' }, { 'p.txt': 1 }), [seen()]), { result: 'different', rule: 'p.txt', index: -1 })
  assert.equal(match(safari({ did: 'x' }), [seen()]).rule, 'os')
})

test('a value one side cannot give is no evidence either way', () => {
  const brave = seen({ did: 'd-brave' }, { 'hw.mem': '!ex' })
  assert.equal(match(brave, [seen()]).result, 'likely')
})

test('versions do not go backwards: an older system, or an older build of the same app, is another device', () => {
  assert.deepEqual(match(instagram({ did: 'x', osVer: '16' }), [instagram()]), { result: 'different', rule: 'os went back', index: -1 })
  assert.equal(match(instagram({ did: 'x', appVer: '455.0.0.51.9' }), [instagram()]).rule, 'app went back')
  assert.equal(match(instagram({ did: 'x', appVer: '456.0.0.1.1', osVer: '17.1' }), [instagram()]).result, 'likely')
  assert.equal(match(seen({ did: 'x' }), [instagram()]).result, 'likely', 'another app has its own version numbers')
})

test('nothing to compare with is unknown', () => {
  assert.deepEqual(match(seen(), []), { result: 'unknown', rule: 'nothing to compare', index: -1 })
})

test('a reading without a stored id never matches another reading without one through it', () => {
  assert.equal(match(seen({ did: null }), [seen({ did: null })]).result, 'likely')
  assert.notEqual(match(seen({ did: null }), [seen({ did: null })]).rule, 'stored id')
})

test('two earlier readings without a stored id may be two devices: a tie, not one device', () => {
  assert.deepEqual(match(instagram(), [seen({ did: null }), seen({ did: null })]), { result: 'unknown', rule: 'tie', index: -1 })
  assert.deepEqual(match(instagram(), [seen(), seen({ did: null })]), { result: 'unknown', rule: 'tie', index: -1 })
})

test('a value a store turned into a string is the same part as the number it was', () => {
  const stored = seen({}, { 'hw.mem': '8', 'p.txt': '1.15' })
  assert.deepEqual(match(instagram(), [stored]), { result: 'likely', rule: 'model and settings', index: 0 })
  assert.equal(match(instagram({}, { 'hw.mem': '4' }), [seen()]).rule, 'hw.mem', 'a different value is still different')
})

test('a malformed candidate is not compared part by part and never throws', () => {
  const noParts = seen()
  delete noParts.c
  const bad = [noParts, { ...seen(), c: null }, { ...seen(), c: 'x' }, null, 7, 'reading']
  assert.deepEqual(match(instagram(), bad), { result: 'unknown', rule: 'nothing to compare', index: -1 })
  assert.deepEqual(match(instagram(), [null, seen()]), { result: 'likely', rule: 'model and settings', index: 1 })
  assert.deepEqual(match(seen(), [{ ...seen(), c: null }]), { result: 'same', rule: 'stored id', index: 0 }, 'the stored id needs no parts')
  assert.deepEqual(match(instagram({ did: 'x' }, { 'hw.model': 'SM-A155F' }), [undefined, seen()]), { result: 'different', rule: 'hw.model', index: -1 })
  assert.equal(match(instagram({ did: 'x', osVer: 16 }), [instagram({ osVer: 17 })]).rule, 'os went back', 'a version stored as a number')
})

test('a malformed reading to match gives unknown, nothing to compare, unless its stored id decides', () => {
  const noParts = seen({ did: 'x' })
  delete noParts.c
  for (const now of [noParts, { ...seen({ did: 'x' }), c: null }, null, undefined, 'reading']) {
    assert.deepEqual(match(now, [seen()]), { result: 'unknown', rule: 'nothing to compare', index: -1 })
  }
  assert.deepEqual(match(seen(), null), { result: 'unknown', rule: 'nothing to compare', index: -1 })
})

test('the stored id decides on its own: a candidate without parts still matches through it, whatever its version', () => {
  const noParts = seen({ v: 1 })
  delete noParts.c
  assert.deepEqual(match(seen({ v: 2 }), [instagram(), noParts]), { result: 'same', rule: 'stored id', index: 1 })
  assert.deepEqual(match(seen(), [{ ...seen({ v: 3 }), c: 'x' }]), { result: 'same', rule: 'stored id', index: 0 })
  assert.deepEqual(match(seen(), [{ did: 'd-chrome' }]), { result: 'same', rule: 'stored id', index: 0 })
  assert.deepEqual(match(seen(), [{ did: 'd-chrome', c: null, v: { toString: 1 } }]), { result: 'same', rule: 'stored id', index: 0 })
  assert.deepEqual(match(seen(), [null, 7, 'd-chrome', ['d-chrome']]), { result: 'unknown', rule: 'nothing to compare', index: -1 }, 'only an object has a stored id')
})

test('a reading to match without parts still matches through its stored id', () => {
  const noParts = seen()
  delete noParts.c
  assert.deepEqual(match(noParts, [instagram(), seen()]), { result: 'same', rule: 'stored id', index: 1 })
  assert.deepEqual(match({ did: 'd-chrome' }, [seen()]), { result: 'same', rule: 'stored id', index: 0 })
  assert.deepEqual(match({ did: 'd-chrome', c: null, v: 9 }, [{ did: 'd-chrome' }]), { result: 'same', rule: 'stored id', index: 0 })
  assert.deepEqual(match(noParts, [instagram()]), { result: 'unknown', rule: 'nothing to compare', index: -1 })
})

test('a stored id counts only when it is a non-empty string on both sides', () => {
  // a store that corrupts the field the same way on both sides must not make two readings one device
  for (const json of ['true', 'false', '5', '0', '""', '{}', '[]', '["d-chrome"]', '{"toString":1}']) {
    const odd = JSON.parse(json)
    assert.deepEqual(match(instagram({ did: odd }), [seen({ did: odd })]), { result: 'likely', rule: 'model and settings', index: 0 }, `did ${json}`)
    assert.deepEqual(match(instagram(), [seen({ did: odd }), seen({ did: odd })]), { result: 'unknown', rule: 'tie', index: -1 }, `two candidates with did ${json}`)
  }
  assert.equal(match(instagram({ did: 5 }), [seen({ did: '5' })]).rule, 'model and settings', 'a number is no stored id, even against its text')
})

test('a reading of another id version is neither confirmed nor ruled out part by part', () => {
  assert.deepEqual(match(instagram({ v: 3 }), [seen({ v: 2 })]), { result: 'unknown', rule: 'other id version', index: -1 })
  assert.deepEqual(match(instagram({ did: 'x', v: 3 }, { 'hw.model': 'SM-A155F' }), [seen({ v: 2 })]), { result: 'unknown', rule: 'other id version', index: -1 })
  assert.deepEqual(match(instagram({ v: 3 }), [seen({ v: 2 }), seen({ v: 3 })]), { result: 'likely', rule: 'model and settings', index: 1 })
  assert.equal(match(instagram({ v: 2 }), [seen({ v: '2' })]).result, 'likely', 'a version a store turned into a string')
})

test('the stored id decides across id versions, and a missing version behaves as before', () => {
  assert.deepEqual(match(seen({ v: 3 }), [seen({ v: 2 })]), { result: 'same', rule: 'stored id', index: 0 })
  assert.equal(match(instagram({ v: 3 }), [seen()]).result, 'likely')
  assert.equal(match(instagram(), [seen({ v: 2 })]).result, 'likely')
  assert.equal(match(instagram({ v: null }), [seen({ v: 2 })]).result, 'likely')
})

test('versions are compared only on the fields both sides have', () => {
  assert.equal(match(instagram({ did: 'x', osVer: '17' }), [instagram({ osVer: '17.0.1' })]).result, 'likely')
  assert.equal(match(instagram({ did: 'x', osVer: '17.0.1' }), [instagram({ osVer: '17' })]).result, 'likely')
  assert.equal(match(instagram({ did: 'x', osVer: '16.9' }), [instagram({ osVer: '17' })]).rule, 'os went back')
  assert.equal(match(instagram({ did: 'x', appVer: '455' }), [instagram()]).result, 'likely')
  assert.equal(match(instagram({ did: 'x', appVer: '454' }), [instagram()]).rule, 'app went back')
})

// What a store can hand back: every one is valid JSON, and some have no text form at all.
const HOSTILE = [
  'null', 'true', 'false', '0', '-1', '1e308', '""', '"!"', '"!na"', '"x"', '".."', '"17..1"',
  '[]', '[null]', '[[]]', '["17"]', '[{"toString":1}]',
  '{}', '{"toString":1}', '{"toString":null}', '{"toString":{}}', '{"toString":1,"valueOf":1}',
  '{"valueOf":1}', '{"__proto__":null}', '{"charAt":1,"split":1}', '{"length":2,"0":"1","1":"2"}',
]
const RULES = ['stored id', 'model and settings', 'tie', 'no model to compare', 'other id version', 'nothing to compare', 'os', 'os went back', 'app went back', 'hw.model', 'hw.mem', 'p.lang', 'p.txt', 'hw.scr', 'hw.cores']
const FIELDS = ['did', 'os', 'osVer', 'app', 'appVer', 'v', 'c']
const PART_KEYS = ['hw.model', 'hw.mem', 'p.lang', 'p.txt', 'hw.scr', 'hw.cores']

test('no JSON value in any field, on either side, makes the matcher throw or answer off its list', () => {
  // each case reaches a different rule: versions compared, a tie between stored ids, and the stored id itself
  const cases = [
    () => [instagram({ did: 'x', v: 2 }), [instagram({ v: 2 })]],
    () => [instagram({ v: 2 }), [seen({ v: 2 }), seen({ v: 2, did: 'd-other' })]],
    () => [seen({ v: 2 }), [seen({ v: 2 })]],
  ]
  let calls = 0
  for (const make of cases) {
    const sides = make()[1].length + 1
    for (let side = 0; side < sides; side++) {
      for (const json of HOSTILE) {
        // a field of the reading, a value in its parts, or the whole reading
        const edits = FIELDS.map((f) => [f, (r) => { r[f] = JSON.parse(json); return r }])
          .concat(PART_KEYS.map((k) => ['c.' + k, (r) => { r.c[k] = JSON.parse(json); return r }]))
          .concat([['the reading', () => JSON.parse(json)]])
        for (const [field, edit] of edits) {
          let [now, earlier] = make()
          if (side === 0) now = edit(now)
          else earlier[side - 1] = edit(earlier[side - 1])
          let out
          assert.doesNotThrow(() => { out = match(now, earlier) }, `${field} = ${json} on side ${side}`)
          calls++
          assert.ok(['same', 'likely', 'unknown', 'different'].indexOf(out.result) >= 0, out.result)
          assert.ok(RULES.indexOf(out.rule) >= 0, out.rule)
          const decided = out.result === 'same' || out.result === 'likely'
          assert.equal(decided, out.index >= 0, `${json}: index ${out.index} with ${out.result}`)
          assert.ok(out.index < earlier.length && Number.isInteger(out.index))
        }
      }
    }
  }
  assert.ok(calls > 2000, `${calls} calls`)
  for (const json of HOSTILE) {
    // as the list of earlier readings: nothing in it can be compared
    assert.deepEqual(match(instagram(), JSON.parse(json)), { result: 'unknown', rule: 'nothing to compare', index: -1 }, json)
  }
})

test('a version that has no text form counts as missing, on either side', () => {
  for (const json of ['{"toString":1}', '[{"toString":1}]', '{}', '[]', 'true']) {
    const odd = JSON.parse(json)
    assert.equal(match(instagram({ did: 'x', osVer: odd }), [instagram()]).result, 'likely', `osVer ${json}`)
    assert.equal(match(instagram({ did: 'x' }), [instagram({ osVer: odd })]).result, 'likely', `earlier osVer ${json}`)
    assert.equal(match(instagram({ did: 'x', appVer: odd }), [instagram()]).result, 'likely', `appVer ${json}`)
    assert.equal(match(instagram({ did: 'x' }), [instagram({ appVer: odd })]).result, 'likely', `earlier appVer ${json}`)
    assert.equal(match(instagram({ v: odd }), [seen({ v: 2 })]).result, 'likely', `v ${json} is no id version`)
    assert.equal(match(instagram({ v: 2 }), [seen({ v: odd })]).result, 'likely', `earlier v ${json}`)
  }
})

test('a JSON value the docs call missing gives the answer its absence gives, in every field and on either side', () => {
  // one scenario per rule, so a hostile value cannot hide behind an answer that would come out the same anyway
  const cases = [
    () => [seen({ v: 2 }), [seen({ v: 2 })]],
    () => [instagram({ did: 'x', v: 2 }), [instagram({ v: 2 })]],
    () => [instagram({ v: 2 }), [seen({ v: 2 }), seen({ v: 2, did: 'd-other' })]],
    () => [safari({ did: 'x', v: 2 }), [safari({ v: 2 })]],
    () => [instagram({ v: 3 }), [seen({ v: 2 })]],
    () => [instagram({ did: 'x', v: 2, osVer: '16' }), [instagram({ v: 2 })]],
    () => [instagram({ did: 'x', v: 2, appVer: '454' }), [instagram({ v: 2 }), seen({ v: 2, did: 'd-other' }, { 'hw.mem': 4 })]],
  ]
  const textless = (x) => typeof x !== 'string' && typeof x !== 'number'
  const noEvidence = (x) => !(typeof x === 'number' || (typeof x === 'string' && x.charAt(0) !== '!'))
  const notObject = (x) => !x || typeof x !== 'object'
  const noId = (x) => typeof x !== 'string' || x === ''
  const rules = new Set()
  let checked = 0
  for (const make of cases) {
    const sides = make()[1].length + 1
    for (let side = 0; side < sides; side++) {
      const run = (edit) => {
        const pair = make()
        edit(pair, side === 0 ? pair[0] : pair[1][side - 1])
        return match(pair[0], pair[1])
      }
      // something that is not a reading at all is skipped as if it were not in the list, and so is a reading without parts unless its stored id decides
      const skipped = side === 0 ? { result: 'unknown', rule: 'nothing to compare', index: -1 } : run((pair) => pair[1].splice(side - 1, 1))
      if (skipped.index >= side - 1 && side > 0) skipped.index++
      const base = run(() => {})
      rules.add(base.rule)
      // the stored id needs no parts: where it decided, a reading without them gives the same answer
      const unparted = base.rule === 'stored id' && (side === 0 || base.index === side - 1) ? base : skipped
      for (const json of HOSTILE) {
        const value = JSON.parse(json)
        const where = `${json} on side ${side} of ${make()[0].did}`
        for (const f of ['osVer', 'appVer', 'v']) {
          if (!textless(value)) continue
          assert.deepEqual(run((_, r) => { r[f] = value }), run((_, r) => { r[f] = null }), `${f} = ${where}`)
          checked++
        }
        if (noId(value)) {
          assert.deepEqual(run((_, r) => { r.did = value }), run((_, r) => { r.did = null }), `did = ${where}`)
          checked++
        }
        for (const k of PART_KEYS) {
          if (!noEvidence(value)) continue
          assert.deepEqual(run((_, r) => { r.c[k] = value }), run((_, r) => { delete r.c[k] }), `c.${k} = ${where}`)
          checked++
        }
        if (notObject(value)) {
          assert.deepEqual(run((_, r) => { r.c = value }), unparted, `c = ${where}`)
          assert.deepEqual(run((pair) => { if (side === 0) pair[0] = value; else pair[1][side - 1] = value }), skipped, `the reading = ${where}`)
          checked += 2
        }
      }
    }
  }
  assert.deepEqual([...rules].sort(), ['app went back', 'model and settings', 'no model to compare', 'os went back', 'other id version', 'stored id', 'tie'])
  assert.ok(checked > 1500, `${checked} checks`)
})
