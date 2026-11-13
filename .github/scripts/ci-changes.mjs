// Decides which CI jobs a change needs, from the files it touches. CI runs it in the "Build and unit tests" job.
// Any doubt runs everything: a wasted minute is cheaper than a change that skipped the check it needed.
import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// Files no browser harness reads and no build step uses. Anything else, including a file added tomorrow, counts as code
const DOCS = [/\.md$/, /^docs\//, /^LICENSE$/, /^third_party\//, /^\.github\/ISSUE_TEMPLATE\//, /^\.github\/CODEOWNERS$/, /^\.github\/dependabot\.yml$/]

// What can change the shipped bytes in Chrome 53 to 80 or the run that checks them. .npmrc and .gitattributes change what npm
// runs and the line endings of src/. The last three are the wiring that starts the run
const OLD_ENGINES = [
  /^src\//,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^rollup\.config\.mjs$/,
  /^tsconfig\.json$/,
  /^\.npmrc$/,
  /^\.gitattributes$/,
  /^lab\/old-engines\//,
  /^lab\/schema\.mjs$/,
  /^lab\/deep-schema\.mjs$/,
  /^\.github\/workflows\/old-engines\.yml$/,
  /^\.github\/workflows\/ci\.yml$/,
  /^\.github\/scripts\/ci-changes\.mjs$/,
]

const matches = (patterns, path) => patterns.some((pattern) => pattern.test(path))

export function classify(paths) {
  return {
    code: paths.some((path) => !matches(DOCS, path)),
    oldEngines: paths.some((path) => matches(OLD_ENGINES, path)),
  }
}

// The two commits to compare, or null when the change cannot be measured and everything must run
export function range({ event, ref, before, full }) {
  if (full) return null
  // GitHub checks out a pull request as its merge into the base branch; the first parent is that base
  if (event === 'pull_request') return { from: 'HEAD^1', to: 'HEAD', merge: true }
  if (event === 'push' && ref === 'refs/heads/main' && /^[0-9a-f]{40}$/.test(before || '') && !/^0+$/.test(before)) return { from: before, to: 'HEAD', merge: false }
  return null
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function changedFiles(span) {
  if (span.merge && git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').length !== 3) throw new Error('HEAD is not a merge commit')
  // without renames a file moved out of src/ also shows its old path
  return git('diff', '--no-renames', '--name-only', '-z', span.from, span.to).split('\0').filter(Boolean)
}

function main() {
  const env = process.env
  let before = ''
  try {
    before = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).before || ''
  } catch (e) {}
  const span = range({ event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, before, full: env.FULL === 'true' })
  let decision = { code: true, oldEngines: true }
  if (!span) console.log(`Running everything: ${env.FULL === 'true' ? 'the caller asked for it' : `a ${env.GITHUB_EVENT_NAME} on ${env.GITHUB_REF} is not narrowed`}.`)
  else {
    try {
      const files = changedFiles(span)
      decision = classify(files)
      console.log(`${files.length} files changed between ${span.from} and ${span.to}:\n${files.map((file) => `  ${file}`).join('\n')}`)
    } catch (e) {
      console.log(`Running everything: the change could not be read (${String(e.message).split('\n')[0]}).`)
    }
  }
  console.log(`Browser harnesses and Windows: ${decision.code ? 'run' : 'skip'}. Old engines: ${decision.oldEngines ? 'run' : 'skip'}.`)
  appendFileSync(env.GITHUB_OUTPUT, `code=${decision.code}\nold_engines=${decision.oldEngines}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
