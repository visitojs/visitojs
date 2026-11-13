// What a run records about where its bytes came from: a digest of each bundle served, a refusal to serve a VisitoJS
// bundle that is older than the sources it is built from, and the files whose uncommitted changes would change a run.
import { createHash } from 'node:crypto'

/** The sha256 of the bytes served, in hex. */
export function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Throws when the built bundle is missing or older than any of its sources, naming the newest source.
 * built: { path, mtimeMs } or null; sources: [{ path, mtimeMs }].
 */
export function checkBuild(built, sources) {
  if (!built) throw new Error('there is no built bundle: run npm run build first')
  const newer = sources.filter((s) => s.mtimeMs > built.mtimeMs).sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (newer.length) throw new Error(`${built.path} is older than ${newer[0].path}${newer.length > 1 ? ` and ${newer.length - 1} other sources` : ''}: run npm run build first`)
}

/**
 * The files a comparison run depends on besides the libraries it serves: the harness, everything it imports, and the
 * table generator. A run records whether any of them has uncommitted changes; test/compare.test.mjs checks that the
 * list covers every file lab/compare.mjs imports.
 */
export const HARNESS_FILES = ['lab/compare.mjs', 'lab/compare', 'lab/phone.mjs', 'lab/launch.mjs']
