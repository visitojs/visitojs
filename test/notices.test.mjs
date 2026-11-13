import test from 'node:test'
import assert from 'node:assert/strict'
import { blockedFont, noticeFor } from '../lab/notices.mjs'

// the console lines Playwright's Firefox 155 gave on Ubuntu 24.04 in CI, 13 November 2026
const FROM_CI = [
  ['warning: [JavaScript Warning: "Request for font "WenQuanYi Zen Hei" blocked at visibility level 2 (requires 3)\n" {file: "about:blank" line: 0}]', 'WenQuanYi Zen Hei'],
  ['warning: [JavaScript Warning: "Request for font "WenQuanYi Zen Hei Mono" blocked at visibility level 2 (requires 3)\n" {file: "http://localhost:62260/visito.defer.min.js" line: 2}]', 'WenQuanYi Zen Hei Mono'],
  ['warning: [JavaScript Warning: "Request for font "IPAGothic" blocked at visibility level 2 (requires 3)\n" {file: "http://localhost:62260/visito.defer.min.js" line: 2}]', 'IPAGothic'],
  // the bare form, as Gecko formats it
  ['warning: Request for font "DejaVu Sans" blocked at visibility level 1 (requires 3)\n', 'DejaVu Sans'],
]

test("Firefox's font-visibility warning is a browser notice, and the font it names is read", () => {
  for (const [line, font] of FROM_CI) {
    assert.equal(noticeFor('firefox', line).name, 'font-visibility', line)
    assert.equal(blockedFont('firefox', line), font)
  }
})

test('only that warning, only from Firefox: anything else on the console still counts', () => {
  const [line] = FROM_CI[0]
  assert.equal(noticeFor('chromium', line), undefined)
  assert.equal(noticeFor('webkit', line), undefined)
  for (const other of [
    line.replace('warning: ', 'error: '),
    line.replace('warning: ', 'log: '),
    'warning: ' + line.slice(9) + ' and more',
    'warning: [JavaScript Warning: "visito: Request for font "X" blocked at visibility level 2 (requires 3)\n" {file: "about:blank" line: 0}]',
    'warning: Request for font "X" blocked at visibility level 2 (requires 3); TypeError: x is undefined',
    'warning: Request for font "X" blocked',
    'log: VISITO_DONE',
    'error: TypeError: e is undefined',
  ]) {
    assert.equal(noticeFor('firefox', other), undefined, other)
    assert.equal(blockedFont('firefox', other), null, other)
  }
})

test('the screen notice stays a notice and names no font', () => {
  const line = 'warning: Fingerprinting Protection is altering screen.availWidth and screen.availHeight.'
  assert.equal(noticeFor('firefox', line).name, 'screen-avail')
  assert.equal(blockedFont('firefox', line), null)
})
