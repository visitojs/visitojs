// The public site (demo/, deployed by .github/workflows/pages.yml): what it says about the package to crawlers and to readers of llms.txt must match the package.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const pkg = JSON.parse(read('package.json'))
const html = read('demo/index.html')
const SITE = 'https://visitojs.github.io/visitojs/'
const REPO = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
const meta = (attr, name) => {
  const tag = html.match(new RegExp(`<meta ${attr}="${name.replace(/[.:]/g, '\\$&')}" content="([^"]*)">`))
  return tag && tag[1]
}

test('the demo page has a title, a description, a canonical link and the Open Graph and card tags, all naming the site', () => {
  assert.match(html, /<html lang="en">/)
  assert.match(html, /<title>VisitoJS[^<]+<\/title>/)
  const description = meta('name', 'description')
  assert.ok(description && description.length >= 70 && description.length <= 160, `meta description of ${description && description.length} characters`)
  assert.ok(html.includes(`<link rel="canonical" href="${SITE}">`), 'canonical link')
  assert.equal(meta('property', 'og:url'), SITE)
  assert.equal(meta('property', 'og:type'), 'website')
  assert.ok(meta('property', 'og:title') && meta('property', 'og:description'))
  assert.equal(meta('name', 'twitter:card'), 'summary')
})

test('the JSON-LD block describes this package at its current version and repository', () => {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  assert.equal(blocks.length, 1)
  const data = JSON.parse(blocks[0][1])
  assert.equal(data['@context'], 'https://schema.org')
  assert.equal(data['@type'], 'SoftwareSourceCode')
  assert.equal(data.name, 'VisitoJS')
  assert.equal(data.version, pkg.version, 'the version in demo/index.html is stale: set it to the one in package.json')
  assert.equal(data.codeRepository, REPO)
  assert.equal(data.url, SITE)
  assert.equal(data.license, `https://spdx.org/licenses/${pkg.license}.html`)
  assert.ok(data.description && data.programmingLanguage)
})

test('the page loads nothing from another origin: every src and href to a file is relative', () => {
  const tags = [...html.matchAll(/<(?:script|link|img|iframe|source|video|audio|object|embed)\b[^>]*>/g)].map((match) => match[0])
  assert.ok(tags.some((tag) => /\bsrc="visito\.min\.js"/.test(tag)), 'the page loads the library from its own folder')
  for (const tag of tags) {
    if (/^<link rel="canonical"/.test(tag)) continue // names the page's address; the browser fetches nothing for it
    const [, value = ''] = /\b(?:src|href|data)="([^"]*)"/.exec(tag) || []
    assert.ok(!/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(value), `${tag} loads from another origin`)
  }
  assert.ok(!/@import|url\(\s*['"]?(https?:)?\/\//i.test(html), 'the stylesheet loads nothing from another origin')
  assert.ok(existsSync(new URL('../demo/favicon.svg', import.meta.url)), 'the icon the page names exists')
})

test('llms.txt has a title, a summary and links to the documents it names, at this repository', () => {
  const text = read('demo/llms.txt')
  assert.match(text, /^# VisitoJS\n\n> .+\n/)
  for (const doc of ['README.md', 'docs/API.md', 'docs/SIGNALS.md', 'docs/DECISIONS.md', 'docs/LEGAL.md', 'COMPARISON.md', 'CHANGELOG.md']) {
    assert.ok(text.includes(`](${REPO}/blob/main/${doc})`), `llms.txt links ${doc}`)
    assert.ok(existsSync(new URL(`../${doc}`, import.meta.url)), `${doc} exists`)
  }
})

test('the Pages workflow publishes every file the site needs', () => {
  const workflow = read('.github/workflows/pages.yml')
  for (const file of ['demo/index.html', 'demo/favicon.svg', 'demo/llms.txt', 'dist/visito.min.js']) assert.ok(workflow.includes(file), `pages.yml copies ${file}`)
})
