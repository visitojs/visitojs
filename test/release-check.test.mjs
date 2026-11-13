import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { changelogSection, checkLatest, checkVersions, releaseNotes, versionFromTag } from '../.github/scripts/release-check.mjs'

const SCRIPT = fileURLToPath(new URL('../.github/scripts/release-check.mjs', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'visito-release-check-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const CHANGELOG = `# Changelog

Intro.

## [Unreleased]

## [1.2.0] - 2027-01-02

### Fixed

- One thing.

## [1.2.0-rc.1] - 2027-01-01

## [1.1.0] - 2026-12-01

- Older.
`

test('a release tag is v and a version; anything else is refused', () => {
  assert.equal(versionFromTag('v1.2.0'), '1.2.0')
  assert.equal(versionFromTag('v1.2.0-rc.1'), '1.2.0-rc.1')
  for (const tag of ['1.2.0', 'v1.2', 'v1.2.0.1', 'v01.2.0', 'v1.2.0-', 'v1.2.0+build', 'v1.2.0;id', 'vx', '']) assert.throws(() => versionFromTag(tag), /not a release tag/, tag)
})

test('the version must be the same in the tag, package.json and both places in package-lock.json', () => {
  const lock = (version, root = version) => ({ version, packages: { '': { version: root } } })
  assert.doesNotThrow(() => checkVersions('1.2.0', { version: '1.2.0' }, lock('1.2.0')))
  assert.throws(() => checkVersions('1.2.0', { version: '1.1.0' }, lock('1.2.0')), /package\.json has 1\.1\.0/)
  assert.throws(() => checkVersions('1.2.0', { version: '1.2.0' }, lock('1.1.0', '1.2.0')), /package-lock\.json has 1\.1\.0/)
  assert.throws(() => checkVersions('1.2.0', { version: '1.2.0' }, lock('1.2.0', '1.1.0')), /package-lock\.json's root package has 1\.1\.0/)
  assert.throws(() => checkVersions('1.2.0', { version: '1.2.0' }, { version: '1.2.0' }), /package-lock\.json's root package has nothing/)
})

test('the changelog section of a version is its text up to the next heading of the same level', () => {
  assert.equal(changelogSection(CHANGELOG, '1.2.0'), '### Fixed\n\n- One thing.')
  assert.equal(changelogSection(CHANGELOG, '1.1.0'), '- Older.')
})

test('a version with no changelog section, or an empty one, is refused', () => {
  assert.throws(() => changelogSection(CHANGELOG, '1.3.0'), /CHANGELOG\.md has no section for 1\.3\.0/)
  assert.throws(() => changelogSection(CHANGELOG, '1.2.0-rc.1'), /section for 1\.2\.0-rc\.1 in CHANGELOG\.md is empty/)
  // a heading that only starts with the version is another version
  assert.throws(() => changelogSection('## [1.2.0-rc.1]\n\n- x\n', '1.2.0'), /no section for 1\.2\.0/)
  assert.throws(() => changelogSection('## [1x2y0]\n\n- x\n', '1.2.0'), /no section for 1\.2\.0/)
})

test('a version without a pre-release part becomes latest on npm, so it must not be lower than the latest there', () => {
  assert.doesNotThrow(() => checkLatest('1.2.0', '1.1.9'))
  assert.doesNotThrow(() => checkLatest('2.0.0', '1.10.3'))
  assert.doesNotThrow(() => checkLatest('1.10.0', '1.9.0'), 'numbers, not text')
  // the same version again is a re-run, and a release is higher than its own pre-releases
  assert.doesNotThrow(() => checkLatest('1.2.0', '1.2.0'))
  assert.doesNotThrow(() => checkLatest('1.2.0', '1.2.0-rc.1'))
  assert.throws(() => checkLatest('0.1.5', '0.2.0'), /npm's latest is 0\.2\.0, and 0\.1\.5 is lower/)
  assert.throws(() => checkLatest('1.9.0', '1.10.0'), /is lower/)
  assert.throws(() => checkLatest('1.2.0', '2.0.0'), /is lower/)
  // a pre-release goes under the next tag and leaves latest alone
  assert.doesNotThrow(() => checkLatest('0.1.1-rc.0', '0.2.0'))
  // when npm's answer cannot be read, the release stops rather than guess
  for (const latest of ['', undefined, 'not a version']) assert.throws(() => checkLatest('1.2.0', latest), /latest version on npm could not be read/, String(latest))
})

test('the release notes are the section and the CDN integrity of the minified build', () => {
  const file = Buffer.from('var a=1')
  const sri = `sha384-${createHash('sha384').update(file).digest('base64')}`
  assert.equal(releaseNotes('- One thing.', file), `- One thing.\n\nCDN integrity for \`dist/visito.min.js\`:\n\`${sri}\`\n`)
})

function project(name, { tag, version = '1.2.0', lockVersion = version, changelog = CHANGELOG, latest = '1.1.0' }) {
  const cwd = join(dir, name)
  mkdirSync(join(cwd, 'dist'), { recursive: true })
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'visitojs', version }))
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({ name: 'visitojs', version: lockVersion, packages: { '': { name: 'visitojs', version: lockVersion } } }))
  writeFileSync(join(cwd, 'CHANGELOG.md'), changelog)
  writeFileSync(join(cwd, 'dist', 'visito.min.js'), 'var a=1')
  writeFileSync(join(cwd, 'output.txt'), '')
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_REF_NAME: tag, GITHUB_OUTPUT: join(cwd, 'output.txt'), NPM_LATEST: latest } })
  return { cwd, run }
}

test('check: a good release writes its version and whether it is a pre-release for the later jobs', () => {
  const { cwd, run } = project('good', { tag: 'v1.2.0' })
  const result = run('check')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(readFileSync(join(cwd, 'output.txt'), 'utf8'), 'version=1.2.0\nprerelease=false\n')
})

test('check: a pre-release is marked as one', () => {
  const changelog = '## [1.2.0-rc.2]\n\n- Trying the release path.\n'
  const { cwd, run } = project('pre', { tag: 'v1.2.0-rc.2', version: '1.2.0-rc.2', changelog })
  assert.equal(run('check').status, 0)
  assert.equal(readFileSync(join(cwd, 'output.txt'), 'utf8'), 'version=1.2.0-rc.2\nprerelease=true\n')
})

test('check: a mismatch fails the step with an error line and writes nothing', () => {
  const { cwd, run } = project('mismatch', { tag: 'v1.2.0', lockVersion: '1.1.0' })
  const result = run('check')
  assert.equal(result.status, 1)
  assert.match(result.stdout, /::error::The tag says 1\.2\.0, but package-lock\.json has 1\.1\.0/)
  assert.equal(readFileSync(join(cwd, 'output.txt'), 'utf8'), '')
})

test('check: an empty changelog section fails the step', () => {
  const { run } = project('empty', { tag: 'v1.2.0', changelog: '## [1.2.0] - 2027-01-02\n\n## [1.1.0]\n\n- Older.\n' })
  const result = run('check')
  assert.equal(result.status, 1)
  assert.match(result.stdout, /::error::The section for 1\.2\.0 in CHANGELOG\.md is empty/)
})

test('check: a version below the latest on npm fails the step and writes nothing', () => {
  const { cwd, run } = project('below', { tag: 'v1.2.0', latest: '1.3.0' })
  const result = run('check')
  assert.equal(result.status, 1)
  assert.match(result.stdout, /::error::npm's latest is 1\.3\.0, and 1\.2\.0 is lower/)
  assert.equal(readFileSync(join(cwd, 'output.txt'), 'utf8'), '')
})

test("check: without npm's latest version the step fails", () => {
  const { cwd, run } = project('nolatest', { tag: 'v1.2.0', latest: '' })
  const result = run('check')
  assert.equal(result.status, 1)
  assert.match(result.stdout, /::error::The latest version on npm could not be read/)
  assert.equal(readFileSync(join(cwd, 'output.txt'), 'utf8'), '')
})

test('notes: writes the release notes file', () => {
  const { cwd, run } = project('notes', { tag: 'v1.2.0' })
  const result = run('notes', '1.2.0', 'notes.md')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(readFileSync(join(cwd, 'notes.md'), 'utf8'), /^### Fixed\n\n- One thing\.\n\nCDN integrity for `dist\/visito\.min\.js`:\n`sha384-[A-Za-z0-9+/]+=*`\n$/)
})
