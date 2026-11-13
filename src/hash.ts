/**
 * The first 32 bits of the fractional part of the n-th root of each of the first `count` primes
 * (FIPS 180-4, 4.2.2 and 5.3.3), as signed 32-bit integers. Newton's method uses only + - * / %,
 * which ECMAScript defines as IEEE 754 double operations, so every engine computes the same tables
 * and a page that replaces Math cannot change them. 12 steps from x = 7, above every root taken here,
 * leave each value within one ulp of its root, and the nearest truncation boundary (the square root
 * of 5) is about 2,900 ulps away; fewer than 8 steps give wrong constants. test/hash.test.mjs checks
 * both tables against the published values. They cost a fraction of a millisecond once on a desktop,
 * instead of 540 gzipped bytes. The result has no prototype, so a setter or getter that a page puts on an
 * index of Array.prototype or Object.prototype cannot change a constant, as it could not change 0.1.0's
 * array literals; the round constants are kept for the life of the page.
 */
export function roots(count: number, n: number): number[] {
  var out: number[] = <any>{ __proto__: null }
  for (var p = 2, k = 0; k < count; p++) {
    for (var d = 2; d * d <= p && p % d; d++);
    if (d * d > p) {
      var x = 7
      for (var i = 0; i < 12; i++) x -= (x - p / (n > 2 ? x * x : x)) / n
      out[k++] = ((x % 1) * 4294967296) | 0
    }
  }
  return out
}

// the round constants, computed on the first call
var K: number[]

// utf8, hex32 and fnv1a make the calls 0.1.0 made, with the same values, so a page that replaced charCodeAt,
// push, toString or slice gets the same ids as before; a shorter encoder saved one byte and lost that
function utf8(s: string): number[] {
  var out: number[] = []
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      var low = s.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00)
        i++
      }
    }
    // a lone surrogate becomes U+FFFD, as every UTF-8 encoder does
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

function hex32(n: number): string {
  return ('0000000' + (n >>> 0).toString(16)).slice(-8)
}

/** SHA-256 of the UTF-8 bytes of `s`, as 64 hex characters. Synchronous, plain ES5. */
export function sha256(s: string): string {
  K = K || roots(64, 3)
  var bytes = utf8(s)
  var bits = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  var high = Math.floor(bits / 4294967296)
  bytes.push((high >>> 24) & 255, (high >>> 16) & 255, (high >>> 8) & 255, high & 255)
  bytes.push((bits >>> 24) & 255, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255)

  var h = roots(8, 2)
  var w: number[] = []
  for (var block = 0; block < bytes.length; block += 64) {
    var t: number
    // the schedule is 0.1.0's, line for line: w and bytes are ordinary arrays, so a page's accessor on one of
    // their indexes sees the same reads and conversions in the same order
    for (t = 0; t < 16; t++) {
      var p = block + t * 4
      w[t] = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]
    }
    for (t = 16; t < 64; t++) {
      var x = w[t - 15]
      var y = w[t - 2]
      var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
      var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
    for (t = 0; t < 64; t++) {
      var e1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      var t1 = (hh + e1 + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0
      var a0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      var t2 = (a0 + ((a & b) ^ (a & c) ^ (b & c))) | 0
      hh = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    var v = [a, b, c, d, e, f, g, hh]
    for (t = 0; t < 8; t++) h[t] = (h[t] + v[t]) | 0
  }
  var out = ''
  for (t = 0; t < 8; t++) out += hex32(h[t])
  return out
}

function fnv1a(s: string, h: number): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    // the low byte, then the rest when the unit is above 255: two rounds at most, whatever charCodeAt returns
    h ^= c & 255
    // h * 16777619 mod 2^32: h * 403 stays below 2^41, exact in a double, and h << 24 wraps by itself
    h = (h * 403 + (h << 24)) >>> 0
    if (c > 255) {
      h ^= c >>> 8
      h = (h * 403 + (h << 24)) >>> 0
    }
  }
  return h
}

/** A fast 64-bit hash (two FNV-1a passes) as 16 hex characters, for large rendering output where SHA-256 would be slow. */
export function short(s: string): string {
  return hex32(fnv1a(s, 0x811c9dc5)) + hex32(fnv1a(s, 0x01000193))
}
