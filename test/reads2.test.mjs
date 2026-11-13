import { test } from 'node:test'
import assert from 'node:assert/strict'
import { syncReads, automation, screenSize } from '../build/esm/reads.js'

const media = (matching) => (query) => ({ matches: matching.includes(query) })
const phone = (over = {}) => ({
  navigator: { languages: ['de-DE', 'pt-BR', 'en'], hardwareConcurrency: 8, maxTouchPoints: 5, platform: 'Linux armv81', cookieEnabled: true, deviceMemory: 4, webdriver: false },
  screen: { width: 393, height: 873, availWidth: 393, availHeight: 849, colorDepth: 24 },
  devicePixelRatio: 2.75,
  matchMedia: media(['(color-gamut: srgb)', '(prefers-color-scheme: dark)']),
  ...over,
})

test('syncReads: every cheap candidate, as a raw hint with its key', () => {
  assert.deepEqual(syncReads(phone()), {
    'x.langs': 'de-DE,pt-BR,en',
    'x.cores': 8,
    'x.touch': 5,
    'x.scr': '873x393',
    'x.dpr': 2.75,
    'x.avail': '849x393',
    'x.depth': 24,
    'x.plat': 'Linux armv81',
    'x.cookie': true,
    'x.mem': 4,
    'x.tzo': new Date().getTimezoneOffset(),
    'x.gamut': 'srgb',
    'x.hdr': 'standard',
    'x.contrast': 'no-preference',
    'x.forced': 'none',
    'x.inverted': 'none',
    'x.motion': 'no-preference',
    'x.transp': 'no-preference',
    'x.scheme': 'dark',
  })
})

test('syncReads: the screen is reported long side first, so rotation changes nothing', () => {
  const upright = syncReads(phone())
  const rotated = syncReads(phone({ screen: { width: 873, height: 393, availWidth: 849, availHeight: 393, colorDepth: 24 } }))
  assert.equal(rotated['x.scr'], upright['x.scr'])
  assert.equal(rotated['x.avail'], upright['x.avail'])
})

test('screenSize: the longer side, "x", the shorter, whichever way the browser reports them (CSSOM View leaves rotation to the engine)', () => {
  const at = (width, height) => screenSize({ screen: { width, height } })
  assert.equal(at(393, 852), '852x393')
  assert.equal(at(852, 393), '852x393')
  assert.equal(at(400, 400), '400x400')
  assert.equal(at('852', '393'), '852x393', 'converted with Number()')
  assert.equal(at(1366.5, 768), '1366.5x768', 'a fraction is kept, not hidden')
  for (const [width, height] of [[0, 852], [-1, 852], [NaN, 852], ['', 852], [852, undefined], [Infinity, 852], [852, -Infinity], ['abc', 393]]) {
    assert.equal(at(width, height), '!na', `${width} x ${height}`)
  }
  const throwing = { get width() { throw new Error('fault') }, height: 393 }
  assert.equal(screenSize({ screen: throwing }), '!err')
  assert.equal(screenSize({}), '!err', 'no screen object')
})

test('screenSize: the order needs no Math call and no other value, so a page that broke Math gets the same answer', () => {
  const { max, min } = Math
  Math.max = Math.min = () => { throw new Error('fault') }
  try {
    assert.equal(screenSize({ screen: { width: 393, height: 852 }, orientation: 90, matchMedia: () => { throw new Error('unread') } }), '852x393')
  } finally {
    Object.assign(Math, { max, min })
  }
})

test('syncReads: the available area follows the same rule as the screen', () => {
  const r = syncReads(phone({ screen: { width: 393, height: 873, availWidth: Infinity, availHeight: 849, colorDepth: 24 } }))
  assert.equal(r['x.avail'], '!na')
  assert.equal(syncReads(phone({ screen: { width: 393, height: 873, availWidth: 849, availHeight: 393, colorDepth: 24 } }))['x.avail'], '849x393')
})

test('syncReads: a setting the browser does not know reads as its default, so a later update changes nothing', () => {
  const old = syncReads(phone({ matchMedia: media([]) }))
  assert.equal(old['x.contrast'], 'no-preference')
  assert.equal(old['x.transp'], 'no-preference')
  assert.equal(old['x.hdr'], 'standard')
  assert.equal(old['x.gamut'], 'srgb')
  const none = syncReads(phone({ matchMedia: undefined }))
  assert.equal(none['x.contrast'], 'no-preference')
})

test('syncReads: a user setting is seen', () => {
  const r = syncReads(phone({ matchMedia: media(['(prefers-contrast: more)', '(prefers-reduced-motion: reduce)', '(color-gamut: p3)', '(color-gamut: srgb)', '(dynamic-range: high)']) }))
  assert.deepEqual([r['x.contrast'], r['x.motion'], r['x.gamut'], r['x.hdr']], ['more', 'reduce', 'p3', 'high'])
})

test('syncReads: missing and throwing pieces become statuses, one bad read does not touch the others', () => {
  const r = syncReads(phone({ navigator: { languages: 'fr', maxTouchPoints: 5 }, screen: undefined, devicePixelRatio: 'x',
    matchMedia: () => { throw new Error('blocked') } }))
  assert.equal(r['x.langs'], '!na')
  assert.equal(r['x.cores'], '!na')
  assert.equal(r['x.touch'], 5)
  assert.equal(r['x.scr'], '!err')
  assert.equal(r['x.dpr'], '!na')
  assert.equal(r['x.contrast'], '!err')
})

test('automation: an ordinary phone carries no mark', () => {
  assert.deepEqual(automation(phone(), { os: 'android' }), [])
})

test('automation: webdriver, a driver global, an empty language list, a headless user agent', () => {
  const w = phone({ callPhantom: function () {}, navigator: { webdriver: true, languages: [], maxTouchPoints: 5, platform: 'Linux armv81', userAgent: 'Mozilla/5.0 HeadlessChrome/150.0' } })
  assert.deepEqual(automation(w, { os: 'android' }), ['webdriver', 'global', 'no-languages', 'headless'])
})

// Each name is set by the tool's own source (docs/DECISIONS.md, "Automation marks: sources"); the second list are names found in no tool's source.
const SOURCED_GLOBALS = ['callPhantom', '_phantom', '__nightmare', '_Selenium_IDE_Recorder', '__webdriver_evaluate', '__webdriver_script_fn', 'domAutomationController', '$chrome_asyncScriptInfo']
const UNSOURCED_GLOBALS = ['phantom', 'domAutomation', '_selenium', '__selenium_evaluate', '__driver_evaluate', '$cdc_asdjflasutopfhvcZLmcf_']

test('automation: a global that a tool\'s own source sets is a mark; a name no tool was found to set is not', () => {
  for (const name of SOURCED_GLOBALS) assert.deepEqual(automation(phone({ [name]: {} }), { os: 'android' }), ['global'], name)
  for (const name of UNSOURCED_GLOBALS) assert.deepEqual(automation(phone({ [name]: {} }), { os: 'android' }), [], name)
})

test('automation: the user agents headless products document carry the headless mark, in any letter case', () => {
  const desktop = (userAgent) => phone({ navigator: { languages: ['fr-FR'], maxTouchPoints: 0, platform: 'Linux x86_64', userAgent } })
  for (const userAgent of [
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36',
    'Mozilla/5.0 (Unknown; Linux x86_64) AppleWebKit/538.1 (KHTML, like Gecko) PhantomJS/2.1.1 Safari/538.1',
    'Mozilla/5.0 (X11; Linux x86_64; rv:21.0) Gecko/20100101 SlimerJS/0.7',
    'Mozilla/5.0 (X11; Linux x86_64; rv:21.0) Gecko/20100101 slimerjs/0.7',
  ]) assert.deepEqual(automation(desktop(userAgent), { os: 'linux' }), ['headless'], userAgent)
})

test('automation: a desktop application shell is a person at a window, not a headless browser', () => {
  const desktop = (userAgent) => phone({ navigator: { languages: ['fr-FR'], maxTouchPoints: 0, platform: 'Win32', userAgent } })
  const shell = desktop('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SomeApp/3.1.0 Chrome/150.0.0.0 Electron/40.0.0 Safari/537.36')
  assert.deepEqual(automation(shell, { os: 'windows' }), [])
  const headless = desktop('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.0.0 Safari/537.36')
  assert.deepEqual(automation(headless, { os: 'windows' }), ['headless'])
})

test('automation: the user agent says phone, the platform says desktop', () => {
  const w = phone({ navigator: { languages: ['fr'], maxTouchPoints: 0, platform: 'Win32' } })
  assert.deepEqual(automation(w, { os: 'android' }), ['platform', 'no-touch'])
  assert.deepEqual(automation(phone({ navigator: { languages: ['fr'], maxTouchPoints: 5, platform: 'iPhone' } }), { os: 'ios' }), [])
})

test('automation: a window that throws everywhere yields no mark and no exception', () => {
  const hostile = new Proxy({}, { get() { throw new Error('blocked') } })
  assert.deepEqual(automation(hostile, { os: 'android' }), [])
})

const withHints = (brands, over = {}) => phone({ navigator: { ...phone().navigator, userAgentData: { brands, mobile: brands.length > 0 }, ...over } })

test('automation: a desktop browser sent out with a phone user agent, as link scanners do', () => {
  const scanner = withHints([], { maxTouchPoints: 1, platform: 'Linux armv8l' })
  assert.deepEqual(automation(scanner, { os: 'android' }, { engine: 'blink', android: false }), ['no-brands', 'not-android'])
})

test('automation: real client-hint brands and Android features carry no mark', () => {
  const webview = withHints([{ brand: 'Android WebView', version: '157' }, { brand: 'Chromium', version: '157' }])
  assert.deepEqual(automation(webview, { os: 'android' }, { engine: 'blink', android: true }), [])
})

test('automation: a browser without client hints is not marked for lacking brands', () => {
  assert.deepEqual(automation(phone(), { os: 'android' }, { engine: 'blink', android: true }), [])
  assert.deepEqual(automation(phone({ navigator: { languages: ['fr'], maxTouchPoints: 5, platform: 'iPhone' } }), { os: 'ios' }, { engine: 'webkit', android: false }), [])
})
