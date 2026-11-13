// What fetch-image.mjs needs to know about Docker Hub and image manifests, kept free of I/O so that it can be tested.
// Sources: the OCI distribution specification (pulling manifests and blobs by digest), the OCI image specification
// (index, manifest, config, layer media types) and Docker's registry token authentication and image manifest
// documentation (schema 2, manifest list, schema 1).

const HUB = 'registry-1.docker.io'
const DEFAULT_PATH = 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

// every kind of manifest this tool reads; the registry answers with one of them for a digest
export const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.v1+prettyjws',
].join(', ')

const INDEXES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']
const DIGEST = /^sha256:[a-f0-9]{64}$/

// name[:tag]@sha256:<hex>, from Docker Hub only. The digest is required: it is what makes the image the one we tested
export function parseReference(ref) {
  const at = ref.lastIndexOf('@')
  const digest = at >= 0 ? ref.slice(at + 1) : ''
  if (!DIGEST.test(digest)) throw new Error(`${ref}: an image must be pinned by a sha256 digest`)
  let name = ref.slice(0, at)
  const slash = name.indexOf('/')
  const first = slash >= 0 ? name.slice(0, slash) : ''
  if (/[.:]/.test(first) || first === 'localhost') {
    if (first !== 'docker.io' && first !== 'index.docker.io') throw new Error(`${ref}: only images on Docker Hub are supported`)
    name = name.slice(slash + 1)
  }
  const colon = name.lastIndexOf(':')
  const tag = colon >= 0 ? name.slice(colon + 1) : undefined
  const path = colon >= 0 ? name.slice(0, colon) : name
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(path)) throw new Error(`${ref}: not a repository name`)
  return { registry: HUB, repository: path.includes('/') ? path : `library/${path}`, tag, digest }
}

// WWW-Authenticate: Bearer realm="...",service="...",scope="..."
export function parseChallenge(header) {
  const match = /^\s*(\w+)\s+(.*)$/.exec(header || '')
  if (!match || match[1].toLowerCase() !== 'bearer') throw new Error(`the registry asked for ${header}, not a bearer token`)
  const challenge = { scheme: 'bearer' }
  const pair = /(\w+)="([^"]*)"/g
  let found
  while ((found = pair.exec(match[2]))) challenge[found[1]] = found[2]
  if (!challenge.realm) throw new Error(`no realm in the registry's challenge: ${header}`)
  return challenge
}

// an anonymous token for pulling one repository
export function tokenUrl(challenge, repository) {
  const url = new URL(challenge.realm)
  if (challenge.service) url.searchParams.set('service', challenge.service)
  url.searchParams.set('scope', challenge.scope || `repository:${repository}:pull`)
  return url.toString()
}

export function isIndex(manifest, contentType) {
  const type = manifest.mediaType || contentType || ''
  return INDEXES.includes(type) || (!type && Array.isArray(manifest.manifests))
}

// the image for this runner from a multi-platform index
export function selectPlatform(index, os = 'linux', architecture = 'amd64') {
  const found = (index.manifests || []).find((m) => m.platform && m.platform.os === os && m.platform.architecture === architecture)
  if (!found) throw new Error(`the index has no ${os}/${architecture} image`)
  return found
}

function compression(mediaType) {
  if (/foreign|nondistributable/.test(mediaType)) throw new Error(`a foreign layer cannot be pulled from the registry: ${mediaType}`)
  if (/zstd/.test(mediaType)) throw new Error(`zstd layers are not supported: ${mediaType}`)
  if (/tar\.gzip$|tar\+gzip$/.test(mediaType)) return 'gzip'
  if (/\.tar$/.test(mediaType)) return 'none'
  throw new Error(`unknown layer type: ${mediaType}`)
}

// the layers bottom first, which is the order they are applied in
export function layersOf(manifest) {
  if (manifest.schemaVersion === 1) {
    // schema 1 lists the newest layer first; its layers are always gzip
    return (manifest.fsLayers || []).map((layer) => ({ digest: layer.blobSum, size: undefined, compression: 'gzip' })).reverse()
  }
  return (manifest.layers || []).map((layer) => ({ digest: layer.digest, size: layer.size, compression: compression(layer.mediaType || '') }))
}

export function checkDigest(expected, actual, what) {
  if (!DIGEST.test(expected)) throw new Error(`${what}: only sha256 digests are checked, not ${expected}`)
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`)
}

// the variables the image's config sets, as Docker passes them to a container; Docker adds a PATH when the image has none
export function environment(config) {
  const env = ((config && config.config && config.config.Env) || []).slice()
  for (const pair of env) if (/[\r\n]/.test(pair)) throw new Error(`an environment variable with a line break: ${pair.split('=')[0]}`)
  if (!env.some((pair) => pair.startsWith('PATH='))) env.unshift(DEFAULT_PATH)
  return env
}
