// Lab build only: every automation mark candidate, recorded as a hint under x.bot.* so test pages and lab/marks.mjs collect evidence.
// None is hashed, none enters an id or flags.auto, and none ships in 1.0 (docs/DECISIONS.md, "Automation marks: none added in 1.0").
import { NA, Raw } from './guard.js'
import { appVersion, descriptorOf, frameSrcdoc, frameWindow, noWebdriver, Observe, ownValue, plainGetter } from './marks.js'
import { Parts } from './reading.js'
import { Win } from './reads.js'

// [Chrome version, a CSS condition Blink accepts from that version on] (MDN compatibility data), newest last
const ANCHORS: Array<[number, string]> = [
  [88, '(aspect-ratio:1)'],
  [105, 'selector(:has(a))'],
  [114, '(text-wrap:balance)'],
  [123, '(field-sizing:content)'],
  [129, '(interpolate-size:allow-keywords)'],
  [133, '(text-box:normal)'],
  [137, '(reading-flow:normal)'],
  [140, '(scroll-target-group:auto)'],
]

/** Object.getPrototypeOf while it answers as ECMA-262 defines it. */
function prototypeOf(): (o: unknown) => unknown {
  const get = Object.getPrototypeOf
  if (get([]) !== Array.prototype) throw 0
  return get
}

/** Every candidate, in the order the lab records it. A name is never reused with another meaning. */
const CANDIDATES: Array<[string, Observe]> = [
  // src/marks.ts has these observations and the reason each is held back
  ['own-value', ownValue],
  ['frame-window', frameWindow],
  ['frame-srcdoc', frameSrcdoc],
  ['no-webdriver', noWebdriver],
  ['app-version', appVersion],
  ['plain-getter', plainGetter],
  // HTML, PDF viewing support: navigator.plugins is a PluginArray of fixed Plugin objects, or empty. The first read of the
  // list costs milliseconds at script start in headed Blink, and a plug-in emulator people run makes this state when the native list is empty
  ['plugins-type', function (w) {
    const proto = prototypeOf()
    const PluginArray = w.PluginArray
    if (typeof PluginArray !== 'function') return undefined
    const list = w.navigator.plugins
    if (proto(list) !== PluginArray.prototype) return true
    if (!(list.length > 0)) return false
    return proto(list[0]) !== w.Plugin.prototype
  }],
  // the Chrome major in the user agent against the features the engine has, two versions of slack either way: forks, flags and WebViews are unmeasured
  ['ua-version', function (w) {
    const found = /Chrome\/(\d+)/.exec(w.navigator.userAgent)
    if (!found || w.CSS.supports('(:)')) return undefined
    const major = +found[1]
    for (let i = 0; i < ANCHORS.length; i++) {
      const has = w.CSS.supports(ANCHORS[i][1]) === true
      if (has ? ANCHORS[i][0] > major + 2 : ANCHORS[i][0] < major - 2) return true
    }
    return false
  }],
  // an empty client-hint platform; redundant with the core's no-brands until readings show otherwise
  ['no-platform-hint', function (w) {
    const data = w.navigator.userAgentData
    return data ? data.platform === '' : undefined
  }],
  // chrome.runtime functions with an own prototype, which built-in bindings would not have; with no sendMessage there is nothing to look at
  ['runtime-constructible', function (w) {
    const runtime = w.chrome && w.chrome.runtime
    if (!runtime || typeof runtime.sendMessage !== 'function') return undefined
    return descriptorOf()(runtime.sendMessage, 'prototype') !== undefined
  }],
]

/** The answer: a boolean, or "!na" when the check could not be made here. */
function raw(observe: Observe, w: Win): Raw {
  try {
    const answer = observe(w)
    return typeof answer === 'boolean' ? answer : NA
  } catch (e) {
    // a missing API and a throwing one are the same: no evidence. Neither is a failed read of the reading, so neither enters flags.partial
    return NA
  }
}

/** The lab keys, in order. */
export const BOT_KEYS: string[] = []
for (let i = 0; i < CANDIDATES.length; i++) BOT_KEYS[BOT_KEYS.length] = 'x.bot.' + CANDIDATES[i][0]

/** Every candidate's observation, with no gate: true, false, or "!na" when it could not be looked for. */
export function botMarks(w: Win): Parts {
  const out: Parts = {}
  for (let i = 0; i < CANDIDATES.length; i++) out['x.bot.' + CANDIDATES[i][0]] = raw(CANDIDATES[i][1], w)
  return out
}
