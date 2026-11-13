import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { hardening, lintAll, parse, privileged } from './workflow-lint.mjs'

// GitHub Actions cannot be run from here, so these checks are what a workflow change can prove before it is pushed
const DIR = new URL('../.github/workflows/', import.meta.url)
const texts = Object.fromEntries(readdirSync(DIR).filter((name) => /\.ya?ml$/.test(name)).map((name) => [name, readFileSync(new URL(name, DIR), 'utf8')]))
const { problems, files } = lintAll(texts)

test('every workflow parses, and every job, need, output, input, step and expression it names exists where it is used', () => {
  assert.ok(Object.keys(files).length >= 4, `found ${Object.keys(texts).join(', ')}`)
  assert.deepEqual(problems, [])
})

// The checks themselves, on small workflows written to break one rule each
const lint = (text, extra = {}) => lintAll({ 'w.yml': text, ...extra }).problems
const job = (steps, more = '') => `name: W\non: push\npermissions: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n${more}    steps:\n${steps}`

test('the checks accept a small valid workflow', () => {
  const text = job(`      - id: s\n        run: echo "$X"\n        env:\n          X: \${{ github.ref }}\n      - if: \${{ steps.s.outcome == 'success' }}\n        run: echo done\n`, `    outputs:\n      out: \${{ steps.s.outputs.v }}\n`)
  assert.deepEqual(lint(text), [])
})

test('the checks catch a duplicated key and a YAML error', () => {
  assert.match(lint('name: W\nname: X\non: push\njobs: {}\n').join('\n'), /YAML: Map keys must be unique/)
  assert.match(lint('name: W\non: [push\n').join('\n'), /YAML:/)
})

test('the checks catch a need, an output, a step and an input that do not exist', () => {
  const text = `name: W
on:
  workflow_call:
    inputs:
      full: { type: boolean, default: false }
permissions: {}
jobs:
  a:
    runs-on: ubuntu-latest
    outputs:
      code: \${{ steps.decide.outputs.code }}
    steps:
      - run: echo
  b:
    needs: [a, c]
    if: \${{ needs.a.outputs.cod == 'true' && inputs.ful }}
    runs-on: ubuntu-latest
    steps:
      - if: \${{ steps.later.outcome == 'success' && needs.x.result }}
        run: echo
      - id: later
        run: echo
`
  const found = lint(text).join('\n')
  assert.match(found, /job a outputs: no step has the id decide/)
  assert.match(found, /job b: needs c, which is not a job here/)
  assert.match(found, /job a has no output cod/)
  assert.match(found, /there is no input ful/)
  assert.match(found, /step later runs after this one/)
  assert.match(found, /needs\.x is not in this job's needs/)
})

test('the checks catch a context used where GitHub does not provide it, and a misspelt name', () => {
  const found = lint(job('      - run: echo\n', `    if: \${{ steps.s.outputs.v == 'x' || github.evnt_name == 'push' || sucess() }}\n`)).join('\n')
  assert.match(found, /the steps context is not available here/)
  assert.match(found, /github\.evnt_name is not a property of github/)
  assert.match(found, /unknown function sucess\(\)/)
})

test('the checks catch broken expression syntax', () => {
  const found = lint(job('      - run: echo\n', `    if: \${{ (github.ref = 'refs/heads/main' }}\n    env:\n      A: \${{ format("x") }}\n      B: \${{ 'open }}\n      C: \${{ github.ref\n`)).join('\n')
  assert.match(found, /brackets do not balance/)
  assert.match(found, /a single = is not an operator/)
  assert.match(found, /strings take single quotes/)
  assert.match(found, /a string is not closed/)
  assert.match(found, /unterminated/)
})

test('the checks catch a bare if that names something unknown', () => {
  assert.match(lint(job('      - if: steps.nope.outcome\n        run: echo\n')).join('\n'), /no step has the id nope/)
})

test('the checks catch a cycle in needs and a job that needs itself', () => {
  const text = 'name: W\non: push\njobs:\n  a:\n    needs: b\n    runs-on: x\n    steps: [{ run: echo }]\n  b:\n    needs: [a, b]\n    runs-on: x\n    steps: [{ run: echo }]\n'
  const found = lint(text).join('\n')
  assert.match(found, /needs form a cycle/)
  assert.match(found, /job b: needs itself/)
})

test('the checks catch a call to a reusable workflow that does not match it', () => {
  const called = 'name: Called\non:\n  workflow_call:\n    inputs:\n      full: { type: boolean, default: false }\n      must: { type: string, required: true }\n    outputs:\n      ok:\n        value: ${{ jobs.x.outputs.ok }}\njobs:\n  x:\n    runs-on: x\n    outputs:\n      ok: yes\n    steps: [{ run: echo }]\n'
  const plain = 'name: Plain\non: push\njobs:\n  x:\n    runs-on: x\n    steps: [{ run: echo }]\n'
  const text = `name: W
on: push
jobs:
  a:
    uses: ./.github/workflows/called.yml
    timeout-minutes: 5
    with:
      full: 'yes'
      extra: 1
  b:
    uses: ./.github/workflows/plain.yml
  c:
    uses: ./.github/workflows/missing.yml
  d:
    needs: a
    runs-on: x
    steps:
      - run: echo
        env:
          A: \${{ needs.a.outputs.ok }}
          B: \${{ needs.a.outputs.nope }}
`
  const found = lint(text, { 'called.yml': called, 'plain.yml': plain }).join('\n')
  assert.match(found, /timeout-minutes is not allowed on a job that calls a reusable workflow/)
  assert.match(found, /full must be a boolean/)
  assert.match(found, /passes extra, which called\.yml does not declare/)
  assert.match(found, /does not pass must, which called\.yml requires/)
  assert.match(found, /calls plain\.yml, which has no workflow_call trigger/)
  assert.match(found, /calls missing\.yml, which is not in \.github\/workflows/)
  assert.match(found, /job a has no output nope/)
  assert.doesNotMatch(found, /no output ok/)
})

test('the checks catch unknown keys, permissions and steps that are neither uses nor run', () => {
  const text = 'name: W\non: [push, pull_requests]\npermissions:\n  content: read\n  id-token: read\njobs:\n  a:\n    runs-on: x\n    timeout: 5\n    steps:\n      - name: nothing\n      - run: echo\n        uses: actions/checkout@v1\n        whith: {}\n'
  const found = lint(text).join('\n')
  assert.match(found, /unknown event pull_requests/)
  assert.match(found, /unknown scope content/)
  assert.match(found, /id-token is write or none/)
  assert.match(found, /job a: unknown key timeout/)
  assert.match(found, /needs exactly one of uses and run/)
  assert.match(found, /unknown key whith/)
})

// What keeps a required check from waiting for ever: GitHub leaves a check pending when a path filter skips its workflow,
// while a job skipped by its own `if:` reports success
const pathFiltered = (workflow) => {
  const on = workflow.on && typeof workflow.on === 'object' && !Array.isArray(workflow.on) ? workflow.on : {}
  return ['push', 'pull_request'].filter((event) => on[event] && (on[event].paths || on[event]['paths-ignore']))
}

test('no workflow that runs on a push or pull request filters it by path', () => {
  for (const [name, workflow] of Object.entries(files)) assert.deepEqual(pathFiltered(workflow), [], name)
})

test('CI runs on every push to main and every pull request, and decides inside itself what a change needs', () => {
  const ci = files['ci.yml']
  assert.deepEqual(ci.on.push, { branches: ['main'] })
  assert.ok('pull_request' in ci.on)
  const unit = ci.jobs.unit
  assert.equal(unit['runs-on'], LINUX)
  const checkout = unit.steps.find((step) => /^actions\/checkout@/.test(step.uses || ''))
  assert.equal(checkout.with['fetch-depth'], 0, 'the decision needs the history it compares')
  const decide = unit.steps.find((step) => step.id === 'changes')
  assert.match(decide.run, /node \.github\/scripts\/ci-changes\.mjs/)
  assert.deepEqual(unit.outputs, { code: '${{ steps.changes.outputs.code }}', old_engines: '${{ steps.changes.outputs.old_engines }}' })
})

test('CI runs the unit tests on Windows too, and the browsers and old engines only when the change can affect them', () => {
  const { jobs } = files['ci.yml']
  assert.equal(jobs.windows['runs-on'], 'windows-latest')
  // the self-hosted runner CI_LINUX_RUNNER names is Linux only, and GitHub's runners do not start while it is in use
  assert.equal(jobs.windows.if, "${{ needs.unit.outputs.code == 'true' && vars.CI_LINUX_RUNNER == '' }}")
  assert.equal(jobs.browsers.if, "${{ needs.unit.outputs.code == 'true' }}")
  assert.deepEqual(jobs.windows.steps.filter((step) => step.run).map((step) => step.run), ['npm ci --ignore-scripts', 'npm test'])
  for (const id of ['windows', 'browsers']) assert.deepEqual(jobs[id].needs, 'unit', id)
  assert.equal(jobs.old_engines.uses, './.github/workflows/old-engines.yml')
  assert.equal(jobs.old_engines.needs, 'unit')
  assert.equal(jobs.old_engines.if, "${{ needs.unit.outputs.old_engines == 'true' }}")
  assert.deepEqual(jobs.old_engines.permissions, { contents: 'read' })
})

test('one CI job, CI result, stands for all the others, so a skipped job can never pass for a failed one', () => {
  const { jobs } = files['ci.yml']
  const result = jobs.result
  assert.equal(result.name, 'CI result')
  assert.deepEqual([...result.needs].sort(), Object.keys(jobs).filter((id) => id !== 'result').sort())
  // always(): with success() the default, a failed job would skip this one, and a skipped job reports success
  assert.equal(result.if, '${{ always() }}')
  const step = result.steps.find((s) => /ci-result\.mjs/.test(s.run || ''))
  assert.deepEqual(step.env, {
    UNIT: '${{ needs.unit.result }}',
    WINDOWS: '${{ needs.windows.result }}',
    BROWSERS: '${{ needs.browsers.result }}',
    OLD_ENGINES: '${{ needs.old_engines.result }}',
    CODE: '${{ needs.unit.outputs.code }}',
    RUN_OLD_ENGINES: '${{ needs.unit.outputs.old_engines }}',
    // a release asks CI for every job (full), so there the Windows skip that CI_LINUX_RUNNER causes still fails the run
    SELF_HOSTED: "${{ vars.CI_LINUX_RUNNER != '' && !inputs.full }}",
  })
})

test('the Old engines workflow runs when CI calls it or by hand, never on its own triggers', () => {
  assert.deepEqual(Object.keys(files['old-engines.yml'].on).sort(), ['workflow_call', 'workflow_dispatch'])
})

// CI_LINUX_RUNNER, a repository variable, sends CI's Linux jobs to a self-hosted runner that has no Docker and no sudo
const LINUX = "${{ vars.CI_LINUX_RUNNER || 'ubuntu-latest' }}"

test('CI_LINUX_RUNNER moves CI\'s Linux jobs and the old engines and nothing else: every other runs-on is a plain GitHub-hosted label', () => {
  for (const [name, workflow] of Object.entries(files)) {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (job.uses !== undefined) continue
      const where = `${name} job ${id}`
      const label = job['runs-on']
      if ((name === 'ci.yml' && id !== 'windows') || name === 'old-engines.yml') assert.equal(label, LINUX, where)
      else assert.match(label, /^(ubuntu|windows|macos)-[a-z0-9.]+$/, where)
    }
  }
  // the workflows that install system packages, publish or deploy must never reach that runner
  for (const [name, text] of Object.entries(texts)) {
    if (name === 'ci.yml' || name === 'old-engines.yml') continue
    assert.doesNotMatch(text, /CI_LINUX_RUNNER/, name)
  }
})

// that runner has no Docker: lab/old-engines/run.sh runs the same pinned images there in user namespaces
test('with CI_LINUX_RUNNER set, the old engines run on that runner; nothing skips them', () => {
  const { jobs } = files['old-engines.yml']
  assert.deepEqual(Object.keys(jobs), ['old-engines'])
  assert.equal(jobs['old-engines'].if, undefined)
  assert.equal(jobs['old-engines']['runs-on'], LINUX)
  for (const step of jobs['old-engines'].steps) assert.doesNotMatch(step.if || '', /CI_LINUX_RUNNER/, step.name || step.run || step.uses)
})

test('the browser job uses the Playwright image only while CI_LINUX_RUNNER is unset, and otherwise downloads the browser', () => {
  const { browsers } = files['ci.yml'].jobs
  const pinned = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).devDependencies.playwright
  const image = /^\$\{\{ vars\.CI_LINUX_RUNNER == '' && '(mcr\.microsoft\.com\/playwright:v([\d.]+)-noble[^']*)' \|\| '' \}\}$/.exec(browsers.container.image)
  assert.ok(image, `the image is not the CI_LINUX_RUNNER expression: ${browsers.container.image}`)
  assert.equal(image[2], pinned, 'the image must match the playwright version in package.json')
  const steps = browsers.steps
  const install = steps.findIndex((step) => step.name === 'Browser build, where no container brings it')
  assert.ok(install > 0, 'no step downloads the browser')
  assert.equal(steps[install].if, "${{ vars.CI_LINUX_RUNNER != '' }}")
  assert.match(steps[install].run, /^npx playwright install /)
  assert.ok(steps.findIndex((step) => step.run === 'npm ci --ignore-scripts') < install, 'the download needs the pinned playwright installed first')
  assert.ok(install < steps.findIndex((step) => /^node lab\//.test(step.run || '')), 'the download must come before the first harness')
})

// The hardening the workflow audit asks for, kept true by test
test('every workflow pins its actions and images, keeps credentials out of reach and bounds its run time', () => {
  assert.deepEqual(hardening(texts, files), [])
})

test('an image is a string pinned by digest, or the CI_LINUX_RUNNER switch whose non-empty branch is pinned by digest', () => {
  const digest = `@sha256:${'0'.repeat(64)}`
  const withImage = (image) => `name: W\non: push\npermissions: {}\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 1\n    container:\n      image: ${image}\n    steps:\n      - run: echo\n`
  const check = (image) => {
    const text = withImage(image)
    return hardening({ 'w.yml': text }, { 'w.yml': parse('w.yml', text).workflow })
  }
  assert.deepEqual(check(`mcr.microsoft.com/playwright:v1.63.0-noble${digest}`), [])
  assert.deepEqual(check(`\${{ vars.CI_LINUX_RUNNER == '' && 'mcr.microsoft.com/playwright:v1.63.0-noble${digest}' || '' }}`), [])
  assert.match(check(`\${{ vars.CI_LINUX_RUNNER == '' && 'mcr.microsoft.com/playwright:v1.63.0-noble' || '' }}`).join('\n'), /the container mcr\.microsoft\.com\/playwright:v1\.63\.0-noble is not pinned by digest/)
  // any other expression is not known to resolve to a pinned image
  assert.match(check(`\${{ vars.IMAGE || 'mcr.microsoft.com/playwright:v1.63.0-noble${digest}' }}`).join('\n'), /is not pinned by digest/)
  assert.match(check(`\${{ vars.CI_LINUX_RUNNER != '' && 'mcr.microsoft.com/playwright:v1.63.0-noble${digest}' || '' }}`).join('\n'), /is not pinned by digest/)
})

test('the hardening checks catch each thing they look for', () => {
  const text = `name: W
on: [push, pull_request_target]
permissions:
  contents: write
jobs:
  a:
    runs-on: x
    container: mcr.microsoft.com/playwright:v1.63.0-noble
    permissions:
      id-token: write
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - run: echo \${{ github.head_ref }}
  b:
    uses: ./.github/workflows/w.yml
    secrets: inherit
`
  const found = hardening({ 'w.yml': text }, { 'w.yml': parse('w.yml', text).workflow }).join('\n')
  assert.match(found, /w\.yml:12: actions\/checkout@v7 is not pinned/)
  assert.match(found, /w\.yml:13: .* needs its release tag in a comment/)
  assert.doesNotMatch(found, /w\.yml:14:/)
  assert.match(found, /pull_request_target runs with the base repository's credentials/)
  assert.match(found, /permissions: nothing may be written with the permissions every job inherits/)
  assert.match(found, /job a: id-token: write is not on the list/)
  assert.match(found, /job a: timeout-minutes is missing/)
  assert.match(found, /the container mcr\.microsoft\.com\/playwright:v1\.63\.0-noble is not pinned by digest/)
  assert.match(found, /an expression inside run: is pasted into the shell/)
  assert.match(found, /step actions\/checkout@v7: checkout must set persist-credentials: false/)
  assert.match(found, /job b: secrets: inherit/)
  assert.match(hardening({}, { 'w.yml': { name: 'W', on: 'push', jobs: {} } }).join('\n'), /set them at the top/)
})

test('a workflow that can write or deploy restores no cache', () => {
  for (const [name, workflow] of Object.entries(files)) {
    if (!privileged(workflow)) continue
    assert.equal(workflow['cache-mode'], 'none', name)
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps || []) {
        if (!/^actions\/setup-node@/.test(step.uses || '')) continue
        assert.equal(step.with['package-manager-cache'], false, name)
        assert.equal(step.with.cache, undefined, name)
      }
    }
  }
  assert.deepEqual(Object.keys(files).filter((name) => privileged(files[name])).sort(), ['pages.yml', 'release.yml'])
})

const runs = (job) => (job.steps || []).filter((step) => typeof step.run === 'string').map((step) => step.run).join('\n')
const usesOf = (job) => (job.steps || []).map((step) => step.uses || '').filter(Boolean)

test('a release starts only from a v tag, holds no permission at the top, and never cancels a run in progress', () => {
  const release = files['release.yml']
  assert.deepEqual(release.on, { push: { tags: ['v*'] } })
  assert.deepEqual(release.permissions, {})
  assert.equal(release.concurrency['cancel-in-progress'], false)
})

test('releases run one at a time: every tag shares one concurrency group, so two tags never publish side by side', () => {
  // a group per tag would let v1.0.1 and v1.0.2 run together, and whichever was approved last would become latest
  assert.deepEqual(files['release.yml'].concurrency, { group: 'release', 'cancel-in-progress': false })
})

test('the release build refuses a version below the latest on npm before anything runs, and keeps its files as long as an approval can wait', () => {
  const build = files['release.yml'].jobs.build
  const check = build.steps.find((step) => step.id === 'check')
  assert.match(check.run, /NPM_LATEST="\$\(npm view visitojs dist-tags\.latest\)"/)
  assert.match(check.run, /export NPM_LATEST/)
  assert.ok(check.run.indexOf('npm view') < check.run.indexOf('release-check.mjs check'))
  const upload = build.steps.find((step) => /^actions\/upload-artifact@/.test(step.uses || ''))
  // GitHub lets a run wait up to 30 days for an environment approval; the artifact must still be there when it is approved
  assert.equal(upload.with['retention-days'], 30)
})

test('a release runs the whole of CI, old engines included, on the tagged commit before anything publishes', () => {
  const { jobs } = files['release.yml']
  assert.equal(jobs.ci.uses, './.github/workflows/ci.yml')
  assert.deepEqual(jobs.ci.with, { full: true })
  assert.deepEqual(jobs.ci.permissions, { contents: 'read' })
  assert.deepEqual([...jobs.publish.needs].sort(), ['build', 'ci'])
  // CI asked for everything runs every job, and CI result fails on a skipped one
  const ci = files['ci.yml']
  const full = ci.on.workflow_call.inputs.full
  assert.equal(full.type, 'boolean')
  assert.equal(full.default, false)
  assert.equal(ci.jobs.unit.steps.find((step) => step.id === 'changes').env.FULL, '${{ inputs.full }}')
  assert.equal(ci.jobs.old_engines.uses, './.github/workflows/old-engines.yml')
})

test('the release build reads the repository only, checks where the tag came from and what it says, and packs once', () => {
  const build = files['release.yml'].jobs.build
  assert.deepEqual(build.permissions, { contents: 'read' })
  const checkout = build.steps.find((step) => /^actions\/checkout@/.test(step.uses || ''))
  assert.equal(checkout.with['fetch-depth'], 0, 'main must be fetched to check that the tagged commit is on it')
  const text = runs(build)
  assert.match(text, /git merge-base --is-ancestor "\$GITHUB_SHA" refs\/remotes\/origin\/main/)
  assert.match(text, /node \.github\/scripts\/release-check\.mjs check/)
  assert.match(text, /npm ci --ignore-scripts/)
  assert.match(text, /npm test/)
  assert.match(text, /npm pack --ignore-scripts --pack-destination out/)
  assert.match(text, /sha256sum/)
  // the checks come before any third-party code runs
  const order = build.steps.map((step) => step.run || step.uses)
  const at = (re) => order.findIndex((step) => re.test(step))
  assert.ok(at(/release-check\.mjs check/) < at(/npm ci/))
  assert.ok(at(/merge-base/) < at(/npm ci/))
  assert.ok(usesOf(build).some((uses) => /^actions\/upload-artifact@/.test(uses)))
  assert.deepEqual(Object.keys(build.outputs).sort(), ['prerelease', 'sums', 'version'])
})

test('the publish job holds the npm credential alone: no checkout, no install, no build, and only the tested tarball', () => {
  const publish = files['release.yml'].jobs.publish
  assert.deepEqual(publish.permissions, { 'id-token': 'write' })
  assert.equal(publish.environment.name, 'npm')
  assert.ok(!usesOf(publish).some((uses) => /^actions\/checkout@/.test(uses)))
  const text = runs(publish)
  assert.doesNotMatch(text, /npm (ci|install|i|test|run|rebuild|exec|x)\b|npx /)
  assert.match(text, /sha256sum -c/)
  // the leading ./ matters: npm reads a bare "out/name.tgz" as the GitHub shorthand owner/repo and tries to clone it
  assert.match(text, /npm publish "\.\/out\/visitojs-\$VERSION\.tgz"/)
  assert.doesNotMatch(text, /npm publish "out\//)
  assert.match(text, /dist\.integrity/)
  assert.ok(usesOf(publish).some((uses) => /^actions\/download-artifact@/.test(uses)))
})

test('the GitHub Release is created after npm has the version, from the same verified files, with write access to contents only', () => {
  const release = files['release.yml'].jobs['github-release']
  assert.deepEqual(release.permissions, { contents: 'write' })
  assert.deepEqual([...release.needs].sort(), ['build', 'publish'])
  assert.ok(!usesOf(release).some((uses) => /^actions\/checkout@/.test(uses)))
  const text = runs(release)
  assert.match(text, /sha256sum -c/)
  assert.match(text, /gh release create "\$TAG" out\/visito\.min\.js out\/visito\.esm\.js out\/match\.js --verify-tag/)
  assert.match(text, /--notes-file out\/notes\.md/)
})

test('the demo page is built without the deploy credential and deployed by a job that runs nothing else', () => {
  const pages = files['pages.yml']
  assert.deepEqual(pages.permissions, {})
  assert.deepEqual(pages.jobs.build.permissions, { contents: 'read' })
  assert.deepEqual(pages.jobs.deploy.permissions, { pages: 'write', 'id-token': 'write' })
  assert.equal(pages.jobs.deploy.needs, 'build')
  assert.equal(pages.jobs.deploy.environment.name, 'github-pages')
  assert.deepEqual(pages.jobs.deploy.steps.map((step) => step.uses.split('@')[0]), ['actions/deploy-pages'])
  assert.ok(!Object.values(pages.jobs).some((job) => usesOf(job).some((uses) => /configure-pages/.test(uses))))
})

test('CI on a pull request cancels the run it replaces; on main, a tag or a call it waits, in a group of its own', () => {
  const { concurrency } = files['ci.yml']
  assert.equal(concurrency.group, 'ci-${{ github.workflow }}-${{ github.ref }}')
  assert.equal(concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}")
})

test('the concurrency comments say that a newer run replaces a pending one, which GitHub does unless a queue is set', () => {
  for (const name of ['ci.yml', 'old-engines.yml', 'release.yml']) {
    assert.equal(files[name].concurrency.queue, undefined, name)
    const text = texts[name]
    const comment = text.slice(0, text.indexOf('\nconcurrency:'))
    assert.match(comment.slice(comment.lastIndexOf('\n\n')), /replaces/, name)
  }
})

test('Dependabot waits a week before proposing a new release and groups the updates it proposes', () => {
  const parsed = parse('dependabot.yml', readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8'))
  assert.deepEqual(parsed.problems, [])
  const updates = parsed.workflow.updates
  assert.deepEqual(updates.map((update) => update['package-ecosystem']).sort(), ['github-actions', 'npm'])
  for (const update of updates) {
    assert.ok(update.cooldown && update.cooldown['default-days'] >= 7, update['package-ecosystem'])
    assert.ok(Object.keys(update.groups || {}).length, update['package-ecosystem'])
  }
  // playwright moves with its image; a major TypeScript is left alone because 7 no longer compiles to ES5
  assert.deepEqual(updates.find((update) => update['package-ecosystem'] === 'npm').ignore, [
    { 'dependency-name': 'playwright' },
    { 'dependency-name': 'typescript', 'update-types': ['version-update:semver-major'] },
  ])
})
