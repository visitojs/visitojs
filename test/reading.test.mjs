import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonical, makeId, idParts, seal, ID_VERSION } from '../build/esm/reading.js'

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

test('canonical: sorted "key=value" lines, whatever order the object was built in', () => {
  assert.equal(canonical({ 'p.tz': 'Asia/Kolkata', 'hw.model': 'SM-A135F', 'hw.mem': 4 }), 'hw.mem=4\nhw.model=SM-A135F\np.tz=Asia/Kolkata')
  assert.equal(canonical({ b: true, a: false }), 'a=false\nb=true')
  assert.equal(canonical({}), '')
})

test('canonical: line breaks inside a value cannot forge another line', () => {
  assert.equal(canonical({ a: 'x\nb=1', c: 'y\r\nz' }), 'a=x b=1\nc=y  z')
})

test('makeId: a server can recompute it from the documented string', () => {
  const parts = { 'hw.model': 'SM-A135F', 'hw.mem': 4, 'p.lang': 'fr-FR', 'p.txt': 1.15 }
  const expected = sha(`visito:${ID_VERSION}\nhw.mem=4\nhw.model=SM-A135F\np.lang=fr-FR\np.txt=1.15`)
  assert.deepEqual(makeId(parts), { id: expected, partial: [] })
  assert.match(expected, /^[0-9a-f]{64}$/)
})

test('makeId: one changed setting changes the id', () => {
  const base = { 'hw.model': 'SM-A135F', 'hw.mem': 4, 'p.lang': 'fr-FR' }
  assert.notEqual(makeId(base).id, makeId({ ...base, 'p.lang': 'ja-JP' }).id)
})

test('makeId: a value the browser does not have ("!na") or that is excluded ("!ex") is a stable fact and still gives an id', () => {
  const r = makeId({ 'hw.model': 'iPhone14,5', 'hw.mem': '!na', 'p.x': '!ex' })
  assert.match(r.id, /^[0-9a-f]{64}$/)
  assert.deepEqual(r.partial, [])
})

test('makeId: a read that failed or timed out gives no id and is named', () => {
  assert.deepEqual(makeId({ 'hw.model': 'SM-A135F', 'p.lang': '!err', 'p.tz': '!to', 'hw.mem': 4 }), { id: null, partial: ['p.lang', 'p.tz'] })
})

test('makeId: nothing to hash gives no id', () => {
  assert.deepEqual(makeId({}), { id: null, partial: [] })
})

test('idParts: only hardware ("hw.") and settings ("p.") values enter the id', () => {
  assert.deepEqual(idParts({ 'hw.model': 'SM-A135F', 'p.lang': 'fr', 'x.tzo': -60, 'r.canvas': 'abc' }), { 'hw.model': 'SM-A135F', 'p.lang': 'fr' })
})

test('seal: replays the id rules on stored values, so a server gets the ids the browser built', () => {
  const versions = { osVer: '17', app: 'instagram', appVer: '455.0.0.51.72', engineVer: 157 }
  const stored = { 'hw.model': 'Pixel 10', 'hw.mem': 8, 'p.lang': 'en-US', 'x.txt.env': 1.15, 'x.txt.fs': 115, 'x.txt.apple': '!na', 'x.scr': '924x412', 'x.cores': 8 }
  const c = { ...stored }
  const ids = seal(c, { scr: false, cores: false }, versions)
  assert.equal(c['p.txt'], 1.15)
  assert.equal(ids.id, sha(`visito:${ID_VERSION}\nhw.mem=8\nhw.model=Pixel 10\np.lang=en-US\np.txt=1.15`))
  assert.equal(ids.idStrict, sha(`visito:${ID_VERSION}\nhw.mem=8\nhw.model=Pixel 10\np.lang=en-US\np.txt=1.15\nv.app=instagram\nv.appVer=455.0.0.51.72\nv.engine=157\nv.os=17`))

  const noModel = { ...stored, 'hw.model': '!na' }
  seal(noModel, { scr: true, cores: false }, versions)
  assert.deepEqual([noModel['hw.scr'], noModel['hw.cores']], ['!ex', 8])
})

test('the id definition is version 3: the hashed text starts with "visito:3"', () => {
  assert.equal(ID_VERSION, 3)
  assert.equal(makeId({ 'p.lang': 'fr' }).id, sha('visito:3\np.lang=fr'))
})

test('seal: a text value that was not read leaves no id, instead of another text value standing in for it unflagged', () => {
  const versions = { osVer: '17', app: 'chrome', appVer: '157.0.0.0', engineVer: 157 }
  const text = (env, fs, apple) => {
    const c = { 'hw.model': 'Pixel 10', 'hw.mem': 8, 'p.lang': 'en-US', 'x.txt.env': env, 'x.txt.fs': fs, 'x.txt.apple': apple }
    const ids = seal(c, {}, versions)
    return [c['p.txt'], ids.id]
  }
  // the scale decides on Chrome: a failed scale read must not let the fixed size (always 100 there) give 1 instead of 1.15
  assert.deepEqual(text('!err', 100, '!na'), ['!err', null])
  assert.deepEqual(text('!to', 100, '!na'), ['!to', null])
  // the system text style decides alone on WebKit
  assert.deepEqual(text(1, 100, '!err'), ['!err', null])
  assert.deepEqual(text(1, 100, '!to'), ['!to', null])
  // every engine computes the fixed 100px font: no number for it means the probe failed, not a setting the browser lacks
  assert.deepEqual(text(1, '!na', '!na'), ['!err', null])
  assert.deepEqual(text(1, '!err', '!na'), ['!err', null])
  // what a browser really answers is unchanged
  assert.deepEqual(text(1.15, 100, '!na')[0], 1.15)
  assert.deepEqual(text('!na', 115, '!na')[0], 1.15, 'an engine without env() still gives the size')
  assert.deepEqual(text(1, 100, 17)[0], 17)
  assert.deepEqual(text(1.15, '!err', '!na')[0], 1.15, 'where the scale decides, the size is not needed')
})

test('the README sample is what the library computes: version 3, and the id and idStrict prefixes of its parts', async () => {
  const { readFileSync } = await import('node:fs')
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const sample = JSON.parse(/## What you get\s+```json\n([\s\S]*?)\n```/.exec(readme)[1].replace(/\.\.\."/g, '"'))
  // the parts behind the sample: a Pixel 10 in Chrome 157 with 8 GB, English and a text scale of 1.15
  const c = { 'hw.model': sample.model, 'hw.mem': 8, 'p.lang': 'en-US', 'x.txt.env': 1.15, 'x.txt.fs': 100, 'x.txt.apple': '!na' }
  const ids = seal(c, {}, { osVer: sample.osVer, app: sample.app, appVer: sample.appVer, engineVer: 157 })
  assert.equal(sample.v, ID_VERSION)
  assert.ok(ids.id.startsWith(sample.id), `README id ${sample.id}, computed ${ids.id}`)
  assert.ok(ids.idStrict.startsWith(sample.idStrict), `README idStrict ${sample.idStrict}, computed ${ids.idStrict}`)
  assert.ok(sample.id.length >= 8 && sample.idStrict.length >= 8)
})
