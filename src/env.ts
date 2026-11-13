// The browser build, told from the features it has: a page or an automation tool can replace the user agent, not the engine.
import { Parts } from './reading.js'
import { Win } from './reads.js'

export interface Build {
  engine: 'blink' | 'webkit' | 'gecko' | 'other'
  /** An Android build of Blink or Gecko. */
  android: boolean
  /** WebKit at the level of Safari 17.0 or later. */
  safari17: boolean
  /** Gecko at the level of Firefox 143 or later. */
  firefox143: boolean
  brave: boolean
}

// Five features per engine, each in that engine across its whole range and in no other (MDN compatibility data): three decide, so two lost or two gained change nothing.
// No set here or in Safari 17 has more than two tests behind one object or function (CSS.supports is one), so a page that breaks one changes neither.
const BLINK = 'InputDeviceCapabilities BeforeInstallPromptEvent performance.memory ShadowRoot.prototype.getSelection (-webkit-app-region:drag)'
const WEBKIT = 'GestureEvent HTMLMediaElement.prototype.getStartDate SVGFEGaussianBlurElement.prototype.edgeMode (-webkit-nbsp-mode:space) (-webkit-hyphenate-limit-after:auto)'
const GECKO = 'scrollMaxX Event.prototype.explicitOriginalTarget getDefaultComputedStyle HTMLCanvasElement.prototype.mozPrintCallback TimeEvent'
// two features only Android builds have, then two that Android lacks and a desktop browser on a secure page has, emulating a phone or not
const MOBILE = 'onorientationchange HTMLInputElement.prototype.capture'
const HANDLER = 'navigator.registerProtocolHandler'
const SINK = 'HTMLMediaElement.prototype.setSinkId'
// each shipped in exactly Safari 17.0, and only the last is commonly polyfilled
const SAFARI17 = 'RegExp.prototype.unicodeSets CSSContainerRule.prototype.containerName (contain-intrinsic-size:1px) (hyphens:auto) URL.canParse'
// the two selectors arrived in Firefox 143 and the property left in it, all it shipped that a script can test: a page that breaks CSS.supports reads as an older Firefox
const FIREFOX143 = 'selector(::details-content) selector(::before::marker) !CompositionEvent.prototype.locale'
const BRAVE = 'navigator.brave.isBrave'

/** One test: a dotted path whose last name is looked up with `in`, so its getter never runs, or a CSS condition. A leading "!" negates it. */
function holds(w: Win, test: string): boolean {
  const negated = test.charAt(0) === '!'
  const body = negated ? test.substring(1) : test
  let found = false
  try {
    if (body.indexOf('(') < 0) {
      const names = body.split('.')
      let holder = w
      for (let i = 0; i < names.length - 1; i++) holder = holder[names[i]]
      const last = names[names.length - 1]
      // a split a page replaced can leave no name: a missing one must not be looked up as "undefined", which every window has
      found = typeof last === 'string' && last in Object(holder)
    } else {
      // a condition counts only where one that can never be valid, a declaration without a property, is refused: a stub answering true to everything is no evidence
      found = w.CSS.supports(body) === true && !w.CSS.supports('(:)')
    }
  } catch (e) {
    // a missing holder, a getter that throws or a hostile Proxy is no evidence
  }
  return negated ? !found : found
}

/** The result of each test in a space-separated list, as 1 and 0. */
function marks(w: Win, list: string): string {
  const tests = list.split(' ')
  let out = ''
  for (let i = 0; i < tests.length; i++) out += holds(w, tests[i]) ? '1' : '0'
  return out
}

function score(w: Win, list: string): number {
  return marks(w, list).split('1').length - 1
}

/** An http: page, where Chromium withholds registerProtocolHandler. */
function insecure(w: Win): boolean {
  try {
    return w.isSecureContext === false
  } catch (e) {
    return false
  }
}

/** Runs once at script start. Deterministic for a given build; never throws. */
export function detectBuild(w: Win): Build {
  try {
    const b = score(w, BLINK) > 2
    const k = score(w, WEBKIT) > 2
    const g = score(w, GECKO) > 2
    // two engines at once only happens to a tampered window: no engine, so nothing is excluded
    const engine = b ? (k || g ? 'other' : 'blink') : k ? (g ? 'other' : 'webkit') : g ? 'gecko' : 'other'
    const mobile = score(w, MOBILE)
    // setSinkId, which Android lacks, with registerProtocolHandler or on an http: page that withholds it: a desktop build emulating a phone
    const desktop = holds(w, SINK) && (holds(w, HANDLER) || insecure(w))
    return {
      engine: engine,
      // errs towards true: false on a real Android Chromium would raise a false automation mark, so both mobile features are never vetoed
      android: (engine === 'blink' || engine === 'gecko') && (mobile > 1 || (mobile > 0 && !desktop)),
      safari17: engine === 'webkit' && score(w, SAFARI17) > 2,
      firefox143: engine === 'gecko' && score(w, FIREFOX143) > 1,
      brave: holds(w, BRAVE),
    }
  } catch (e) {
    // a page that broke String.prototype.split: an answer that excludes nothing
    return { engine: 'other', android: false, safari17: false, firefox143: false, brave: false }
  }
}

/** Lab build only: every test's result, so a feature drifting in a new release shows in readings before it changes an answer. */
export function featureMarks(w: Win): Parts {
  return {
    'x.ev.blink': marks(w, BLINK),
    'x.ev.webkit': marks(w, WEBKIT),
    'x.ev.gecko': marks(w, GECKO),
    'x.ev.android': marks(w, MOBILE + ' ' + HANDLER + ' ' + SINK) + (insecure(w) ? '1' : '0'),
    'x.ev.safari17': marks(w, SAFARI17),
    'x.ev.firefox143': marks(w, FIREFOX143),
    'x.ev.brave': marks(w, BRAVE),
  }
}
