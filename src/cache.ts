import { ERR, Raw, TIMEOUT } from './guard.js'
import { ID_VERSION, Parts } from './reading.js'

const MAX_AGE_MS = 24 * 3600 * 1000

type Store = { getItem(key: string): string | null; setItem(key: string, value: string): void } | null

/** The values a complete earlier page view read, when they are under 24 hours old and from this same browser build. */
export function load(store: Store, key: string, uaKey: string): Parts | null {
  try {
    const saved = store ? JSON.parse(store.getItem(key) || 'null') : null
    const age = saved ? Date.now() - saved.t : -1
    if (!saved || saved.v !== ID_VERSION || saved.u !== uaKey || !(age >= 0 && age < MAX_AGE_MS) || !saved.c) return null
    const out: Parts = {}
    for (const name in saved.c) {
      // skips what a page added to Object.prototype, with an operator: hasOwnProperty is a built-in the page may have replaced
      if (name in {}) continue
      const value: Raw = saved.c[name]
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return null
      out[name] = value
    }
    return out
  } catch (e) {
    // unreadable storage or a page that replaced JSON: behave as if nothing was cached
    return null
  }
}

/** Saves a set of values, unless one of them failed or timed out: a partial reading must never be replayed. */
export function save(store: Store, key: string, uaKey: string, values: Parts): void {
  try {
    for (const name in values) {
      // no hasOwnProperty, which a page may have replaced by now: a name it added to Object.prototype holds no failed value
      if (values[name] === ERR || values[name] === TIMEOUT) return
    }
    if (store) store.setItem(key, JSON.stringify({ v: ID_VERSION, u: uaKey, t: Date.now(), c: values }))
  } catch (e) {
    // storage full or blocked: the next page view simply reads again
  }
}
