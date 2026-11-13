import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const HASH = new URL('../build/esm/hash.js', import.meta.url).href
const INPUT = 'visito:'

// Each case runs in its own process with a time limit, so a hash that never ends fails here instead of hanging the suite.
function hashWith(replacement) {
  const script = `
    import { sha256, short } from ${JSON.stringify(HASH)}
    const original = String.prototype.charCodeAt
    String.prototype.charCodeAt = (${replacement})
    let result
    try { result = { sha256: sha256(${JSON.stringify(INPUT)}), short: short(${JSON.stringify(INPUT)}) } } catch (e) { result = { threw: e.constructor.name } }
    String.prototype.charCodeAt = original
    process.stdout.write(JSON.stringify(result))`
  try {
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000, encoding: 'utf8' }))
  } catch (error) {
    return { ended: false, error: error.code || error.message.split('\n')[0] }
  }
}

// What 0.1.0 returned for INPUT with String.prototype.charCodeAt replaced by each function (sha256 first, then short).
const RELEASED = {
  'function () { return -1 }': ['adaac4b55ddb3a6ab09d09b3b1e43850b9e5ae838a9460152bf064e3ee61ae6a', '99ccfab02c6d6fb6'],
  'function () { return 3e9 }': ['1c3b499cd5b84305ab1a9cc4a1211747ff582687ad7012c04ae6c989d6994939', '8d5a7ae38ce90bc5'],
  'function () { return NaN }': ['1e013643b16f4d0c1364ee5953acba211ce87b37f094aecf1c49e84482edc870', '462a7c275d615f21'],
  'function () {}': ['1e013643b16f4d0c1364ee5953acba211ce87b37f094aecf1c49e84482edc870', '462a7c275d615f21'],
  'function () { return "300" }': ['f8881efe0b5f357715e4c063e0d99bdc22172b67fca1df11aa945c18fd7c5f85', '4a08e00e9e34948c'],
  'function () { return null }': ['837885c8f8091aeaeb9ec3c3f85a6ff470a415e610b8ba3e49f9b33c9cf9d619', '462a7c275d615f21'],
  'function () { return 1e10 }': ['932141825bc93b3cea6d36823e40e370f3cc632a94edf2886ab9e01246b8a661', 'd8fcb1f1352c8ce7'],
  'function () { return Infinity }': ['1e013643b16f4d0c1364ee5953acba211ce87b37f094aecf1c49e84482edc870', '3538be3dd69d215b'],
  'function () { return 0x200000 }': ['15c15483cda723aeacc70f95ad984acbce12516dd2f3e41827e9322510d03213', 'bd2cde3d8b13c15b'],
  // after one 1-byte unit every 4-byte lead lands inside a word, where all of its bits count
  'function (i) { return i ? 1e10 : 65 }': ['66b52764af62bd43bd4da0d2d1d8b29ff3c7975702984360a6ed8d229296df56', 'd1696b6c86df0a96'],
  'function (i) { return i ? 3e9 : 65 }': ['1ceae82ddd7bef75ddf9ced6f068f486859d598f884de40a1fab2e12c73e8793', 'd67e5e5c03cc9fc6'],
  'function () { return 70000 }': ['062e6d8a9cc10ff55d9c0596114f6a2685aa2f571fcb205c922ba06ba7a4655c', '76f797c2822f0e20'],
  'function () { return 255.5 }': ['cdf22c756b78531beef91b8685d3fbfd7a489f8741f92a382b1b30402dccb0a9', '9544d222c5a05304'],
  'function () { return 0xdfff + 0.5 }': ['07552fe6a2932747a2f39cd0ed998dde2de2ea82b1f1565aee5b72615dff9182', 'c9707627d4b77b45'],
  // INPUT has an odd length, so this one answers with a low surrogate for the index past the end
  'function (i) { return i % 2 ? 0xdc00 : 0xd800 }': ['54c473fc8826f23b0337289dd0b5bf07592de8af595c13eead62f40d5d476e20', '4c7091596924ad4f'],
  'function (i) { return i % 2 ? 0xdc00 : 0xdbff + 0.5 }': ['0a6a7586835556d4369cc98cf1edc4c8771c7540b54dc60307d6b3703f16b966', '25a034c1e8db6267'],
  'function (i) { return i % 2 ? 0xdfff + 0.5 : 0xd800 }': ['73b9760f57e6c9bc87e3a129821852dd3f02288ecd25a89fafa49a1b94c690f4', '8ea2c65ffc76e16d'],
  // a different value on every call, so the result also depends on how often and in what order the hashes call it
  '(function () { var n = 0xdbf0; return function () { return n++ } })()': ['0a6a7586835556d4369cc98cf1edc4c8771c7540b54dc60307d6b3703f16b966', 'b9e33bbc77fa5724'],
}

test('short and sha256 end when charCodeAt returns -1, 3e9, NaN, undefined or a string', () => {
  for (const value of ['-1', '3e9', 'NaN', 'undefined', '"7"']) {
    const result = hashWith('function () { return ' + value + ' }')
    assert.match(String(result.sha256), /^[0-9a-f]{64}$/, value + ': ' + JSON.stringify(result))
    assert.match(String(result.short), /^[0-9a-f]{16}$/, value + ': ' + JSON.stringify(result))
  }
})

test('with charCodeAt replaced, both hashes return what 0.1.0 returned', () => {
  for (const replacement of Object.keys(RELEASED)) {
    const [sha, fnv] = RELEASED[replacement]
    assert.deepEqual(hashWith(replacement), { sha256: sha, short: fnv }, replacement)
  }
})
