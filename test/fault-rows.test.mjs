import { test } from 'node:test'
import assert from 'node:assert/strict'
import { outcomeProblems, readingProblems, rowState } from '../lab/fault-rows.mjs'

const absent = (targets) => (target) => (targets.includes(target) ? { reason: 'this build lacks it' } : undefined)

test('fault rows: a row whose every target resolved is applied, and one whose every target is a known absence is not applicable', () => {
  assert.deepEqual(rowState(['window', 'Math'], [], absent([])), { state: 'applied', unknown: [] })
  assert.deepEqual(rowState(['AudioBuffer.prototype'], ['AudioBuffer.prototype'], absent(['AudioBuffer.prototype'])), { state: 'absent', unknown: [] })
})

test('fault rows: a row where only some targets are known absences is partly applied, not applied', () => {
  const state = rowState(['Math', 'AudioBuffer.prototype'], ['AudioBuffer.prototype'], absent(['AudioBuffer.prototype']))
  assert.deepEqual(state, { state: 'partial', unknown: [] })
})

test('fault rows: a target that does not resolve and is not a known absence is named, whatever else the row did', () => {
  assert.deepEqual(rowState(['HTMLCanvasElemnt.prototype'], ['HTMLCanvasElemnt.prototype'], absent([])), { state: 'absent', unknown: ['HTMLCanvasElemnt.prototype'] })
  assert.deepEqual(rowState(['Math', 'Nope'], ['Nope'], absent([])).unknown, ['Nope'])
})

test('fault rows: an expected outcome names statuses, check values, any value, the baseline value or a changed value', () => {
  const baseline = { 'r.cg': '0123456789abcdef', 'r.math': 'aaaaaaaaaaaaaaaa' }
  const c = { 'r.cg': '0123456789abcdef', 'r.ct': '!noise', 'r.cchk': 'pattern', 'r.math': 'bbbbbbbbbbbbbbbb', 'r.audio': 'fedcba9876543210' }
  assert.deepEqual(outcomeProblems({ 'r.cg': 'same', 'r.ct': '!noise', 'r.cchk': 'pattern', 'r.math': 'changed', 'r.audio': 'value' }, c, baseline), [])
  assert.deepEqual(outcomeProblems({ 'r.cg': 'changed', 'r.ct': 'value', 'r.cchk': 'ok', 'r.math': 'same', 'r.audio': '!na' }, c, baseline), [
    'r.cg is 0123456789abcdef, expected a value other than the baseline 0123456789abcdef',
    'r.ct is !noise, expected a value',
    'r.cchk is pattern, expected ok',
    'r.math is bbbbbbbbbbbbbbbb, expected the baseline aaaaaaaaaaaaaaaa',
    'r.audio is fedcba9876543210, expected !na',
  ])
})

test('fault rows: a list in an expected outcome accepts any of its entries, and a missing key is a problem', () => {
  assert.deepEqual(outcomeProblems({ 'r.audio': ['!na', 'value'] }, { 'r.audio': '0123456789abcdef' }, {}), [])
  assert.deepEqual(outcomeProblems({ 'r.audio': ['!na', '!err'] }, { 'r.audio': '!to' }, {}), ['r.audio is !to, expected !na or !err'])
  assert.deepEqual(outcomeProblems({ 'r.cg': '!noise' }, {}, {}), ['r.cg is missing, expected !noise'])
})

test('fault rows: a row with an expected outcome and no reading is a problem, not an outcome as expected', () => {
  assert.deepEqual(readingProblems({ 'r.cg': '!noise' }, null, { c: {} }), ['no reading'])
  assert.deepEqual(readingProblems({ 'r.cg': '!noise' }, { c: null }, { c: {} }), ['no reading'])
  assert.deepEqual(readingProblems({ 'r.cg': 'same' }, { c: { 'r.cg': '0123456789abcdef' } }, null), ['r.cg is 0123456789abcdef, expected the baseline undefined'])
  assert.deepEqual(readingProblems({ 'r.cg': 'same' }, { c: { 'r.cg': '0123456789abcdef' } }, { c: { 'r.cg': '0123456789abcdef' } }), [])
})
