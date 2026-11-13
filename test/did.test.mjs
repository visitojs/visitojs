import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readDid } from '../build/esm/did.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const KNOWN = '11111111-2222-4333-8444-555555555555'
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

function jar(initial = {}, { blocked = false, throws = false } = {}) {
  const values = { ...initial }
  const writes = []
  return {
    writes,
    values,
    get cookie() {
      if (throws) throw new Error('SecurityError')
      return Object.entries(values).map(([k, v]) => `${k}=${v}`).join('; ')
    },
    set cookie(text) {
      writes.push(text)
      if (blocked) return
      const [pair] = text.split(';')
      const at = pair.indexOf('=')
      values[pair.slice(0, at)] = pair.slice(at + 1)
    },
  }
}

function storage(initial = {}, { throws = false } = {}) {
  const values = { ...initial }
  return {
    values,
    getItem: (k) => (k in values ? values[k] : null),
    setItem: (k, v) => {
      if (throws) throw new Error('QuotaExceededError')
      values[k] = String(v)
    },
  }
}

const bytes = () => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
const env = (doc, ls, extra = {}) => ({ doc, storage: ls, name: '_visito', secure: true, random: bytes, ...extra })

test('empty storages: a new v4 id is created and written to both', () => {
  const doc = jar()
  const ls = storage()
  const r = readDid(env(doc, ls))
  assert.match(r.did, UUID)
  assert.equal(r.didNew, true)
  assert.equal(r.didSrc, '')
  assert.equal(doc.values._visito, r.did)
  assert.equal(ls.values._visito, r.did)
  assert.match(doc.writes[0], /; Path=\/; Max-Age=\d+; SameSite=Lax; Secure$/)
})

test('a valid cookie wins, fills localStorage and is never rewritten', () => {
  const doc = jar({ _visito: KNOWN })
  const ls = storage()
  const r = readDid(env(doc, ls))
  assert.deepEqual(r, { did: KNOWN, didNew: false, didSrc: 'c' })
  assert.equal(ls.values._visito, KNOWN)
  assert.equal(doc.writes.length, 0, 'rewriting would turn a server-set cookie into a script-written one')
})

test('localStorage alone restores the cookie', () => {
  const doc = jar()
  const r = readDid(env(doc, storage({ _visito: KNOWN })))
  assert.deepEqual(r, { did: KNOWN, didNew: false, didSrc: 'l' })
  assert.equal(doc.values._visito, KNOWN)
})

test('cookie and localStorage disagree: the cookie wins and localStorage follows', () => {
  const ls = storage({ _visito: OTHER })
  const r = readDid(env(jar({ _visito: KNOWN }), ls))
  assert.deepEqual(r, { did: KNOWN, didNew: false, didSrc: 'cl' })
  assert.equal(ls.values._visito, KNOWN)
})

test('a malformed stored value is ignored', () => {
  const r = readDid(env(jar({ _visito: '%3Cscript%3E' }), storage({ _visito: 'not-an-id' })))
  assert.match(r.did, UUID)
  assert.equal(r.didNew, true)
  assert.equal(r.didSrc, '')
})

test('other cookies, including a name that merely ends with ours, are not mistaken for it', () => {
  const r = readDid(env(jar({ x_visito: OTHER, theme: 'dark', _visito: KNOWN }), storage()))
  assert.equal(r.did, KNOWN)
})

test('nothing can be stored: no id is handed out', () => {
  const r = readDid(env(jar({}, { blocked: true }), null))
  assert.deepEqual(r, { did: null, didNew: false, didSrc: '' })
})

test('cookies throw but localStorage works: the id lives in localStorage', () => {
  const ls = storage()
  const r = readDid(env(jar({}, { throws: true }), ls))
  assert.match(r.did, UUID)
  assert.equal(r.didNew, true)
  assert.equal(ls.values._visito, r.did)
})

test('localStorage throws on write but cookies work: the id lives in the cookie', () => {
  const doc = jar()
  const r = readDid(env(doc, storage({}, { throws: true })))
  assert.match(r.did, UUID)
  assert.equal(doc.values._visito, r.did)
})

test('a second page view finds the id of the first', () => {
  const doc = jar()
  const ls = storage()
  const first = readDid(env(doc, ls))
  const second = readDid(env(doc, ls))
  assert.deepEqual(second, { did: first.did, didNew: false, didSrc: 'cl' })
})

test('no document and no storage at all never throws', () => {
  assert.deepEqual(readDid(env(null, null)), { did: null, didNew: false, didSrc: '' })
})

test('on plain http the cookie is written without Secure', () => {
  const doc = jar()
  readDid(env(doc, storage(), { secure: false }))
  assert.doesNotMatch(doc.writes[0], /Secure/)
})
