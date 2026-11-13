import { Raw, safe } from './guard.js'

/** The browser is untrusted input: any property may be missing, of the wrong type, or throw when read. */
export type Win = { [key: string]: any }

export function language(w: Win): Raw {
  return safe(function () {
    const value = w.navigator.language
    return typeof value === 'string' ? value : undefined
  })
}

/** Device memory in three buckets (2, 4, 8): Chromium is changing the steps it reports, the buckets survive that. */
export function memory(w: Win): Raw {
  return safe(function () {
    const gigabytes = Number(w.navigator.deviceMemory)
    if (!(gigabytes > 0)) return undefined
    return gigabytes < 4 ? 2 : gigabytes < 8 ? 4 : 8
  })
}

/** Minutes from UTC. A hint for the lab build, never part of an id: it changes when a person travels. */
export function tzOffset(): Raw {
  return safe(function () {
    return new Date().getTimezoneOffset()
  })
}

/** Two sides as "longer x shorter". CSSOM View does not say whether width and height swap when a device turns, so the order comes from the sizes alone. */
function sides(a: unknown, b: unknown): string | undefined {
  const one = Number(a)
  const two = Number(b)
  // both above zero and finite: an infinite side minus itself is NaN
  if (!(one > 0 && two > 0 && one - one + (two - two) === 0)) return undefined
  return one < two ? two + 'x' + one : one + 'x' + two
}

/** A media feature's value. An engine that does not know the feature reads as the default, so learning it later changes nothing. */
function media(w: Win, feature: string, values: string[], fallback: string): Raw {
  return safe(function () {
    if (typeof w.matchMedia !== 'function') return fallback
    for (let i = 0; i < values.length; i++) {
      if (w.matchMedia('(' + feature + ': ' + values[i] + ')').matches) return values[i]
    }
    return fallback
  })
}

function positive(value: unknown): number | undefined {
  const n = Number(value)
  return n > 0 ? n : undefined
}

/** Screen size in CSS pixels, the longer side first, so holding the device either way gives one value. */
export function screenSize(w: Win): Raw {
  return safe(function () { return sides(w.screen.width, w.screen.height) })
}

export function cores(w: Win): Raw {
  return safe(function () { return positive(w.navigator.hardwareConcurrency) })
}

// each entry returns the value or undefined; the loop below wraps every call, so one bad read cannot touch the others
const SYNC: Array<[string, (w: Win) => unknown]> = [
  ['x.langs', function (w) { return Array.isArray(w.navigator.languages) ? w.navigator.languages.join(',') : undefined }],
  ['x.touch', function (w) { const n = Number(w.navigator.maxTouchPoints); return n >= 0 ? n : undefined }],
  ['x.dpr', function (w) { const n = positive(w.devicePixelRatio); return n && Math.round(n * 100) / 100 }],
  ['x.avail', function (w) { return sides(w.screen.availWidth, w.screen.availHeight) }],
  ['x.depth', function (w) { return positive(w.screen.colorDepth) }],
  ['x.plat', function (w) { return w.navigator.platform }],
  ['x.cookie', function (w) { return w.navigator.cookieEnabled }],
  ['x.mem', function (w) { return positive(w.navigator.deviceMemory) }],
]

// [key, media feature, values to try in order, value when none matches]
const MEDIA: Array<[string, string, string[], string]> = [
  ['x.gamut', 'color-gamut', ['rec2020', 'p3', 'srgb'], 'srgb'],
  ['x.hdr', 'dynamic-range', ['high'], 'standard'],
  ['x.contrast', 'prefers-contrast', ['more', 'less', 'custom'], 'no-preference'],
  ['x.forced', 'forced-colors', ['active'], 'none'],
  ['x.inverted', 'inverted-colors', ['inverted'], 'none'],
  ['x.motion', 'prefers-reduced-motion', ['reduce'], 'no-preference'],
  ['x.transp', 'prefers-reduced-transparency', ['reduce'], 'no-preference'],
  ['x.scheme', 'prefers-color-scheme', ['dark'], 'light'],
]

/** Every candidate that is a plain property or media-query read. Only the lab build runs them all. */
export function syncReads(w: Win): { [key: string]: Raw } {
  const out: { [key: string]: Raw } = { 'x.scr': screenSize(w), 'x.cores': cores(w), 'x.tzo': tzOffset() }
  for (let i = 0; i < SYNC.length; i++) {
    out[SYNC[i][0]] = safe(function () { return SYNC[i][1](w) })
  }
  for (let i = 0; i < MEDIA.length; i++) out[MEDIA[i][0]] = media(w, MEDIA[i][1], MEDIA[i][2], MEDIA[i][3])
  return out
}

// Each name is set by the tool's own source; docs/DECISIONS.md gives the file for each, and which of them the tool puts on document
const DRIVER_GLOBALS = [
  // PhantomJS, on every frame of a page it loads
  'callPhantom', '_phantom',
  // Nightmare's preload script
  '__nightmare',
  // the Firefox add-on of Selenium IDE, while it records
  '_Selenium_IDE_Recorder',
  // Selenium's Firefox and Internet Explorer drivers
  '__webdriver_evaluate', '__webdriver_script_fn',
  // Chromium started with --dom-automation
  'domAutomationController',
  // ChromeDriver up to version 126
  '$chrome_asyncScriptInfo',
]

function platformMismatch(os: string, platform: unknown): boolean {
  if (typeof platform !== 'string' || !platform) return false
  if (os === 'android') return !/Linux|Android|arm|aarch/i.test(platform)
  if (os === 'ios') return !/iPhone|iPad|iPod|MacIntel/.test(platform)
  if (os === 'windows') return !/Win/.test(platform)
  if (os === 'mac') return !/Mac/.test(platform)
  return false
}

/** Marks left by automation tools. Reported, never hashed. Rules that misfire inside Android in-app browsers are left out on purpose. */
export function automation(w: Win, ua: { os: string }, env?: { engine: string; android: boolean }): string[] {
  const marks: string[] = []
  const check = function (mark: string, test: () => boolean): void {
    try {
      if (test()) marks.push(mark)
    } catch (e) {
      // an unreadable property is not evidence of automation
    }
  }
  check('webdriver', function () { return w.navigator.webdriver === true })
  check('global', function () {
    for (let i = 0; i < DRIVER_GLOBALS.length; i++) if (DRIVER_GLOBALS[i] in w) return true
    return false
  })
  check('no-languages', function () { return Array.isArray(w.navigator.languages) && w.navigator.languages.length === 0 })
  // desktop application shells are left out: they have a window and a person in front of it
  check('headless', function () { return /HeadlessChrome|PhantomJS|SlimerJS/i.test(w.navigator.userAgent) })
  check('platform', function () { return platformMismatch(ua.os, w.navigator.platform) })
  check('no-touch', function () { return (ua.os === 'android' || ua.os === 'ios') && w.navigator.maxTouchPoints === 0 })
  // a user agent replaced through the debugging protocol leaves the client-hint brands empty; a real Chromium never does
  check('no-brands', function () { return Array.isArray(w.navigator.userAgentData.brands) && w.navigator.userAgentData.brands.length === 0 })
  check('not-android', function () { return ua.os === 'android' && !!env && env.engine === 'blink' && !env.android })
  return marks
}
