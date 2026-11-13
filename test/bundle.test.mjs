import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeWindow } from './fake-window.mjs'

// npm is a .cmd shim on Windows that execFileSync cannot start; running its script with node needs no shell, so spaces in paths are safe
// npm_execpath names that script when npm runs the tests; otherwise take the npm installed beside node
const npmCli = () => {
  if (/npm-cli\.js$/.test(process.env.npm_execpath || '')) return process.env.npm_execpath
  const dir = dirname(process.execPath)
  const places = [join(dir, 'node_modules/npm/bin/npm-cli.js'), join(dir, '../lib/node_modules/npm/bin/npm-cli.js')]
  const found = places.find((place) => existsSync(place))
  assert.ok(found, `npm's CLI script is not in ${places.join(' or ')}`)
  return found
}

// stderr is piped, not ignored, so a failing npm puts its own message in the thrown error
const npm = (args, cwd) => execFileSync(process.execPath, [npmCli(), ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const load = (file, sandbox) => {
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8') + '\n;this.__visito = Visito', sandbox)
  return sandbox.__visito
}

for (const file of ['visito.js', 'visito.min.js', 'visito.lab.js', 'visito.lab.min.js']) {
  test(`${file} loads where there is no browser at all and reports nothing`, () => {
    const visito = load(file, {})
    assert.equal(visito.getSync(), null)
    let got = 'never called'
    visito.get((reading) => (got = reading))
    assert.equal(got, null)
  })

  test(`${file} in a browser-like window: getSync has the reading at script end, get calls back later with the same one`, async () => {
    const visito = load(file, { window: fakeWindow(), setTimeout })
    const sync = visito.getSync()
    assert.match(sync.did, /^[0-9a-f-]{36}$/)
    assert.equal(sync.model, 'SM-X135FU')

    let calls = 0
    const later = await new Promise((resolve) => {
      visito.get((reading) => {
        calls++
        resolve(reading)
      })
      assert.equal(calls, 0, 'the callback must not run before get() returns')
    })
    assert.deepEqual(later, sync)
  })

  test(`${file}: get() with something that is not a function does not throw`, () => {
    const visito = load(file, { window: fakeWindow(), setTimeout })
    assert.doesNotThrow(() => visito.get(undefined))
    assert.doesNotThrow(() => visito.get('nope'))
  })
}

test('the product build stays under its budget of 8,192 bytes gzipped', async () => {
  const { gzipSync } = await import('node:zlib')
  const bytes = gzipSync(readFileSync(new URL('../dist/visito.min.js', import.meta.url))).length
  assert.ok(bytes <= 8192, `${bytes} bytes gzipped`)
})

test('the product build carries none of the lab-only reads', () => {
  const product = readFileSync(new URL('../dist/visito.min.js', import.meta.url), 'utf8')
  const lab = readFileSync(new URL('../dist/visito.lab.min.js', import.meta.url), 'utf8')
  // what the lab build reads with: present there, absent from the product build; x.ev. is the per-test engine evidence
  const labOnly = ['getImageData', 'willReadFrequently', 'globalCompositeOperation', 'fillText', 'OfflineAudioContext', 'createDynamicsCompressor', 'copyFromChannel', 'expm1', 'atanh', 'DateTimeFormat', 'x.ev.']
  for (const mark of labOnly) {
    assert.ok(lab.includes(mark), `the lab build should contain ${mark}`)
    assert.ok(!product.includes(mark), `the product build should not contain ${mark}`)
  }
  // canvas encoders: no build uses them today, and a canvas encode must never reach the product build
  for (const mark of ['toDataURL', 'toBlob', 'convertToBlob']) assert.ok(!product.includes(mark), `the product build should not contain ${mark}`)
})

// what only the automation mark candidates read (src/marks.ts, src/botlab.ts): in the lab build, never in a build that ships
const CANDIDATE_READS = ['contentWindow', 'srcdoc', 'appVersion', 'PluginArray', 'sendMessage', 'field-sizing', 'scroll-target-group', 'accent-color', 'getOwnPropertyDescriptor', 'x.bot.']

test('the product and deferred builds carry none of the automation mark candidates, and the lab build carries them all', () => {
  const lab = readFileSync(new URL('../dist/visito.lab.min.js', import.meta.url), 'utf8')
  for (const mark of CANDIDATE_READS) assert.ok(lab.includes(mark), `the lab build should contain ${mark}`)
  for (const file of ['visito.js', 'visito.min.js', 'visito.esm.js', 'visito.defer.js', 'visito.defer.min.js', 'visito.defer.esm.js', 'match.js']) {
    const code = readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8')
    for (const mark of CANDIDATE_READS) assert.ok(!code.includes(mark), `${file} should not contain ${mark}`)
  }
})

test('the lab build writes no frame document: srcdoc is a Trusted Types sink, so it reads only the name in a descriptor lookup', () => {
  for (const file of ['visito.lab.js', 'visito.lab.min.js']) {
    const code = readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8')
    assert.ok(!/\.srcdoc\b|\[\s*["']srcdoc["']\s*\]|setAttribute\(\s*["']srcdoc/.test(code), `${file} reads or writes srcdoc`)
  }
})

test('every build is plain ASCII, so the character encoding of the page that loads it cannot change a string it draws or hashes', () => {
  for (const file of ['visito.js', 'visito.min.js', 'visito.lab.js', 'visito.lab.min.js', 'visito.esm.js', 'match.js', 'visito.defer.js', 'visito.defer.min.js', 'visito.defer.esm.js', 'deep.js', 'deep.min.js', 'deep.esm.js']) {
    const bytes = readFileSync(new URL(`../dist/${file}`, import.meta.url))
    const at = bytes.findIndex((b) => b > 0x7f)
    assert.equal(at, -1, `${file} has a non-ASCII byte at offset ${at}`)
  }
})

test('the ES module build exports the two calls and reports nothing outside a browser', async () => {
  const visito = await import('../dist/visito.esm.js')
  assert.deepEqual(Object.keys(visito).sort(), ['get', 'getSync'])
  assert.equal(visito.getSync(), null)
})

test('the matcher is its own entry and loads without the rest', async () => {
  const { match } = await import('../dist/match.js')
  assert.equal(match({ did: 'a', os: 'ios', osVer: null, app: 'safari', appVer: null, c: {} }, []).result, 'unknown')
})

test('the package ships exactly the product builds, the deferred builds, the deep entry, their types, the docs and the license, and no credits file or third-party license text', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const packed = JSON.parse(npm(['pack', '--dry-run', '--json'], root))
  const files = packed[0].files.map((file) => file.path).sort()
  const types = ['api', 'deep', 'defer', 'did', 'env', 'guard', 'index', 'match', 'reading', 'reads', 'stages'].map((name) => `dist/types/${name}.d.ts`)
  const expected = ['CHANGELOG.md', 'LICENSE', 'README.md', 'package.json', 'docs/API.md', 'docs/DECISIONS.md', 'docs/LEGAL.md', 'docs/SIGNALS.md', 'dist/match.js', 'dist/visito.esm.js', 'dist/visito.js', 'dist/visito.min.js', 'dist/visito.defer.esm.js', 'dist/visito.defer.js', 'dist/visito.defer.min.js', 'dist/deep.js', 'dist/deep.min.js', 'dist/deep.esm.js', ...types]
  assert.deepEqual(files, expected.sort())
  for (const file of files) assert.ok(!/^CREDITS|^third_party\//i.test(file), file)
})

// Names of other device-identification and detection libraries, built from pieces so that this file does not carry them either.
// The library is its own code: no file it ships names one. A comparison table, where they may appear, is not shipped.
const OTHER_LIBRARIES = [
  ['finger', 'printjs'], ['finger', 'print2'], ['finger', 'print pro'], ['finger', 'print.com'], ['f', 'pjs'],
  ['thumb', 'mark'], ['creep', 'js'], ['detect', 'incognito'], ['bo', 'td'], ['fp', 'scanner'], ['fp-', 'stalker'],
  ['get-browser-', 'fingerprint'], ['client', 'js'], ['ever', 'cookie'], ['amiuni', 'que'], ['panopti', 'click'],
].map((parts) => parts.join(''))

test('no file in the package names another fingerprinting or detection library', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const packed = JSON.parse(npm(['pack', '--dry-run', '--json'], root))
  for (const { path } of packed[0].files) {
    const text = readFileSync(join(root, path), 'utf8').toLowerCase()
    for (const name of OTHER_LIBRARIES) assert.ok(!text.includes(name), `${path} names ${name}`)
  }
})

// 1.0 ships no automation-marks entry (docs/DECISIONS.md, "Automation marks: none added in 1.0"): the candidates live in the lab build
test('the package ships no bot entry: no file, export, type or global for automation marks beyond the core', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(pkg.exports).filter((key) => /bot/i.test(key)), [], 'package.json exports a bot entry')
  assert.deepEqual([...pkg.files, ...pkg.sideEffects].filter((file) => /bot/i.test(file)), [], 'package.json lists a bot file')
  const packed = JSON.parse(npm(['pack', '--dry-run', '--json'], root))
  assert.deepEqual(packed[0].files.map((file) => file.path).filter((path) => /(^|\/)bot[^/]*$/i.test(path)), [], 'the package carries a bot file')
  for (const file of ['bot.js', 'bot.min.js', 'bot.esm.js']) assert.ok(!existsSync(new URL(`../dist/${file}`, import.meta.url)), `the build writes dist/${file}`)
  for (const file of ['visito.js', 'visito.min.js', 'visito.esm.js', 'visito.defer.js', 'visito.defer.min.js', 'visito.defer.esm.js', 'match.js']) {
    const code = readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8')
    for (const mark of ['VisitoBot', 'x.bot.', 'own-value', 'frame-window', 'no-webdriver']) assert.ok(!code.includes(mark), `${file} contains ${mark}`)
  }
})

// The deferred builds (src/defer.ts): nothing is read before start(), and start() is the core's session.

/** A recording Proxy: every operation on it, and on any object reached through it, is logged with its path. */
const recording = (target, name, log) => {
  const handler = {}
  for (const trap of ['get', 'set', 'has', 'defineProperty', 'deleteProperty', 'getOwnPropertyDescriptor', 'ownKeys', 'getPrototypeOf', 'setPrototypeOf', 'isExtensible', 'preventExtensions']) {
    handler[trap] = (t, key, ...rest) => {
      const at = key === undefined || typeof key === 'symbol' ? name : `${name}.${String(key)}`
      log.push(`${trap} ${at}`)
      const value = Reflect[trap](t, key, ...rest)
      return trap === 'get' && value && typeof value === 'object' ? recording(value, at, log) : value
    }
  }
  return new Proxy(target, handler)
}
/**
 * A context whose global and whose window both record every operation. Every name the script looks up on the global is logged, the
 * built-ins included: the global holds the window and the ECMAScript built-ins the library uses, so that the core build can run in it.
 */
const BUILT_INS = { Object, Array, String, Number, Boolean, Date, Math, JSON, RegExp, Error, Uint8Array, parseFloat, parseInt, isNaN, isFinite }
const recorded = () => {
  const log = []
  const window = recording(fakeWindow(), 'window', log)
  const global = recording({ window, ...BUILT_INS }, 'global', log)
  return { log, context: vm.createContext(global) }
}
// what the script-tag build may do to the global at load: define its own name, nothing else
const OWN_NAME = /^(getOwnPropertyDescriptor|set|defineProperty) global\.Visito$/
// the ES module as a function body, so that it runs in a context as a script while its declarations stay local, as in a module
const asScript = (source) => {
  const at = source.lastIndexOf('export {')
  assert.ok(at > 0, 'the ES module ends with its export list')
  const names = source.slice(at + 8, source.indexOf('}', at)).split(',').map((s) => s.trim()).filter(Boolean)
  const pairs = names.map((n) => {
    const [local, as = local] = n.split(/\s+as\s+/)
    return `${as}: ${local}`
  })
  return `(function () { 'use strict';\n${source.slice(0, at)}\nreturn { ${pairs.join(', ')} } })()`
}
const turn = () => new Promise((resolve) => setTimeout(resolve, 20))

for (const file of ['visito.defer.js', 'visito.defer.min.js']) {
  test(`${file} reads and stores nothing at load or before start(): no access to the window, nor to the global beyond its own name`, async () => {
    const { log, context } = recorded()
    const visito = vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8') + '\n;Visito', context)
    // reaching the api object itself goes through the global too: those lookups are the test's, not the build's
    const others = () => log.filter((entry) => !OWN_NAME.test(entry) && !/^get global.Visito(.|$)/.test(entry))
    assert.deepEqual(others(), [])
    assert.ok(log.length, 'the global name is defined')
    log.length = 0
    assert.equal(visito.getSync(), null)
    let called = 0
    visito.get(() => called++)
    await turn()
    assert.equal(called, 0, 'get() waits for start()')
    assert.deepEqual(others(), [], 'getSync() and get() before start() touch nothing')
    visito.start()
    assert.ok(others().includes('get window.navigator'), 'the control: start() reads, and the recording sees it')
    assert.deepEqual(Object.keys(visito).sort(), ['get', 'getSync', 'start'])
  })

  test(`${file} where there is no browser at all: start() reports null to the callbacks queued before it`, async () => {
    const visito = load(file, { setTimeout })
    let got = 'never called'
    visito.get((reading) => (got = reading))
    assert.doesNotThrow(() => visito.start())
    await turn()
    assert.equal(got, null)
    assert.equal(visito.getSync(), null)
  })

  test(`${file} in a browser-like window: start() reads and stores, then get calls back with the reading getSync has`, async () => {
    const window = fakeWindow()
    const visito = load(file, { window, setTimeout })
    assert.deepEqual(window.document.values, {}, 'nothing stored at load')
    visito.start()
    const sync = visito.getSync()
    assert.match(sync.did, /^[0-9a-f-]{36}$/)
    assert.equal(window.document.values._visito, sync.did)
    const later = await new Promise((resolve) => visito.get(resolve))
    assert.deepEqual(later, sync)
  })

  // this window has no layout, so the text size fails and both ids are null here: the values are compared instead, and
  // test/defer.test.mjs and lab/defer.mjs compare complete ids
  test(`${file}: start({ store: false }) leaves the cookie and localStorage empty and reads what the product build reads`, async () => {
    const window = fakeWindow()
    const visito = load(file, { window, setTimeout })
    visito.start({ store: false })
    const bare = await new Promise((resolve) => visito.get(resolve))
    assert.deepEqual([window.document.values, window.localStorage.values], [{}, {}])
    assert.deepEqual([bare.did, bare.didNew, bare.didSrc], [null, false, ''])
    const core = load('visito.min.js', { window: fakeWindow(), setTimeout })
    const kept = await new Promise((resolve) => core.get(resolve))
    assert.ok(kept.did)
    const same = (r) => JSON.stringify({ ...r, did: 0, didNew: 0, didSrc: 0, ms: 0, t: 0 })
    assert.equal(same(bare), same(kept))
  })
}

test('the core script-tag build reads at load and has no start(): the recording sees the read, and its api is get and getSync only', () => {
  const { log, context } = recorded()
  const visito = vm.runInContext(readFileSync(new URL('../dist/visito.min.js', import.meta.url), 'utf8') + '\n;Visito', context)
  assert.ok(log.includes('get window.document'), 'the recording sees a read at load')
  assert.deepEqual(Object.keys(visito).sort(), ['get', 'getSync'])
})

test('the deferred ES module exports the three calls, and evaluating it touches no global', async () => {
  const visito = await import('../dist/visito.defer.esm.js')
  assert.deepEqual(Object.keys(visito).sort(), ['get', 'getSync', 'start'])
  assert.equal(visito.getSync(), null)
  const { log, context } = recorded()
  const exported = vm.runInContext(asScript(readFileSync(new URL('../dist/visito.defer.esm.js', import.meta.url), 'utf8')), context)
  assert.deepEqual(Object.keys(exported).sort(), ['get', 'getSync', 'start'])
  exported.getSync()
  exported.get(() => {})
  assert.deepEqual(log, [])
  // the control: the same evaluation of the core module does read the window
  const core = recorded()
  vm.runInContext(asScript(readFileSync(new URL('../dist/visito.esm.js', import.meta.url), 'utf8')), core.context)
  assert.ok(core.log.includes('get window.document'))
})

test('the deferred build stays under 8,192 bytes gzipped and within 134 bytes of the product build (102 when it was added, plus 32; 108 at 1.0.0)', async () => {
  const { gzipSync } = await import('node:zlib')
  const size = (file) => gzipSync(readFileSync(new URL(`../dist/${file}`, import.meta.url))).length
  const bytes = size('visito.defer.min.js')
  const core = size('visito.min.js')
  assert.ok(bytes <= 8192, `${bytes} bytes gzipped`)
  assert.ok(bytes - core <= 134, `${bytes} bytes gzipped, ${bytes - core} more than the product build's ${core}`)
})

test('the deferred build carries none of the lab-only reads', () => {
  const build = readFileSync(new URL('../dist/visito.defer.min.js', import.meta.url), 'utf8')
  for (const mark of ['getImageData', 'willReadFrequently', 'fillText', 'OfflineAudioContext', 'expm1', 'DateTimeFormat', 'x.ev.', 'toDataURL']) {
    assert.ok(!build.includes(mark), `the deferred build should not contain ${mark}`)
  }
})

// ---- The deep entry ---------------------------------------------------------------------------------

// Each entry's budget in bytes gzipped (node's default level). The core's is the published limit. The deep entry's is what it
// measured with the review fixes in (the digest self-test, the gecko rule, the lang read-back), 7,089, and about 2% more: room for a
// fix, not for a new read without a decision. Without the text scene it measures 6,402.
const BUDGETS = { 'visito.min.js': 8192, 'deep.min.js': 7232 }

test('every entry stays under its own budget', async () => {
  const { gzipSync } = await import('node:zlib')
  for (const file of Object.keys(BUDGETS)) {
    const bytes = gzipSync(readFileSync(new URL(`../dist/${file}`, import.meta.url))).length
    assert.ok(bytes <= BUDGETS[file], `${file}: ${bytes} bytes gzipped, budget ${BUDGETS[file]}`)
  }
})

const loadDeep = (file, sandbox) => {
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8') + '\n;this.__deep = VisitoDeep', sandbox)
  return sandbox.__deep
}

for (const file of ['deep.js', 'deep.min.js']) {
  test(`${file} defines VisitoDeep, not Visito, and outside a browser calls back null`, () => {
    const sandbox = {}
    const deep = loadDeep(file, sandbox)
    assert.equal(sandbox.Visito, undefined, 'it leaves the core global alone')
    assert.deepEqual(Object.keys(deep).sort(), ['DEEP_VERSION', 'get'])
    let got = 'never called'
    deep.get((reading) => (got = reading))
    assert.equal(got, null)
  })

  test(`${file} in a browser-like window: get calls back once, after it returns, and an engine it cannot name is excluded`, async () => {
    const deep = loadDeep(file, { window: fakeWindow(), setTimeout })
    let calls = 0
    const reading = await new Promise((resolve) => {
      deep.get((r) => {
        calls++
        resolve(r)
      })
      assert.equal(calls, 0, 'the callback must not run before get() returns')
    })
    assert.equal(calls, 1)
    assert.equal(reading.v, 1)
    assert.equal(reading.id, null)
    assert.equal(reading.c['x.rule'], 'other')
    // the array comes from the sandbox's realm: compared by its items
    assert.deepEqual([...reading.flags.excluded], ['r.audio', 'r.cg'])
  })
}

test("the core build carries no deep code, and the deep build none of the core's storage, parser or any way to send or load", () => {
  const product = readFileSync(new URL('../dist/visito.min.js', import.meta.url), 'utf8')
  const deep = readFileSync(new URL('../dist/deep.min.js', import.meta.url), 'utf8')
  for (const mark of ['getImageData', 'OfflineAudioContext', 'Hamburgefonstiv', 'visito-deep', 'VisitoDeep']) assert.ok(!product.includes(mark), `the core build should not contain ${mark}`)
  for (const mark of ['getImageData', 'OfflineAudioContext', 'visito-deep:']) assert.ok(deep.includes(mark), `the deep build should contain ${mark}`)
  // the text scene is not drawn: no string of it, no font, no text call and no canvas language in the deep build
  for (const mark of ['Hamburgefonstiv', 'fillText', 'strokeText', 'measureText', 'sans-serif', 'monospace', 'lang']) assert.ok(!deep.includes(mark), `the deep build should not contain ${mark}`)
  // the cache name, the in-app browser table, client hints, storage, encoders, the lab-only evidence, and every way to send or load
  const never = ['_visito', 'Barcelona', 'getHighEntropyValues', 'localStorage', 'sessionStorage', 'cookie', 'indexedDB', 'toDataURL', 'toBlob', 'x.ev.', 'expm1',
    'fetch', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'import(', 'importScripts', '"script"', '"iframe"']
  for (const mark of never) assert.ok(!deep.includes(mark), `the deep build should not contain ${mark}`)
})

test('the deep ES module exports get and DEEP_VERSION, does nothing at import, and reports nothing outside a browser', async () => {
  const deep = await import('../dist/deep.esm.js')
  assert.deepEqual(Object.keys(deep).sort(), ['DEEP_VERSION', 'get'])
  assert.equal(deep.DEEP_VERSION, 1)
  assert.equal(await new Promise((resolve) => deep.get(resolve)), null)
})
