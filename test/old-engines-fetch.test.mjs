import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fetchImage } from '../lab/old-engines/fetch-image.mjs'
import { entry, archive } from './old-engines-tar.mjs'

const dir = mkdtempSync(join(tmpdir(), 'visito-fetch-'))
after(() => rmSync(dir, { recursive: true, force: true }))
let caches = 0
const newCache = () => { const cache = join(dir, `cache${caches++}`); mkdirSync(cache); return cache }
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const quiet = { log: () => {}, wait: async () => {} }

// an image of two layers on a registry that answers from memory, as Docker Hub answers a pull by digest
function image() {
  const tars = [
    archive(entry({ name: 'etc/', type: '5' }), entry({ name: 'etc/base' }, 'base')),
    archive(entry({ name: 'etc/good' }, 'good')),
  ]
  const layers = tars.map((tar) => gzipSync(tar))
  const config = Buffer.from(JSON.stringify({ config: { Env: ['PATH=/bin', 'LANG=C.UTF-8'] }, rootfs: { type: 'layers', diff_ids: tars.map(sha) } }))
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: { mediaType: 'application/vnd.docker.container.image.v1+json', digest: sha(config), size: config.length },
    layers: layers.map((layer) => ({ mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', digest: sha(layer), size: layer.length })),
  }))
  const blobs = new Map([[sha(config), config], ...layers.map((layer) => [sha(layer), layer])])
  const digest = sha(manifest)
  return { reference: `example/old:1@${digest}`, entryName: digest.replace(':', '-'), manifest, blobs, top: sha(layers[1]) }
}

// the top layer as a registry or a proxy might serve it once: other bytes, which plant a file before its digest is checked
const planted = gzipSync(archive(entry({ name: 'etc/ld.so.preload' }, '/tmp/evil.so\n'), entry({ name: 'etc/good' }, 'good')))

function registry(img, { blob } = {}) {
  const calls = { manifest: 0, blob: 0 }
  async function fetch(url) {
    const path = new URL(url).pathname
    const manifest = /\/manifests\/(.+)$/.exec(path)
    if (manifest) {
      calls.manifest++
      return new Response(img.manifest, { headers: { 'content-type': 'application/vnd.docker.distribution.manifest.v2+json' } })
    }
    const wanted = (/\/blobs\/(.+)$/.exec(path) || [])[1]
    if (!wanted || !img.blobs.has(wanted)) return new Response('not found', { status: 404 })
    calls.blob++
    const body = (blob && blob(wanted, calls)) || img.blobs.get(wanted)
    return new Response(body)
  }
  return { fetch, calls }
}

test('an image is unpacked into the cache under its digest, with its environment, and marked complete', async () => {
  const img = image()
  const cache = newCache()
  const { fetch } = registry(img)
  const entryDir = await fetchImage(cache, img.reference, { ...quiet, fetch })
  assert.equal(entryDir, join(cache, img.entryName))
  assert.equal(readFileSync(join(entryDir, 'rootfs/etc/base'), 'utf8'), 'base')
  assert.equal(readFileSync(join(entryDir, 'rootfs/etc/good'), 'utf8'), 'good')
  assert.equal(readFileSync(join(entryDir, 'env'), 'utf8'), 'PATH=/bin\nLANG=C.UTF-8\n')
  assert.ok(existsSync(join(entryDir, 'complete')))
  assert.deepEqual(readdirSync(cache), [img.entryName])
})

test('an image already complete in the cache is not fetched again', async () => {
  const img = image()
  const cache = newCache()
  await fetchImage(cache, img.reference, { ...quiet, fetch: registry(img).fetch })
  const again = registry(img)
  assert.equal(await fetchImage(cache, img.reference, { ...quiet, fetch: again.fetch }), join(cache, img.entryName))
  assert.deepEqual(again.calls, { manifest: 0, blob: 0 })
})

test('a layer that fails its digest once makes the whole image start again from an empty tree', async () => {
  const img = image()
  const cache = newCache()
  let served = 0
  const { fetch } = registry(img, { blob: (digest) => (digest === img.top && served++ === 0 ? planted : undefined) })
  const entryDir = await fetchImage(cache, img.reference, { ...quiet, fetch })
  assert.equal(served, 2)
  // what the bad bytes wrote before their digest was checked is gone, not kept under the good layer
  assert.equal(existsSync(join(entryDir, 'rootfs/etc/ld.so.preload')), false)
  assert.equal(readFileSync(join(entryDir, 'rootfs/etc/good'), 'utf8'), 'good')
  assert.equal(readFileSync(join(entryDir, 'rootfs/etc/base'), 'utf8'), 'base')
  assert.deepEqual(readdirSync(cache), [img.entryName])
})

test('an image whose layer never matches its digest is not marked complete and leaves nothing behind', async () => {
  const img = image()
  const cache = newCache()
  const { fetch } = registry(img, { blob: (digest) => (digest === img.top ? planted : undefined) })
  await assert.rejects(fetchImage(cache, img.reference, { ...quiet, fetch, attempts: 2 }), new RegExp(`expected ${img.top}`))
  assert.equal(existsSync(join(cache, img.entryName, 'complete')), false)
  assert.deepEqual(readdirSync(cache), [])
})

test('a run that finds the image completed by another run meanwhile keeps that one and discards its own', async () => {
  const img = image()
  const cache = newCache()
  const theirs = join(cache, img.entryName)
  const { fetch } = registry(img, {
    blob: (digest, calls) => {
      // another run sharing the cache finishes first, while this one is still pulling
      if (calls.blob === 1) {
        mkdirSync(join(theirs, 'rootfs'), { recursive: true })
        writeFileSync(join(theirs, 'theirs'), '')
        writeFileSync(join(theirs, 'complete'), `${img.reference}\n`)
      }
    },
  })
  assert.equal(await fetchImage(cache, img.reference, { ...quiet, fetch }), theirs)
  assert.ok(existsSync(join(theirs, 'theirs')))
  assert.equal(existsSync(join(theirs, 'rootfs/etc/good')), false)
  assert.deepEqual(readdirSync(cache), [img.entryName])
})
