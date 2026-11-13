import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUa } from '../build/esm/ua.js'

// Synthetic user agents with the exact shapes seen on real orders; models and versions are altered.
const cases = [
  {
    name: 'Facebook on iPhone',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/24A446 Safari/604.1 [FBAN/FBIOS;FBAV/586.0.0.62.72;FBBV/1106861720;FBDV/iPhone18,2;FBMD/iPhone;FBSN/iOS;FBSV/27.0.1;FBSS/3;FBID/phone;FBLC/fr_FR;FBOP/5;FBRV/0]',
    want: { model: 'iPhone18,2', os: 'ios', osVer: '27.0', app: 'facebook', appVer: '586.0.0.62.72', engineVer: null, reduced: false },
  },
  {
    name: 'Instagram on iPhone',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22B5054e Instagram 454.1.0.41.71 (iPhone12,1; iOS 18_1; fr_FR; fr; scale=2.00; 828x1792; IABMV/1; 1106185088) Safari/604.1',
    want: { model: 'iPhone12,1', os: 'ios', osVer: '18.1', app: 'instagram', appVer: '454.1.0.41.71', engineVer: null, reduced: false },
  },
  {
    name: 'Facebook on Android',
    ua: 'Mozilla/5.0 (Linux; Android 12; SM-X135FU Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.8078.50 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/585.0.0.47.54;IABMV/1;]',
    want: { model: 'SM-X135FU', os: 'android', osVer: '12', app: 'facebook', appVer: '585.0.0.47.54', engineVer: 156, reduced: false },
  },
  {
    name: 'Facebook on Android with the wv marker and a model that contains spaces',
    ua: 'Mozilla/5.0 (Linux; Android 13; Redmi Note 99 Pro Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7000.10 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/580.1.0.2.3;]',
    want: { model: 'Redmi Note 99 Pro', os: 'android', osVer: '13', app: 'facebook', appVer: '580.1.0.2.3', engineVer: 150, reduced: false },
  },
  {
    name: 'Instagram on Android',
    ua: 'Mozilla/5.0 (Linux; Android 16; SM-Z938U Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.7444.102 Mobile Safari/537.36 Instagram 408.0.0.51.78 Android (36/16; 450dpi; 1080x2340; samsung; SM-Z938U; pa3q; qcom; en_US; 827698799)',
    want: { model: 'SM-Z938U', os: 'android', osVer: '16', app: 'instagram', appVer: '408.0.0.51.78', engineVer: 142, reduced: false },
  },
  {
    name: 'Instagram on Android whose main part is reduced: the model comes from the Instagram suffix',
    ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.0.0 Mobile Safari/537.36 Instagram 410.0.0.1.2 Android (34/14; 420dpi; 1080x2400; Xiaomi; M9999K6G; sweet; qcom; fr_FR; 1)',
    want: { model: 'M9999K6G', os: 'android', osVer: '14', app: 'instagram', appVer: '410.0.0.1.2', engineVer: 150, reduced: false },
  },
  {
    name: 'Chrome on Android with the reduced user agent',
    ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
    want: { model: null, os: 'android', osVer: null, app: 'chrome', appVer: '150.0.0.0', engineVer: 150, reduced: true },
  },
  {
    name: 'Safari on iPhone',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    want: { model: null, os: 'ios', osVer: '26.0', app: 'safari', appVer: '26.0', engineVer: null, reduced: false },
  },
  {
    name: 'Chrome on iPhone',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/150.0.7000.1 Mobile/15E148 Safari/604.1',
    want: { model: null, os: 'ios', osVer: '18.6', app: 'chrome', appVer: '150.0.7000.1', engineVer: null, reduced: false },
  },
  {
    name: 'Samsung Internet',
    ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
    want: { model: null, os: 'android', osVer: null, app: 'samsung', appVer: '28.0', engineVer: 130, reduced: true },
  },
  {
    name: 'TikTok on Android',
    ua: 'Mozilla/5.0 (Linux; Android 14; TECNO ZZ5q Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/148.0.7000.9 Mobile Safari/537.36 musical_ly_2023508030 JsSdk/1.0 NetType/4G Channel/googleplay AppName/musical_ly app_version/35.8.3 ByteLocale/fr BytedanceWebview/d8a21c6',
    want: { model: 'TECNO ZZ5q', os: 'android', osVer: '14', app: 'tiktok', appVer: '35.8.3', engineVer: 148, reduced: false },
  },
  {
    name: 'Firefox on Android',
    ua: 'Mozilla/5.0 (Android 14; Mobile; rv:150.0) Gecko/150.0 Firefox/150.0',
    want: { model: null, os: 'android', osVer: '14', app: 'firefox', appVer: '150.0', engineVer: 150, reduced: false },
  },
  {
    name: 'old Android stock browser with a locale before the model',
    ua: 'Mozilla/5.0 (Linux; U; Android 4.4.2; fr-fr; GT-I9999 Build/KOT49H) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30',
    want: { model: 'GT-I9999', os: 'android', osVer: '4.4', app: 'other', appVer: null, engineVer: null, reduced: false },
  },
  {
    name: 'Android browser that omits the Build token',
    ua: 'Mozilla/5.0 (Linux; Android 13; SM-Y135F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36 OPR/90.0.0.0',
    want: { model: 'SM-Y135F', os: 'android', osVer: '13', app: 'opera', appVer: '90.0.0.0', engineVer: 149, reduced: false },
  },
  {
    name: 'Chrome on Windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    want: { model: null, os: 'windows', osVer: '10.0', app: 'chrome', appVer: '150.0.0.0', engineVer: 150, reduced: false },
  },
]

for (const c of cases) {
  test(`parseUa: ${c.name}`, () => {
    assert.deepEqual(parseUa(c.ua), c.want)
  })
}

test('parseUa: an app or browser update changes only the version fields', () => {
  const before = parseUa(cases[2].ua)
  const after = parseUa(cases[2].ua.replace('FBAV/585.0.0.47.54', 'FBAV/586.0.0.1.1').replace('Chrome/156.0.8078.50', 'Chrome/157.0.8100.3'))
  assert.equal(after.model, before.model)
  assert.equal(after.os, before.os)
  assert.equal(after.osVer, before.osVer)
  assert.equal(after.app, before.app)
  assert.notEqual(after.appVer, before.appVer)
  assert.equal(after.engineVer, 157)
})

test('parseUa: empty, missing and garbage input never throw', () => {
  const blank = { model: null, os: 'other', osVer: null, app: 'other', appVer: null, engineVer: null, reduced: false }
  assert.deepEqual(parseUa(''), blank)
  assert.deepEqual(parseUa(undefined), blank)
  assert.deepEqual(parseUa(null), blank)
  assert.deepEqual(parseUa(12345), blank)
  assert.deepEqual(parseUa('((((;;;;))))'), blank)
  assert.equal(parseUa('Android '.repeat(5000)).os, 'android')
})

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)'

test('parseUa: Safari 26 and newer freeze the OS token on iPhone; the real version is in Version/', () => {
  const info = parseUa(`${IPHONE} Version/27.2 Mobile/15E148 Safari/604.1`)
  assert.equal(info.osVer, '27.2')
  assert.equal(info.app, 'safari')
  assert.equal(parseUa(`${IPHONE.replace('18_7', '18_6')} Version/26.0 Mobile/15E148 Snapchat/14.30.1.0 (like Safari/8622.1.22.10.9, panda)`).osVer, '26.0')
})

test('parseUa: Safari 18 on iOS 18.7 keeps its token, which is true there', () => {
  assert.equal(parseUa(`${IPHONE} Version/18.7 Mobile/15E148 Safari/604.1`).osVer, '18.7')
})

// Shapes the cases above leave out, pinned before the parser is rewritten for size.
const more = [
  {
    name: 'Safari on a Mac',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15',
    want: { model: null, os: 'mac', osVer: '10.15', app: 'safari', appVer: '26.1', engineVer: null, reduced: false },
  },
  {
    name: 'an iPad WebView that names no app',
    ua: 'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    want: { model: null, os: 'ios', osVer: '18.6', app: 'webview', appVer: null, engineVer: null, reduced: false },
  },
  {
    name: 'Edge on Windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.3000.1',
    want: { model: null, os: 'windows', osVer: '10.0', app: 'edge', appVer: '150.0.3000.1', engineVer: 150, reduced: false },
  },
  {
    name: 'an Android WebView',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 99 Build/AP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7000.1 Mobile Safari/537.36',
    want: { model: 'Pixel 99', os: 'android', osVer: '14', app: 'webview', appVer: '150.0.7000.1', engineVer: 150, reduced: false },
  },
  {
    name: 'Firefox on Linux',
    ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
    want: { model: null, os: 'linux', osVer: null, app: 'firefox', appVer: '150.0', engineVer: 150, reduced: false },
  },
  {
    name: 'an Android user agent cut off before its closing parenthesis',
    ua: 'Mozilla/5.0 (Linux; Android 9; SM-Q999',
    want: { model: 'SM-Q999', os: 'android', osVer: '9', app: 'other', appVer: null, engineVer: null, reduced: false },
  },
  {
    name: 'an app token without a version, then one with',
    ua: 'Mozilla/5.0 (Linux; Android 13; SM-Y135F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/0149.0.0.0 Mobile Safari/537.36 Snapchat/ Snapchat/13.1.0',
    want: { model: 'SM-Y135F', os: 'android', osVer: '13', app: 'snapchat', appVer: '13.1.0', engineVer: 149, reduced: false },
  },
]

for (const c of more) {
  test(`parseUa: ${c.name}`, () => {
    assert.deepEqual(parseUa(c.ua), c.want)
  })
}

test('parseUa: on iPhone the system version an app reports wins over a frozen token', () => {
  const instagram = `${IPHONE.replace('18_7', '18_6')} Mobile/23A355 Instagram 404.0.0.27.81 (iPhone14,8; iOS 26_0_1; fr_FR; fr; scale=3.00; 1284x2778; IABMV/1; 812000001)`
  assert.equal(parseUa(instagram).osVer, '26.0')
  const facebook = `${IPHONE} Mobile/24B119 Safari/604.1 [FBAN/FBIOS;FBAV/586.0.0.62.72;FBBV/1106861720;FBDV/iPhone18,2;FBMD/iPhone;FBSN/iOS;FBSV/27.1;FBSS/3;FBLC/fr_FR;FBOP/5]`
  assert.equal(parseUa(facebook).osVer, '27.1')
})

// A page can replace the built-ins the parser calls. Where that is cheap, the parser calls them exactly as 0.1.0 did,
// so a tampered page gets the reading it got before the parser was rewritten for size.
const ANDROID = 'Mozilla/5.0 (Linux; Android 12; SM-X135FU Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.8078.50 Mobile Safari/537.36'

function tampered(target, name, make, run) {
  const original = target[name]
  target[name] = make(original)
  try {
    return run()
  } finally {
    target[name] = original
  }
}

test('parseUa: the Build/ tail is removed by its own pattern, which does not depend on the global flag', () => {
  // a replace that ignores the g flag, as a page's wrapper might
  const dropG = (replace) =>
    function (pattern, value) {
      const once = pattern instanceof RegExp && pattern.global ? new RegExp(pattern.source, pattern.flags.split('g').join('')) : pattern
      return replace.call(this, once, value)
    }
  assert.equal(tampered(String.prototype, 'replace', dropG, () => parseUa(ANDROID).model), 'SM-X135FU')
})

test('parseUa: the Android version token is found with indexOf, as 0.1.0 finds it', () => {
  const lost = () =>
    function () {
      return -1
    }
  // 0.1.0 finds no version token when indexOf says nothing is there, so no model either
  assert.deepEqual(tampered(String.prototype, 'indexOf', lost, () => parseUa(ANDROID)), {
    model: null,
    os: 'android',
    osVer: '12',
    app: 'chrome',
    appVer: '156.0.8078.50',
    engineVer: 156,
    reduced: false,
  })
})

test('parseUa: an engine version of any length, leading zeros included, reads as parseInt(s, 10) reads it', () => {
  // unary plus and parseInt agree on every run of ASCII digits, which is all \d matches; the cut at 1,024 characters applies first
  for (const head of ['Mozilla/5.0 (X11; Linux x86_64) Chrome/', 'Mozilla/5.0 (X11; Linux x86_64; rv:1.0) Gecko/20100101 Firefox/']) {
    for (let n = 1; n <= 1100; n++) {
      for (const lead of [0, 1, n >> 1, n]) {
        let digits = ''
        for (let i = 0; i < n; i++) digits += i < lead ? '0' : String((i * 7 + n) % 10)
        const ua = head + digits + '.0 Safari/537.36'
        const want = parseInt(ua.slice(0, 1024).slice(head.length), 10)
        const got = parseUa(ua).engineVer
        assert.ok(Object.is(got, want), `${n} digits, ${lead} leading zeros: ${got} instead of ${want}`)
      }
    }
  }
})

test('parseUa: an Android section with no closing parenthesis ends 200 characters after "Android", or at the cut', () => {
  for (let pad = 0; pad <= 995; pad += pad < 600 ? 50 : 1) {
    for (let k = 0; k <= 400; k += k < 170 ? 17 : 1) {
      const ua = 'x'.repeat(pad) + '(Linux; Android 9; ' + 'M'.repeat(k)
      // "Android" starts at pad + 8 and the model at pad + 19: 189 characters fit before the end, fewer past the cut
      const count = Math.min(k, 189, 1024 - pad - 19)
      assert.equal(parseUa(ua).model, count > 0 ? 'M'.repeat(count) : null, `pad ${pad}, ${k} characters`)
    }
  }
  assert.equal(parseUa('x'.repeat(1000) + '(Linux; Android 9; SM-Q999').model, 'SM-Q9')
  assert.equal(parseUa('(Linux; Android 9; ' + ' '.repeat(250) + 'SM-Q999').model, null)
})

// The three parser edges of id version 3 (docs/DECISIONS.md, "Id definition, version 3"). Synthetic strings of the published shapes.
test('parseUa: a Huawei browser that writes "HarmonyOS" among the Android tokens: the model is the token after it', () => {
  // shape of the Android-based HarmonyOS browser string (third-party sample, 2024); model and versions altered
  const ua = 'Mozilla/5.0 (Linux; Android 12; HarmonyOS; ZZZ-AL00; HMSCore 6.14.0.302) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.196 HuaweiBrowser/15.0.7.301 Mobile Safari/537.36'
  const info = parseUa(ua)
  assert.equal(info.model, 'ZZZ-AL00')
  assert.equal(info.os, 'android')
  assert.equal(info.osVer, '12')
  assert.equal(info.reduced, false)
  // the same phone's model, written without the token, is the same value
  assert.equal(parseUa(ua.replace('HarmonyOS; ', '')).model, info.model)
  // only that exact token is skipped: a model that merely begins with the word stays a model
  assert.equal(parseUa(ua.replace('HarmonyOS; ZZZ-AL00', 'HarmonyOSX')).model, 'HarmonyOSX')
})

test('parseUa: HarmonyOS followed by the reduced "K" asks client hints for the model, as any reduced user agent does', () => {
  const info = parseUa('Mozilla/5.0 (Linux; Android 12; HarmonyOS; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36')
  assert.deepEqual([info.model, info.reduced], [null, true])
})

test('parseUa: Opera on iOS is labelled opera with the version of its own token, with or without Version/', () => {
  const opera = (tail) => parseUa(`${IPHONE} ${tail}`)
  // the one dated shape (third-party, 2014) has OPiOS/ and no Version/; a Version/ is tried as well since nothing documents its absence
  assert.deepEqual([opera('OPiOS/8.0.0.78129 Mobile/11D201 Safari/9537.53').app, opera('OPiOS/8.0.0.78129 Mobile/11D201 Safari/9537.53').appVer], ['opera', '8.0.0.78129'])
  assert.deepEqual([opera('Version/27.2 OPiOS/6.1.0 Mobile/15E148 Safari/604.1').app, opera('Version/27.2 OPiOS/6.1.0 Mobile/15E148 Safari/604.1').appVer], ['opera', '6.1.0'])
  assert.equal(opera('Version/27.2 OPiOS/6.1.0 Mobile/15E148 Safari/604.1').osVer, '27.2', 'the OS version is read as for Safari')
  assert.equal(opera('Version/27.2 Mobile/15E148 Safari/604.1').app, 'safari', 'Safari itself is unchanged')
})

test('parseUa: known limit kept in id version 3: an iPad that sends the Mac user agent reads as a Mac (needs a device to settle)', () => {
  // WebKit's desktop-class user agent on iPadOS is byte for byte the Mac one; telling them apart needs a read the id version 3 change does not add
  const info = parseUa('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15')
  assert.deepEqual([info.os, info.osVer, info.app], ['mac', '10.15', 'safari'])
})

test('parseUa: HMSCore right after HarmonyOS is not a model: its version moves with every update, so the phone has no model there', () => {
  // shape unverified (no vendor source): the guard keeps an update of Huawei's services from splitting one phone's ids
  const ua = (hms) => `Mozilla/5.0 (Linux; Android 12; HarmonyOS; HMSCore ${hms}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.196 HuaweiBrowser/15.0.7.301 Mobile Safari/537.36`
  const before = parseUa(ua('6.14.0.302'))
  const after = parseUa(ua('6.15.0.300'))
  assert.deepEqual([before.model, before.reduced], [null, false])
  assert.equal(after.model, before.model)
  // without HarmonyOS the token rule is unchanged
  assert.equal(parseUa('Mozilla/5.0 (Linux; Android 12; ZZZ-AL00; HMSCore 6.14.0.302) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36').model, 'ZZZ-AL00')
})
