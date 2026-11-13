import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { seal } from '../build/esm/reading.js'

const CHECK = fileURLToPath(new URL('../lab/old-engines/check.mjs', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'visito-old-engines-'))
let files = 0
after(() => rmSync(dir, { recursive: true, force: true }))

// A synthetic reading of the shape an old desktop Chrome returns, with both ids computed by the library's own seal().
// `extra` adds values before sealing: a lab-only hint, or a different id part. `skip` names the parts seal() excludes.
function reading(extra = {}, skip = {}) {
  const c = {
    'hw.model': '!na',
    'hw.mem': '!na',
    // a line break and a non-ASCII letter, so the recomputation has to follow the canonical text exactly
    'p.lang': 'de-CH\nfr-CH é',
    'x.engine': 'blink',
    'x.android': false,
    'x.scr': '1366x768',
    'x.cores': 4,
    'x.txt.env': 1,
    'x.txt.fs': 100,
    'x.txt.w': 412,
    'x.txt.apple': '!na',
    ...extra,
  }
  const versions = { osVer: null, app: 'chrome', appVer: '53.0.2785.116', engineVer: 53 }
  const ids = seal(c, skip, versions)
  return {
    v: 3,
    did: '0b8e8a3c-2f6d-4c39-9d3e-6a1f0c2b7e45',
    didNew: true,
    didSrc: 'cl',
    model: null,
    os: 'linux',
    ...versions,
    c,
    id: ids.id,
    idStrict: ids.idStrict,
    flags: { partial: [], auto: [], private: null, weak: true },
    ms: 4.2,
    t: { ua: 0.4, did: 0.6 },
  }
}

// only the lab build reads the time-zone offset (syncReads in src/reads.ts) and records each engine test's result
// (featureMarks in src/env.ts): a desktop Chrome passes all five Blink tests and too few of any other engine's
const LAB = {
  'x.tzo': -60,
  'x.ev.blink': '11111',
  'x.ev.webkit': '00000',
  'x.ev.gecko': '00000',
  'x.ev.android': '00110',
  'x.ev.safari17': '00000',
  'x.ev.firefox143': '001',
  'x.ev.brave': '0',
}

const ua = (chrome) => `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`

function page(edit = (out) => out, { chrome = '53.0.2785.116', extra, skip } = {}) {
  const r = reading(extra, skip)
  const out = edit({ errors: [], ua: ua(chrome), defined: 'object', sync: r, got: r, called: true })
  return `VISITO_RESULT ${encodeURIComponent(JSON.stringify(out))} END`
}

function block({ tag = '2.53.0', chrome = '53.0.2785.116', version = `VERSION Google Chrome ${chrome} `, extra, skip, result = page(undefined, { chrome, extra, skip }), tail = '' } = {}) {
  return [`IMAGE selenium/standalone-chrome:${tag}@sha256:${'a'.repeat(64)}`, version, result, tail].filter(Boolean).join('\n') + '\n'
}

function checkWith(args, ...blocks) {
  const file = join(dir, `old-engines-${files++}.txt`)
  writeFileSync(file, blocks.join(''))
  try {
    return { status: 0, output: execFileSync(process.execPath, [CHECK, file, ...args], { encoding: 'utf8', stdio: 'pipe' }) }
  } catch (error) {
    return { status: error.status, output: String(error.stdout) + String(error.stderr) }
  }
}

const check = (...blocks) => checkWith(['--build', 'product'], ...blocks)

// the images run.sh pulls by default, with the Chrome each one holds
const ENGINES = [
  ['2.53.0', '53.0.2785.143'],
  ['3.4.0-einsteinium', '59.0.3071.115'],
  ['3.8.1-erbium', '63.0.3239.132'],
  ['3.14.0-arsenic', '68.0.3440.84'],
  ['3.141.59-zirconium', '80.0.3987.106'],
]

test('the synthetic reading has both ids, so the cases below compare something', () => {
  const r = reading()
  assert.match(r.id, /^[0-9a-f]{64}$/)
  assert.match(r.idStrict, /^[0-9a-f]{64}$/)
})

test('old-engines check passes a block whose ids equal the ones recomputed from c, and names the version', () => {
  const { status, output } = check(block())
  assert.equal(status, 0, output)
  assert.match(output, /^ok .*Chrome 53\.0\.2785\.116/m)
  assert.match(output, /id=same idStrict=same/)
  // the number of values read tells a lab-build line from a product-build line
  assert.match(output, new RegExp(` c=${Object.keys(reading().c).length} `))
})

test('old-engines check fails when the id the browser computed differs from the recomputed one', () => {
  const { status, output } = check(block({ result: page((out) => ({ ...out, got: { ...out.got, id: 'f'.repeat(64) } })) }))
  assert.equal(status, 1, output)
  assert.match(output, /^FAIL .*id differs from SHA-256 of c/m)
})

test('old-engines check fails when only idStrict differs', () => {
  const { status, output } = check(block({ result: page((out) => ({ ...out, got: { ...out.got, idStrict: '0'.repeat(64) } })) }))
  assert.equal(status, 1, output)
  assert.match(output, /idStrict differs from SHA-256 of c/)
})

test('old-engines check fails a reading without an id: there is nothing to prove the hash with', () => {
  const { status, output } = check(block({ result: page((out) => ({ ...out, got: { ...out.got, id: null, idStrict: null } })) }))
  assert.equal(status, 1, output)
  assert.match(output, /no id to compare/)
})

test('old-engines check fails a silent exit: every old engine must return a reading', () => {
  const { status, output } = check(block({ result: page((out) => ({ ...out, sync: null, got: null })) }))
  assert.equal(status, 1, output)
  assert.match(output, /no reading/)
})

test('old-engines check fails when the callback never fired', () => {
  const { status, output } = check(block({ result: page((out) => ({ ...out, got: undefined, called: undefined, timedOut: true })) }))
  assert.equal(status, 1, output)
  assert.match(output, /get\(\) never called back/)
})

test('old-engines check fails a page error', () => {
  const { status, output } = check(block({ result: page((out) => ({ ...out, errors: ['TypeError: x is not a function @1'] })) }))
  assert.equal(status, 1, output)
  assert.match(output, /page error: TypeError/)
})

test('old-engines check fails when the library was not defined on the page', () => {
  const { status, output } = check(block({ result: page((out) => ({ ...out, defined: 'undefined' })) }))
  assert.equal(status, 1, output)
  assert.match(output, /Visito is undefined/)
})

test('old-engines check fails a call that threw', () => {
  const { status, output } = check(block({ result: page((out) => ({ ...out, threw: 'getSync: TypeError: boom' })) }))
  assert.equal(status, 1, output)
  assert.match(output, /getSync: TypeError: boom/)
})

test('old-engines check fails a reading that breaks the schema', () => {
  // weak must say whether the model is unknown; this reading says the opposite
  const { status, output } = check(block({ result: page((out) => ({ ...out, got: { ...out.got, flags: { ...out.got.flags, weak: false } } })) }))
  assert.equal(status, 1, output)
  assert.match(output, /schema: flags\.weak/)
})

test('old-engines check fails when get() and getSync() return different readings', () => {
  const { status, output } = check(block({ result: page((out) => ({ ...out, sync: { ...out.sync, didNew: false } })) }))
  assert.equal(status, 1, output)
  assert.match(output, /get\(\) and getSync\(\) disagree/)
})

test('old-engines check fails an image that did not report its browser version', () => {
  const { status, output } = check(block({ version: 'VERSION ' }))
  assert.equal(status, 1, output)
  assert.match(output, /no browser version/)
})

test('old-engines check fails when the page ran in a different Chrome than the image reported', () => {
  const { status, output } = check(block({ version: 'VERSION Google Chrome 53.0.2785.143 ' }))
  assert.equal(status, 1, output)
  assert.match(output, /user agent says Chrome\/53\.0\.2785\.116/)
})

test('old-engines check fails when either side of the version cross-check is missing, instead of calling two blanks equal', () => {
  const noUa = check(block({ result: page((out) => ({ ...out, ua: undefined })) }))
  assert.equal(noUa.status, 1, noUa.output)
  assert.match(noUa.output, /cannot cross-check the version/)
  const noNumber = check(block({ version: 'VERSION Chromium' }))
  assert.equal(noNumber.status, 1, noNumber.output)
  assert.match(noNumber.output, /cannot cross-check the version/)
  const neither = check(block({ version: 'VERSION Chromium', result: page((out) => ({ ...out, ua: undefined })) }))
  assert.equal(neither.status, 1, neither.output)
  assert.match(neither.output, /cannot cross-check the version/)
})

test('old-engines check fails a block marked RUN_FAILED even when a result was printed first', () => {
  const { status, output } = check(block({ tail: 'RUN_FAILED' }))
  assert.equal(status, 1, output)
  assert.match(output, /RUN_FAILED/)
})

test('old-engines check fails one bad image among good ones, and an empty file', () => {
  assert.equal(check(block(), block({ result: 'NO_RESULT chrome crashed' }), block()).status, 1)
  assert.equal(check('').status, 1)
})

test('old-engines check needs to be told which build ran', () => {
  for (const args of [[], ['--build'], ['--build', 'beta']]) {
    const { status, output } = checkWith(args, block())
    assert.equal(status, 1, output)
    assert.match(output, /--build product\|lab/)
  }
})

test('old-engines check fails a lab run whose reading lacks the lab-only values: the product bundle ran', () => {
  const lab = checkWith(['--build', 'lab'], block({ extra: LAB }))
  assert.equal(lab.status, 0, lab.output)
  const { status, output } = checkWith(['--build', 'lab'], block())
  assert.equal(status, 1, output)
  assert.match(output, /lab build expected but the reading has no x\.tzo/)
})

test('old-engines check tells the deferred build by its start(): a deferred run needs it, a product or lab run must not have it', () => {
  // the page records whether the build has start() and, when it has, calls it before getSync()
  const started = (out) => ({ ...out, started: true })
  const deferred = checkWith(['--build', 'defer'], block({ result: page(started) }))
  assert.equal(deferred.status, 0, deferred.output)
  const missing = checkWith(['--build', 'defer'], block())
  assert.equal(missing.status, 1, missing.output)
  assert.match(missing.output, /deferred build expected but the page found no start\(\)/)
  for (const args of [['--build', 'product'], ['--build', 'lab']]) {
    const { status, output } = checkWith(args, block({ result: page(started, { extra: args[1] === 'lab' ? LAB : undefined }), extra: args[1] === 'lab' ? LAB : undefined }))
    assert.equal(status, 1, output)
    assert.match(output, new RegExp(`${args[1]} build expected but the page found start\\(\\)`))
  }
})

test('old-engines check fails a product run whose reading has a lab-only value: the lab bundle ran', () => {
  const { status, output } = check(block({ extra: LAB }))
  assert.equal(status, 1, output)
  assert.match(output, /product build expected but the reading has x\.tzo/)
})

test('old-engines check fails an image whose Chrome is not the one its tag stands for', () => {
  // a digest copied to the wrong tag: the 2.53.0 slot runs Chrome 80
  const { status, output } = check(block({ chrome: '80.0.3987.106' }))
  assert.equal(status, 1, output)
  assert.match(output, /2\.53\.0 should hold Chrome 53, not 80/)
  const right = check(block({ tag: '3.141.59-zirconium', chrome: '80.0.3987.106' }))
  assert.equal(right.status, 0, right.output)
})

test('old-engines check fails an image tag it has no Chrome version for', () => {
  const { status, output } = check(block({ tag: '4.0.0-beta' }))
  assert.equal(status, 1, output)
  assert.match(output, /4\.0\.0 has no expected Chrome version/)
})

test('old-engines check with --all-tags passes one block per tag and fails a run that left a tag out', () => {
  const blocks = ENGINES.map(([tag, chrome]) => block({ tag, chrome }))
  const all = checkWith(['--build', 'product', '--all-tags'], ...blocks)
  assert.equal(all.status, 0, all.output)
  for (const [, chrome] of ENGINES) assert.match(all.output, new RegExp(`^ok .*${chrome.replace(/\./g, '\\.')}`, 'm'))
  const four = checkWith(['--build', 'product', '--all-tags'], ...blocks.slice(1))
  assert.equal(four.status, 1, four.output)
  assert.match(four.output, /no block for 2\.53\.0 \(Chrome 53\)/)
  // without --all-tags a run of some tags is fine: run.sh was given them by hand
  assert.equal(check(...blocks.slice(1)).status, 0)
})

test('old-engines check prints the id parts of each engine and names the ones that changed the id', () => {
  const { status, output } = check(
    block({ tag: '3.4.0-einsteinium', chrome: '59.0.3071.115' }),
    block({ tag: '3.8.1-erbium', chrome: '63.0.3239.132', extra: { 'hw.mem': 8 } }),
  )
  assert.equal(status, 0, output)
  assert.match(output, /^ +id parts: hw\.cores=4 hw\.mem=!na hw\.model=!na hw\.scr=1366x768 p\.lang=de-CH fr-CH é p\.txt=1$/m)
  assert.match(output, /^id changes from Chrome 59 \(3\.4\.0-einsteinium\) to Chrome 63 \(3\.8\.1-erbium\): hw\.mem !na -> 8$/m)
})

const lab = (...blocks) => checkWith(['--build', 'lab'], ...blocks)

test('old-engines check fails an old Chrome that does not read as Blink, in either build', () => {
  for (const engine of ['webkit', 'gecko', 'other']) {
    const { status, output } = check(block({ extra: { 'x.engine': engine } }))
    assert.equal(status, 1, output)
    assert.match(output, new RegExp(`^FAIL .*x\\.engine is ${engine}, not blink`, 'm'))
    const inLab = lab(block({ extra: { ...LAB, 'x.engine': engine } }))
    assert.equal(inLab.status, 1, inLab.output)
    assert.match(inLab.output, new RegExp(`x\\.engine is ${engine}, not blink`))
  }
  const { status, output } = check(block({ extra: { 'x.engine': undefined } }))
  assert.equal(status, 1, output)
  assert.match(output, /x\.engine is undefined, not blink/)
})

test('old-engines check fails a desktop Chrome that reads as Android, in either build', () => {
  const { status, output } = check(block({ extra: { 'x.android': true } }))
  assert.equal(status, 1, output)
  assert.match(output, /^FAIL .*x\.android is true: a desktop Chrome read as Android/m)
  const inLab = lab(block({ extra: { ...LAB, 'x.android': true } }))
  assert.equal(inLab.status, 1, inLab.output)
  assert.match(inLab.output, /x\.android is true/)
  // fail closed: no answer is not "not Android"
  const missing = check(block({ extra: { 'x.android': undefined } }))
  assert.equal(missing.status, 1, missing.output)
  assert.match(missing.output, /x\.android is undefined/)
})

test('old-engines check fails a memory, screen or core part that was excluded: no exclusion applies in Chrome', () => {
  const mem = check(block({ extra: { 'hw.mem': '!ex' } }))
  assert.equal(mem.status, 1, mem.output)
  assert.match(mem.output, /^FAIL .*hw\.mem is excluded \(!ex\): no exclusion applies in Chrome/m)
  const scr = check(block({ skip: { scr: true } }))
  assert.equal(scr.status, 1, scr.output)
  assert.match(scr.output, /hw\.scr is excluded \(!ex\)/)
  const cores = lab(block({ extra: LAB, skip: { cores: true } }))
  assert.equal(cores.status, 1, cores.output)
  assert.match(cores.output, /hw\.cores is excluded \(!ex\)/)
})

test('old-engines check prints each engine\'s classification, and the per-test results in the lab build only', () => {
  const product = check(block())
  assert.equal(product.status, 0, product.output)
  assert.match(product.output, /^ok .* engine=blink android=false/m)
  assert.doesNotMatch(product.output, /tests:/)
  const { status, output } = lab(block({ extra: LAB }))
  assert.equal(status, 0, output)
  assert.match(output, /^ok .* engine=blink android=false tests: blink=11111 webkit=00000 gecko=00000 android=00110 safari17=00000 firefox143=001 brave=0 /m)
})

test('old-engines check fails a lab reading where a Blink test is missing, naming it by position', () => {
  // still Blink by four votes of five, so only this rule catches it
  const one = lab(block({ extra: { ...LAB, 'x.ev.blink': '11011' } }))
  assert.equal(one.status, 1, one.output)
  assert.match(one.output, /^FAIL .*x\.ev\.blink is 11011, not 11111: Blink test 3 of 5 missing/m)
  const two = lab(block({ extra: { ...LAB, 'x.ev.blink': '01110' } }))
  assert.equal(two.status, 1, two.output)
  assert.match(two.output, /x\.ev\.blink is 01110, not 11111: Blink tests 1 and 5 of 5 missing/)
  const three = lab(block({ extra: { ...LAB, 'x.ev.blink': '10101' } }))
  assert.match(three.output, /Blink tests 2 and 4 of 5 missing/)
  const none = lab(block({ extra: { ...LAB, 'x.ev.blink': '00000' } }))
  assert.match(none.output, /Blink tests 1, 2, 3, 4 and 5 of 5 missing/)
})

test('old-engines check fails a lab reading whose Blink results are absent or not five results', () => {
  for (const value of [undefined, '!err', '1111', '111111', 11111]) {
    const { status, output } = lab(block({ extra: { ...LAB, 'x.ev.blink': value } }))
    assert.equal(status, 1, `${value}: ${output}`)
    assert.match(output, /x\.ev\.blink is .*, not five test results/)
  }
})

test('old-engines check fails a lab reading where another engine\'s tests reach three of five', () => {
  for (const key of ['x.ev.webkit', 'x.ev.gecko']) {
    const name = key.slice(5)
    const three = lab(block({ extra: { ...LAB, [key]: '10101' } }))
    assert.equal(three.status, 1, three.output)
    assert.match(three.output, new RegExp(`^FAIL .*${key.replace(/\./g, '\\.')} is 10101: 3 of 5 ${name} tests hold, enough to vote`, 'm'))
    const five = lab(block({ extra: { ...LAB, [key]: '11111' } }))
    assert.equal(five.status, 1, five.output)
    assert.match(five.output, /5 of 5/)
    // two is below the three that choose an engine
    const two = lab(block({ extra: { ...LAB, [key]: '11000' } }))
    assert.equal(two.status, 0, two.output)
    const absent = lab(block({ extra: { ...LAB, [key]: undefined } }))
    assert.equal(absent.status, 1, absent.output)
    assert.match(absent.output, new RegExp(`${key.replace(/\./g, '\\.')} is undefined, not five test results`))
  }
})

test('old-engines check with --all-tags passes a lab run of every engine that reads as Blink with all five tests', () => {
  const blocks = ENGINES.map(([tag, chrome]) => block({ tag, chrome, extra: LAB }))
  const all = checkWith(['--build', 'lab', '--all-tags'], ...blocks)
  assert.equal(all.status, 0, all.output)
  for (const [, chrome] of ENGINES) assert.match(all.output, new RegExp(`^ok .*${chrome.replace(/\./g, '\\.')} .*tests: blink=11111`, 'm'))
})
