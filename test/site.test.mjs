// The public site (demo/, deployed by .github/workflows/pages.yml) and the README's head: what they say about the package to
// crawlers, link previews and readers of llms.txt must match the package, and every file they show must exist.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const pkg = JSON.parse(read('package.json'))
const html = read('demo/index.html')
const SITE = 'https://visitojs.github.io/visitojs/'
const REPO = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
const PREVIEW = `${SITE}social-preview.png`
// the brand kit's six colours: Teal, Mint, Ink, Paper, Night, Line
const KIT = ['#0b6e5c', '#3fd0b0', '#12161a', '#fbf9f3', '#0d1114', '#dedad0']
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
  assert.equal(meta('name', 'twitter:card'), 'summary_large_image')
})

test('a link preview shows the brand image, at its real size, with a description', () => {
  assert.equal(meta('property', 'og:image'), PREVIEW)
  assert.equal(meta('property', 'og:image:width'), '1280')
  assert.equal(meta('property', 'og:image:height'), '640')
  assert.ok((meta('property', 'og:image:alt') || '').length > 20, 'og:image:alt')
  assert.equal(meta('name', 'twitter:image'), PREVIEW)
  const png = readFileSync(new URL('../demo/social-preview.png', import.meta.url))
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1280, 640], 'demo/social-preview.png is 1280x640')
})

test('the JSON-LD block describes this package at its current version and repository, with the preview image', () => {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  assert.equal(blocks.length, 1)
  const data = JSON.parse(blocks[0][1])
  assert.equal(data['@context'], 'https://schema.org')
  assert.equal(data['@type'], 'SoftwareSourceCode')
  assert.equal(data.name, 'VisitoJS')
  assert.equal(data.version, pkg.version, 'the version in demo/index.html is stale: set it to the one in package.json')
  assert.equal(data.codeRepository, REPO)
  assert.equal(data.url, SITE)
  assert.equal(data.image, PREVIEW)
  assert.equal(data.license, `https://spdx.org/licenses/${pkg.license}.html`)
  assert.ok(data.description && data.programmingLanguage)
})

test('the page loads nothing from another origin: every src and href to a file is relative', () => {
  const tags = [...html.matchAll(/<(?:script|link|img|iframe|source|video|audio|object|embed)\b[^>]*>/g)].map((match) => match[0])
  assert.ok(tags.some((tag) => /\bsrc="visito\.min\.js"/.test(tag)), 'the page loads the library from its own folder')
  for (const tag of tags) {
    if (/^<link rel="canonical"/.test(tag)) continue // names the page's address; the browser fetches nothing for it
    for (const [, value] of tag.matchAll(/\b(?:src|href|data|srcset)="([^"]*)"/g)) {
      assert.ok(!/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(value), `${tag} loads from another origin`)
    }
  }
  assert.ok(!/@import|@font-face|url\(\s*['"]?(https?:)?\/\//i.test(html), 'the stylesheet loads nothing from another origin')
})

test("the icons are the brand kit's, linked from the page, and the hand-drawn one is gone", () => {
  for (const tag of [
    '<link rel="icon" href="favicon.ico" sizes="any">',
    '<link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">',
    '<link rel="icon" type="image/png" sizes="192x192" href="favicon-192.png">',
    '<link rel="icon" type="image/png" sizes="512x512" href="favicon-512.png">',
    '<link rel="apple-touch-icon" sizes="180x180" href="favicon-180.png">',
  ]) assert.ok(html.includes(tag), tag)
  assert.ok(!html.includes('favicon.svg'), 'the page names favicon.svg')
  assert.ok(!existsSync(new URL('../demo/favicon.svg', import.meta.url)), 'demo/favicon.svg is still there')
})

test("the header shows the logo image, never the name typed beside it, and the page uses only the kit's colours", () => {
  const brand = /<a class="brand"[^>]*>([\s\S]*?)<\/a>/.exec(html)
  assert.ok(brand, 'the brand link')
  assert.match(brand[1], /<source srcset="logo-dark-624\.png" media="\(prefers-color-scheme: dark\)">/)
  assert.match(brand[1], /<img src="logo-light-624\.png" alt="VisitoJS" width="156" height="54">/)
  assert.equal(brand[1].replace(/<[^>]*>/g, '').trim(), '', 'no typed text beside the logo')
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1].toLowerCase()
  const used = [...new Set(style.match(/#[0-9a-f]{3,8}\b/g))]
  assert.deepEqual(used.filter((colour) => !KIT.includes(colour)), [], 'a colour outside the brand kit')
  assert.deepEqual([...used].sort(), [...KIT].sort(), 'each of the six colours is used')
  // a kit colour may be drawn with transparency, as rgba() of its own channels
  const hex = (r, g, b) => '#' + [r, g, b].map((n) => Number(n).toString(16).padStart(2, '0')).join('')
  for (const [, r, g, b] of style.matchAll(/rgba\((\d+), (\d+), (\d+), 0?\.\d+\)/g)) assert.ok(KIT.includes(hex(r, g, b)), `rgba(${r}, ${g}, ${b}) is not a kit colour`)
  assert.ok(!/hsla?\(|rgb\(|color-mix/.test(style), 'a colour function outside the kit')
})

test('the README shows the logo for light and dark themes from this repository, and a size badge that is the measured size', () => {
  const readme = read('README.md')
  const raw = 'https://raw.githubusercontent.com/visitojs/visitojs/main/.github/brand/'
  assert.ok(readme.startsWith('<h1 align="center">\n  <picture>\n'), 'the README opens with the logo')
  assert.ok(readme.includes(`<source media="(prefers-color-scheme: dark)" srcset="${raw}logo-dark-624.png">`), 'dark logo')
  assert.ok(readme.includes(`<img src="${raw}logo-light-624.png" alt="VisitoJS" width="312">`), 'light logo')
  for (const file of ['logo-light-624.png', 'logo-dark-624.png']) assert.ok(existsSync(new URL(`../.github/brand/${file}`, import.meta.url)), file)
  const head = readme.slice(0, readme.indexOf('\n- '))
  assert.ok(!/^#\s*VisitoJS|<h1[^>]*>\s*VisitoJS/m.test(head), 'the name is typed as a heading beside the logo')
  const gzip = gzipSync(readFileSync(new URL('../dist/visito.min.js', import.meta.url))).length
  const badge = /<a href="#entries"><img src="https:\/\/img\.shields\.io\/badge\/gzip-([0-9.]+)%20kB-0B6E5C" alt="([0-9,]+) bytes gzipped"><\/a>/.exec(readme)
  assert.ok(badge, 'the size badge')
  assert.equal(badge[1], (gzip / 1000).toFixed(1), `the badge says ${badge[1]} kB, dist/visito.min.js is ${gzip} bytes gzipped`)
  assert.equal(Number(badge[2].replace(/,/g, '')), gzip, 'the badge alt text gives the exact bytes')
  assert.ok(!/bundlephobia/.test(readme), 'the rate-limited size badge is back')
})

test('llms.txt has a title, a summary and links to the documents it names, at this repository', () => {
  const text = read('demo/llms.txt')
  assert.match(text, /^# VisitoJS\n\n> .+\n/)
  for (const doc of ['README.md', 'docs/API.md', 'docs/SIGNALS.md', 'docs/DECISIONS.md', 'docs/LEGAL.md', 'COMPARISON.md', 'CHANGELOG.md']) {
    assert.ok(text.includes(`](${REPO}/blob/main/${doc})`), `llms.txt links ${doc}`)
    assert.ok(existsSync(new URL(`../${doc}`, import.meta.url)), `${doc} exists`)
  }
})

test('every file the page names exists, and the Pages workflow publishes it', () => {
  const workflow = read('.github/workflows/pages.yml')
  const named = new Set(['index.html', 'llms.txt', 'social-preview.png'])
  for (const [, value] of html.matchAll(/\b(?:src|href|srcset)="([^"]*)"/g)) if (!/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) named.add(value)
  for (const file of ['favicon.ico', 'favicon-32.png', 'favicon-180.png', 'favicon-192.png', 'favicon-512.png', 'logo-light-624.png', 'logo-dark-624.png', 'visito.min.js']) {
    assert.ok(named.has(file), `the page names ${file}`)
  }
  for (const file of named) {
    // the library is built into dist/; everything else is committed in demo/
    const from = file === 'visito.min.js' ? 'dist/visito.min.js' : `demo/${file}`
    if (from.startsWith('demo/')) assert.ok(existsSync(new URL(`../${from}`, import.meta.url)), `${from} exists`)
    assert.ok(workflow.includes(from), `pages.yml copies ${from}`)
  }
})
