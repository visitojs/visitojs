// The verdict of the "CI result" job, the one check the branch rules require. GitHub reports a skipped job as passed,
// so this job reads every result itself: a job the change needed must have run and passed, and no job may fail.
import { pathToFileURL } from 'node:url'

// selfHosted is "true" while the repository variable CI_LINUX_RUNNER sends the Linux jobs to a self-hosted runner. That
// runner is Linux only, so the Windows job is skipped there by its own if:, and that skip is let off; a job that ran and
// failed still fails the run. The old engines run on that runner too, without Docker, so nothing excuses their skip there
export function verdict({ unit, windows, browsers, oldEngines, code, runOldEngines, selfHosted }) {
  const problems = []
  if (unit !== 'success') problems.push(`Build and unit tests: ${unit}`)
  const offRunner = selfHosted === 'true'
  const jobs = [
    ['Build and unit tests (Windows)', windows, code, offRunner],
    ['Browser harnesses', browsers, code, false],
    ['Old engines', oldEngines, runOldEngines, false],
  ]
  for (const [name, result, decision, off] of jobs) {
    // only an explicit "false" lets a job off; a missing decision means the unit job never decided
    const needed = decision !== 'false' && !off
    if (result === 'success') continue
    if (result === 'skipped' && !needed) continue
    problems.push(result === 'skipped' ? `${name}: skipped, but this change needs it` : `${name}: ${result}`)
  }
  return problems
}

function main() {
  const env = process.env
  const problems = verdict({ unit: env.UNIT, windows: env.WINDOWS, browsers: env.BROWSERS, oldEngines: env.OLD_ENGINES, code: env.CODE, runOldEngines: env.RUN_OLD_ENGINES, selfHosted: env.SELF_HOSTED })
  console.log(`Build and unit tests: ${env.UNIT}. Windows: ${env.WINDOWS}. Browser harnesses: ${env.BROWSERS}. Old engines: ${env.OLD_ENGINES}.`)
  console.log(`This change needed the browsers and Windows: ${env.CODE || 'undecided'}; the old engines: ${env.RUN_OLD_ENGINES || 'undecided'}.`)
  if (env.SELF_HOSTED === 'true') console.log('CI_LINUX_RUNNER is set: the Windows job does not run on that runner, and its skip is not counted. RELEASING.md says to run it before a release.')
  for (const problem of problems) console.log(`::error::${problem}`)
  process.exitCode = problems.length ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
