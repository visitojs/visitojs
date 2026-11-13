// Browser launch options the harnesses share, from their command line.
// --gpu (Chromium): draw canvases on the machine's GPU instead of the software rasteriser CI has, so the checks meet a real GPU path
// --private (Firefox): every window private, the closest Playwright comes to a real private window
// --headed: a visible browser window. The two differ where it matters here: headed, Chromium's canvas text follows a Japanese,
// Chinese, Korean or Thai interface language despite lang="en", and Firefox's first text drawing of a session is slower
const GPU_ARGS = ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : [])]

export function launchFrom(engineName, argv) {
  const gpu = argv.includes('--gpu')
  const privately = argv.includes('--private')
  if (gpu && engineName !== 'chromium') throw new Error('--gpu is for Chromium only')
  if (privately && engineName !== 'firefox') throw new Error('--private is for Firefox only')
  const headed = argv.includes('--headed')
  const options = gpu ? { args: GPU_ARGS } : privately ? { firefoxUserPrefs: { 'browser.privatebrowsing.autostart': true } } : {}
  if (headed) options.headless = false
  const suffix = (gpu ? '-gpu' : privately ? '-private' : '') + (headed ? '-headed' : '')
  const label = (gpu ? ' with the GPU' : privately ? ', private windows' : '') + (headed ? ', headed' : '')
  return { options, gpu, privately, headed, suffix, label }
}

// How long a harness waits for its own local page to load. Playwright's default is 30 s; a one-CPU runner busy with a browser can
// take longer to serve the page, and that is a slow machine, not a finding. It is a wait only: no check depends on it.
export const NAVIGATION_MS = 90000

/** A harness page that did not load: the run cannot go on, and the message names the page. */
export class PageLoadError extends Error {
  constructor(address, cause) {
    super(`the page ${address} did not load: ${String((cause && cause.message) || cause).split('\n')[0]}`)
    this.name = 'PageLoadError'
  }
}

/** `page.goto` with the harness's wait, unless the caller gives its own; a failure becomes a PageLoadError. */
export async function loadPage(page, address, options = {}) {
  try {
    return await page.goto(address, { ...options, timeout: options.timeout === undefined ? NAVIGATION_MS : options.timeout })
  } catch (error) {
    throw new PageLoadError(address, error)
  }
}

/** For a run's last catch: a page that did not load prints one FAIL line and exits 1; any other error is thrown on. */
export function stopOnPageLoad(error, out = { log: (line) => console.log(line), exit: (code) => process.exit(code) }) {
  if (!(error instanceof PageLoadError)) throw error
  out.log(`FAIL ${error.message}`)
  out.exit(1)
}
