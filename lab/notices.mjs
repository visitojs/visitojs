// Notices a browser prints itself, not the library, each named with its engine and the source that raises it. A harness that
// fails on console output skips these and nothing else. `line` is the console message as `<type>: <text>`.
export const BROWSER_NOTICES = [
  {
    engine: 'firefox',
    name: 'screen-avail',
    pattern: /Fingerprinting Protection is altering screen.availWidth and screen.availHeight/,
    reason: "Firefox's own notice when a page reads screen.availWidth or availHeight under its fingerprinting protection; the lab build's x.avail read triggers it",
  },
  {
    // FontVisibilityProvider::FormatBlockedFontFamilyMessage, toolkit/components/resistfingerprinting/FontVisibilityProvider.cpp.
    // In private browsing Firefox's fingerprinting protection exposes only base-system and language-pack fonts (level 2), and layout
    // reports each other installed font it looks up; on Linux fontconfig lists such fonts for the generic families
    engine: 'firefox',
    name: 'font-visibility',
    pattern: /^warning: (?:\[JavaScript Warning: ")?Request for font "([^"\n]+)" blocked at visibility level \d \(requires \d\)\n?(?:" \{file: "[^"\n]*" line: \d+\}\])?$/,
    reason: "Firefox's own warning, in private browsing, when layout looks up an installed font its fingerprinting protection hides; on Linux the default font and the text-size read's monospace node trigger it",
  },
]

/** The browser notice this console line is, or undefined. */
export const noticeFor = (engine, line) => BROWSER_NOTICES.find((n) => n.engine === engine && n.pattern.test(line))

/** The font a font-visibility warning names, or null. */
export const blockedFont = (engine, line) => {
  const notice = noticeFor(engine, line)
  return notice && notice.name === 'font-visibility' ? notice.pattern.exec(line)[1] : null
}
