export interface DidEnv {
  doc: { cookie: string } | null
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null
  name: string
  secure: boolean
  /** Returns 16 random bytes. */
  random: () => number[]
}

export interface Did {
  /** The stored id, or null when no storage can hold one. */
  did: string | null
  /** True only on the page view that created the id. */
  didNew: boolean
  /** Which storages already held a valid id: "c" cookie, "l" localStorage. */
  didSrc: string
}

const VALID = /^[a-f0-9-]{32,36}$/i
// browsers cap a cookie's lifetime at 400 days
const MAX_AGE = 400 * 24 * 3600

function cookieGet(env: DidEnv): string | null {
  try {
    const parts = env.doc ? env.doc.cookie.split(';') : []
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].replace(/^\s+/, '')
      if (part.indexOf(env.name + '=') !== 0) continue
      const value = part.slice(env.name.length + 1)
      if (VALID.test(value)) return value
    }
  } catch (e) {
    // cookies are unreadable here (sandboxed frame, blocked by the browser)
  }
  return null
}

function storageGet(env: DidEnv): string | null {
  try {
    const value = env.storage ? env.storage.getItem(env.name) : null
    return value && VALID.test(value) ? value : null
  } catch (e) {
    return null
  }
}

function uuid(bytes: number[]): string {
  let hex = ''
  for (let i = 0; i < 16; i++) {
    let b = bytes[i] & 255
    if (i === 6) b = (b & 0x0f) | 0x40
    if (i === 8) b = (b & 0x3f) | 0x80
    // 8-4-4-4-12 hex digits: a dash before bytes 4, 6, 8 and 10
    if (i === 4 || i === 6 || i === 8 || i === 10) hex += '-'
    hex += (b < 16 ? '0' : '') + b.toString(16)
  }
  return hex
}

/** Reads the stored id, cookie first, creating one if needed. An existing cookie is never rewritten: Safari deletes script-written cookies after 7 days. */
export function readDid(env: DidEnv): Did {
  const fromCookie = cookieGet(env)
  const fromStorage = storageGet(env)
  const created = !fromCookie && !fromStorage
  const id = fromCookie || fromStorage || uuid(env.random())

  if (fromCookie !== id) {
    try {
      if (env.doc) {
        env.doc.cookie = env.name + '=' + id + '; Path=/; Max-Age=' + MAX_AGE + '; SameSite=Lax' + (env.secure ? '; Secure' : '')
      }
    } catch (e) {
      // the read-back below decides whether the id survived
    }
  }
  if (fromStorage !== id) {
    try {
      if (env.storage) env.storage.setItem(env.name, id)
    } catch (e) {
      // same: decided by the read-back
    }
  }

  // an id that no storage kept would change on every page view: report none instead
  if (created && cookieGet(env) !== id && storageGet(env) !== id) {
    return { did: null, didNew: false, didSrc: '' }
  }
  return { did: id, didNew: created, didSrc: (fromCookie ? 'c' : '') + (fromStorage ? 'l' : '') }
}
