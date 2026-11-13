import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  parseReference, parseChallenge, tokenUrl, isIndex, selectPlatform, layersOf, checkDigest, environment,
} from '../lab/old-engines/oci.mjs'

const sha = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`
const DIGEST = `sha256:${'a'.repeat(64)}`

test('a reference names the repository, the tag and the digest it is pinned by', () => {
  assert.deepEqual(parseReference(`selenium/standalone-chrome:3.4.0-einsteinium@${DIGEST}`), {
    registry: 'registry-1.docker.io', repository: 'selenium/standalone-chrome', tag: '3.4.0-einsteinium', digest: DIGEST,
  })
  // an official image lives under library/
  assert.equal(parseReference(`busybox:1.36-musl@${DIGEST}`).repository, 'library/busybox')
  assert.equal(parseReference(`busybox@${DIGEST}`).tag, undefined)
})

test('a reference without a sha256 digest is refused: a tag can be re-pointed', () => {
  assert.throws(() => parseReference('selenium/standalone-chrome:2.53.0'), /digest/)
  assert.throws(() => parseReference('busybox@sha256:abc'), /digest/)
  assert.throws(() => parseReference(`quay.io/x/y@${DIGEST}`), /Docker Hub/)
})

test('the bearer challenge gives the token endpoint', () => {
  const challenge = parseChallenge('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/busybox:pull"')
  assert.deepEqual(challenge, {
    scheme: 'bearer', realm: 'https://auth.docker.io/token', service: 'registry.docker.io', scope: 'repository:library/busybox:pull',
  })
  assert.equal(tokenUrl(challenge, 'library/busybox'),
    'https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fbusybox%3Apull')
  // no scope in the challenge: the pull scope of the repository is asked for
  assert.equal(tokenUrl(parseChallenge('Bearer realm="https://a.example/t"'), 'x/y'), 'https://a.example/t?scope=repository%3Ax%2Fy%3Apull')
  assert.throws(() => parseChallenge('Basic realm="x"'), /bearer/i)
})

test('an image index is told from a manifest by its media type', () => {
  assert.equal(isIndex({ mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] }), true)
  assert.equal(isIndex({ mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json', manifests: [] }), true)
  // an OCI index may leave mediaType out; the content type of the response says what it is
  assert.equal(isIndex({ manifests: [] }, 'application/vnd.oci.image.index.v1+json'), true)
  assert.equal(isIndex({ mediaType: 'application/vnd.docker.distribution.manifest.v2+json', layers: [] }), false)
})

test('the linux/amd64 manifest is picked from an index, attestations and other platforms skipped', () => {
  const index = {
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      { digest: sha('arm'), platform: { os: 'linux', architecture: 'arm', variant: 'v6' } },
      { digest: sha('att'), platform: { os: 'unknown', architecture: 'unknown' } },
      { digest: sha('amd64'), platform: { os: 'linux', architecture: 'amd64' } },
    ],
  }
  assert.equal(selectPlatform(index).digest, sha('amd64'))
  assert.throws(() => selectPlatform({ manifests: [index.manifests[0]] }), /linux\/amd64/)
})

test('layers come in the order they are applied, with their digests and compression', () => {
  const docker = {
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: { digest: sha('config') },
    layers: [
      { mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', digest: sha('base'), size: 10 },
      { mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', digest: sha('top'), size: 3 },
    ],
  }
  assert.deepEqual(layersOf(docker), [
    { digest: sha('base'), size: 10, compression: 'gzip' },
    { digest: sha('top'), size: 3, compression: 'gzip' },
  ])
  const oci = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { digest: sha('config') },
    layers: [
      { mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: sha('a'), size: 1 },
      { mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: sha('b'), size: 2 },
    ],
  }
  assert.deepEqual(layersOf(oci).map((layer) => layer.compression), ['gzip', 'none'])
  // schema 1 lists the newest layer first
  const v1 = { schemaVersion: 1, fsLayers: [{ blobSum: sha('top') }, { blobSum: sha('base') }] }
  assert.deepEqual(layersOf(v1).map((layer) => layer.digest), [sha('base'), sha('top')])
})

test('a layer type that cannot be unpacked is refused, not skipped', () => {
  const zstd = { schemaVersion: 2, layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+zstd', digest: sha('z'), size: 1 }] }
  assert.throws(() => layersOf(zstd), /zstd/)
  const foreign = { schemaVersion: 2, layers: [{ mediaType: 'application/vnd.docker.image.rootfs.foreign.diff.tar.gzip', digest: sha('f'), size: 1 }] }
  assert.throws(() => layersOf(foreign), /foreign/)
})

test('content is accepted only when its sha256 is the digest asked for', () => {
  assert.doesNotThrow(() => checkDigest(sha('x'), sha('x'), 'manifest'))
  assert.throws(() => checkDigest(sha('x'), sha('y'), 'layer 2'), /layer 2.*sha256:2d71/)
  assert.throws(() => checkDigest('md5:00', sha('y'), 'blob'), /sha256/)
})

test('the environment of the image comes from its config, with a PATH when it sets none', () => {
  assert.deepEqual(environment({ config: { Env: ['PATH=/opt/bin:/usr/bin', 'LANG=en_US.UTF-8'] } }), ['PATH=/opt/bin:/usr/bin', 'LANG=en_US.UTF-8'])
  assert.deepEqual(environment({ config: { Env: ['TZ=UTC'] } }),
    ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'TZ=UTC'])
  assert.deepEqual(environment({}), ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'])
  // one variable per line in the file the run reads
  assert.throws(() => environment({ config: { Env: ['A=x\ny'] } }), /line break/)
})
