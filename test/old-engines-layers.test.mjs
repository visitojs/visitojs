import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanPath, whiteout, parseHeader, parsePax, applyLayer, remove } from '../lab/old-engines/layers.mjs'
import { header, entry, pax, archive } from './old-engines-tar.mjs'

const dir = mkdtempSync(join(tmpdir(), 'visito-layers-'))
after(() => rmSync(dir, { recursive: true, force: true }))
let roots = 0
const newRoot = () => { const root = join(dir, `root${roots++}`); mkdirSync(root); return root }

// Windows without developer mode cannot make symbolic links; CI runs these on Linux
const SYMLINKS = (() => {
  try { symlinkSync('x', join(dir, 'probe')); return true } catch { return false }
})()
const needsLinks = { skip: !SYMLINKS && 'this system does not let an unprivileged user make symbolic links' }

// split the archive at odd offsets, as a network stream would
async function* chunks(buffer, size = 700) { for (let i = 0; i < buffer.length; i += size) yield buffer.subarray(i, i + size) }

test('paths in a layer are taken relative to the root, and ".." is refused', () => {
  assert.equal(cleanPath('./usr/bin/'), 'usr/bin')
  assert.equal(cleanPath('/etc//passwd'), 'etc/passwd')
  assert.equal(cleanPath('./'), '')
  assert.throws(() => cleanPath('usr/../../etc'), /\.\./)
})

test('whiteouts name what a layer removes from the layers below it', () => {
  assert.deepEqual(whiteout('etc/.wh.motd'), { remove: 'etc/motd' })
  assert.deepEqual(whiteout('.wh.tmp'), { remove: 'tmp' })
  assert.deepEqual(whiteout('var/cache/.wh..wh..opq'), { opaque: 'var/cache' })
  assert.equal(whiteout('etc/motd'), null)
  assert.equal(whiteout('etc/x.wh.y'), null)
})

test('a header is read from its octal fields and its checksum is checked', () => {
  const block = header({ name: 'bin/sh', size: 5, mode: 0o755, prefix: 'usr' })
  const parsed = parseHeader(block)
  assert.equal(parsed.name, 'usr/bin/sh')
  assert.equal(parsed.size, 5)
  assert.equal(parsed.mode, 0o755)
  assert.equal(parsed.type, '0')
  assert.equal(parsed.mtime, 1500000000)
  assert.equal(parseHeader(Buffer.alloc(512)), null)
  const broken = Buffer.from(block)
  broken[0] ^= 1
  assert.throws(() => parseHeader(broken), /checksum/)
})

test('a size too large for octal is read in base-256', () => {
  const block = header({ name: 'big' })
  block.fill(0, 124, 136)
  block[124] = 0x80
  block.writeUIntBE(9 * 2 ** 30, 130, 6)
  let sum = 0
  block.fill(0x20, 148, 156)
  for (const byte of block) sum += byte
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  assert.equal(parseHeader(block).size, 9 * 2 ** 30)
})

test('pax records override the path, link and size', () => {
  const body = Buffer.from('30 path=a/very/long/name/here\n21 linkpath=target/x\n12 size=123\n')
  assert.deepEqual(parsePax(body), { path: 'a/very/long/name/here', linkpath: 'target/x', size: '123' })
})

test('a layer unpacks files, directories and hard links, with their modes and times', async () => {
  const root = newRoot()
  await applyLayer(root, chunks(archive(
    entry({ name: 'usr/', type: '5', mode: 0o755 }),
    entry({ name: 'usr/bin/', type: '5', mode: 0o555 }),
    entry({ name: 'usr/bin/tool', mode: 0o4755 }, 'echo hi\n'),
    entry({ name: 'usr/bin/same', type: '1', linkname: 'usr/bin/tool' }),
    pax({ path: `usr/${'n'.repeat(120)}` }),
    entry({ name: 'ignored-by-pax' }, 'long'),
  )))
  assert.equal(readFileSync(join(root, 'usr/bin/tool'), 'utf8'), 'echo hi\n')
  assert.equal(readFileSync(join(root, 'usr/bin/same'), 'utf8'), 'echo hi\n')
  assert.equal(readFileSync(join(root, 'usr', 'n'.repeat(120)), 'utf8'), 'long')
  assert.equal(existsSync(join(root, 'ignored-by-pax')), false)
  assert.equal(lstatSync(join(root, 'usr/bin/tool')).mtimeMs, 1500000000 * 1000)
  if (process.platform !== 'win32') {
    // setuid is dropped and the owner can always write, so that the next layer can replace what this one made
    assert.equal(lstatSync(join(root, 'usr/bin/tool')).mode & 0o7777, 0o755)
    assert.equal(lstatSync(join(root, 'usr/bin')).mode & 0o777, 0o755)
  }
})

test('device nodes and fifos are skipped and counted', async () => {
  const root = newRoot()
  const result = await applyLayer(root, chunks(archive(
    entry({ name: 'dev/', type: '5' }),
    entry({ name: 'dev/null', type: '3' }),
    entry({ name: 'dev/sda', type: '4' }),
    entry({ name: 'run/pipe', type: '6' }),
    entry({ name: 'etc/ok' }, 'x'),
  )))
  assert.deepEqual(result.skipped, ['dev/null', 'dev/sda', 'run/pipe'])
  assert.equal(existsSync(join(root, 'dev/null')), false)
  assert.equal(readFileSync(join(root, 'etc/ok'), 'utf8'), 'x')
})

test('a whiteout removes a lower file; an opaque directory keeps only what its own layer adds', async () => {
  const root = newRoot()
  await applyLayer(root, chunks(archive(
    entry({ name: 'etc/motd' }, 'old'),
    entry({ name: 'etc/keep' }, 'keep'),
    entry({ name: 'var/cache/a/old' }, 'old'),
    entry({ name: 'var/cache/b' }, 'old'),
  )))
  await applyLayer(root, chunks(archive(
    entry({ name: 'etc/.wh.motd' }),
    entry({ name: 'var/cache/a/', type: '5' }),
    entry({ name: 'var/cache/a/new' }, 'new'),
    // the marker after the entries of its own layer must not remove them
    entry({ name: 'var/cache/.wh..wh..opq' }),
  )))
  assert.equal(existsSync(join(root, 'etc/motd')), false)
  assert.equal(existsSync(join(root, 'etc/.wh.motd')), false)
  assert.equal(readFileSync(join(root, 'etc/keep'), 'utf8'), 'keep')
  assert.equal(readFileSync(join(root, 'var/cache/a/new'), 'utf8'), 'new')
  assert.equal(existsSync(join(root, 'var/cache/a/old')), false)
  assert.equal(existsSync(join(root, 'var/cache/b')), false)
  assert.equal(existsSync(join(root, 'var/cache/.wh..wh..opq')), false)
})

test('a later entry replaces what is at its path', async () => {
  const root = newRoot()
  await applyLayer(root, chunks(archive(entry({ name: 'a/x' }, 'file'), entry({ name: 'b' }, 'file'))))
  await applyLayer(root, chunks(archive(entry({ name: 'a', }, 'now a file'), entry({ name: 'b/', type: '5' }), entry({ name: 'b/y' }, 'y'))))
  assert.equal(readFileSync(join(root, 'a'), 'utf8'), 'now a file')
  assert.equal(readFileSync(join(root, 'b/y'), 'utf8'), 'y')
})

test('symbolic links are made as they are and are resolved inside the root, never outside it', needsLinks, async () => {
  const root = newRoot()
  const outside = join(dir, 'outside')
  mkdirSync(outside, { recursive: true })
  await applyLayer(root, chunks(archive(
    entry({ name: 'usr/lib/', type: '5' }),
    entry({ name: 'lib', type: '2', linkname: 'usr/lib' }),
    // an absolute link points into the image, as it would after chroot
    entry({ name: 'opt/abs', type: '2', linkname: '/usr/lib' }),
    entry({ name: 'opt/escape', type: '2', linkname: '../../../../../../../../' + outside.replace(/^\//, '') }),
  )))
  assert.equal(readlinkSync(join(root, 'opt/abs')), '/usr/lib')
  await applyLayer(root, chunks(archive(
    entry({ name: 'lib/a' }, 'via relative'),
    entry({ name: 'opt/abs/b' }, 'via absolute'),
    entry({ name: 'opt/escape/c' }, 'must stay in the root'),
  )))
  assert.equal(readFileSync(join(root, 'usr/lib/a'), 'utf8'), 'via relative')
  assert.equal(readFileSync(join(root, 'usr/lib/b'), 'utf8'), 'via absolute')
  assert.equal(existsSync(join(outside, 'c')), false)
  // ".." stops at the root, so the escaping link lands on a path inside it
  assert.equal(readFileSync(join(root, outside, 'c'), 'utf8'), 'must stay in the root')
})

// fs.rmSync left an absolute symbolic link in place under gVisor, so that a later layer could not replace it
test('remove deletes links and trees and never what a link points to', needsLinks, () => {
  const root = newRoot()
  const target = join(dir, 'kept')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'file'), 'kept')
  mkdirSync(join(root, 'tree/sub'), { recursive: true })
  writeFileSync(join(root, 'tree/sub/f'), 'x')
  symlinkSync(target, join(root, 'tree/abs'))
  symlinkSync(target, join(root, 'link'))
  symlinkSync('/nowhere/at/all', join(root, 'dangling'))
  remove(join(root, 'link'))
  remove(join(root, 'dangling'))
  remove(join(root, 'tree'))
  remove(join(root, 'missing'))
  assert.equal(lstatSync(join(root, 'link'), { throwIfNoEntry: false }), undefined)
  assert.equal(lstatSync(join(root, 'dangling'), { throwIfNoEntry: false }), undefined)
  assert.equal(existsSync(join(root, 'tree')), false)
  assert.equal(readFileSync(join(target, 'file'), 'utf8'), 'kept')
})

test('a directory that a later entry replaces with a link does not have its time set through that link', needsLinks, async () => {
  const root = newRoot()
  const outside = join(dir, 'outside-time')
  writeFileSync(outside, 'not ours')
  utimesSync(outside, 1000000000, 1000000000)
  await applyLayer(root, chunks(archive(
    entry({ name: 'a/', type: '5', mtime: 1500000000 }),
    entry({ name: 'a', type: '2', linkname: outside }),
  )))
  assert.equal(readlinkSync(join(root, 'a')), outside)
  assert.equal(statSync(outside).mtimeMs, 1000000000 * 1000)
})

test('a hard link to a path outside the root is refused', needsLinks, async () => {
  const root = newRoot()
  const secret = join(dir, 'secret')
  writeFileSync(secret, 'secret')
  await applyLayer(root, chunks(archive(entry({ name: 'etc', type: '2', linkname: dir }))))
  // inside the root etc/secret does not exist, so the link has nothing to point at
  await assert.rejects(applyLayer(root, chunks(archive(entry({ name: 'copy', type: '1', linkname: 'etc/secret' })))), /hard link/)
  assert.equal(existsSync(join(root, 'copy')), false)
})

test('a truncated layer fails', async () => {
  const root = newRoot()
  const full = archive(entry({ name: 'f' }, 'x'.repeat(2000)))
  await assert.rejects(applyLayer(root, chunks(full.subarray(0, 1200))), /truncated|end/)
})
