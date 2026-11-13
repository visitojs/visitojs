// Fetches a pinned npm tarball once, checks it against the pinned integrity, and reads one file out of it.
// Nothing fetched here is committed: the tarballs stay in lab/compare/cache/, which git ignores.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

/** The Subresource Integrity string npm records for a tarball: sha512, base64. */
export function integrityOf(bytes) {
  return 'sha512-' + createHash('sha512').update(bytes).digest('base64')
}

/** Returns the integrity when it equals the pin; throws when it differs or when there is no usable pin. */
export function checkIntegrity(bytes, pinned, label) {
  if (typeof pinned !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(pinned)) throw new Error(`${label}: no sha512 pin, so it is not run`)
  const got = integrityOf(bytes)
  if (got !== pinned) throw new Error(`${label}: the tarball's integrity ${got} differs from the pinned ${pinned}`)
  return got
}

const field = (block, start, length) => {
  const raw = block.subarray(start, start + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end < 0 ? length : end).toString('utf8')
}

/** The bytes of one file in an uncompressed tar archive, or null when it holds no such file. */
export function readTar(archive, path) {
  let offset = 0
  let paxPath = null
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) return null
    const size = parseInt(field(header, 124, 12).trim() || '0', 8)
    const type = field(header, 156, 1)
    const prefix = field(header, 345, 155)
    const start = offset + 512
    if (start + size > archive.length) throw new Error(`tar archive truncated inside ${field(header, 0, 100)}`)
    const data = archive.subarray(start, start + size)
    offset = start + Math.ceil(size / 512) * 512
    if (type === 'x') {
      // a pax header: records of "length key=value\n", whose path replaces the next entry's name
      const text = data.toString('utf8')
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)
      paxPath = match ? match[1] : null
      continue
    }
    if (type === 'g') continue
    const name = paxPath || (prefix ? prefix + '/' : '') + field(header, 0, 100)
    paxPath = null
    if ((type === '0' || type === '' || type === '\0') && name === path) return Buffer.from(data)
  }
  return null
}

// npm is a .cmd shim on Windows that execFileSync cannot start; running its script with node needs no shell (as in test/bundle.test.mjs)
function npmCli() {
  if (/npm-cli\.js$/.test(process.env.npm_execpath || '')) return process.env.npm_execpath
  const dir = dirname(process.execPath)
  const found = [join(dir, 'node_modules/npm/bin/npm-cli.js'), join(dir, '../lib/node_modules/npm/bin/npm-cli.js')].find((p) => existsSync(p))
  if (!found) throw new Error(`npm's CLI script is not beside ${process.execPath}`)
  return found
}

/**
 * The pinned file of a library's npm tarball. The first run fetches the tarball with npm pack into cacheDir;
 * every run checks its integrity against the pin before reading anything from it.
 */
export function fetchPackage(lib, cacheDir) {
  const spec = `${lib.package}@${lib.version}`
  mkdirSync(cacheDir, { recursive: true })
  const tarball = join(cacheDir, lib.package.replace(/^@/, '').replace('/', '-') + '-' + lib.version + '.tgz')
  if (!existsSync(tarball)) {
    const out = execFileSync(process.execPath, [npmCli(), 'pack', spec, '--ignore-scripts', '--json', '--pack-destination', cacheDir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const packed = JSON.parse(out)[0]
    if (join(cacheDir, packed.filename) !== tarball) throw new Error(`${spec}: npm pack wrote ${packed.filename}, expected ${tarball}`)
  }
  const bytes = readFileSync(tarball)
  const integrity = checkIntegrity(bytes, lib.integrity, spec)
  const archive = gunzipSync(bytes)
  const manifest = JSON.parse(String(readTar(archive, 'package/package.json')))
  if (manifest.name !== lib.package || manifest.version !== lib.version) throw new Error(`${spec}: the tarball says ${manifest.name}@${manifest.version}`)
  const file = readTar(archive, lib.file)
  if (!file) throw new Error(`${spec}: the tarball has no ${lib.file}`)
  return { bytes: file, integrity, tarball }
}
