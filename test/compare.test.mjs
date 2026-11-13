import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import vm from 'node:vm'
import { integrityOf, checkIntegrity, readTar } from '../lab/compare/package.mjs'
import { classify, sameAs, faultOutcome, bumpVersion, spread, baseId, pruneComponents, hintsMatch, HINT_NAMES } from '../lab/compare/judge.mjs'
import { render } from '../lab/compare/table.mjs'
import { LIBRARIES } from '../lab/compare/libraries.mjs'
import { FAULTS, faultScript } from '../lab/compare/faults.mjs'
import { hintsFor, conditionContexts, reducedUserAgent } from '../lab/compare/contexts.mjs'
import { sha256Of, checkBuild, HARNESS_FILES } from '../lab/compare/provenance.mjs'
import { parseUa } from '../build/esm/ua.js'

// a tar archive as npm writes one: 512-byte headers, octal sizes, data padded to 512, two empty blocks at the end
function tar(entries) {
  const blocks = []
  for (const { name, data, type = '0', prefix = '' } of entries) {
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
    header.write(type, 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write(prefix, 345, 155, 'utf8')
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}
const pax = (records) => Buffer.from(Object.entries(records).map(([key, value]) => {
  const body = ` ${key}=${value}\n`
  let length = body.length + 1
  while (String(length).length + body.length !== length) length++
  return length + body
}).join(''))

test('integrityOf gives the sha512 Subresource Integrity string npm records for a tarball', () => {
  const bytes = Buffer.from('a tarball')
  assert.equal(integrityOf(bytes), 'sha512-' + createHash('sha512').update(bytes).digest('base64'))
})

test('checkIntegrity accepts the pinned value and returns it', () => {
  const bytes = Buffer.from('a tarball')
  assert.equal(checkIntegrity(bytes, integrityOf(bytes), 'pkg@1.0.0'), integrityOf(bytes))
})

test('checkIntegrity fails on one changed byte and names the package and both values', () => {
  const pinned = integrityOf(Buffer.from('a tarball'))
  const changed = Buffer.from('a tarbalL')
  assert.throws(() => checkIntegrity(changed, pinned, 'pkg@1.0.0'), (error) => {
    assert.match(error.message, /pkg@1\.0\.0/)
    assert.ok(error.message.includes(pinned))
    assert.ok(error.message.includes(integrityOf(changed)))
    return true
  })
})

test('checkIntegrity refuses a pin that is missing or not sha512, so nothing runs unpinned', () => {
  const bytes = Buffer.from('a tarball')
  assert.throws(() => checkIntegrity(bytes, undefined, 'pkg@1.0.0'), /pin/)
  assert.throws(() => checkIntegrity(bytes, '', 'pkg@1.0.0'), /pin/)
  assert.throws(() => checkIntegrity(bytes, 'sha1-' + createHash('sha1').update(bytes).digest('base64'), 'pkg@1.0.0'), /pin/)
})

test('readTar returns the bytes of one file and null for a file that is not there', () => {
  const archive = tar([
    { name: 'package/package.json', data: Buffer.from('{"name":"x"}') },
    { name: 'package/dist/x.min.js', data: Buffer.alloc(700, 97) },
  ])
  assert.deepEqual(readTar(archive, 'package/dist/x.min.js'), Buffer.alloc(700, 97))
  assert.equal(readTar(archive, 'package/package.json').toString(), '{"name":"x"}')
  assert.equal(readTar(archive, 'package/missing.js'), null)
})

test('readTar joins the ustar prefix to the name and honours a pax path record', () => {
  const archive = tar([
    { name: 'long.js', prefix: 'package/dist/deep', data: Buffer.from('one') },
    { name: 'PaxHeader', type: 'x', data: pax({ path: 'package/a/very/long/name.js' }) },
    { name: 'package/a/very/lo', data: Buffer.from('two') },
  ])
  assert.equal(readTar(archive, 'package/dist/deep/long.js').toString(), 'one')
  assert.equal(readTar(archive, 'package/a/very/long/name.js').toString(), 'two')
  assert.equal(readTar(archive, 'package/a/very/lo'), null)
})

test('readTar rejects an archive that ends inside a file', () => {
  const archive = tar([{ name: 'package/x.js', data: Buffer.alloc(2000, 1) }]).subarray(0, 1024)
  assert.throws(() => readTar(archive, 'package/x.js'), /truncated/)
})

test('a run is stable when every visit answered with the same id', () => {
  assert.deepEqual(classify(Array(20).fill('abc')), { runs: 20, answered: 20, distinct: 1, verdict: 'stable' })
})

test('a run is split when the answers hold more than one id, and says how many', () => {
  const ids = [...Array(18).fill('abc'), 'def', 'ghi']
  assert.deepEqual(classify(ids), { runs: 20, answered: 20, distinct: 3, verdict: 'split' })
})

test('a run with one id and a visit that gave none is incomplete, not stable', () => {
  assert.deepEqual(classify(['abc', null, 'abc', '']), { runs: 4, answered: 2, distinct: 1, verdict: 'incomplete' })
})

test('a run that is both split and incomplete counts as split', () => {
  assert.equal(classify(['abc', 'def', null]).verdict, 'split')
})

test('a run with no id at all says so, and an empty run is not stable', () => {
  assert.deepEqual(classify([null, undefined, '']), { runs: 3, answered: 0, distinct: 0, verdict: 'no id' })
  assert.equal(classify([]).verdict, 'no id')
})

test('sameAs compares one visit with the base and never calls two missing ids the same', () => {
  assert.equal(sameAs('abc', 'abc'), 'same')
  assert.equal(sameAs('abc', 'def'), 'changed')
  assert.equal(sameAs('abc', null), 'no id')
  assert.equal(sameAs(null, null), 'no id')
  assert.equal(sameAs('', ''), 'no id')
})

test('faultOutcome names what the page saw: an id, an answer without one, a throw or rejection, or nothing', () => {
  assert.deepEqual(faultOutcome({ values: { fingerprint: 'abc' }, error: null, escaped: [] }), { outcome: 'id', escaped: false })
  assert.deepEqual(faultOutcome({ values: { fingerprint: '' }, error: null, escaped: [] }), { outcome: 'answered without an id', escaped: false })
  assert.deepEqual(faultOutcome({ values: null, error: 'TypeError: x', escaped: [] }), { outcome: 'threw or rejected', escaped: false })
  assert.deepEqual(faultOutcome({ values: null, error: null, escaped: ['error: fault'] }), { outcome: 'no answer', escaped: true })
})

test('faultOutcome counts a stored id alone as an id for the library that has one', () => {
  assert.equal(faultOutcome({ values: { id: null, idStrict: null, did: 'u-1' }, error: null, escaped: [] }).outcome, 'id')
})

test('bumpVersion raises the browser and app versions of a phone user agent and leaves the rest', () => {
  const phone =
    'Mozilla/5.0 (Linux; Android 12; SM-X135FU Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.8078.50 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/585.0.0.47.54;IABMV/1;]'
  assert.equal(
    bumpVersion(phone),
    'Mozilla/5.0 (Linux; Android 12; SM-X135FU Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/157.0.8078.50 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/586.0.0.47.54;IABMV/1;]',
  )
})

test('bumpVersion raises Firefox in both of its tokens and Safari in Version/', () => {
  assert.equal(
    bumpVersion('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0'),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0',
  )
  assert.equal(
    bumpVersion('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15'),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.6 Safari/605.1.15',
  )
})

test('bumpVersion fails on a user agent with no version it knows, so a check never runs unchanged', () => {
  assert.throws(() => bumpVersion('curl/8.0'), /version/)
})

test('spread gives the median, quartiles and range of a list of timings', () => {
  assert.deepEqual(spread([5, 1, 3, 2, 4]), { n: 5, median: 3, p25: 2, p75: 4, min: 1, max: 5 })
  assert.deepEqual(spread([1, 2, 3, 4]), { n: 4, median: 2.5, p25: 1.75, p75: 3.25, min: 1, max: 4 })
  assert.deepEqual(spread([7]), { n: 1, median: 7, p25: 7, p75: 7, min: 7, max: 7 })
})

test('spread ignores visits that never produced a time and reports an empty list as such', () => {
  assert.deepEqual(spread([2, null, NaN, 4]), { n: 2, median: 3, p25: 2.5, p75: 3.5, min: 2, max: 4 })
  assert.deepEqual(spread([null]), { n: 0, median: null, p25: null, p75: null, min: null, max: null })
})

test('every compared library is pinned to an exact version and a sha512 integrity, except the local build', () => {
  for (const lib of LIBRARIES) {
    if (lib.local) continue
    assert.match(lib.version, /^\d+\.\d+\.\d+$/, lib.key)
    assert.match(lib.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, lib.key)
    assert.match(lib.file, /^package\//, lib.key)
  }
  assert.equal(LIBRARIES.filter((lib) => lib.local).length, 1)
})

test('the fault subset is fixed, names each fault once and starts with a run with no fault', () => {
  assert.equal(FAULTS[0].edits.length, 0)
  assert.equal(new Set(FAULTS.map((f) => f.name)).size, FAULTS.length)
  assert.ok(FAULTS.length >= 8)
})

// two engine reports in the shape lab/compare.mjs writes, with synthetic ids
const visit = (values, extra = {}) => ({ values, error: null, escaped: [], ...extra })
const libs = [
  { key: 'visitojs', name: 'VisitoJS', package: 'visitojs', version: '0.1.0', local: true, file: 'dist/visito.min.js', integrity: null, commit: 'e77fd8f', outputs: ['id', 'idStrict', 'did'], cacheKeys: ['_visito_c'], bytes: { raw: 17844, gzip: 7489, brotli: 6733 } },
  { key: 'other', name: 'Other', package: 'other-lib', version: '2.0.0', file: 'package/dist/o.js', integrity: 'sha512-' + 'A'.repeat(86) + '==', outputs: ['fingerprint'], bytes: { raw: 30000, gzip: 11000, brotli: 9800 } },
]
function report(engine, version, otherReloads) {
  const v = (id, did = 'd-1') => visit({ id, idStrict: id + 's', did })
  // the cleared and second-context visits, and one new-context visit per condition; null where the check does not apply to the profile
  const inNew = (seen) => (seen ? { in: 'new', base: null, visit: seen } : null)
  const conditions = (base) => ({ cleared: base.cleared, second: base.second, conditions: { uaBump: inNew(base.uaBump), rotation: inNew(base.rotation), viewport: inNew(base.viewport) } })
  const reloads = (id) => Array(20).fill(0).map(() => v(id))
  return {
    schema: 2,
    date: '2026-11-13T10:00:00.000Z',
    engine,
    browserVersion: version,
    os: 'win32 10.0.26300',
    playwright: '1.63.0',
    node: 'v24.19.0',
    harness: { commit: 'abc1234', dirty: false },
    settings: { reloads: 20, timingRuns: 21, answerWaitMs: 30000, faultWaitMs: 15000, faults: FAULTS },
    libraries: libs,
    results: {
      visitojs: {
        profiles: {
          phone: { reloads: reloads('a1'), recomputed: reloads('a1'), ...conditions({ cleared: v('a1', 'd-2'), second: v('a1', 'd-3'), uaBump: visit({ id: 'a1', idStrict: 'b2', did: 'd-4' }), rotation: v('a1', 'd-5'), viewport: v('a1', 'd-6') }) },
          desktop: { reloads: reloads('c1'), recomputed: reloads('c1'), ...conditions({ cleared: v('c1', 'd-2'), second: v('c1', 'd-3'), uaBump: visit({ id: 'c1', idStrict: 'x', did: 'd-4' }), rotation: null, viewport: v('c1', 'd-6') }) },
        },
        network: { default: { visits: 70, requests: [] }, forced: { visits: 1, requests: [] }, faults: { visits: 3, requests: [] } },
        faults: [
          { fault: 'none (baseline)', ...visit({ id: 'a1', idStrict: 'a1s', did: 'd' }) },
          { fault: 'window.screen throws', ...visit({ id: null, idStrict: null, did: null }) },
          { fault: 'window.matchMedia throws', ...visit({ id: null, idStrict: null, did: 'd' }) },
        ],
        timing: [{ id: 30, idStrict: 30, did: 1 }, { id: 32, idStrict: 32, did: 1.2 }, { id: 31, idStrict: 31, did: 0.9 }],
      },
      other: {
        profiles: {
          phone: { reloads: otherReloads.map((id) => visit({ fingerprint: id })), recomputed: otherReloads.map((id) => visit({ fingerprint: id })), ...conditions({ cleared: visit({ fingerprint: 'f1' }), second: visit({ fingerprint: 'f9' }), uaBump: visit({ fingerprint: 'f8' }), rotation: visit({ fingerprint: 'f1' }), viewport: visit({ fingerprint: 'f1' }) }) },
          desktop: { reloads: otherReloads.map((id) => visit({ fingerprint: id })), recomputed: otherReloads.map((id) => visit({ fingerprint: id })), ...conditions({ cleared: visit({ fingerprint: 'f1' }), second: visit({ fingerprint: 'f1' }), uaBump: visit({ fingerprint: 'f1' }), rotation: null, viewport: visit({ fingerprint: 'f1' }) }) },
        },
        network: { default: { visits: 70, requests: [] }, forced: { visits: 1, requests: [{ method: 'POST', url: 'https://api.example.test/log?x=1' }, { method: 'GET', url: 'https://cdn.example.test/p.js' }] }, faults: { visits: 3, requests: [] } },
        faults: [
          { fault: 'none (baseline)', ...visit({ fingerprint: 'f1' }) },
          { fault: 'window.screen throws', values: null, error: null, escaped: ['rejection: TypeError'] },
          { fault: 'window.matchMedia throws', values: null, error: 'TypeError: fault', escaped: [] },
        ],
        timing: [{ fingerprint: 50 }, { fingerprint: 70 }, { fingerprint: 60 }],
      },
    },
  }
}

test('the table has one column per library and a VisitoJS cell that reports id, idStrict and did apart', () => {
  const md = render([report('chromium', '153.0.7000.1', Array(20).fill('f1'))])
  assert.match(md, /\| Check \| VisitoJS 0\.1\.0 \| Other 2\.0\.0 \|/)
  const reloads = md.split('\n').find((line) => line.startsWith('| Phone profile: 20 reloads'))
  assert.ok(reloads.includes('id: stable (1 id in 20 visits); idStrict: stable (1 id in 20 visits); did: stable (1 id in 20 visits)'), reloads)
  assert.ok(reloads.endsWith('| stable (1 id in 20 visits) |'), reloads)
  const bump = md.split('\n').find((line) => line.startsWith('| Phone profile: user-agent version raised'))
  assert.ok(bump.includes('id: same; idStrict: changed; did: changed'), bump)
})

test('a split run and a changed id are reported as counted facts', () => {
  const md = render([report('firefox', '155.0', [...Array(17).fill('f1'), 'f2', 'f3', 'f3'])])
  assert.ok(md.includes('split (3 ids in 20 visits, 17 with the most frequent)'))
  const second = md.split('\n').find((line) => line.startsWith('| Phone profile: second context'))
  assert.ok(second.endsWith('| changed |'), second)
  assert.ok(md.split('\n').find((line) => line.startsWith('| Desktop profile: rotation')).includes('not run'))
})

test('the network row lists every request with its method, and the timing row its median, spread and run count', () => {
  const md = render([report('chromium', '153.0.7000.1', Array(20).fill('f1'))])
  const forced = md.split('\n').find((line) => line.startsWith('| Network requests, Math.random() returning 0'))
  assert.ok(forced.includes('none in 1 visit'), forced)
  assert.ok(forced.includes('2 requests: POST https://api.example.test/log (not described in the package), GET https://cdn.example.test/p.js (not described in the package) (1 visit)'), forced)
  const time = md.split('\n').find((line) => line.startsWith('| Time from the end of the script download to first id'))
  assert.ok(time.includes('60.0 ms (quartiles 55.0 to 65.0, range 50.0 to 70.0, 3 runs)'), time)
  assert.ok(time.includes('id: 31.0 ms'), time)
  assert.ok(time.includes('did: 1.0 ms'), time)
})

test('the fault rows count outcomes over the fixed subset and the fault table names each one', () => {
  const md = render([report('chromium', '153.0.7000.1', Array(20).fill('f1'))])
  const line = (start) => md.split('\n').find((l) => l.startsWith(start))
  assert.ok(line('| Faults where an error reached the page').endsWith('| 0 of 3 | 1 of 3 |'))
  assert.ok(line('| Faults with no answer').endsWith('| 0 of 3 | 1 of 3 |'))
  assert.ok(line('| Faults where the call threw or rejected').endsWith('| 0 of 3 | 1 of 3 |'))
  // each output counted on its own, so a stored id never stands in for a fingerprint
  assert.ok(line('| Faults answered with an id').endsWith('| id: 1 of 3; idStrict: 1 of 3; did: 2 of 3 | 1 of 3 |'), line('| Faults answered with an id'))
  const screen = line('| window.screen throws')
  assert.ok(screen.includes('| answered without an id |') && screen.includes('no answer, error reached the page'), screen)
  assert.ok(line('| window.matchMedia throws').includes('| id (did only) | threw or rejected |'), line('| window.matchMedia throws'))
})

test('the size table gives raw, gzip and brotli bytes and the integrity of each tarball', () => {
  const md = render([report('chromium', '153.0.7000.1', Array(20).fill('f1'))])
  assert.ok(md.includes('| VisitoJS | 0.1.0 | `dist/visito.min.js` | 17,844 | 7,489 | 6,733 |'))
  assert.ok(md.includes('sha512-' + 'A'.repeat(86) + '=='))
})

test('several engine files give one section each and one methods paragraph naming every build', () => {
  const md = render([report('chromium', '153.0.7000.1', Array(20).fill('f1')), report('webkit', '26.6', Array(20).fill('f1'))])
  assert.ok(md.includes('## chromium 153.0.7000.1'))
  assert.ok(md.includes('## webkit 26.6'))
  const methods = md.slice(md.indexOf('## Method'))
  for (const words of ['chromium 153.0.7000.1', 'webkit 26.6', '20 reloads', '21 runs', 'desktop lab timing', 'no real phone', 'one device', 'Playwright 1.63.0', '2026-11-13']) {
    assert.ok(methods.includes(words), words)
  }
})

test('each condition is compared with the id most reloads returned, so one odd first visit does not mark every condition changed', () => {
  const r = report('chromium', '153.0.7000.1', ['f0', ...Array(19).fill('f1')])
  const md = render([r])
  const line = (start) => md.split('\n').find((l) => l.startsWith(start))
  assert.ok(line('| Phone profile: 20 reloads').endsWith('| split (2 ids in 20 visits, 19 with the most frequent) |'))
  assert.ok(line('| Phone profile: cookies and storage cleared').endsWith('| same |'), line('| Phone profile: cookies and storage cleared'))
  assert.ok(line('| Phone profile: second context').endsWith('| changed |'))
})

test('the base id of a run is the most frequent one, the earliest on a tie, and null when no visit gave one', () => {
  assert.equal(baseId(['a', 'b', 'b', null]), 'b')
  assert.equal(baseId(['a', 'b', 'b', 'a']), 'a')
  assert.equal(baseId([null, '', undefined]), null)
})

test('the method states the clock step each engine showed, since it bounds every timing', () => {
  const a = { ...report('chromium', '153.0.7000.1', Array(20).fill('f1')), clockStepMs: 0.005 }
  const b = { ...report('webkit', '26.6', Array(20).fill('f1')), clockStepMs: 1 }
  const methods = render([a, b]).split('## Method')[1]
  assert.ok(methods.includes('Smallest step of performance.now() seen in the page: chromium 0.005 ms, webkit 1 ms.'), methods)
})

test('files from different library versions are not merged into one table', () => {
  const a = report('chromium', '153.0.7000.1', Array(20).fill('f1'))
  const b = report('firefox', '155.0', Array(20).fill('f1'))
  b.libraries = b.libraries.map((lib) => (lib.key === 'other' ? { ...lib, version: '2.0.1' } : lib))
  assert.throws(() => render([a, b]), /version/)
})

test('the generated text states counts and measurements, with no words that grade a library', () => {
  const md = render([report('chromium', '153.0.7000.1', [...Array(19).fill('f1'), 'f2'])])
  assert.doesNotMatch(md, /\b(best|better|worse|worst|superior|inferior|fastest|slowest|winner|loser|wins|loses|beats|leading|accurate)\b/i)
})

// client hints as Chromium 153 reports them on Windows, and the user agent it sends with them
const OWN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36'
const OWN = {
  brands: [{ brand: 'HeadlessChrome', version: '153' }, { brand: 'Not_A Brand', version: '8' }, { brand: 'Chromium', version: '153' }],
  fullVersionList: [{ brand: 'HeadlessChrome', version: '153.0.8010.12' }, { brand: 'Not_A Brand', version: '8.0.0.0' }, { brand: 'Chromium', version: '153.0.8010.12' }],
  platform: 'Windows',
  platformVersion: '19.0.0',
  architecture: 'x86',
  model: '',
  mobile: false,
  bitness: '64',
  wow64: false,
  formFactors: ['Desktop'],
}
const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 12; SM-X135FU Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.8078.50 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/585.0.0.47.54;IABMV/1;]'

// every leaf of an object as path -> JSON value, to say which fields two contexts differ in
function leaves(value, path = '', out = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value)) leaves(value[key], path ? `${path}.${key}` : key, out)
  } else if (value !== undefined) out[path] = JSON.stringify(value)
  return out
}
function differ(a, b) {
  const x = leaves(a)
  const y = leaves(b)
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((key) => x[key] !== y[key]).sort()
}

test('hintsFor gives the browser its own client hints back for its own user agent', () => {
  assert.deepEqual(hintsFor(OWN, OWN_UA, OWN_UA), { ...OWN, fullVersion: '153.0.8010.12' })
})

test('hintsFor raises the brand versions with the user agent and leaves the grease brand and the platform alone', () => {
  const bumped = hintsFor(OWN, OWN_UA, bumpVersion(OWN_UA))
  assert.deepEqual(differ({ ...OWN, fullVersion: '153.0.8010.12' }, bumped), ['brands', 'fullVersion', 'fullVersionList'])
  assert.deepEqual(bumped.brands.map((b) => b.version), ['154', '8', '154'])
  assert.deepEqual(bumped.fullVersionList.map((b) => b.version), ['154.0.8010.12', '8.0.0.0', '154.0.8010.12'])
})

test('hintsFor gives a phone user agent the platform, version, model and mobile flag it states', () => {
  const phone = hintsFor(OWN, OWN_UA, PHONE_UA)
  assert.equal(phone.platform, 'Android')
  assert.equal(phone.platformVersion, '12')
  assert.equal(phone.model, 'SM-X135FU')
  assert.equal(phone.mobile, true)
  assert.deepEqual(phone.formFactors, ['Mobile'])
  assert.deepEqual(phone.brands.map((b) => b.version), ['156', '8', '156'])
  assert.equal(phone.fullVersion, '156.0.8078.50')
  assert.deepEqual(differ(phone, hintsFor(OWN, OWN_UA, bumpVersion(PHONE_UA))), ['brands', 'fullVersion', 'fullVersionList'])
})

test('hintsFor has nothing to emulate in a browser without client hints', () => {
  assert.equal(hintsFor(null, OWN_UA, OWN_UA), null)
})

// what a context is, without how the harness reaches it
const state = (ctx) => ({ options: ctx.options, hints: ctx.hints })

test('every condition context differs from its base only in the field under test, in both profiles', () => {
  const hints = (ua, device) => hintsFor(OWN, OWN_UA, ua, device)
  const desktop = conditionContexts({ options: { viewport: { width: 1280, height: 720 } }, userAgent: OWN_UA, screen: { width: 1280, height: 720 }, rotation: false, hints })
  // the base goes through the same user-agent override as the bumped context, with the browser's own string
  assert.equal(desktop.base.options.userAgent, OWN_UA)
  assert.deepEqual(desktop.base.hints, hints(OWN_UA))
  assert.deepEqual(differ(state(desktop.base), state(desktop.second)), [])
  assert.deepEqual(differ(state(desktop.base), state(desktop.uaBump)), ['hints.brands', 'hints.fullVersion', 'hints.fullVersionList', 'options.userAgent'])
  assert.deepEqual(differ(state(desktop.base), state(desktop.viewport)), ['options.viewport.height', 'options.viewport.width'])
  assert.equal(desktop.rotation, null)

  const phone = conditionContexts({ options: { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, locale: 'fr-FR' }, userAgent: PHONE_UA, screen: { width: 393, height: 852 }, rotation: true, hints })
  assert.equal(phone.base.options.userAgent, PHONE_UA)
  assert.deepEqual(differ(state(phone.base), state(phone.second)), [])
  assert.deepEqual(differ(state(phone.base), state(phone.uaBump)), ['hints.brands', 'hints.fullVersion', 'hints.fullVersionList', 'options.userAgent'])
  assert.deepEqual(differ(state(phone.base), state(phone.rotation)), ['options.screen.height', 'options.screen.width', 'options.viewport.height', 'options.viewport.width'])
  assert.deepEqual(phone.rotation.options.viewport, { width: 852, height: 393 })
  assert.deepEqual(differ(state(phone.base), state(phone.viewport)), ['options.viewport.height', 'options.viewport.width'])
})

test('in a browser without client hints the condition contexts carry none and still differ only in the field under test', () => {
  const firefox = conditionContexts({ options: {}, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0', screen: { width: 1280, height: 720 }, rotation: false, hints: () => null })
  assert.equal(firefox.base.hints, null)
  assert.deepEqual(differ(state(firefox.base), state(firefox.uaBump)), ['options.userAgent'])
})

// the client hints a page reads back, from the metadata a context emulates
const seenOf = (planned) => ({
  brands: planned.brands,
  mobile: planned.mobile,
  platform: planned.platform,
  platformVersion: planned.platformVersion,
  model: planned.model,
  fullVersionList: planned.fullVersionList,
  architecture: planned.architecture,
  bitness: planned.bitness,
  wow64: planned.wow64,
  formFactors: planned.formFactors,
  uaFullVersion: planned.fullVersion,
})

test('hintsMatch accepts the hints a page saw only when they are the ones the context emulated', () => {
  const planned = hintsFor(OWN, OWN_UA, PHONE_UA)
  const seen = seenOf(planned)
  assert.equal(hintsMatch(planned, seen), true)
  assert.equal(hintsMatch(planned, { ...seen, platformVersion: '10.0' }), false)
  assert.equal(hintsMatch(planned, { ...seen, brands: OWN.brands }), false)
  assert.equal(hintsMatch(null, null), true)
  assert.equal(hintsMatch(planned, null), false)
})

test('sha256Of gives the hex digest of the bytes served', () => {
  const bytes = Buffer.from('a bundle')
  assert.equal(sha256Of(bytes), createHash('sha256').update(bytes).digest('hex'))
})

test('checkBuild refuses a bundle older than any of its sources and names the newest one', () => {
  const dist = { path: 'dist/visito.min.js', mtimeMs: 2000 }
  assert.doesNotThrow(() => checkBuild(dist, [{ path: 'src/a.ts', mtimeMs: 1000 }, { path: 'package.json', mtimeMs: 2000 }]))
  assert.throws(() => checkBuild(dist, [{ path: 'src/a.ts', mtimeMs: 1000 }, { path: 'src/b.ts', mtimeMs: 3000 }]), (error) => {
    assert.match(error.message, /src\/b\.ts/)
    assert.match(error.message, /npm run build/)
    return true
  })
  assert.throws(() => checkBuild(null, []), /npm run build/)
})

test('pruneComponents keeps components only for visits whose id differs from the base, and the base once', () => {
  const visits = [
    { values: { fingerprint: 'f0' }, components: { a: 0 } },
    { values: { fingerprint: 'f1' }, components: { a: 1 } },
    { values: { fingerprint: 'f1' }, components: { a: 1 } },
    { values: null, components: undefined },
  ]
  const base = pruneComponents(visits, 'fingerprint', 'f1')
  assert.deepEqual(base, { a: 1 })
  assert.deepEqual(visits[0].components, { a: 0 })
  assert.equal('components' in visits[1], false)
  assert.equal('components' in visits[2], false)
})

test('the fault set adds faults on reads other libraries depend on, and says for each whether VisitoJS makes the read', () => {
  const names = FAULTS.map((f) => f.name)
  for (const name of ['WebGL getParameter throws', 'speechSynthesis.getVoices throws', 'offsetWidth, offsetHeight and measureText throw', 'window.sessionStorage throws']) assert.ok(names.includes(name), name)
  for (const fault of FAULTS) {
    assert.ok(['baseline', 'VisitoJS fault matrix', 'added'].includes(fault.origin), fault.name)
    if (fault.origin === 'baseline') continue
    assert.ok(fault.apis.length > 0, fault.name)
    assert.equal(typeof fault.visitoProduct, 'string', fault.name)
  }
})

test('the fault set breaks the text measurement VisitoJS makes, and each fault is named after what it breaks', () => {
  const names = FAULTS.map((f) => f.name)
  assert.ok(!names.includes('text measurement throws'))
  // src/probes.ts textSize: getComputedStyle for x.txt.env, x.txt.fs and x.txt.apple, getBoundingClientRect for x.txt.w
  for (const [name, api] of [['getBoundingClientRect throws', 'getBoundingClientRect'], ['getComputedStyle throws', 'getComputedStyle']]) {
    const fault = FAULTS.find((f) => f.name === name)
    assert.ok(fault, name)
    assert.deepEqual(fault.apis, [api], name)
    assert.equal(fault.visitoProduct, 'reads', name)
  }
  // a fault on several properties names each of them
  for (const fault of FAULTS.filter((f) => f.apis.length > 1 && f.edits.length === f.apis.length)) {
    for (const api of fault.apis) assert.ok(fault.name.includes(api), `${fault.name} does not name ${api}`)
  }
})

test('getHighEntropyValues never settles also runs with a reduced user agent, the one case where the VisitoJS product build asks for client hints', () => {
  const plain = FAULTS.find((f) => f.name === 'getHighEntropyValues never settles')
  assert.match(plain.visitoProduct, /only when the user agent hides the model/)
  const reduced = FAULTS.filter((f) => f.profile === 'reduced')
  assert.deepEqual(reduced.map((f) => f.origin), ['baseline', 'VisitoJS fault matrix'])
  assert.deepEqual(reduced[1].apis, ['getHighEntropyValues'])
  assert.equal(reduced[1].visitoProduct, 'reads')
  assert.ok(FAULTS.filter((f) => f.profile !== 'reduced').every((f) => !f.profile))
})

test('a fault records every call that reaches the property it breaks, and still breaks it', () => {
  // prototypes only: Node's vm reads accessors on its global object by itself, which a page's window does not
  const sandbox = vm.createContext({})
  vm.runInContext(`this.window = this
    this.Navigator = function () {}
    Object.defineProperty(Navigator.prototype, 'userAgent', { configurable: true, get: function () { return 'real' } })
    this.navigator = new Navigator()
    this.Permissions = function () {}
    Permissions.prototype.query = function () { return 1 }
    this.Audio = function () {}
    Audio.prototype.context = function () {}`, sandbox)
  for (const name of ['navigator.userAgent throws', 'permissions.query never settles']) vm.runInContext(faultScript(FAULTS.find((f) => f.name === name).edits), sandbox)
  vm.runInContext(faultScript([['Audio.prototype', 'context', 'missing']]), sandbox)
  const after = vm.runInContext(`(function () {
    var threw = false
    try { navigator.userAgent } catch (e) { threw = true }
    try { navigator.userAgent } catch (e) {}
    var pending = new Permissions().query()
    return { threw: threw, pending: typeof pending.then, missing: typeof new Audio().context, hits: JSON.stringify(window.__faultHits) }
  })()`, sandbox)
  // copied out of the sandbox's realm, whose Object.prototype is its own
  assert.deepEqual({ ...after }, { threw: true, pending: 'function', missing: 'undefined', hits: JSON.stringify({ userAgent: 2, query: 1, context: 1 }) })
  assert.throws(() => faultScript([['window', 'screen', 'melts']]), /melts/)
})

test('what each fault says about the VisitoJS product build matches the names in the built bundle', () => {
  const bundle = readFileSync(new URL('../dist/visito.min.js', import.meta.url), 'utf8')
  for (const fault of FAULTS.filter((f) => f.origin !== 'baseline')) {
    const named = fault.apis.some((api) => bundle.includes(api))
    if (fault.visitoProduct === 'not read') assert.equal(named, false, `${fault.name}: the product bundle names ${fault.apis.join(', ')}`)
    else assert.equal(named, true, `${fault.name}: the product bundle names none of ${fault.apis.join(', ')}`)
  }
})

test('a fault said to come from VisitoJS fault matrix breaks a property that matrix breaks', () => {
  const matrix = readFileSync(new URL('../lab/fault-matrix.mjs', import.meta.url), 'utf8')
  for (const fault of FAULTS.filter((f) => f.origin === 'VisitoJS fault matrix')) {
    for (const api of fault.apis) assert.ok(matrix.includes(`'${api}'`), `${fault.name}: lab/fault-matrix.mjs has no '${api}'`)
  }
  for (const fault of FAULTS.filter((f) => f.origin === 'added')) {
    assert.ok(fault.apis.every((api) => !matrix.includes(`'${api}'`)), `${fault.name}: lab/fault-matrix.mjs already breaks it`)
  }
})

test('the method says where the faults come from and which reads the VisitoJS product build never makes', () => {
  const methods = render([report('chromium', '153.0.7000.1', Array(20).fill('f1'))]).split('## Method')[1]
  const fromMatrix = FAULTS.filter((f) => f.origin === 'VisitoJS fault matrix').length
  const added = FAULTS.filter((f) => f.origin === 'added').length
  assert.ok(methods.includes(`${fromMatrix} come from VisitoJS's own fault matrix`), methods)
  assert.ok(methods.includes(`${added} were added`), methods)
  for (const fault of FAULTS.filter((f) => f.visitoProduct === 'not read')) assert.ok(methods.includes(fault.name), fault.name)
})

test('the reload rows give the recomputed run and the run as shipped apart, and the method says which is which', () => {
  const r = report('chromium', '153.0.7000.1', Array(20).fill('f1'))
  r.results.visitojs.profiles.phone.reloads[5] = visit({ id: 'zz', idStrict: 'zzs', did: 'd-1' })
  const md = render([r])
  const lines = md.split('\n')
  const recomputed = lines.find((l) => l.startsWith('| Phone profile: 20 reloads, cached values removed before each'))
  const shipped = lines.find((l) => l.startsWith('| Phone profile: 20 reloads as shipped'))
  assert.ok(recomputed.includes('id: stable (1 id in 20 visits)'), recomputed)
  assert.ok(shipped.includes('id: split (2 ids in 20 visits, 19 with the most frequent)'), shipped)
  const methods = md.split('## Method')[1]
  assert.match(methods, /_visito_c/)
  assert.match(methods, /recomputed/)
})

test('the network rows include the fault visits and say, beside a recorded request, what the package documents about it', () => {
  const r = report('chromium', '153.0.7000.1', Array(20).fill('f1'))
  r.libraries = r.libraries.map((lib) => lib.key === 'other' ? { ...lib, requests: [{ match: 'https://api.example.test/log', rate: 'at most 1 in 10,000 calls', off: '`{ logging: false }`', carries: 'the id and its components', where: 'README.md:93-101 in 2.0.0' }] } : lib)
  const md = render([r])
  const forced = md.split('\n').find((line) => line.startsWith('| Network requests, Math.random() returning 0'))
  assert.ok(forced.includes('POST https://api.example.test/log (documented rate: at most 1 in 10,000 calls; turned off by `{ logging: false }`; carries the id and its components; README.md:93-101 in 2.0.0)'), forced)
  assert.ok(forced.includes('GET https://cdn.example.test/p.js (not described in the package)'), forced)
  assert.ok(md.split('\n').find((line) => line.startsWith('| Network requests during the fault visits')).includes('none in 3 visits'))
})

test('the method states the facts about the other libraries that bear on the rows', () => {
  const r = report('chromium', '153.0.7000.1', Array(20).fill('f1'))
  r.libraries = r.libraries.map((lib) => lib.key === 'other' ? { ...lib, notes: ['Other sells a server-side product that its README.md:30-38 says differs from this open-source build.'] } : lib)
  const methods = render([r]).split('## Method')[1]
  assert.ok(methods.includes('Other sells a server-side product that its README.md:30-38 says differs from this open-source build.'), methods)
  assert.match(methods, /only the open-source builds/)
})

test('a library with a documented call pattern of its own gets a timing row for it', () => {
  const r = report('chromium', '153.0.7000.1', Array(20).fill('f1'))
  r.libraries = r.libraries.map((lib) => lib.key === 'other' ? { ...lib, documented: { label: 'get() 1 s after load' } } : lib)
  r.results.other.documentedTiming = [{ fingerprint: 10 }, { fingerprint: 12 }, { fingerprint: 11 }]
  const line = render([r]).split('\n').find((l) => l.startsWith('| Time in the documented call pattern'))
  assert.ok(line.includes('get() 1 s after load: 11.0 ms'), line)
  assert.ok(line.includes('| as the row above |'), line)
})

test('the size table gives the sha256 of each bundle served and the harness commit with its state', () => {
  const r = report('chromium', '153.0.7000.1', Array(20).fill('f1'))
  r.libraries = r.libraries.map((lib) => ({ ...lib, sha256: lib.key.padEnd(64, '0') }))
  r.harness = { commit: 'abc1234', dirty: true }
  const md = render([r])
  assert.ok(md.includes('visitojs'.padEnd(64, '0')))
  assert.match(md, /harness at commit `abc1234`, with uncommitted changes to lab\/compare/)
})

test('runs of one engine share one section, a cell that differs between runs shows each run, and the timing order is checked across runs', () => {
  const a = report('chromium', '153.0.7000.1', Array(20).fill('f1'))
  const b = report('chromium', '153.0.7000.1', Array(20).fill('f1'))
  b.results.other.profiles.phone.second = visit({ fingerprint: 'f1' })
  b.results.other.timing = [{ fingerprint: 20 }, { fingerprint: 25 }, { fingerprint: 22 }]
  const md = render([a, b])
  assert.equal(md.split('\n').filter((l) => l.startsWith('## chromium')).length, 1)
  const second = md.split('\n').find((l) => l.startsWith('| Phone profile: second context'))
  assert.ok(second.endsWith('| run 1: changed; run 2: same |'), second)
  assert.ok(md.split('\n').find((l) => l.startsWith('| Phone profile: rotation')).endsWith('| same |'))
  // VisitoJS id 31 ms in both runs; Other 60 ms in run 1, 22 ms in run 2
  assert.match(md, /Order of the median time to first id, lowest first: run 1: VisitoJS, Other; run 2: Other, VisitoJS\. The order differs between runs\./)
})

test('an order that holds in every run is said to hold', () => {
  const md = render([report('webkit', '26.6', Array(20).fill('f1')), report('webkit', '26.6', Array(20).fill('f1'))])
  assert.match(md, /Order of the median time to first id, lowest first, the same in all 2 runs: VisitoJS, Other\./)
})

test('files from different harness commits are not merged into one table', () => {
  const a = report('chromium', '153.0.7000.1', Array(20).fill('f1'))
  const b = { ...report('firefox', '155.0', Array(20).fill('f1')), harness: { commit: 'def5678', dirty: false } }
  assert.throws(() => render([a, b]), /harness/)
})

test('cookies and storage cleared is compared with the base id of the context it ran in, the reloads as shipped', () => {
  const r = report('firefox', '155.0', Array(20).fill('f1'))
  const other = r.results.other.profiles.phone
  // a library whose id is fixed per context: the shipped run's context has its own id, and clearing its storage keeps it
  other.reloads = Array(20).fill(0).map(() => visit({ fingerprint: 'g1' }))
  other.cleared = visit({ fingerprint: 'g1' })
  const line = () => render([r]).split('\n').find((l) => l.startsWith('| Phone profile: cookies and storage cleared'))
  assert.ok(line().endsWith('| same |'), line())
  // equal to the recomputed run's base but not to its own context's: changed
  other.cleared = visit({ fingerprint: 'f1' })
  assert.ok(line().endsWith('| changed |'), line())
  assert.match(line(), /compared with the reloads as shipped/)
})

test('a condition applied in the same context is compared with the visit just before it there, whatever the other contexts gave', () => {
  const r = report('chromium', '153.0.7000.1', Array(20).fill('f1'))
  const other = r.results.other.profiles.phone
  // the second-context control changed (f9), but these conditions ran in one context each
  other.conditions.viewport = { in: 'same', base: visit({ fingerprint: 'h1' }), visit: visit({ fingerprint: 'h1' }) }
  other.conditions.uaBump = { in: 'same', base: visit({ fingerprint: 'h1' }), visit: visit({ fingerprint: 'h2' }) }
  const v = r.results.visitojs.profiles.phone
  v.conditions.viewport = { in: 'same', base: visit({ id: 'a1', idStrict: 'a1s', did: 'd-7' }), visit: visit({ id: 'a1', idStrict: 'a1s', did: 'd-7' }) }
  v.conditions.uaBump = { in: 'same', base: visit({ id: 'a1', idStrict: 'a1s', did: 'd-7' }), visit: visit({ id: 'a1', idStrict: 'b2', did: 'd-7' }) }
  const md = render([r])
  const line = (start) => md.split('\n').find((l) => l.startsWith(start))
  const viewport = line('| Phone profile: viewport changed, screen kept')
  assert.match(viewport, /in the same context/)
  assert.ok(viewport.endsWith('| id: same; idStrict: same; did: same | same |'), viewport)
  const bump = line('| Phone profile: user-agent version raised by one')
  assert.ok(bump.endsWith('| id: same; idStrict: changed; did: same | changed |'), bump)
})

test('a condition that needs a new context says so, and where a new context alone also changes the id the cell says that', () => {
  const r = report('firefox', '155.0', Array(20).fill('f1'))
  const md = render([r])
  const line = (start) => md.split('\n').find((l) => l.startsWith(start))
  const bump = line('| Phone profile: user-agent version raised by one')
  assert.match(bump, /in a new context/)
  // Other's phone second context gave f9 against f1, so its changed cells cannot be put down to the condition
  assert.ok(bump.endsWith('| changed (a new context alone also changes it) |'), bump)
  // where the second context kept the id, a change is shown as it is
  r.results.other.profiles.desktop.conditions.uaBump.visit = visit({ fingerprint: 'f8' })
  const desktop = render([r]).split('\n').find((l) => l.startsWith('| Desktop profile: user-agent version raised by one'))
  assert.ok(desktop.endsWith('| changed |'), desktop)
  const methods = md.split('## Method')[1]
  assert.match(methods, /a new context alone also changes it/)
  assert.match(methods, /same context/)
})

test('with a per-tab override (Chromium) the user agent and the viewport change inside one context, and rotation does wherever the screen equals the viewport', () => {
  const hints = (ua, device) => hintsFor(OWN, OWN_UA, ua, device)
  const phoneOptions = { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true }
  const chromium = conditionContexts({ options: phoneOptions, userAgent: PHONE_UA, screen: { width: 393, height: 852 }, rotation: true, hints, perTab: true })
  assert.deepEqual([chromium.uaBump.in, chromium.rotation.in, chromium.viewport.in], ['same', 'same', 'same'])
  assert.deepEqual([chromium.uaBump.via, chromium.rotation.via, chromium.viewport.via], ['user-agent override', 'viewport size', 'device metrics'])
  assert.equal(chromium.second.in, 'new')
  const other = conditionContexts({ options: phoneOptions, userAgent: PHONE_UA, screen: { width: 393, height: 852 }, rotation: true, hints: () => null, perTab: false })
  assert.deepEqual([other.uaBump.in, other.rotation.in, other.viewport.in], ['new', 'same', 'new'])
  // setViewportSize sets the screen to the viewport, which is a rotation only when the two were equal
  const wide = conditionContexts({ options: phoneOptions, userAgent: PHONE_UA, screen: { width: 412, height: 915 }, rotation: true, hints: () => null, perTab: false })
  assert.equal(wide.rotation.in, 'new')
})

test('the reduced user agent is the form Chrome on Android sends when it hides the model, and the VisitoJS parser treats it as reduced', () => {
  const reduced = reducedUserAgent(PHONE_UA)
  assert.equal(reduced, 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36')
  assert.equal(parseUa(reduced).reduced, true)
  assert.equal(parseUa(PHONE_UA).reduced, false)
  // the hints still carry what the user agent no longer says: the phone's model, Android version and full browser version,
  // so the reduced context differs from the phone base only in the user-agent string
  const phone = conditionContexts({ options: { viewport: { width: 393, height: 852 }, isMobile: true }, userAgent: PHONE_UA, screen: { width: 393, height: 852 }, rotation: true, hints: (ua, device) => hintsFor(OWN, OWN_UA, ua, device), reduced: true })
  assert.equal(phone.reduced.options.userAgent, reduced)
  assert.deepEqual([phone.reduced.hints.model, phone.reduced.hints.platformVersion, phone.reduced.hints.platform, phone.reduced.hints.mobile], ['SM-X135FU', '12', 'Android', true])
  assert.deepEqual(phone.reduced.hints.fullVersionList.map((b) => b.version), ['156.0.8078.50', '8.0.0.0', '156.0.8078.50'])
  assert.deepEqual(differ(state(phone.base), state(phone.reduced)), ['options.userAgent'])
  const desktop = conditionContexts({ options: {}, userAgent: OWN_UA, screen: { width: 1280, height: 720 }, rotation: false, hints: () => null })
  assert.equal(desktop.reduced, null)
})

test('hintsMatch checks every field the emulated metadata sets, the high-entropy ones included, and the page is asked for all of them', () => {
  const planned = hintsFor(OWN, OWN_UA, OWN_UA)
  assert.equal(hintsMatch(planned, seenOf(planned)), true)
  for (const [field, value] of [['architecture', 'arm'], ['bitness', '32'], ['wow64', true], ['formFactors', ['Mobile']], ['uaFullVersion', '1.0']]) {
    assert.equal(hintsMatch(planned, { ...seenOf(planned), [field]: value }), false, field)
  }
  for (const name of ['architecture', 'bitness', 'fullVersionList', 'model', 'platformVersion', 'wow64', 'formFactors', 'uaFullVersion']) assert.ok(HINT_NAMES.includes(name), name)
})

test('the harness dirty flag covers every file a run imports', () => {
  const covered = (path) => HARNESS_FILES.some((entry) => path === entry || path.startsWith(entry + '/'))
  const rootUrl = new URL('../', import.meta.url)
  const seen = new Set()
  const walk = (path) => {
    if (seen.has(path)) return
    seen.add(path)
    assert.ok(covered(path), `${path} is imported by the harness but not in HARNESS_FILES`)
    const source = readFileSync(new URL(path, rootUrl), 'utf8')
    for (const [, spec] of source.matchAll(/^import\s[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      walk(new URL(spec, new URL(path, rootUrl)).href.slice(rootUrl.href.length))
    }
  }
  walk('lab/compare.mjs')
  assert.ok(seen.has('lab/phone.mjs') && seen.has('lab/launch.mjs'), [...seen].join(', '))
  for (const entry of HARNESS_FILES) assert.ok(existsSync(new URL(entry, rootUrl)), entry)
})

test('each fault cell says whether the library reached the property the fault breaks, and the method counts the faults reached', () => {
  const r = report('chromium', '153.0.7000.1', Array(20).fill('f1'))
  const [vBase, vScreen, vMedia] = r.results.visitojs.faults
  vBase.hits = {}
  vScreen.hits = { screen: 2 }
  vMedia.hits = {}
  const [oBase, oScreen, oMedia] = r.results.other.faults
  oBase.hits = {}
  oScreen.hits = { screen: 1 }
  oMedia.hits = { matchMedia: 1 }
  r.results.visitojs.faults.push({ fault: 'offsetWidth, offsetHeight and measureText throw', ...visit({ id: 'a1', idStrict: 'a1s', did: 'd' }), hits: {} })
  r.results.other.faults.push({ fault: 'offsetWidth, offsetHeight and measureText throw', ...visit({ fingerprint: 'f1' }), hits: { measureText: 3 } })
  const md = render([r])
  const line = (start) => md.split('\n').find((l) => l.startsWith(start))
  assert.ok(line('| window.screen throws').includes('| answered without an id (fault reached) | no answer, error reached the page (fault reached) |'), line('| window.screen throws'))
  assert.ok(line('| window.matchMedia throws').includes('| id (did only) (fault not reached) | threw or rejected (fault reached) |'), line('| window.matchMedia throws'))
  assert.ok(line('| offsetWidth, offsetHeight and measureText throw').endsWith('| id (fault not reached) | id (fault reached: measureText) |'), line('| offsetWidth'))
  assert.ok(line('| none (baseline)').endsWith('| id | id |'))
  const reached = line('| Faults whose broken property the library reached')
  assert.ok(reached && reached.endsWith('| 1 of 3 | 3 of 3 |'), reached)
  const methods = md.split('## Method')[1]
  assert.ok(methods.includes('chromium: VisitoJS 1 of 3, Other 3 of 3'), methods)
})

test('the method names a fault whose reach for VisitoJS differs from what lab/compare/faults.mjs expects of its product build', () => {
  const r = report('chromium', '153.0.7000.1', Array(20).fill('f1'))
  for (const f of r.results.visitojs.faults) f.hits = {}
  for (const f of r.results.other.faults) f.hits = {}
  // window.matchMedia throws: expected 'not read', reached here
  r.results.visitojs.faults[2].hits = { matchMedia: 1 }
  assert.match(render([r]).split('## Method')[1], /expected: VisitoJS reached window\.matchMedia throws in chromium/)
  r.results.visitojs.faults[2].hits = {}
  assert.doesNotMatch(render([r]).split('## Method')[1], /Not as expected/)
  // and one expected to be read that was not
  r.results.visitojs.faults.push({ fault: 'getComputedStyle throws', ...visit({ id: 'a1', idStrict: 'a1s', did: 'd' }), hits: {} })
  assert.match(render([r]).split('## Method')[1], /expected: VisitoJS did not reach getComputedStyle throws in chromium/)
})

test('facts that are the same in every run of an engine are stated once for it, and an absent property is not held against an expectation', () => {
  const runOf = () => {
    const r = report('webkit', '26.6', Array(20).fill('f1'))
    r.settings.phone = { userAgent: PHONE_UA, viewport: { width: 393, height: 852 }, deviceScaleFactor: 2.75, locale: 'fr-FR', timezoneId: 'Europe/Paris' }
    r.results.visitojs.profiles.phone.recomputed[0].dpr = 1.1028
    for (const f of r.results.visitojs.faults) f.hits = {}
    for (const f of r.results.other.faults) f.hits = {}
    r.results.visitojs.faults[1].hits = { screen: 1 }
    // a fault expected to be read, on a property this engine does not have
    r.results.visitojs.faults.push({ fault: 'getComputedStyle throws', ...visit({ id: 'a1', idStrict: 'a1s', did: 'd' }), hits: {} })
    r.results.other.faults.push({ fault: 'getComputedStyle throws', ...visit({ fingerprint: 'f1' }), hits: {} })
    r.absent = { 'getComputedStyle throws': ['getComputedStyle'] }
    return r
  }
  const methods = render([runOf(), runOf()]).split('## Method')[1]
  assert.doesNotMatch(methods, /webkit and webkit/)
  assert.match(methods, /In webkit the phone base visit saw another value/)
  assert.ok(methods.includes('devicePixelRatio the page saw: webkit: phone base 1.1028'), methods)
  assert.doesNotMatch(methods, /webkit run 2: phone base/)
  assert.ok(methods.includes('Faults reached by each library\'s code, the baselines aside: webkit: VisitoJS 1 of 3, Other 0 of 3.'), methods)
  assert.doesNotMatch(methods, /Not as expected/)
  // where runs differ, each run is still named
  const [a, b] = [runOf(), runOf()]
  b.results.visitojs.faults[1].hits = {}
  assert.match(render([a, b]).split('## Method')[1], /webkit run 1: VisitoJS 1 of 3, Other 0 of 3; webkit run 2: VisitoJS 0 of 3/)
})

test('the method says where the phone profile has the machine\'s own screen, which decides whether rotation can stay in one context', () => {
  const r = report('firefox', '155.0', Array(20).fill('f1'))
  r.settings.phone = { userAgent: PHONE_UA, viewport: { width: 393, height: 852 }, deviceScaleFactor: 2.75, locale: 'fr-FR', timezoneId: 'Europe/Paris' }
  r.contexts = { phone: { base: { options: { viewport: { width: 393, height: 852 }, screen: { width: 1366, height: 768 } } } } }
  const methods = render([r]).split('## Method')[1]
  assert.match(methods, /in firefox the phone profile has the screen the machine reports/i)
  assert.doesNotMatch(methods, /1366/)
})

test('the method states the facts of the run that bear on cells: locale and time zone, the browser builds, what an engine lacks, the pixel ratio seen', () => {
  const a = report('webkit', '26.6', Array(20).fill('f1'))
  a.settings.phone = { userAgent: PHONE_UA, viewport: { width: 393, height: 852 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, locale: 'fr-FR', timezoneId: 'Europe/Paris' }
  a.absent = { 'window.OfflineAudioContext missing': ['OfflineAudioContext', 'webkitOfflineAudioContext'] }
  a.harness = { commit: 'abc1234', dirty: false, files: ['lab/compare.mjs', 'lab/compare', 'lab/phone.mjs', 'lab/launch.mjs'] }
  a.results.visitojs.profiles.phone.recomputed[0].dpr = 1.1028
  a.results.visitojs.profiles.phone.conditions.viewport.visit.dpr = 0.8811
  a.results.visitojs.profiles.desktop.recomputed[0].dpr = 1
  const md = render([a])
  const methods = md.split('## Method')[1]
  for (const words of ['locale fr-FR', 'time zone Europe/Paris', "Playwright's own builds", 'WebKit is not Safari', 'headless', 'window.OfflineAudioContext missing changes nothing in webkit', 'OfflineAudioContext, webkitOfflineAudioContext', 'devicePixelRatio', '1.1028', '0.8811']) {
    assert.ok(methods.includes(words), words)
  }
  assert.match(md, /no uncommitted changes to lab\/compare\.mjs, lab\/compare, lab\/phone\.mjs and lab\/launch\.mjs/)
})
