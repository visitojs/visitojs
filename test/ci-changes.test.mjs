import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { classify, range } from '../.github/scripts/ci-changes.mjs'

const SCRIPT = fileURLToPath(new URL('../.github/scripts/ci-changes.mjs', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'visito-ci-changes-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const all = { code: true, oldEngines: true }
const none = { code: false, oldEngines: false }

test('a change to documentation only needs neither the browser harnesses nor the old engines', () => {
  assert.deepEqual(classify(['README.md', 'docs/SIGNALS.md', 'CHANGELOG.md', 'lab/testpage/README.md']), none)
  assert.deepEqual(classify(['LICENSE', 'third_party/licenses/NOTICE.txt', 'docs/img/flow.svg']), none)
  assert.deepEqual(classify(['.github/ISSUE_TEMPLATE/bug.yml', '.github/PULL_REQUEST_TEMPLATE.md', '.github/CODEOWNERS', '.github/dependabot.yml']), none)
})

test('nothing changed needs nothing', () => {
  assert.deepEqual(classify([]), none)
})

test('a change to the shipped code, the build or the dependencies needs everything', () => {
  for (const path of ['src/reads.ts', 'package.json', 'package-lock.json', 'rollup.config.mjs', 'tsconfig.json', '.npmrc', '.gitattributes']) {
    assert.deepEqual(classify(['README.md', path]), all, path)
  }
})

test('a change to the old-engines harness or to the CI wiring runs the old engines', () => {
  for (const path of ['lab/old-engines/check.mjs', 'lab/old-engines/fetch-image.mjs', 'lab/old-engines/layers.mjs', 'lab/old-engines/oci.mjs', 'lab/old-engines/sandbox.sh', 'lab/schema.mjs', 'lab/deep-schema.mjs', '.github/workflows/old-engines.yml', '.github/workflows/ci.yml', '.github/scripts/ci-changes.mjs']) {
    assert.deepEqual(classify([path]), all, path)
  }
})

test('a change to tests, other harnesses, the demo or another workflow runs the browser harnesses but not the old engines', () => {
  for (const path of ['test/ua.test.mjs', 'lab/fault-matrix.mjs', 'lab/testpage/index.html', 'demo/index.html', '.github/workflows/pages.yml', '.gitignore', 'some-new-file']) {
    assert.deepEqual(classify([path]), { code: true, oldEngines: false }, path)
  }
})

test('a file that only looks like documentation is not documentation', () => {
  // the old-engines page, a source file named like a doc, and a directory that only starts like docs/
  for (const path of ['lab/old-engines/page.html', 'src/docs.ts', 'docsite/index.html', 'README.md.bak']) {
    assert.equal(classify([path]).code, true, path)
  }
})

test('a pull request compares the checked-out merge commit with its first parent, the base branch', () => {
  assert.deepEqual(range({ event: 'pull_request', ref: 'refs/pull/7/merge', before: '' }), { from: 'HEAD^1', to: 'HEAD', merge: true })
})

test('a push to main compares the pushed commit with the one main pointed at before', () => {
  const before = 'a'.repeat(40)
  assert.deepEqual(range({ event: 'push', ref: 'refs/heads/main', before }), { from: before, to: 'HEAD', merge: false })
})

test('anything the change cannot be measured for runs everything', () => {
  // a new branch has no previous commit; a tag, a manual run or a caller asking for everything is never narrowed
  assert.equal(range({ event: 'push', ref: 'refs/heads/main', before: '0'.repeat(40) }), null)
  assert.equal(range({ event: 'push', ref: 'refs/heads/main', before: 'not-a-sha' }), null)
  assert.equal(range({ event: 'push', ref: 'refs/heads/main' }), null)
  assert.equal(range({ event: 'push', ref: 'refs/tags/v1.0.0', before: 'a'.repeat(40) }), null)
  assert.equal(range({ event: 'push', ref: 'refs/heads/other', before: 'a'.repeat(40) }), null)
  assert.equal(range({ event: 'workflow_dispatch', ref: 'refs/heads/main' }), null)
  assert.equal(range({ event: 'pull_request', ref: 'refs/pull/7/merge', full: true }), null)
})

// The script as CI runs it, in a scratch repository: it reads the event from the environment and appends to GITHUB_OUTPUT
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function repo(name) {
  const cwd = join(dir, name)
  execFileSync('git', ['init', '-q', '-b', 'main', cwd])
  writeFileSync(join(cwd, 'README.md'), 'one\n')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'one')
  return cwd
}

function run(cwd, env) {
  const output = join(cwd, '..', `${cwd.split(/[\\/]/).pop()}-output.txt`)
  writeFileSync(output, 'earlier=line\n')
  const event = join(cwd, '..', `${cwd.split(/[\\/]/).pop()}-event.json`)
  writeFileSync(event, JSON.stringify({ before: env.before || '' }))
  const log = execFileSync(process.execPath, [SCRIPT], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: env.event, GITHUB_REF: env.ref, FULL: env.full || '' },
  })
  return { log, output: readFileSync(output, 'utf8') }
}

test('the script narrows a push to main that changed only documentation, and says why', () => {
  const cwd = repo('docs-push')
  const before = git(cwd, 'rev-parse', 'HEAD')
  writeFileSync(join(cwd, 'README.md'), 'two\n')
  git(cwd, 'commit', '-q', '-am', 'two')
  const { log, output } = run(cwd, { event: 'push', ref: 'refs/heads/main', before })
  assert.equal(output, 'earlier=line\ncode=false\nold_engines=false\n')
  assert.match(log, /README\.md/)
})

test('the script sees both sides of a file moved out of src/ into docs/', () => {
  const cwd = repo('rename-push')
  mkdirSync(join(cwd, 'src'))
  writeFileSync(join(cwd, 'src', 'old.ts'), 'export var a = 1\n')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'source')
  const before = git(cwd, 'rev-parse', 'HEAD')
  mkdirSync(join(cwd, 'docs'))
  git(cwd, 'mv', 'src/old.ts', 'docs/old.md')
  // reported as a rename, the change would name docs/old.md alone and look like documentation
  git(cwd, 'commit', '-q', '-m', 'move')
  const { output } = run(cwd, { event: 'push', ref: 'refs/heads/main', before })
  assert.equal(output, 'earlier=line\ncode=true\nold_engines=true\n')
})

test('the script reads a pull request from the merge commit GitHub checks out', () => {
  const cwd = repo('pull-request')
  git(cwd, 'checkout', '-q', '-b', 'topic')
  writeFileSync(join(cwd, 'notes.md'), 'docs\n')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'docs')
  git(cwd, 'checkout', '-q', 'main')
  writeFileSync(join(cwd, 'package.json'), '{}\n')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'meanwhile on main')
  git(cwd, 'merge', '-q', '--no-ff', '-m', 'merge', 'topic')
  // main's own change after the branch point is not part of the pull request
  const { output } = run(cwd, { event: 'pull_request', ref: 'refs/pull/7/merge' })
  assert.equal(output, 'earlier=line\ncode=false\nold_engines=false\n')
})

test('the script runs everything when a pull request checkout is not a merge commit', () => {
  const cwd = repo('not-a-merge')
  writeFileSync(join(cwd, 'README.md'), 'two\n')
  git(cwd, 'commit', '-q', '-am', 'two')
  const { log, output } = run(cwd, { event: 'pull_request', ref: 'refs/pull/7/merge' })
  assert.equal(output, 'earlier=line\ncode=true\nold_engines=true\n')
  assert.match(log, /everything/)
})

test('the script runs everything when git cannot answer, instead of failing or skipping', () => {
  const cwd = repo('unknown-before')
  const { log, output } = run(cwd, { event: 'push', ref: 'refs/heads/main', before: 'b'.repeat(40) })
  assert.equal(output, 'earlier=line\ncode=true\nold_engines=true\n')
  assert.match(log, /everything/)
})

test('the script runs everything when the caller asks for it', () => {
  const cwd = repo('full')
  const before = git(cwd, 'rev-parse', 'HEAD')
  writeFileSync(join(cwd, 'README.md'), 'two\n')
  git(cwd, 'commit', '-q', '-am', 'two')
  const { output } = run(cwd, { event: 'push', ref: 'refs/heads/main', before, full: 'true' })
  assert.equal(output, 'earlier=line\ncode=true\nold_engines=true\n')
})
