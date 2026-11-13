// Builds tar archives for the old-engines tests, from the POSIX ustar and pax layouts

// a ustar header written field by field from the POSIX layout
export function header({ name, type = '0', size = 0, mode = 0o644, linkname = '', mtime = 1500000000, prefix = '' }) {
  const block = Buffer.alloc(512)
  const put = (offset, length, value) => block.write(value, offset, length, 'utf8')
  const octal = (offset, length, value) => put(offset, length, value.toString(8).padStart(length - 1, '0') + '\0')
  put(0, 100, name)
  octal(100, 8, mode)
  octal(108, 8, 1200)
  octal(116, 8, 1200)
  octal(124, 12, size)
  octal(136, 12, mtime)
  put(148, 8, ' '.repeat(8))
  put(156, 1, type)
  put(157, 100, linkname)
  put(257, 6, 'ustar\0')
  put(263, 2, '00')
  put(345, 155, prefix)
  let sum = 0
  for (const byte of block) sum += byte
  put(148, 8, sum.toString(8).padStart(6, '0') + '\0 ')
  return block
}
const padded = (data) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)])
export function entry(fields, data = '') {
  const bytes = Buffer.from(data)
  return Buffer.concat([header({ ...fields, size: bytes.length }), padded(bytes)])
}
export function pax(records) {
  const body = Object.entries(records).map(([key, value]) => {
    const rest = ` ${key}=${value}\n`
    let length = rest.length + 1
    while (String(length).length + rest.length !== length) length++
    return `${length}${rest}`
  }).join('')
  return entry({ name: 'PaxHeader', type: 'x' }, body)
}
export const archive = (...entries) => Buffer.concat([...entries, Buffer.alloc(1024)])
