import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verdict } from '../.github/scripts/ci-result.mjs'

const SCRIPT = fileURLToPath(new URL('../.github/scripts/ci-result.mjs', import.meta.url))
const passed = { unit: 'success', windows: 'success', browsers: 'success', oldEngines: 'success', code: 'true', runOldEngines: 'true' }

test('a code change passes when every job ran and passed', () => {
  assert.deepEqual(verdict(passed), [])
})

test('a documentation change passes with the jobs it did not need skipped', () => {
  assert.deepEqual(verdict({ ...passed, windows: 'skipped', browsers: 'skipped', oldEngines: 'skipped', code: 'false', runOldEngines: 'false' }), [])
  assert.deepEqual(verdict({ ...passed, oldEngines: 'skipped', runOldEngines: 'false' }), [])
})

test('a job the change needed fails the run when it was skipped, failed or cancelled', () => {
  assert.deepEqual(verdict({ ...passed, browsers: 'skipped' }), ['Browser harnesses: skipped, but this change needs it'])
  assert.deepEqual(verdict({ ...passed, windows: 'failure' }), ['Build and unit tests (Windows): failure'])
  assert.deepEqual(verdict({ ...passed, oldEngines: 'cancelled' }), ['Old engines: cancelled'])
})

test('a failed or cancelled job fails the run even when the change did not need it', () => {
  assert.deepEqual(verdict({ ...passed, browsers: 'failure', code: 'false', windows: 'skipped' }), ['Browser harnesses: failure'])
})

test('the build and unit tests on Linux must always pass', () => {
  assert.deepEqual(verdict({ ...passed, unit: 'skipped' }), ['Build and unit tests: skipped'])
  assert.deepEqual(verdict({ ...passed, unit: 'failure', code: '', runOldEngines: '', windows: 'skipped', browsers: 'skipped', oldEngines: 'skipped' }), [
    'Build and unit tests: failure',
    'Build and unit tests (Windows): skipped, but this change needs it',
    'Browser harnesses: skipped, but this change needs it',
    'Old engines: skipped, but this change needs it',
  ])
})

test('a decision that is missing or garbled counts as needing the job', () => {
  assert.deepEqual(verdict({ ...passed, browsers: 'skipped', code: 'yes' }), ['Browser harnesses: skipped, but this change needs it'])
  assert.deepEqual(verdict({ ...passed, oldEngines: 'skipped', runOldEngines: undefined }), ['Old engines: skipped, but this change needs it'])
})

// CI_LINUX_RUNNER set: the Windows job is skipped by its own if:, since that runner is Linux only. The old engines run there
// without Docker, so they are let off only when the change did not need them, as anywhere else
test('on the self-hosted runner, the Windows job may be skipped and nothing else may', () => {
  assert.deepEqual(verdict({ ...passed, windows: 'skipped', selfHosted: 'true' }), [])
  assert.deepEqual(verdict({ ...passed, windows: 'skipped', oldEngines: 'skipped', selfHosted: 'true' }), ['Old engines: skipped, but this change needs it'])
  assert.deepEqual(verdict({ ...passed, windows: 'skipped', oldEngines: 'skipped', runOldEngines: 'false', selfHosted: 'true' }), [])
  assert.deepEqual(verdict({ ...passed, windows: 'skipped', oldEngines: 'skipped', runOldEngines: undefined, selfHosted: 'true' }), ['Old engines: skipped, but this change needs it'])
  assert.deepEqual(verdict({ ...passed, windows: 'skipped', browsers: 'skipped', selfHosted: 'true' }), ['Browser harnesses: skipped, but this change needs it'])
  assert.deepEqual(verdict({ ...passed, windows: 'skipped', unit: 'skipped', selfHosted: 'true' }), ['Build and unit tests: skipped'])
})

test('on the self-hosted runner, a Windows or old-engines job that ran and failed still fails the run', () => {
  assert.deepEqual(verdict({ ...passed, windows: 'failure', selfHosted: 'true' }), ['Build and unit tests (Windows): failure'])
  assert.deepEqual(verdict({ ...passed, windows: 'cancelled', selfHosted: 'true' }), ['Build and unit tests (Windows): cancelled'])
  assert.deepEqual(verdict({ ...passed, windows: 'skipped', oldEngines: 'failure', selfHosted: 'true' }), ['Old engines: failure'])
})

test('only an explicit "true" says the self-hosted runner was in use', () => {
  for (const selfHosted of ['false', '', 'yes', undefined]) {
    assert.deepEqual(verdict({ ...passed, windows: 'skipped', oldEngines: 'skipped', selfHosted }), [
      'Build and unit tests (Windows): skipped, but this change needs it',
      'Old engines: skipped, but this change needs it',
    ], String(selfHosted))
  }
})

test('the script reads the results from the environment and fails the step on any problem', () => {
  const env = (results) => ({ ...process.env, UNIT: 'success', WINDOWS: 'success', BROWSERS: 'success', OLD_ENGINES: 'success', CODE: 'true', RUN_OLD_ENGINES: 'true', ...results })
  const ok = spawnSync(process.execPath, [SCRIPT], { env: env({}), encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  const bad = spawnSync(process.execPath, [SCRIPT], { env: env({ BROWSERS: 'skipped' }), encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /::error::Browser harnesses: skipped, but this change needs it/)
  const selfHosted = spawnSync(process.execPath, [SCRIPT], { env: env({ WINDOWS: 'skipped', SELF_HOSTED: 'true' }), encoding: 'utf8' })
  assert.equal(selfHosted.status, 0, selfHosted.stdout)
  assert.match(selfHosted.stdout, /CI_LINUX_RUNNER is set: the Windows job does not run/)
  const skippedOld = spawnSync(process.execPath, [SCRIPT], { env: env({ WINDOWS: 'skipped', OLD_ENGINES: 'skipped', SELF_HOSTED: 'true' }), encoding: 'utf8' })
  assert.equal(skippedOld.status, 1)
  assert.match(skippedOld.stdout, /::error::Old engines: skipped, but this change needs it/)
  const hosted = spawnSync(process.execPath, [SCRIPT], { env: env({ WINDOWS: 'skipped', SELF_HOSTED: 'false' }), encoding: 'utf8' })
  assert.equal(hosted.status, 1)
})
