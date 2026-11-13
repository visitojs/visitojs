// The release workflow's own checks, before any third-party code runs and before anything is published.
//   node .github/scripts/release-check.mjs check                  the tag, both version fields and the changelog agree, and the
//                                                                 version is not below NPM_LATEST, npm's latest dist-tag
//   node .github/scripts/release-check.mjs notes <version> <file> writes the GitHub Release notes
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

// v, then a semantic version without build metadata; a pre-release part is allowed and is published under the next tag
export function versionFromTag(tag) {
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(tag || '')
  if (!match) throw new Error(`${tag || 'the ref'} is not a release tag: it must be v followed by a version such as v1.2.0 or v1.2.0-rc.1`)
  return match[1]
}

export function checkVersions(version, pkg, lock) {
  const root = lock.packages && lock.packages[''] ? lock.packages[''].version : undefined
  const found = [
    ['package.json', pkg.version],
    ['package-lock.json', lock.version],
    ["package-lock.json's root package", root],
  ]
  const wrong = found.filter(([, value]) => value !== version).map(([where, value]) => `${where} has ${value === undefined ? 'nothing' : value}`)
  if (wrong.length) throw new Error(`The tag says ${version}, but ${wrong.join(', and ')}`)
}

// A version without a pre-release part is published under the latest dist-tag, and npm moves latest to whatever it is given,
// even an older version. So a fix for an older line (0.1.5 after 0.2.0) is refused here, before the approval, not published
export function checkLatest(version, latest) {
  const core = (text) => /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(text || '')
  const have = core(latest)
  if (!have) throw new Error(`The latest version on npm could not be read (${latest ? `"${latest}"` : 'nothing'}), so the release cannot tell whether it would move latest back`)
  if (version.includes('-')) return
  const want = core(version)
  for (let part = 1; part <= 3; part++) {
    if (Number(want[part]) === Number(have[part])) continue
    if (Number(want[part]) > Number(have[part])) return
    throw new Error(`npm's latest is ${latest}, and ${version} is lower: publishing it would make it latest. This workflow publishes only the newest line; see RELEASING.md`)
  }
}

// The text under "## [version]" up to the next "## " heading, without the heading
export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const heading = `## [${version}]`
  const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} `))
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}: add a "## [${version}] - <date>" heading with the changes under it`)
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  if (end < 0) end = lines.length
  const section = lines.slice(start + 1, end).join('\n').trim()
  if (!section) throw new Error(`The section for ${version} in CHANGELOG.md is empty: say what changed before releasing`)
  return section
}

export function releaseNotes(section, minJs) {
  const integrity = `sha384-${createHash('sha384').update(minJs).digest('base64')}`
  return `${section}\n\nCDN integrity for \`dist/visito.min.js\`:\n\`${integrity}\`\n`
}

function main(args) {
  const json = (file) => JSON.parse(readFileSync(file, 'utf8'))
  try {
    if (args[0] === 'check') {
      const version = versionFromTag(process.env.GITHUB_REF_NAME)
      checkVersions(version, json('package.json'), json('package-lock.json'))
      changelogSection(readFileSync('CHANGELOG.md', 'utf8'), version)
      checkLatest(version, process.env.NPM_LATEST)
      const prerelease = version.includes('-')
      console.log(`Releasing ${version}${prerelease ? ', a pre-release' : ''}: the tag, package.json, package-lock.json and CHANGELOG.md agree; npm's latest is ${process.env.NPM_LATEST}.`)
      appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nprerelease=${prerelease}\n`)
    } else if (args[0] === 'notes' && args.length === 3) {
      const notes = releaseNotes(changelogSection(readFileSync('CHANGELOG.md', 'utf8'), args[1]), readFileSync('dist/visito.min.js'))
      writeFileSync(args[2], notes)
      console.log(notes)
    } else throw new Error('usage: release-check.mjs check | notes <version> <file>')
  } catch (e) {
    console.log(`::error::${e.message}`)
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2))
