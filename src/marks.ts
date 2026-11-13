// Automation mark candidates, read by the lab build only (src/botlab.ts): none ships in 1.0 (docs/DECISIONS.md). Written from the
// specifications named on each one: WHATWG HTML, Web IDL, ECMA-262, W3C WebDriver.
// An observation reads descriptors, prototypes and the values of two attributes. It never calls a getter it found, writes nothing,
// and never touches what a page's own libraries commonly wrap: Function.prototype.toString, timers, fetch, XHR, events, Promise, console.
import { Win } from './reads.js'

/** True: the state was observed. False: looked for and not there. Anything else, or a throw: it could not be looked for here. */
export type Observe = (w: Win) => boolean | undefined

// Navigator and Screen attributes whose values a reading uses (plain-getter). None is [LegacyUnforgeable] in HTML or CSSOM View, so each is a getter on the prototype
const NAVIGATOR = ['userAgent', 'appVersion', 'platform', 'language', 'languages', 'webdriver', 'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'plugins', 'vendor']
// the ones own-value looks at: not plugins, which a plug-in emulator people run defines on navigator itself, nor the user agent, app
// version and platform, which user-agent switchers define there. Language switchers, full-profile switchers (vendor) and hardware or
// screen spoofers define the rest there too, which is why own-value does not ship (measured with lab/marks/extensions)
const OWN = ['language', 'languages', 'webdriver', 'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'vendor']
const SCREEN = ['width', 'height', 'availWidth', 'availHeight', 'colorDepth']

/** Object.getOwnPropertyDescriptor while it answers as ECMA-262 defines it: a wrapper that returns the real answer is fine, a broken one gives no evidence. */
export function descriptorOf(): (o: unknown, name: string) => PropertyDescriptor | undefined {
  const get = Object.getOwnPropertyDescriptor
  // reading .value of a missing answer throws too: either way the observation is empty
  if ((get({ a: 1 }, 'a') as PropertyDescriptor).value !== 1 || get({}, 'a') !== undefined) throw 0
  return get
}

/** Does any of the names hold for `test`? Each name is looked at on its own; a missing one says nothing. */
function some(names: string[], test: (name: string) => boolean): boolean {
  for (let i = 0; i < names.length; i++) if (test(names[i])) return true
  return false
}

/** One CSS condition, counted only where the never-valid declaration "(:)" is refused: a stub that accepts everything is no evidence. */
export function supports(w: Win, condition: string): boolean {
  return w.CSS.supports(condition) === true && !w.CSS.supports('(:)')
}

// A switcher that replaces the user agent alone produces it. HTML, NavigatorID: in the Chrome and WebKit compatibility modes appVersion is the user agent after "Mozilla/", for any user agent
// that starts "Mozilla/5.0 (". A user agent replaced by the engine changes both; a script that replaced one of the two leaves them apart
export const appVersion: Observe = function (w) {
  const ua = w.navigator.userAgent
  const app = w.navigator.appVersion
  if (typeof ua !== 'string' || typeof app !== 'string' || ua.indexOf('Mozilla/5.0 (') !== 0) return undefined
  return 'Mozilla/' + app !== ua
}

// Web IDL, "Attributes": a regular attribute is an accessor on the interface prototype object, so navigator and screen have no own
// property of these names. One defined on the instance was planted there by a script
export const ownValue: Observe = function (w) {
  const own = descriptorOf()
  const nav = w.navigator
  const scr = w.screen
  return some(OWN, function (n) { return own(nav, n) !== undefined }) || some(SCREEN, function (n) { return own(scr, n) !== undefined })
}

// Privacy extensions and switchers replace getters with ordinary functions. Web IDL: an attribute getter is a built-in function object; ECMA-262: a built-in that is not a constructor has no own "prototype".
// An ordinary function expression has one. A data property in the getter's place is no attribute at all
export const plainGetter: Observe = function (w) {
  const own = descriptorOf()
  const replaced = function (proto: unknown) {
    return function (n: string) {
      const d = own(proto, n)
      if (!d) return false
      if ('value' in d) return true
      return typeof d.get === 'function' && own(d.get, 'prototype') !== undefined
    }
  }
  return some(NAVIGATOR, replaced(w.Navigator.prototype)) || some(SCREEN, replaced(w.Screen.prototype))
}

// HTML, the iframe element: it gets a content navigable only once inserted into a document, so a fresh one has no window, and Web IDL
// puts contentWindow on the prototype. The element is never inserted and nothing is written to it: no navigation, no Trusted Types sink.
// It was written to look after a write to srcdoc; without that write it no longer observes the state it was written for
export const frameWindow: Observe = function (w) {
  const own = descriptorOf()
  const frame = w.document.createElement('iframe')
  if (!('contentWindow' in frame)) return undefined
  return frame.contentWindow != null || own(frame, 'contentWindow') !== undefined
}

// Web IDL puts srcdoc on HTMLIFrameElement.prototype too, so a fresh element has no own srcdoc. Only its descriptor is read: the
// attribute is a Trusted Types sink, and this neither reads nor writes it. Evidence gathering for frame-window, never a mark on its own
export const frameSrcdoc: Observe = function (w) {
  const own = descriptorOf()
  const frame = w.document.createElement('iframe')
  if (!('srcdoc' in frame)) return undefined
  return own(frame, 'srcdoc') !== undefined
}

// W3C WebDriver, NavigatorAutomationInformation: navigator.webdriver is defined, false when not automated. Chromium defines it
// unconditionally from version 89 (its platform status); accent-color, from Blink 93 (MDN compatibility data), shows the engine is past that
export const noWebdriver: Observe = function (w) {
  if (!supports(w, '(accent-color:red)')) return undefined
  return !('webdriver' in w.navigator)
}
