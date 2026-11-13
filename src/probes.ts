// Reads that need the document or wait on the browser: client hints, the locale settings and the text-size setting.
import { Build } from './env.js'
import { ERR, NA, Raw, safe, TIMEOUT } from './guard.js'
import { Parts } from './reading.js'
import { Win } from './reads.js'

/** Wraps a callback so it fires once: with the read's answer, or with `late` when `ms` pass first. */
export function once(w: Win, ms: number, late: Parts, callback: (values: Parts) => void): (values: Parts) => void {
  let open = true
  // the timer is left to fire into nothing: clearing it would be one more call a page could have broken by the time the answer comes
  w.setTimeout(function () {
    if (!open) return
    open = false
    callback(late)
  }, ms)
  return function (values: Parts) {
    if (!open) return
    open = false
    callback(values)
  }
}

// The brand the User-Agent Client Hints specification has browsers add on purpose ("create an arbitrary brand"): words joined by
// characters from its separator list. One of those that is not a space marks it; so does reading NotABrand once the spaces are gone.
const ARBITRARY_BRAND = /[()\-./:;=?_]|^ *N *o *t *A *B *r *a *n *d *$/

/** The real brand names, in code-unit order: the specification has browsers reorder the list over time, and the set is what says something. */
function brandNames(list: any): string {
  const names: string[] = []
  // a length that is not a number ends the loop at once: the list is then empty; a huge one is cut at 32 entries
  for (let i = 0; list && i < list.length && i < 32; i++) {
    const entry = list[i]
    // a primitive entry has no brand of its own
    const name = entry ? entry.brand : 0
    if (typeof name !== 'string' || ARBITRARY_BRAND.test(name)) continue
    // appended, then moved down by comparison alone, with no sort(): a page may have replaced it
    names.push(name)
    let at = names.length - 1
    while (at > 0 && names[at - 1] > name) names[at] = names[--at]
    names[at] = name
  }
  return names.join(',')
}

/** User-agent client hints: the phone model when the user agent itself is reduced. Promise-only API, so `.then` is called but no promise is built. */
export function hints(w: Win, done: (values: Parts) => void, timeoutMs?: number): void {
  const finish = once(w, timeoutMs || 1000, { 'x.ch.model': TIMEOUT }, done)
  try {
    const data = w.navigator.userAgentData
    if (!data || typeof data.getHighEntropyValues !== 'function') return finish({ 'x.ch.model': NA })
    // read now, inside the try: the answer arrives after the page may have broken join() or a getter
    const known = brandNames(data.brands)
    const mobile = !!data.mobile
    data.getHighEntropyValues(['model', 'platformVersion']).then(
      function (high: any) {
        // a page can replace the call with one that answers anything: a throw here would end as an unhandled rejection
        try {
          finish({
            'x.ch.model': typeof high.model === 'string' ? high.model : NA,
            'x.ch.pv': typeof high.platformVersion === 'string' ? high.platformVersion : NA,
            'x.ch.brands': known,
            'x.ch.mobile': mobile,
          })
        } catch (e) {
          finish({ 'x.ch.model': ERR })
        }
      },
      function () {
        // a refusal (permissions policy) is a final answer, not a failure
        finish({ 'x.ch.model': NA })
      },
    )
  } catch (e) {
    finish({ 'x.ch.model': ERR })
  }
}

/** Locale settings. The first Intl call wakes the locale engine (23 ms at 4x slowdown), so this runs at idle, never at script start. */
export function intl(w: Win): Parts {
  let options: any = null
  let status: Raw = NA
  try {
    if (w.Intl && w.Intl.DateTimeFormat) options = w.Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions()
  } catch (e) {
    status = ERR
  }
  const pick = function (name: string): Raw {
    return options && typeof options[name] === 'string' ? options[name] : status
  }
  return { 'x.tz': pick('timeZone'), 'x.loc': pick('locale'), 'x.cal': pick('calendar'), 'x.num': pick('numberingSystem'), 'x.hc': pick('hourCycle') }
}

// Declared on every text probe before its own styles, as property and value pairs: nothing a page adds to a prototype can join them.
const NEUTRAL_TEXT = ['position', 'absolute', 'white-space', 'nowrap', 'letter-spacing', '0', 'word-spacing', '0', 'text-transform', 'none', 'font-style', 'normal', 'font-weight', '400']

/** The user's text-size setting, three cheap ways, plus the system text style on WebKit. Inline `!important` styles keep a page's theme out of the result. */
export function textSize(w: Win, env: { engine: Build['engine'] }): Parts {
  const out: Parts = { 'x.txt.env': ERR, 'x.txt.fs': ERR, 'x.txt.w': ERR, 'x.txt.apple': NA }
  let box: any = null
  try {
    const doc = w.document
    const declare = function (node: any, pairs: string[]): void {
      for (let i = 0; i < pairs.length; i += 2) node.style.setProperty(pairs[i], pairs[i + 1], 'important')
    }
    const probe = function (own: string[], text: string): any {
      const node = doc.createElement('span')
      declare(node, NEUTRAL_TEXT)
      declare(node, own)
      node.textContent = text
      box.appendChild(node)
      return node
    }
    box = doc.createElement('div')
    box.setAttribute('aria-hidden', 'true')
    box.style.cssText =
      'position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;overflow:hidden!important;visibility:hidden!important;pointer-events:none!important'
    // normal first: an engine without env() drops the second declaration, and the probe then reads no number instead of the page's line height
    const scaled = probe(['line-height', 'normal', 'line-height', 'calc(env(preferred-text-scale, 1) * 100px)'], '')
    const fixed = probe(['font-family', 'monospace', 'font-size', '100px'], 'mmmmmmmmmm')
    // Apple's Dynamic Type reaches web content only through the font shorthand's system text-style values (Safari 7.0 notes,
    // WebKit's "Using the System Font in Web Content"); font-family picks a family and carries no size
    const apple = env.engine === 'webkit' ? probe(['font', '-apple-system-body'], '') : null
    // one change to the document for all probes, so reading them costs one style recalculation
    doc.body.appendChild(box)

    // a value that does not parse stays NaN, with no Math call on it, and safe() names NaN as not available
    const style = function (node: any, property: string): number {
      const value = parseFloat(w.getComputedStyle(node)[property])
      return value === value ? Math.round(value * 100) / 100 : value
    }
    out['x.txt.env'] = safe(function () { return style(scaled, 'lineHeight') / 100 })
    out['x.txt.fs'] = safe(function () { return style(fixed, 'fontSize') })
    out['x.txt.w'] = safe(function () { return Math.round(fixed.getBoundingClientRect().width * 10) / 10 })
    // WebKit always computes a size for the system text style: none is a failed read, which leaves no id, not a missing setting
    if (apple) out['x.txt.apple'] = safe(function () { const size = style(apple, 'fontSize'); if (size !== size) throw size; return size })
  } catch (e) {
    // the statuses set above stand
  } finally {
    try {
      if (box && box.parentNode) box.parentNode.removeChild(box)
    } catch (e) {
      // the node is hidden and inert even if it stays
    }
  }
  return out
}
