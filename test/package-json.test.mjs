import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('package.json makes npm refuse to build or test on anything but Node 24', () => {
  // devEngines is checked by npm before install, ci and run in this repository, and never for a site that installs the package
  assert.deepEqual(pkg.devEngines, { runtime: { name: 'node', version: '^24.0.0', onFail: 'error' } })
})

test('package.json asks nothing of the Node version of the sites that install the package', () => {
  // the package runs in browsers; an engines range would make yarn 1 refuse to install it on any other Node
  assert.equal(pkg.engines, undefined)
})

test('the Node running these tests is one package.json allows', () => {
  assert.equal(process.versions.node.split('.')[0], '24')
})
