// A minimal stand-in for a browser window, enough for the reads that need no real rendering.
export const UA = {
  facebookAndroid:
    'Mozilla/5.0 (Linux; Android 12; SM-X135FU Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.8078.50 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/585.0.0.47.54;IABMV/1;]',
  facebookAndroidUpdated:
    'Mozilla/5.0 (Linux; Android 12; SM-X135FU Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/157.0.8100.3 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/586.0.0.1.1;IABMV/1;]',
  chromeAndroidReduced: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
}

export function cookieJar(initial = {}, { blocked = false } = {}) {
  const values = { ...initial }
  return {
    values,
    get cookie() {
      return Object.entries(values).map(([k, v]) => `${k}=${v}`).join('; ')
    },
    set cookie(text) {
      if (blocked) return
      const pair = text.split(';')[0]
      const at = pair.indexOf('=')
      values[pair.slice(0, at)] = pair.slice(at + 1)
    },
  }
}

export function storageArea(initial = {}) {
  const values = { ...initial }
  return {
    values,
    get length() {
      return Object.keys(values).length
    },
    getItem: (k) => (k in values ? values[k] : null),
    setItem: (k, v) => void (values[k] = String(v)),
  }
}

// The feature tests of the engine-detection specification (research/specs/engine-detection.md), grouped as it groups them.
const F = {
  blink: ['InputDeviceCapabilities', 'BeforeInstallPromptEvent', 'performance.memory', 'ShadowRoot.prototype.getSelection', '(-webkit-app-region:drag)'],
  webkit: ['GestureEvent', 'HTMLMediaElement.prototype.getStartDate', 'SVGFEGaussianBlurElement.prototype.edgeMode', '(-webkit-nbsp-mode:space)', '(-webkit-hyphenate-limit-after:auto)'],
  gecko: ['scrollMaxX', 'Event.prototype.explicitOriginalTarget', 'getDefaultComputedStyle', 'HTMLCanvasElement.prototype.mozPrintCallback', 'TimeEvent'],
  mobile: ['onorientationchange', 'HTMLInputElement.prototype.capture'],
  desktop: ['navigator.registerProtocolHandler', 'HTMLMediaElement.prototype.setSinkId'],
  safari17: ['RegExp.prototype.unicodeSets', 'CSSContainerRule.prototype.containerName', '(contain-intrinsic-size:1px)', '(hyphens:auto)', 'URL.canParse'],
  // the third Firefox 143 test is a removal: CompositionEvent without its locale
  firefox143: ['selector(::details-content)', 'selector(::before::marker)', 'CompositionEvent.prototype'],
  firefoxBefore143: ['CompositionEvent.prototype.locale'],
  brave: ['navigator.brave.isBrave'],
}
export const FEATURES = F

// Browsers as the feature tests see them. The current ones are what Playwright 1.63.0's Chromium 153, Firefox 155 and WebKit 26.6 (Windows) passed on 2026-11-12.
const chromium = [...F.blink, ...F.safari17, ...F.firefox143]
const firefox = [...F.gecko, ...F.safari17, ...F.firefox143]
export const BROWSERS = {
  // secure page: both desktop features; on an http: page registerProtocolHandler is missing and the page says it is not secure
  chromeDesktop: [...chromium, ...F.desktop],
  chromeDesktopHttp: [...chromium, 'HTMLMediaElement.prototype.setSinkId', 'insecure'],
  chromeAndroid: [...chromium, ...F.mobile],
  chromeAndroidHttp: [...chromium, ...F.mobile, 'insecure'],
  // Chromium's mobile emulation adds onorientationchange to a desktop build, not capture
  emulatedAndroid: [...chromium, ...F.desktop, 'onorientationchange'],
  emulatedAndroidHttp: [...chromium, 'HTMLMediaElement.prototype.setSinkId', 'onorientationchange', 'insecure'],
  braveDesktop: [...chromium, ...F.desktop, ...F.brave],
  braveAndroid: [...chromium, ...F.mobile, ...F.brave],
  safari16: [...F.webkit],
  safari17: [...F.webkit, ...F.safari17],
  // the Windows WebKit build also has onorientationchange and ::details-content, and no CompositionEvent.locale
  webkitWindows: [...F.webkit, ...F.safari17, 'onorientationchange', 'selector(::details-content)', 'CompositionEvent.prototype'],
  // Firefox has setSinkId from 116 and registerProtocolHandler from 2 (compat data)
  firefox142: [...F.gecko, ...F.firefoxBefore143, ...F.desktop],
  firefoxDesktop: [...firefox, ...F.desktop],
  firefoxDesktopHttp: [...firefox, 'insecure'],
  // Firefox for Android has registerProtocolHandler too (compat data: from 4)
  firefoxAndroid: [...firefox, ...F.mobile, 'navigator.registerProtocolHandler'],
  edgeHtml: ['CompositionEvent.prototype.locale'],
}

/** Gives a fake window the named features: dotted paths become properties, conditions with a parenthesis become true from CSS.supports, and "insecure" makes it an http: page. */
export function dress(w, features) {
  const conditions = []
  for (const feature of features) {
    if (feature === 'insecure') {
      w.isSecureContext = false
      continue
    }
    if (feature.includes('(')) {
      conditions.push(feature)
      continue
    }
    const names = feature.split('.')
    // performance is the real global in a fake window: give this window its own before adding to it
    if (names[0] === 'performance' && w.performance === globalThis.performance) w.performance = { now: () => globalThis.performance.now() }
    let holder = w
    for (let i = 0; i < names.length - 1; i++) {
      if (holder[names[i]] == null) holder[names[i]] = /^[A-Z]/.test(names[i]) ? function () {} : {}
      holder = holder[names[i]]
    }
    const last = names[names.length - 1]
    if (!(last in holder)) holder[last] = /^[A-Z]/.test(last) ? function () {} : null
  }
  if (conditions.length) {
    const before = w.CSS && w.CSS.supports
    w.CSS = { supports: (text) => conditions.includes(text) || (typeof before === 'function' && before(text) === true) }
  }
  return w
}

export function fakeWindow({
  ua = UA.facebookAndroid,
  language = 'fr-FR',
  timeZone = 'Europe/Paris',
  deviceMemory = 4,
  document = cookieJar(),
  localStorage = storageArea(),
  extra = {},
} = {}) {
  return {
    navigator: { userAgent: ua, language, deviceMemory, languages: [language], hardwareConcurrency: 8, maxTouchPoints: 5, platform: 'Linux armv81', cookieEnabled: true, webdriver: false },
    screen: { width: 393, height: 873, availWidth: 393, availHeight: 849, colorDepth: 24 },
    devicePixelRatio: 2.75,
    matchMedia: () => ({ matches: false }),
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone }) }) },
    document,
    localStorage,
    location: { protocol: 'https:' },
    crypto: globalThis.crypto,
    performance: globalThis.performance,
    ...extra,
  }
}

// A synthetic desktop Chrome user agent, and the appVersion the HTML standard derives from it (the user agent after "Mozilla/").
export const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'

/** An interface object that, like a Web IDL one, cannot be called to make an instance. */
const iface = (name) => ({ [name]: function () { throw new TypeError('Illegal constructor') } })[name]

/** Read-only attributes laid out as Web IDL lays them out: getters on the prototype. An arrow function has no own prototype property, like a built-in getter. */
const attributes = (proto, values) => {
  for (const name of Object.keys(values)) Object.defineProperty(proto, name, { configurable: true, enumerable: true, get: () => values[name] })
}

/**
 * A desktop Blink window whose Navigator, Screen, PluginArray, Plugin and HTMLIFrameElement are prototype-shaped, so a test can
 * tell an own property from an inherited one, and a built-in getter from a replaced one. The iframe it makes is detached: no window.
 * `supports` lists the CSS conditions CSS.supports accepts, or decides them; by default every condition but the never-valid "(:)",
 * as a current Blink answers the anchors the marks use.
 */
export function protoWindow({ ua = DESKTOP_UA, supports = (text) => text !== '(:)', plugins = 5 } = {}) {
  const accepts = typeof supports === 'function' ? supports : (text) => supports.includes(text)
  const Navigator = iface('Navigator')
  const Screen = iface('Screen')
  const PluginArray = iface('PluginArray')
  const Plugin = iface('Plugin')
  const HTMLIFrameElement = iface('HTMLIFrameElement')
  const list = Object.create(PluginArray.prototype)
  for (let i = 0; i < plugins; i++) list[i] = Object.create(Plugin.prototype)
  attributes(PluginArray.prototype, { length: plugins })
  attributes(Navigator.prototype, {
    userAgent: ua,
    appVersion: ua.startsWith('Mozilla/') ? ua.slice(8) : ua,
    platform: 'Win32',
    language: 'en-US',
    languages: ['en-US'],
    webdriver: false,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 0,
    plugins: list,
    vendor: 'Google Inc.',
  })
  attributes(Screen.prototype, { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24 })
  attributes(HTMLIFrameElement.prototype, { contentWindow: null })
  Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', { configurable: true, get() { return '' }, set() {} })
  return {
    Navigator,
    Screen,
    PluginArray,
    Plugin,
    HTMLIFrameElement,
    navigator: Object.create(Navigator.prototype),
    screen: Object.create(Screen.prototype),
    document: { createElement: (tag) => (String(tag).toLowerCase() === 'iframe' ? Object.create(HTMLIFrameElement.prototype) : {}) },
    CSS: { supports: (text) => accepts(text) },
  }
}
