// Applies one image layer, an uncompressed tar stream, to a directory as an unprivileged user. Written from the POSIX
// ustar and pax formats and the OCI image layer specification (whiteouts, opaque directories, the order of changesets).
// Owners are not kept: inside the run the user namespace maps the one user who owns the files to root. Device nodes and
// fifos cannot be made without privilege and are skipped: the run mounts its own /dev. Links are resolved as if the
// directory were the root, so a link in the image can never make a write land outside it.
import {
  linkSync, lstatSync, lutimesSync, mkdirSync, openSync, readdirSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync,
  utimesSync, writeSync, closeSync, chmodSync,
} from 'node:fs'
import { join } from 'node:path'

const BLOCK = 512
const OPAQUE = '.wh..wh..opq'
const WHITEOUT = '.wh.'
// symbolic links followed while resolving one path, as Linux allows
const MAX_HOPS = 40

// a member name as a path relative to the root; '' is the root itself
export function cleanPath(name) {
  const parts = []
  for (const part of name.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') throw new Error(`a layer path with "..": ${name}`)
    parts.push(part)
  }
  return parts.join('/')
}

export function whiteout(path) {
  const slash = path.lastIndexOf('/')
  const dir = slash >= 0 ? path.slice(0, slash) : ''
  const base = path.slice(slash + 1)
  if (base === OPAQUE) return { opaque: dir }
  if (base.startsWith(WHITEOUT)) return { remove: (dir ? `${dir}/` : '') + base.slice(WHITEOUT.length) }
  return null
}

function text(block, start, length) {
  const field = block.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end >= 0 ? end : field.length).toString('utf8')
}

// octal digits, or base-256 when the first byte has its high bit set (sizes over 8 GiB, large ids)
function number(block, start, length) {
  if (block[start] & 0x80) {
    let value = block[start] & 0x7f
    for (let i = start + 1; i < start + length; i++) value = value * 256 + block[i]
    return value
  }
  const digits = text(block, start, length).trim()
  return digits ? parseInt(digits, 8) : 0
}

export function parseHeader(block) {
  if (block.every((byte) => byte === 0)) return null
  let unsigned = 0
  let signed = 0
  for (let i = 0; i < BLOCK; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : block[i]
    unsigned += byte
    signed += byte > 127 ? byte - 256 : byte
  }
  const stored = number(block, 148, 8)
  if (stored !== unsigned && stored !== signed) throw new Error('a tar header with a bad checksum: the layer is corrupt')
  const name = text(block, 0, 100)
  // the prefix field exists in ustar only; GNU tar keeps other data there
  const prefix = block.subarray(257, 263).toString('latin1') === 'ustar\0' ? text(block, 345, 155) : ''
  return {
    name: prefix ? `${prefix}/${name}` : name,
    mode: number(block, 100, 8),
    size: number(block, 124, 12),
    mtime: number(block, 136, 12),
    type: text(block, 156, 1) || '0',
    linkname: text(block, 157, 100),
  }
}

// "<length> <key>=<value>\n" records
export function parsePax(buffer) {
  const records = {}
  let at = 0
  while (at < buffer.length) {
    const space = buffer.indexOf(0x20, at)
    if (space < 0) break
    const length = parseInt(buffer.subarray(at, space).toString('latin1'), 10)
    if (!(length > 0)) throw new Error('a malformed pax record')
    const record = buffer.subarray(space + 1, at + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1)
    at += length
  }
  return records
}

// reads exact byte counts from an async iterable of chunks
function reader(source) {
  const iterator = source[Symbol.asyncIterator]()
  let pending = Buffer.alloc(0)
  async function fill() {
    const next = await iterator.next()
    if (next.done) return false
    pending = pending.length ? Buffer.concat([pending, next.value]) : Buffer.from(next.value)
    return true
  }
  return {
    // null at a clean end of the stream, an error inside a block
    async block() {
      while (pending.length < BLOCK) {
        if (!(await fill())) {
          if (!pending.length) return null
          throw new Error('the layer is truncated')
        }
      }
      const out = pending.subarray(0, BLOCK)
      pending = pending.subarray(BLOCK)
      return out
    },
    async exact(count) {
      while (pending.length < count) if (!(await fill())) throw new Error('the layer is truncated')
      const out = pending.subarray(0, count)
      pending = pending.subarray(count)
      return out
    },
    // up to `count` bytes, at least one
    async some(count) {
      if (!pending.length && !(await fill())) throw new Error('the layer is truncated')
      const out = pending.subarray(0, Math.min(count, pending.length))
      pending = pending.subarray(out.length)
      return out
    },
    async drain() {
      pending = Buffer.alloc(0)
      while (await fill()) pending = Buffer.alloc(0)
    },
  }
}

// deletes a file, a link or a whole tree without ever following a link. fs.rmSync is not used: under gVisor it left
// absolute symbolic links in place without an error
export function remove(path) {
  const stat = lstat(path)
  if (!stat) return
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) remove(join(path, name))
    rmdirSync(path)
  } else {
    unlinkSync(path)
  }
}

const padding = (size) => (BLOCK - (size % BLOCK)) % BLOCK

function lstat(path) {
  try { return lstatSync(path) } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error }
}

// the components of `path` with every symbolic link along it resolved as if `root` were /; the last one is followed
// only when `followLast` is set. ".." stops at the root, as it does there
function resolve(root, path, followLast) {
  const done = []
  let todo = path.split('/')
  let hops = 0
  while (todo.length) {
    const part = todo.shift()
    if (part === '' || part === '.') continue
    if (part === '..') { done.pop(); continue }
    const stat = lstat(join(root, ...done, part))
    if (stat && stat.isSymbolicLink() && (todo.length || followLast)) {
      if (++hops > MAX_HOPS) throw new Error(`too many symbolic links in ${path}`)
      const target = readlinkSync(join(root, ...done, part))
      if (target.startsWith('/')) done.length = 0
      todo = target.split('/').concat(todo)
      continue
    }
    done.push(part)
  }
  return done
}

// makes every missing directory of `parts`; all of them are real directories after resolve()
function makeDirs(root, parts) {
  for (let i = 1; i <= parts.length; i++) {
    const path = join(root, ...parts.slice(0, i))
    const stat = lstat(path)
    if (!stat) mkdirSync(path, { mode: 0o755 })
    else if (!stat.isDirectory()) throw new Error(`${parts.slice(0, i).join('/')} is not a directory`)
  }
}

const fileMode = (mode) => (mode & 0o777) | 0o600
// sticky kept for /tmp-like directories; setuid and setgid never
const dirMode = (mode) => (mode & 0o1777) | 0o700

export async function applyLayer(root, source) {
  const input = reader(source)
  // every path this layer makes, and their parents: an opaque directory keeps these and hides the rest
  const made = new Set()
  const dirs = []
  const skipped = []
  let entries = 0
  let pax = {}
  let longName
  let longLink

  const mark = (parts) => { for (let i = 1; i <= parts.length; i++) made.add(parts.slice(0, i).join('/')) }

  function prune(parts) {
    const path = join(root, ...parts)
    const stat = lstat(path)
    if (!stat || !stat.isDirectory()) return
    for (const name of readdirSync(path)) {
      const child = parts.concat(name)
      const key = child.join('/')
      if (!made.has(key)) remove(join(root, ...child))
      else prune(child)
    }
  }

  async function skip(size) {
    let left = size + padding(size)
    while (left > 0) left -= (await input.some(left)).length
  }

  async function writeFile(path, size, mode) {
    const fd = openSync(path, 'w', fileMode(mode))
    try {
      let left = size
      while (left > 0) {
        const chunk = await input.some(Math.min(left, 1 << 20))
        writeSync(fd, chunk)
        left -= chunk.length
      }
    } finally {
      closeSync(fd)
    }
    await input.exact(padding(size))
    chmodSync(path, fileMode(mode))
  }

  for (;;) {
    const block = await input.block()
    if (!block) break
    const head = parseHeader(block)
    if (!head) {
      await input.drain()
      break
    }
    const size = pax.size !== undefined ? Number(pax.size) : head.size
    if (head.type === 'x' || head.type === 'g' || head.type === 'L' || head.type === 'K') {
      const data = Buffer.from(await input.exact(size))
      await input.exact(padding(size))
      if (head.type === 'x') pax = parsePax(data)
      else if (head.type === 'L') longName = text(data, 0, data.length)
      else if (head.type === 'K') longLink = text(data, 0, data.length)
      // a global pax header carries nothing a layer needs
      continue
    }
    const name = pax.path !== undefined ? pax.path : longName !== undefined ? longName : head.name
    const link = pax.linkpath !== undefined ? pax.linkpath : longLink !== undefined ? longLink : head.linkname
    const mtime = pax.mtime !== undefined ? Number(pax.mtime) : head.mtime
    pax = {}
    longName = longLink = undefined
    entries++

    const path = cleanPath(name)
    const gone = whiteout(path)
    if (gone) {
      if (gone.opaque !== undefined) {
        const parts = resolve(root, gone.opaque, true)
        mark(parts)
        prune(parts)
      } else {
        const parts = resolve(root, gone.remove, false)
        remove(join(root, ...parts))
      }
      await skip(size)
      continue
    }
    if (head.type === '3' || head.type === '4' || head.type === '6') {
      skipped.push(path)
      await skip(size)
      continue
    }
    if (!path) {
      // the root directory itself
      await skip(size)
      continue
    }
    const parts = resolve(root, path, false)
    if (!parts.length) throw new Error(`${path} resolves to the root`)
    makeDirs(root, parts.slice(0, -1))
    const target = join(root, ...parts)
    const existing = lstat(target)
    mark(parts)

    if (head.type === '5') {
      if (existing && !existing.isDirectory()) remove(target)
      if (!existing || !existing.isDirectory()) mkdirSync(target)
      chmodSync(target, dirMode(head.mode))
      dirs.push([target, mtime])
      await skip(size)
      continue
    }
    if (existing) remove(target)
    if (head.type === '0' || head.type === '7') {
      await writeFile(target, size, head.mode)
      utimesSync(target, mtime, mtime)
    } else if (head.type === '1') {
      const source = join(root, ...resolve(root, cleanPath(link), false))
      const stat = lstat(source)
      if (!stat || stat.isDirectory()) throw new Error(`a hard link to ${link}, which is not a file in the image: ${path}`)
      linkSync(source, target)
      await skip(size)
    } else if (head.type === '2') {
      symlinkSync(link, target)
      lutimesSync(target, mtime, mtime)
      await skip(size)
    } else {
      throw new Error(`unsupported tar entry type ${JSON.stringify(head.type)}: ${path}`)
    }
  }
  // last, because making the entries inside a directory changes its time. A later entry of this layer may have replaced
  // the directory with a link, which utimes would follow out of the image, so only what is still a directory is touched
  for (const [dir, mtime] of dirs.reverse()) {
    const stat = lstat(dir)
    if (stat && stat.isDirectory()) utimesSync(dir, mtime, mtime)
  }
  return { entries, skipped }
}
