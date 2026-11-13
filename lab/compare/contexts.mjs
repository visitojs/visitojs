// The browser contexts the comparison runs each library in: one base context per profile and one per condition.
// Every context goes through the same user-agent override, the base with the browser's own string, so that a condition
// differs from its base only in the field under test. Where the browser has client hints (Chromium), each context also
// carries the hints that match its user agent, emulated the same way on both sides. Pure functions, tested without a browser.
//
// A condition is applied in the same context as a base visit wherever the browser allows it ('same'), so that it is
// compared with a visit in that context; otherwise it gets a new context ('new') and the table says what a new context
// alone does to each id. Measured with Playwright 1.63.0 on Windows (Chromium 153, Firefox 155, WebKit 26.6):
// page.setViewportSize sets the screen to the new viewport in all three, which is a rotation exactly when screen and
// viewport were equal; keeping the screen while the viewport changes, and changing the user agent, needs a per-tab
// override, which only Chromium has (CDP Emulation.setDeviceMetricsOverride and Emulation.setUserAgentOverride).
import { bumpVersion } from './judge.mjs'

const CHROME = /Chrome\/(\d+)((?:\.\d+)*)/

function chromeVersion(ua) {
  const match = CHROME.exec(ua)
  return match ? { major: match[1], full: match[1] + match[2] } : null
}

/** What an Android user agent says about the device: { platformVersion, model, fullVersion }, or null. */
function androidDevice(ua) {
  const android = /Android (\d+(?:\.\d+)*)/.exec(ua)
  if (!android) return null
  const model = /; ([^;)]+?) Build\//.exec(ua)
  const chrome = chromeVersion(ua)
  return { platformVersion: android[1], model: model ? model[1] : '', fullVersion: chrome ? chrome.full : '' }
}

/**
 * The client hints for a user agent, built from the browser's own hints (own, read under its own user agent ownUa).
 * Brand versions follow the Chrome/ token of ua, the grease brand stays as the browser reports it, and an Android
 * user agent brings its platform, platform version, model and the mobile flag. device ({ platformVersion, model,
 * fullVersion }) gives what a reduced user agent no longer says, as the browser still reports it in its hints.
 * Null where the browser has no client hints.
 */
export function hintsFor(own, ownUa, ua, device) {
  if (!own) return null
  const from = chromeVersion(ownUa)
  const to = device && device.fullVersion ? chromeVersion('Chrome/' + device.fullVersion) : chromeVersion(ua)
  const hints = JSON.parse(JSON.stringify(own))
  if (from && to) {
    hints.brands = own.brands.map((b) => (b.version === from.major ? { brand: b.brand, version: to.major } : b))
    hints.fullVersionList = own.fullVersionList.map((b) => (b.version === from.full ? { brand: b.brand, version: to.full } : b))
  }
  const full = (to || from)
  hints.fullVersion = full ? full.full : ''
  const android = androidDevice(ua)
  if (android) {
    hints.platform = 'Android'
    hints.platformVersion = device ? device.platformVersion : android.platformVersion
    hints.model = device ? device.model : android.model
    hints.mobile = true
    hints.architecture = ''
    hints.bitness = ''
    hints.wow64 = false
    hints.formFactors = ['Mobile']
  }
  return hints
}

/**
 * The user agent Chrome on Android sends when it hides the device: Android 10, the model replaced by "K", and only the
 * major version, the shape src/ua.ts parses as reduced (see its cases in test/ua.test.mjs). Tokens other than Chrome's
 * go, as a plain Chrome tab has none.
 */
export function reducedUserAgent(ua) {
  const chrome = chromeVersion(ua)
  if (!chrome || !/Android/.test(ua)) throw new Error(`not a Chrome on Android user agent: "${ua}"`)
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome.major}.0.0.0 Mobile Safari/537.36`
}

const scaled = (size, factor) => ({ width: Math.round(size.width * factor), height: Math.round(size.height * factor) })
const swapped = (size) => ({ width: size.height, height: size.width })
const sameSize = (a, b) => a.width === b.width && a.height === b.height

/**
 * The base context of a profile and one context per condition, each as { options, hints, in, via }: options and hints
 * are the state the visit is made in; in is 'same' when the condition is applied to a context after a base visit there
 * (via names how), 'new' when the visit gets a context of its own.
 * options: the profile's Playwright context options; userAgent: the string the profile sends (the browser's own on desktop);
 * screen: the screen size the base context reports; rotation: whether the profile has a rotation check; hints(ua, device):
 * client hints or null; perTab: whether the browser can override the user agent and the screen of one tab (Chromium);
 * reduced: whether the profile also has a context with the reduced form of its user agent (Chrome on Android only).
 */
export function conditionContexts({ options, userAgent, screen, rotation, hints, perTab = false, reduced = false }) {
  const viewport = options.viewport || { width: 1280, height: 720 }
  const make = (changes, ua = userAgent, device) => ({ options: { ...options, viewport, screen, userAgent: ua, ...changes }, hints: hints(ua, device) })
  const where = (ctx, same, via) => ({ ...ctx, in: same ? 'same' : 'new', via: same ? via : null })
  const bumped = bumpVersion(userAgent)
  return {
    base: make({}),
    second: where(make({}), false),
    uaBump: where(make({}, bumped), perTab, 'user-agent override'),
    rotation: rotation ? where(make({ viewport: swapped(viewport), screen: swapped(screen) }), sameSize(viewport, screen), 'viewport size') : null,
    viewport: where(make({ viewport: scaled(viewport, 0.8) }), perTab, 'device metrics'),
    reduced: reduced ? make({}, reducedUserAgent(userAgent), androidDevice(userAgent)) : null,
  }
}
