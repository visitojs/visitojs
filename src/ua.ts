export interface UaInfo {
  /** Phone model as the browser reports it ("SM-A135F", "iPhone14,5"), or null. */
  model: string | null
  os: string
  /** Major, or major.minor, as reported; null when the user agent is known not to tell the truth. */
  osVer: string | null
  /** App or browser family. A label only: it names the environment and never carries a version. */
  app: string
  appVer: string | null
  /** Chrome or Firefox major version; null on WebKit, where the token is frozen. */
  engineVer: number | null
  /** The Android user agent says "K" and no model was found elsewhere: client hints must supply it. */
  reduced: boolean
}

const MAX_LENGTH = 1024

const APPS: Array<string | RegExp> = [
  'threads', /\bBarcelona\b/, /Barcelona ([\d.]+)/,
  'instagram', /\bInstagram\b/, /Instagram ([\d.]+)/,
  'messenger', /FBAN\/Messenger|FB_IAB\/Orca|FB_IAB\/MESSENGER|MessengerLite/, /FBAV\/([\d.]+)/,
  'facebook', /\bFB(?:AN|AV|_IAB)\//, /FBAV\/([\d.]+)/,
  'tiktok', /musical_ly|TikTok|Bytedance|trill_/i, /(?:app_version\/|musical_ly_)(\d+\.[\d.]+)/,
  'snapchat', /Snapchat/, /Snapchat\/([\d.]+)/,
  'whatsapp', /WhatsApp/, /WhatsApp\/([\d.]+)/,
  'samsung', /SamsungBrowser\//, /SamsungBrowser\/([\d.]+)/,
  'edge', /\bEdg(?:e|A|iOS)?\//, /\bEdg(?:e|A|iOS)?\/([\d.]+)/,
  'opera', /\bOP(?:R|T|iOS)\//, /\bOP(?:R|T|iOS)\/([\d.]+)/,
  'firefox', /Firefox\/|FxiOS\//, /(?:Firefox|FxiOS)\/([\d.]+)/,
  'chrome', /CriOS\//, /CriOS\/([\d.]+)/,
  'webview', /; wv\)/, /Chrome\/([\d.]+)/,
  'chrome', /Chrome\//, /Chrome\/([\d.]+)/,
]

/** The text between the parentheses that hold "Android", found without a backtracking pattern. */
function androidSection(ua: string): string {
  const at = ua.indexOf('Android')
  const open = ua.lastIndexOf('(', at)
  const close = ua.indexOf(')', at)
  return ua.substring(open < 0 ? at : open + 1, close < 0 ? at + 200 : close)
}

/** Splits a user agent into identity (model, OS, app family) and versions, so an update moves only the versions. */
export function parseUa(input: unknown): UaInfo {
  const ua = typeof input === 'string' ? input.slice(0, MAX_LENGTH) : ''
  let os = 'other'
  let model: string | null = null
  let osVer: string | null = null
  let app = 'other'
  let appVer: string | null = null
  let engineVer: number | null = null
  let sawK = false
  let v: RegExpExecArray | null = null

  if (/iPhone|iPad|iPod/.test(ua)) {
    os = 'ios'
    v = /\b(iP(?:hone|ad|od)\d+,\d+)/.exec(ua)
    if (v) model = v[1]
    // Safari 26 and newer freeze the OS token at 18_6 or 18_7: an app's own field, then Version/, holds the real one
    v = /FBSV\/(\d+)\.(\d+)/.exec(ua) || /; iOS (\d+)_(\d+)/.exec(ua) || /Version\/(2[6-9]|[3-9]\d)\.(\d+)/.exec(ua) || /OS (\d+)[_.](\d+)/.exec(ua)
  } else if (/Android/.test(ua)) {
    os = 'android'
    const parts = androidSection(ua).split(';')
    let afterVersion = false
    let harmony = false
    for (let i = 0; i < parts.length; i++) {
      // two calls, as 0.1.0 makes them: the tail goes with a pattern that has no g flag, so a page that breaks the flag
      // cannot leave "Build/..." in the model; String.prototype.trim would be a new built-in a page can break
      const token = parts[i].replace(/\s+Build\/.*$/, '').replace(/^\s+|\s+$/g, '')
      if (!afterVersion) {
        // indexOf, as 0.1.0 tests it, so a page that breaks indexOf gets the reading it got before
        afterVersion = token.indexOf('Android') === 0
        continue
      }
      if (token === 'K') {
        sawK = true
        continue
      }
      // HarmonyOS: the system's name, which Huawei's browser writes among these tokens, before the model
      if (token === 'HarmonyOS') {
        harmony = true
        continue
      }
      // Huawei's services and their version in the model's place: an update would move the model, so there is none
      if (harmony && /^HMSCore/.test(token)) break
      if (!token || /^(?:wv|U|Mobile|Tablet|rv:.*|[a-z]{2}[-_][a-z]{2})$/i.test(token)) continue
      model = token
      break
    }
    // Instagram appends "Android (sdk/release; dpi; size; maker; model; ...": the model survives a reduced main part
    const suffix = /Android \(\d+\/([\d.]+);[^;]*;[^;]*;[^;]*;\s*([^;)]+)/.exec(ua)
    if (!model && suffix) model = suffix[2].replace(/\s+$/, '')
    if (!sawK) {
      v = /Android (\d+)(?:\.(\d+))?/.exec(ua)
    } else if (suffix) {
      osVer = suffix[1]
    }
  } else if (/Windows NT/.test(ua)) {
    os = 'windows'
    v = /Windows NT ([\d.]+)/.exec(ua)
  } else if (/Macintosh|Mac OS X/.test(ua)) {
    os = 'mac'
    v = /Mac OS X (\d+)[_.](\d+)/.exec(ua)
  } else if (/Linux|X11/.test(ua)) {
    os = 'linux'
  }
  if (v) osVer = v[1] + (v[2] ? '.' + v[2] : '')

  for (let i = 0; i < APPS.length; i += 3) {
    if ((APPS[i + 1] as RegExp).test(ua)) {
      app = APPS[i] as string
      v = (APPS[i + 2] as RegExp).exec(ua)
      if (v) appVer = v[1]
      break
    }
  }
  if (app === 'other') {
    if ((os === 'ios' || os === 'mac') && /Safari\//.test(ua) && /Version\//.test(ua)) {
      app = 'safari'
      v = /Version\/([\d.]+)/.exec(ua)
      if (v) appVer = v[1]
    } else if (os === 'ios' && /AppleWebKit/.test(ua)) {
      app = 'webview'
    }
  }

  if (os !== 'ios') {
    v = /Chrome\/(\d+)/.exec(ua) || /Firefox\/(\d+)/.exec(ua)
    if (v) engineVer = +v[1]
  }
  return { model: model, os: os, osVer: osVer, app: app, appVer: appVer, engineVer: engineVer, reduced: sawK && !model }
}
