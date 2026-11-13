import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { sealDeep } from '../build/esm/deepseal.js'

const CHECK = fileURLToPath(new URL('../lab/old-engines/check-deep.mjs', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'visito-old-deep-'))
let files = 0
after(() => rmSync(dir, { recursive: true, force: true }))

/** A synthetic deep reading of the shape an old desktop Chrome returns, sealed by the library's own sealDeep(). */
function reading(values = {}) {
  const c = { 'r.audio': 'f4a05a170fb56b91', 'r.cg': '854eef72b056a878', 'r.cchk': 'ok', 'r.achk': 'ok', ...values }
  const seal = sealDeep(c, '')
  return { v: 1, id: seal.id, c, flags: seal.flags, ms: 30.5, t: { 'canvas:pattern': 1.2, audio: 4 } }
}
const ua = (chrome) => `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
function page(edit = (out) => out, { chrome = '53.0.2785.116', values } = {}) {
  const out = edit({ errors: [], calls: 1, early: false, ua: ua(chrome), defined: 'object', got: reading(values), called: true })
  return `VISITO_RESULT ${encodeURIComponent(JSON.stringify(out))} END`
}
function block({ tag = '2.53.0', chrome = '53.0.2785.116', values, result = page(undefined, { chrome, values }), tail = '' } = {}) {
  return [`IMAGE selenium/standalone-chrome:${tag}@sha256:${'a'.repeat(64)}`, `VERSION Google Chrome ${chrome} `, result, tail].filter(Boolean).join('\n') + '\n'
}
function check(...blocks) {
  const file = join(dir, `deep-${files++}.txt`)
  writeFileSync(file, blocks.join(''))
  try {
    return { status: 0, output: execFileSync(process.execPath, [CHECK, file, '--build', 'deep'], { encoding: 'utf8', stdio: 'pipe' }) }
  } catch (error) {
    return { status: error.status, output: String(error.stdout) + String(error.stderr) }
  }
}

test('old-engines deep check passes a block whose deep id Node recomputes from c, and prints the id', () => {
  const { status, output } = check(block())
  assert.equal(status, 0, output)
  assert.match(output, /^ok .*Chrome 53\.0\.2785\.116.*deep id same/m)
  assert.ok(output.includes(reading().id.slice(0, 16)))
})

test('old-engines deep check fails a deep id the browser computed differently', () => {
  const { status, output } = check(block({ result: page((out) => ({ ...out, got: { ...out.got, id: 'f'.repeat(64) } })) }))
  assert.equal(status, 1, output)
  assert.match(output, /not the one recomputed/)
})

test('old-engines deep check fails a reading without a deep id, a check that fired, or audio that did not render', () => {
  const noise = check(block({ values: { 'r.cg': '!noise', 'r.cchk': 'pattern' } }))
  assert.equal(noise.status, 1, noise.output)
  assert.match(noise.output, /r\.cchk is pattern/)
  const noAudio = check(block({ values: { 'r.audio': '!err', 'r.achk': '!err' } }))
  assert.equal(noAudio.status, 1, noAudio.output)
  assert.match(noAudio.output, /r\.achk is !err/)
})

test('old-engines deep check fails a desktop Chrome that a rule excluded', () => {
  const r = reading()
  sealDeep(r.c, 'other')
  const { status, output } = check(block({ result: page((out) => ({ ...out, got: { ...r, id: null, flags: { partial: [], noise: [], excluded: ['r.audio', 'r.cg'], weak: false } } })) }))
  assert.equal(status, 1, output)
  assert.match(output, /x\.rule is "other"/)
})

test('old-engines deep check fails a page error, a callback that never came, came twice or came before get() returned', () => {
  for (const [edit, message] of [
    [(out) => ({ ...out, errors: ['TypeError: x @1'] }), /page error: TypeError/],
    [(out) => ({ ...out, got: undefined, called: undefined, calls: 0, timedOut: true }), /get\(\) never called back/],
    [(out) => ({ ...out, calls: 2 }), /called back 2 times/],
    [(out) => ({ ...out, early: true }), /before get\(\) returned/],
    [(out) => ({ ...out, defined: 'undefined' }), /VisitoDeep is undefined/],
    [(out) => ({ ...out, got: null }), /no reading/],
  ]) {
    const { status, output } = check(block({ result: page(edit) }))
    assert.equal(status, 1, output)
    assert.match(output, message)
  }
})

test('old-engines deep check fails an image whose Chrome is not the one its tag stands for, or that did not run', () => {
  const wrong = check(block({ tag: '3.4.0-einsteinium' }))
  assert.equal(wrong.status, 1, wrong.output)
  assert.match(wrong.output, /should hold Chrome 59/)
  const failed = check(block({ tail: 'RUN_FAILED' }))
  assert.equal(failed.status, 1, failed.output)
})

test('old-engines deep check names the parts that moved where the deep id changes between versions', () => {
  const { status, output } = check(block(), block({ tag: '3.4.0-einsteinium', chrome: '59.0.3071.115', values: { 'r.cg': '0123456789abcdef' } }))
  assert.equal(status, 0, output)
  assert.match(output, /deep id changes from Chrome 53 .* to Chrome 59 .*: r\.cg 854eef72b056a878 -> 0123456789abcdef/)
})
