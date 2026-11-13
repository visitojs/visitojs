import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stageA } from '../build/esm/stages.js'
import { fakeWindow, cookieJar, storageArea, UA } from './fake-window.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('stage A in the Facebook browser on Android: stored id and model are ready at once, the id waits for the text size', () => {
  const r = stageA(fakeWindow())
  assert.equal(r.v, 3)
  assert.match(r.did, UUID)
  assert.equal(r.didNew, true)
  assert.equal(r.didSrc, '')
  assert.deepEqual(
    { model: r.model, os: r.os, osVer: r.osVer, app: r.app, appVer: r.appVer, engineVer: r.engineVer },
    { model: 'SM-X135FU', os: 'android', osVer: '12', app: 'facebook', appVer: '585.0.0.47.54', engineVer: 156 },
  )
  assert.deepEqual([r.c['hw.model'], r.c['hw.mem'], r.c['p.lang']], ['SM-X135FU', 4, 'fr-FR'])
  assert.equal(r.c['x.engine'], 'other')
  assert.equal(r.c['p.txt'], '!to')
  assert.equal(r.id, null)
  assert.equal(r.idStrict, null)
  assert.deepEqual(r.flags, { partial: ['p.txt'], auto: [], private: null, weak: false })
  assert.equal(typeof r.ms, 'number')
})

test('every step reports how long it took', () => {
  const r = stageA(fakeWindow())
  for (const step of ['ua', 'did', 'env', 'hw.mem', 'p.lang', 'auto']) assert.ok(step in r.t, step)
  for (const [step, ms] of Object.entries(r.t)) assert.ok(typeof ms === 'number' && ms >= 0, `${step}: ${ms}`)
})

test('the next page view finds the same stored id', () => {
  const document = cookieJar()
  const localStorage = storageArea()
  const first = stageA(fakeWindow({ document, localStorage }))
  const second = stageA(fakeWindow({ document, localStorage }))
  assert.equal(second.did, first.did)
  assert.equal(second.didNew, false)
  assert.equal(second.didSrc, 'cl')
})

test('Chrome on Android with a reduced user agent: no id until the model arrives, the stored id is still there', () => {
  const r = stageA(fakeWindow({ ua: UA.chromeAndroidReduced }))
  assert.equal(r.id, null)
  assert.ok(r.flags.partial.includes('hw.model'))
  assert.match(r.did, UUID)
})

test('the cookie name comes from VisitoConfig when it is a safe name, else the default', () => {
  const custom = cookieJar()
  stageA(fakeWindow({ document: custom, extra: { VisitoConfig: { did: 'shop_visitor' } } }))
  assert.deepEqual(Object.keys(custom.values), ['shop_visitor'])

  const unsafe = cookieJar()
  stageA(fakeWindow({ document: unsafe, extra: { VisitoConfig: { did: 'a b; Domain=evil' } } }))
  assert.deepEqual(Object.keys(unsafe.values), ['_visito'])
})

test('inside a frame nothing runs', () => {
  const w = fakeWindow()
  w.self = w
  w.top = {}
  assert.equal(stageA(w), null)
})

test('a window where every property throws never throws out', () => {
  const hostile = new Proxy({}, {
    get() {
      throw new Error('blocked')
    },
  })
  assert.equal(stageA(hostile), null)
})

test('an empty window gives a reading that says what failed', () => {
  const r = stageA({})
  assert.equal(r.did, null)
  assert.equal(r.model, null)
  assert.equal(r.id, null)
  for (const key of ['hw.mem', 'p.lang']) assert.ok(r.flags.partial.includes(key), key)
})

test('a page clock that returns garbage does not silence the library', () => {
  const broken = { now: () => ({ valueOf() { throw new Error('fault') } }) }
  const r = stageA(fakeWindow({ extra: { performance: broken } }))
  assert.match(r.did, UUID)
  assert.equal(typeof r.ms, 'number')
})

test('localStorage that throws on access is treated as absent', () => {
  const w = fakeWindow()
  Object.defineProperty(w, 'localStorage', {
    get() {
      throw new Error('SecurityError')
    },
  })
  const r = stageA(w)
  assert.match(r.did, UUID)
  assert.equal(w.document.values._visito, r.did)
})
