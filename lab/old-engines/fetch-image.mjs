// Pulls images from Docker Hub by digest and unpacks each into <cache>/<digest>/rootfs, with no Docker and no privilege.
// The manifest, the config and every layer are checked against their sha256 digests (and each unpacked layer against
// the config's diff_id) before the image is marked complete; an image already complete is not fetched again.
// Usage: node fetch-image.mjs <cache dir> <name[:tag]@sha256:...>...   Prints one image directory per reference.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, pipeline } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { createGunzip } from 'node:zlib'
import { ACCEPT, checkDigest, environment, isIndex, layersOf, parseChallenge, parseReference, selectPlatform, tokenUrl } from './oci.mjs'
import { applyLayer, remove } from './layers.mjs'

const ATTEMPTS = 4
const LOCAL = /^(open|write|close|symlink|link|mkdir|rmdir|unlink|rm|chmod|utime|lutime|lstat|readlink|scandir|rename)$/
const COMPLETE = 'complete'
const sha256 = (buffer) => `sha256:${createHash('sha256').update(buffer).digest('hex')}`
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const stderr = (message) => process.stderr.write(`${message}\n`)

function failure(response, what) {
  const error = new Error(`${what}: HTTP ${response.status}`)
  // 429 and 5xx may pass; anything else will not
  error.permanent = response.status !== 429 && response.status < 500
  return error
}

// one registry repository, with the anonymous pull token the registry asks for
function registry(ref, fetch) {
  const base = `https://${ref.registry}/v2/${ref.repository}`
  let token
  async function get(path, accept) {
    const headers = { accept }
    if (token) headers.authorization = `Bearer ${token}`
    let response = await fetch(base + path, { headers, redirect: 'follow' })
    if (response.status === 401) {
      await response.body?.cancel()
      const challenge = parseChallenge(response.headers.get('www-authenticate'))
      const auth = await fetch(tokenUrl(challenge, ref.repository))
      if (!auth.ok) throw failure(auth, 'token')
      const body = await auth.json()
      token = body.token || body.access_token
      response = await fetch(base + path, { headers: { accept, authorization: `Bearer ${token}` }, redirect: 'follow' })
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw failure(response, path)
    }
    return response
  }
  return {
    async manifest(digest) {
      const response = await get(`/manifests/${digest}`, ACCEPT)
      const raw = Buffer.from(await response.arrayBuffer())
      checkDigest(digest, sha256(raw), `manifest of ${ref.repository}`)
      return { manifest: JSON.parse(raw.toString('utf8')), type: (response.headers.get('content-type') || '').split(';')[0] }
    },
    async blob(digest) {
      const raw = Buffer.from(await (await get(`/blobs/${digest}`, '*/*')).arrayBuffer())
      checkDigest(digest, sha256(raw), `config of ${ref.repository}`)
      return raw
    },
    stream(digest) {
      return get(`/blobs/${digest}`, '*/*')
    },
  }
}

async function* hashed(source, hash, count) {
  for await (const chunk of source) {
    hash.update(chunk)
    count.bytes += chunk.length
    yield chunk
  }
}

async function unpack(hub, layer, diffId, rootfs, label, log) {
  const response = await hub.stream(layer.digest)
  const packed = createHash('sha256')
  const unpacked = createHash('sha256')
  const counts = { packed: { bytes: 0 }, unpacked: { bytes: 0 } }
  let source = Readable.from(hashed(Readable.fromWeb(response.body), packed, counts.packed))
  if (layer.compression === 'gzip') {
    const gunzip = createGunzip()
    pipeline(source, gunzip, () => {})
    source = gunzip
  }
  const result = await applyLayer(rootfs, hashed(source, unpacked, counts.unpacked))
  checkDigest(layer.digest, `sha256:${packed.digest('hex')}`, label)
  if (diffId) checkDigest(diffId, `sha256:${unpacked.digest('hex')}`, `${label}, unpacked`)
  if (result.skipped.length) log(`${label}: skipped ${result.skipped.length} device nodes and fifos (${result.skipped.slice(0, 5).join(', ')})`)
  return counts
}

// one whole pull into `staging`, which nothing else writes to
async function pull(ref, reference, staging, fetch, log) {
  mkdirSync(join(staging, 'rootfs'), { recursive: true })
  const hub = registry(ref, fetch)
  let { manifest, type } = await hub.manifest(ref.digest)
  if (isIndex(manifest, type)) ({ manifest } = await hub.manifest(selectPlatform(manifest).digest))
  // schema 1 carries the image config as text in its newest history entry
  const config = manifest.schemaVersion === 1
    ? JSON.parse(manifest.history[0].v1Compatibility)
    : JSON.parse((await hub.blob(manifest.config.digest)).toString('utf8'))
  const layers = layersOf(manifest)
  const diffIds = (config.rootfs && config.rootfs.diff_ids) || []
  if (manifest.schemaVersion !== 1 && diffIds.length !== layers.length) {
    const error = new Error(`${reference}: ${layers.length} layers but ${diffIds.length} diff_ids`)
    error.permanent = true
    throw error
  }
  const totals = { layers: layers.length, packed: 0, unpacked: 0 }
  for (let i = 0; i < layers.length; i++) {
    const label = `${reference.split('@')[0]} layer ${i + 1}/${layers.length}`
    const counts = await unpack(hub, layers[i], diffIds[i], join(staging, 'rootfs'), label, log)
    totals.packed += counts.packed.bytes
    totals.unpacked += counts.unpacked.bytes
  }
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 1))
  writeFileSync(join(staging, 'config.json'), JSON.stringify(config, null, 1))
  writeFileSync(join(staging, 'env'), environment(config).join('\n') + '\n')
  // inside the staging directory, so that the image directory never exists without it
  writeFileSync(join(staging, COMPLETE), `${reference}\n`)
  return totals
}

// Every attempt starts from an empty directory of its own: a layer that failed its digest has already written its
// files, and applying the good layer over them would keep any file that only the bad bytes had. Two runs that share the
// cache never write to the same directory, and the first to finish keeps its image
export async function fetchImage(cache, reference, { fetch = globalThis.fetch, attempts = ATTEMPTS, wait = pause, log = stderr } = {}) {
  const ref = parseReference(reference)
  const dir = join(cache, ref.digest.replace(':', '-'))
  if (existsSync(join(dir, COMPLETE))) return dir
  const staging = `${dir}.partial-${process.pid}`
  const started = Date.now()
  for (let attempt = 1; ; attempt++) {
    remove(staging)
    let totals
    try {
      totals = await pull(ref, reference, staging, fetch, log)
    } catch (error) {
      remove(staging)
      // a file system error (a full disk, a refused link) does not pass by trying again; a dropped connection may
      if (attempt >= attempts || error.permanent || LOCAL.test(error.syscall || '')) throw error
      log(`${reference.split('@')[0]}: ${error.message}; starting the image again`)
      await wait(2000 * attempt)
      continue
    }
    try {
      renameSync(staging, dir)
    } catch (error) {
      if (existsSync(join(dir, COMPLETE))) {
        // another run finished first
        remove(staging)
        return dir
      }
      // left by a run that stopped before it marked the image complete
      remove(dir)
      renameSync(staging, dir)
    }
    const mb = (bytes) => (bytes / 1048576).toFixed(0)
    log(`${reference.split('@')[0]}: ${totals.layers} layers, ${mb(totals.packed)} MB downloaded, ${mb(totals.unpacked)} MB unpacked in ${((Date.now() - started) / 1000).toFixed(0)} s`)
    return dir
  }
}

async function main() {
  const [cache, ...references] = process.argv.slice(2)
  if (!cache || !references.length) {
    stderr('usage: node fetch-image.mjs <cache dir> <name[:tag]@sha256:...>...')
    process.exit(2)
  }
  mkdirSync(cache, { recursive: true })
  try {
    for (const reference of references) process.stdout.write(`${await fetchImage(cache, reference)}\n`)
  } catch (error) {
    stderr(`fetch-image: ${error.message}`)
    process.exit(1)
  }
}

// run as a script, not imported by a test; by real path, since the module's own URL is resolved through any link
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main()
