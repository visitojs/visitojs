// Differential check for the user-agent parser: runs a reference build of parseUa and the current one over
// synthetic user agents generated from templates and fails on the first result that differs.
// Usage (after npm run build): node lab/ua-diff.mjs <path to reference ua.js> [count]
// A second part replaces, one at a time, each built-in the parser calls with a wrong-value form (lab/tampers.mjs)
// and runs both builds on a sample of the same inputs: the current one may differ only where it gives the untampered value.
// Each build is compared twice: as tsc emits it and after the same terser options the bundle uses.
// Every user agent here is generated; none comes from a real visitor.
// A reference from main, in the ignored report folder:
//   mkdir -p lab/report/raw/ref && git show origin/main:src/ua.ts > lab/report/raw/ref/ua.ts
//   npx tsc --target ES5 --module ES2015 --lib ES5,DOM --strict --outDir lab/report/raw/ref lab/report/raw/ref/ua.ts
//   node lab/ua-diff.mjs lab/report/raw/ref/ua.js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { minify } from 'terser'
import { TAMPERS, install, compare } from './tampers.mjs'

const refPath = process.argv[2]
if (!refPath) {
  console.error('usage: node lab/ua-diff.mjs <reference ua.js> [count]')
  process.exit(2)
}
const COUNT = Number(process.argv[3] || 20000)
const refUrl = pathToFileURL(resolve(refPath))
const curUrl = new URL('../build/esm/ua.js', import.meta.url)
async function minified(url) {
  const out = await minify(readFileSync(url, 'utf8'), { ecma: 5, safari10: true, compress: true, mangle: true, module: true })
  return (await import('data:text/javascript,' + encodeURIComponent(out.code))).parseUa
}
const ref = (await import(refUrl.href)).parseUa
const cur = (await import(curUrl.href)).parseUa
const refMin = await minified(refUrl)
const curMin = await minified(curUrl)

let seed = 0x9e3779b9
function rnd() {
  // xorshift32, seeded so a failure reproduces
  seed ^= seed << 13
  seed >>>= 0
  seed ^= seed >>> 17
  seed ^= seed << 5
  seed >>>= 0
  return seed / 4294967296
}
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1))
const pick = (xs) => xs[Math.floor(rnd() * xs.length)]
const maybe = (p, s) => (rnd() < p ? s : '')
const ver = (parts) => {
  const out = [String(int(0, rnd() < 0.2 ? 999 : 160))]
  for (let i = 1; i < parts; i++) out.push(String(int(0, rnd() < 0.3 ? 99999 : 20)))
  return out.join('.')
}
const v = () => ver(int(1, 5))

const iosModels = ['iPhone14,5', 'iPhone18,2', 'iPad13,1', 'iPod9,1', 'iPhone9,3', 'iPhoneX', 'iPad', 'iPhone12,']
const androidModels = ['SM-A135F', 'Redmi Note 99 Pro', 'TECNO ZZ5q', 'M9999K6G', 'Pixel 10', 'K', 'wv', 'U', 'Mobile', 'Tablet', 'rv:120.0', 'en-us', 'fr_FR', 'GT-I9999', 'moto g(60)', 'SM-X135FU  ', '', ' ', 'Android', 'Build/ABC', 'ONEPLUS A6003', 'K ', 'k']
const locales = ['fr-fr', 'en-US', 'de_de', 'pt-BR', 'zh-Hans-CN', 'en']

function iosOs() {
  const dev = pick(['iPhone', 'iPad', 'iPod touch'])
  const os = int(9, 30) + '_' + int(0, 9) + maybe(0.4, '_' + int(0, 9))
  const sep = rnd() < 0.1 ? os.replace(/_/g, '.') : os
  return pick([
    `(${dev}; CPU ${dev === 'iPad' ? '' : 'iPhone '}OS ${sep} like Mac OS X)`,
    `(${dev}; U; CPU OS ${sep} like Mac OS X; ${pick(locales)})`,
    `(${dev}; CPU iPhone OS ${sep} like Mac OS X)`,
  ])
}

function androidOs() {
  const a = rnd() < 0.15 ? 'Android' : 'Android ' + pick([String(int(1, 17)), int(1, 16) + '.' + int(0, 9), int(1, 16) + '.' + int(0, 9) + '.' + int(0, 9), 'Q', ''])
  const model = pick(androidModels)
  const build = maybe(0.6, ' Build/' + pick(['SP1A.210812.016', 'TP1A.220624.014', 'KOT49H', 'UP1A.231005.007', 'x']))
  const parts = []
  parts.push(...pick([['Linux'], ['Linux', 'U'], [], ['X11', 'Linux']]))
  parts.push(a)
  if (rnd() < 0.3) parts.push(pick(locales))
  if (rnd() < 0.2) parts.push('K')
  if (rnd() < 0.8) parts.push(model + build)
  if (rnd() < 0.3) parts.push(pick(['wv', 'Mobile', 'Tablet', 'rv:' + int(50, 160) + '.0', pick(androidModels)]))
  const body = parts.join(pick(['; ', ';', ' ; ']))
  return rnd() < 0.05 ? '(' + body : '(' + body + ')'
}

function desktopOs() {
  return pick([
    `(Windows NT ${pick(['10.0', '6.1', '6.3', '11.0', '5.1'])}; Win64; x64)`,
    `(Windows NT ${int(5, 11)}.${int(0, 3)})`,
    `(Macintosh; Intel Mac OS X ${pick(['10_15_7', '10.15', '11_2_3', '14_0', '10_9'])})`,
    `(Macintosh; PPC Mac OS X ${int(10, 15)}.${int(0, 9)})`,
    '(X11; Linux x86_64)',
    '(X11; Ubuntu; Linux i686; rv:120.0)',
    '(X11; CrOS x86_64 14541.0.0)',
    '(compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    '(PlayStation 5 3.11)',
    '',
  ])
}

const webkit = () => 'AppleWebKit/' + pick(['605.1.15', '537.36', '534.30', '601.1.46']) + ' (KHTML, like Gecko)'
const engines = [
  () => `${webkit()} Version/${pick(['4.0', int(9, 35) + '.' + int(0, 9), int(25, 120) + '.' + int(0, 9) + '.' + int(0, 9)])} Mobile/15E148 Safari/604.1`,
  () => `${webkit()} Chrome/${v()} Mobile Safari/537.36`,
  () => `${webkit()} Version/4.0 Chrome/${v()} Mobile Safari/537.36`,
  () => `${webkit()} Chrome/${v()} Safari/537.36`,
  () => `${webkit()} CriOS/${v()} Mobile/15E148 Safari/604.1`,
  () => `${webkit()} FxiOS/${v()} Mobile/15E148 Safari/605.1.15`,
  () => `Gecko/${int(20100101, 20991231)} Firefox/${v()}`,
  () => `Gecko/${int(50, 160)}.0 Firefox/${v()}`,
  () => `${webkit()} Mobile/24A446`,
  () => `${webkit()}`,
  () => `${webkit()} Version/${int(9, 30)}.${int(0, 9)} Safari/605.1.15`,
  () => '',
]

const apps = [
  () => `[FBAN/FBIOS;FBAV/${v()};FBBV/${int(1, 1e9)};FBDV/${pick(iosModels)};FBMD/iPhone;FBSN/iOS;FBSV/${int(9, 30)}.${int(0, 9)}${maybe(0.5, '.' + int(0, 9))};FBSS/3;FBID/phone;FBLC/fr_FR;FBOP/5;FBRV/0]`,
  () => `[FB_IAB/FB4A;FBAV/${v()};IABMV/1;]`,
  () => `[FBAN/Messenger;FBAV/${v()};FBBV/1;FBSV/${int(10, 30)}.${int(0, 9)}]`,
  () => `[FB_IAB/Orca-Android;FBAV/${v()};]`,
  () => `[FB_IAB/MESSENGER;FBAV/${v()};]`,
  () => `MessengerLite/${v()}`,
  () => `[FBAN/EMA;FBLC/en_US;FBAV/${v()};]`,
  () => `[FBAV/${v()}]`,
  () => `FBAN/`,
  () => `Instagram ${v()} (${pick(iosModels)}; iOS ${int(12, 30)}_${int(0, 9)}; fr_FR; fr; scale=2.00; 828x1792; IABMV/1; ${int(1, 1e9)})`,
  () => `Instagram ${v()} Android (${int(20, 37)}/${pick([String(int(5, 17)), int(5, 16) + '.' + int(0, 9), int(5, 16) + '.' + int(0, 9) + '.' + int(0, 9)])}; ${int(120, 640)}dpi; 1080x2340; ${pick(['samsung', 'Xiaomi', 'Google', 'OnePlus'])}; ${pick(androidModels)}${maybe(0.3, '   ')}; pa3q; qcom; en_US; ${int(1, 1e9)})`,
  () => `Instagram ${v()} Android (${int(20, 37)}/${int(5, 16)}; x; y)`,
  () => `Instagram`,
  () => `Barcelona ${v()} (iPhone14,5; iOS 18_1; en_US)`,
  () => `Barcelona ${v()} Android (34/14; 420dpi; 1080x2400; Google; Pixel 10; x; y; en_US; 1)`,
  () => `musical_ly_${int(2019000000, 2030000000)} JsSdk/1.0 NetType/4G Channel/googleplay AppName/musical_ly app_version/${v()} ByteLocale/fr BytedanceWebview/d8a21c6`,
  () => `${pick(['musical_ly', 'MUSICAL_LY', 'trill_', 'TRILL_', 'tiktok', 'TikTok', 'bytedance', 'BYTEDANCE'])}_${int(1, 99)}${maybe(0.5, '.' + int(0, 99))}`,
  () => `TikTok ${v()} rv:${int(1, 999)} (iPhone; iOS ${int(12, 30)}.${int(0, 9)}; en_US) Cronet`,
  () => `app_version/${v()} musical_ly`,
  () => `Snapchat/${v()} (like Safari/8622.1.22.10.9, panda)`,
  () => `WhatsApp/${v()} ${pick(['A', 'i', 'N'])}`,
  () => `SamsungBrowser/${v()}`,
  () => `${pick(['Edg', 'EdgA', 'EdgiOS', 'Edge', 'XEdg', 'EdgX'])}/${v()}`,
  () => `${pick(['OPR', 'OPT', 'OPX', 'XOPR'])}/${v()}`,
  () => `Firefox/${v()}`,
  () => `FxiOS/${v()}`,
  () => `CriOS/${v()}`,
  () => `YaBrowser/${v()} Yowser/2.5`,
  () => `GSA/${v()}`,
  () => `Line/${v()}`,
  () => `Version/${int(1, 40)}.${int(0, 9)}`,
  () => `Safari/${v()}`,
]

const fragments = [
  'Mozilla/5.0', '(', ')', ';', ' ', 'Android', 'Android 14', 'Android (34/14;', 'iPhone', 'iPad', 'iPod', 'Macintosh', 'Mac OS X 10_15',
  'Windows NT 10.0', 'Linux', 'X11', 'Chrome/', 'Chrome/150', 'Firefox/', 'Firefox/99', 'Version/26.1', 'Version/', 'Safari/', 'AppleWebKit',
  '; wv)', 'K', 'Build/X', 'FBSV/27.1', '; iOS 19_2', 'OS 18_6', 'OS 17.4', 'CriOS/', 'FBAV/1.2', 'FBAN/', 'FB_IAB/', 'Barcelona', 'Instagram',
  'Instagram 1.0', 'Snapchat/', 'WhatsApp/2.1', 'SamsungBrowser/', 'Edg/', 'OPR/', 'TikTok', 'trill_', 'iPhone14,5', 'iPad13,1', 'rv:1.0',
  'Mobile', 'Tablet', 'U', 'en-us', 'app_version/3.2', 'musical_ly_1.2', 'Messenger', 'MessengerLite', 'FB_IAB/Orca', '\t', '\n', '/', '.', ',',
  '_', '1', '27', '0', 'é', '\u0000', 'Ａｎｄｒｏｉｄ', 'rv:', ' K ', 'Build/', ' Build/x y', 'Android 10; K', 'Android 5.0.1', 'Android (', ' ;) ', 'Edge/', 'EdgA/1', 'OPT/2', 'FxiOS/3', 'Firefox/', 'Chrome/1.2.3',
]

function soup() {
  const n = int(1, 25)
  let s = ''
  for (let i = 0; i < n; i++) s += pick(fragments) + maybe(0.5, pick([' ', ';', '; ', '/', '']))
  return s
}

function structured() {
  const kind = rnd()
  const os = kind < 0.35 ? iosOs() : kind < 0.75 ? androidOs() : desktopOs()
  let s = `${pick(['Mozilla/5.0', 'Mozilla/5.0', 'Dalvik/2.1.0', ''])} ${os} ${pick(engines)()}`
  const extra = int(0, 3)
  for (let i = 0; i < extra; i++) s += ' ' + pick(apps)()
  if (rnd() < 0.05) s = s.slice(0, int(0, s.length))
  if (rnd() < 0.03) s = 'x'.repeat(int(900, 1100)) + s
  if (rnd() < 0.03) s = s + ' '.repeat(int(800, 1100)) + pick(apps)()
  if (rnd() < 0.05) s = s.replace(/ /g, '  ')
  return s
}

const inputs = [undefined, null, 0, 12345, true, {}, [], ['Android'], new String('Android 14'), '', ' ', '((((;;;;))))', 'Android '.repeat(5000), 'iPhone'.repeat(400)]
for (let i = 0; i < COUNT; i++) inputs.push(rnd() < 0.8 ? structured() : soup())

// Every BMP code point where whitespace handling decides the Android token: around it, before Build/, inside the
// Build/ tail (where line terminators stop .*), as the whole token, around K and before the version token.
const sweep = [
  (c) => `(Linux; Android 14; ${c}SM-A135F${c}) Chrome/150`,
  (c) => `(Linux; Android 14; SM-A135F${c}Build/X)`,
  (c) => `(Linux; Android 14; SM-A135F ${c}Build/X${c})`,
  (c) => `(Linux; Android 14; SM-A135F Build/X${c}Y)`,
  (c) => `(Linux; Android 14; SM-A135F Build/A${c} Build/B${c})`,
  (c) => `(Linux; Android 14; ${c}Build/X)`,
  (c) => `(Linux; Android 14; ${c}${c})`,
  (c) => `(Linux; Android 14; ${c})`,
  (c) => `(Linux;${c}Android 14; ${c}K${c}; M)`,
  (c) => `(Linux; ${c}Build/X; Android 14; M)`,
  (c) => `(Linux; Android 14; wv${c}; M${c}${c}Build/${c}; N)`,
  (c) => `Instagram 1.0 Android (34/14; 1dpi; 1x1; maker; ${c}Model${c}; x)`,
]
for (let code = 0; code < 0x10000; code++) for (const make of sweep) inputs.push(make(String.fromCharCode(code)))

// Version numbers of every length up to the 1,024-character cut, with and without leading zeros: unary plus and
// parseInt(s, 10) must read every run of ASCII digits the same.
const digits = (n, lead) => {
  let s = ''
  for (let i = 0; i < n; i++) s += i < lead ? '0' : String(int(0, 9))
  return s
}
for (let n = 1; n <= 1100; n++) {
  for (const lead of [0, 1, int(1, n), n]) {
    inputs.push('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + digits(n, lead) + '.0 Safari/537.36')
    inputs.push('Mozilla/5.0 (X11; Linux x86_64; rv:1.0) Gecko/20100101 Firefox/' + digits(n, lead))
    inputs.push('Mozilla/5.0 (Linux; Android ' + digits(n, lead) + '; SM-A135F) Chrome/' + digits(n, lead))
  }
}
// Android sections with no closing parenthesis, ending anywhere from just after the token to past the cut, and
// starting anywhere up to it: the section end is at most 200 past "Android", clamped to the string by substring.
for (let pad = 0; pad <= 1030; pad += pad < 760 ? 37 : 1) {
  for (const tail of ['', ' Build/X', '; wv', ' '.repeat(int(1, 300)), 'Y'.repeat(int(1, 400)), '; K; SM-Z' + digits(int(1, 300), 0)]) {
    inputs.push('x'.repeat(pad) + '(Linux; Android 12; SM-X135FU' + tail)
    inputs.push('x'.repeat(pad) + 'Android 12; SM-X135FU' + tail)
    inputs.push('Mozilla/5.0 (Linux; Android 12; ' + 'M'.repeat(pad) + tail)
  }
}

// Short strings built from whitespace of every kind and the pieces the token rules look at.
const bits = [' ', '\t', '\n', '\r', '\v', '\f', ' ', ' ', '᠎', ' ', ' ', '​', ' ', ' ', ' ', ' ', '　', '﻿', '\u0085', 'Build/', 'Build', 'B', 'K', 'Android', 'Android 9', ';', 'x', '(', ')', 'wv', 'U']
for (let i = 0; i < COUNT; i++) {
  let s = '(Linux; Android 14; '
  for (let n = int(1, 12); n > 0; n--) s += pick(bits)
  inputs.push(rnd() < 0.5 ? s : s + ')')
}

const run = (parse, ua) => {
  try {
    return { ok: parse(ua) }
  } catch (e) {
    return { threw: String(e) }
  }
}

const seen = new Map()
let n = 0
for (const ua of inputs) {
  const want = run(ref, ua)
  for (const [name, got] of [['current', run(cur, ua)], ['reference, minified', run(refMin, ua)], ['current, minified', run(curMin, ua)]]) {
    try {
      assert.deepStrictEqual(got, want)
      if (want.ok) assert.deepStrictEqual(Object.keys(got.ok), Object.keys(want.ok))
    } catch (e) {
      console.error('MISMATCH for', JSON.stringify(ua))
      console.error('reference:', JSON.stringify(want))
      console.error(`${name}:`.padEnd(11), JSON.stringify(got))
      process.exit(1)
    }
  }
  if (want.ok) {
    const k = want.ok.os + '/' + want.ok.app + '/' + (want.ok.model ? 'm' : '-') + (want.ok.osVer ? 'v' : '-') + (want.ok.appVer ? 'a' : '-') + (want.ok.engineVer !== null ? 'e' : '-') + (want.ok.reduced ? 'r' : '-')
    seen.set(k, (seen.get(k) || 0) + 1)
  }
  n++
}
console.log(`ua-diff: ${n} inputs, identical results; ${seen.size} distinct os/app/field-presence classes`)
if (process.argv.includes('--classes')) for (const [k, c] of [...seen].sort()) console.log(k.padEnd(32), c)

// The same parsers on a page that has replaced one built-in they call. A sample of the inputs above, plus the shapes the
// fault matrix and the tests use. The current build may differ from the reference only where it has the untampered value.
const samples = [
  'Mozilla/5.0 (Linux; Android 12; SM-X135FU Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.8078.50 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/585.0.0.47.54;IABMV/1;]',
  'Mozilla/5.0 (Linux; Android 12; SM-X135FU Build/SP1A.210812.016; wv Version/4.0 Chrome/156.0.8078.50 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.0.0 Mobile Safari/537.36 Instagram 410.0.0.1.2 Android (34/14; 420dpi; 1080x2400; Xiaomi; M9999K6G; sweet; qcom; fr_FR; 1)',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/24A446 Safari/604.1 [FBAN/FBIOS;FBAV/586.0.0.62.72;FBBV/1106861720;FBDV/iPhone18,2;FBMD/iPhone;FBSN/iOS;FBSV/27.0.1;FBSS/3]',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.3000.1',
  'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
]
const TAMPER_SAMPLE = Number(process.env.TAMPER_SAMPLE || 3000)
const strings = inputs.filter((x) => typeof x === 'string')
for (let i = 0; i < TAMPER_SAMPLE; i++) samples.push(strings[Math.floor(rnd() * strings.length)])
const fields = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].map((name) => ({ name, get: (r) => r[name] }))
const under = (tamper, parse, ua) => {
  const undo = (0, eval)(install(tamper))
  let out = null
  try {
    out = parse(ua)
  } catch (e) {
    // a throw here is the reading lost: the stage that calls the parser returns no reading
  }
  undo()
  return out
}
let tamperFailed = false
let checked = 0
for (const tamper of TAMPERS) {
  const counts = { same: 0, better: 0, 'both wrong': 0, FAIL: 0 }
  const moved = new Map()
  let example = null
  for (const [refParse, curParse] of [[ref, cur], [refMin, curMin]]) {
    for (const ua of samples) {
      const result = compare(under(tamper, refParse, ua), under(tamper, curParse, ua), run(curParse, ua).ok, fields)
      counts[result.verdict]++
      checked++
      for (const tag of result.tags) moved.set(tag, (moved.get(tag) || 0) + 1)
      if (result.verdict === 'FAIL' && !example) example = { ua, moved: result.moved }
    }
  }
  if (counts.FAIL) tamperFailed = true
  const summary = Object.keys(counts).filter((k) => counts[k]).map((k) => k + ' ' + counts[k]).join(', ')
  console.log(`${counts.FAIL ? 'FAIL' : 'ok  '} ${tamper.name.padEnd(56)} ${summary}${moved.size ? '  [' + [...moved.keys()].join('; ') + ']' : ''}`)
  if (example) console.log('     e.g.', JSON.stringify(example.ua), example.moved.join(' | '))
}
console.log(`ua-diff, tampered: ${TAMPERS.length} tampers x ${samples.length} inputs x 2 (tsc and terser output) = ${checked} comparisons${tamperFailed ? ', with failures' : ', no reading worse than the reference'}`)
if (tamperFailed) process.exit(1)
