// Display scale, text size and page zoom as a person sets them, written into a new temporary profile before the browser starts.
// Firefox: layout.css.devPixelsPerPx is the display scale, ui.textScaleFactor the operating system's text size (Firefox applies it as
// a zoom), and zoom lives in the profile's content-prefs.sqlite: "browser.content.full-zoom" with no site is the default zoom of
// Settings > General > Zoom, and with a site it is what the zoom keys and menu keep for that site. Chromium: the scale is the
// --force-device-scale-factor switch, the font sizes are the Appearance settings, and zoom is partition.default_zoom_level or
// partition.per_host_zoom_levels in the Preferences file, as a level: zoom = 1.2 ^ level.
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as playwright from 'playwright'

export const SITE = '127.0.0.1'

const scales = (values, make) => Object.fromEntries(values.map((v) => [make(v)[0], make(v)[1]]))
export const SCALE_SETTINGS = {
  firefox: {
    default: {},
    ...scales([1.25, 1.5, 1.75, 2], (v) => [`display scale ${v}`, { prefs: { 'layout.css.devPixelsPerPx': String(v) } }]),
    ...scales([110, 125, 150], (v) => [`text size ${v}%`, { prefs: { 'ui.textScaleFactor': v } }]),
    'minimum font size 20': { prefs: { 'font.minimum-size.x-western': 20 } },
    ...scales([0.8, 0.9, 1.1, 1.2, 1.33, 1.5, 1.7, 2], (v) => [`default zoom ${v}`, { zoom: { global: v } }]),
    ...scales([1.1, 1.5, 2], (v) => [`site zoom ${v}`, { zoom: { site: v } }]),
  },
  chromium: {
    default: {},
    ...scales([1.25, 1.5, 2], (v) => [`display scale ${v}`, { args: [`--force-device-scale-factor=${v}`] }]),
    'font size 20': { prefs: { webkit: { webprefs: { default_font_size: 20 } } } },
    'font size 24': { prefs: { webkit: { webprefs: { default_font_size: 24, default_fixed_font_size: 20 } } } },
    'minimum font size 20': { prefs: { webkit: { webprefs: { minimum_font_size: 20 } } } },
    ...scales([0.8, 0.9, 1.1, 1.25, 1.5, 1.75, 2], (v) => [`default zoom ${v}`, { zoom: { global: v } }]),
    ...scales([1.5, 2], (v) => [`site zoom ${v}`, { zoom: { site: v } }]),
  },
}

// Firefox makes content-prefs.sqlite on first use; one is made per run, from a browser started once with an empty profile, and
// copied into each profile that needs a zoom.
let template = null
async function firefoxTemplate(scratch) {
  if (template) return template
  const dir = scratch + '-template'
  const context = await playwright.firefox.launchPersistentContext(dir, { viewport: null })
  try {
    const tab = context.pages()[0] || (await context.newPage())
    await tab.goto('about:blank')
    for (let i = 0; i < 40 && !existsSync(join(dir, 'content-prefs.sqlite')); i++) await new Promise((r) => setTimeout(r, 100))
  } finally {
    await context.close()
  }
  if (!existsSync(join(dir, 'content-prefs.sqlite'))) throw new Error('Firefox made no content-prefs.sqlite')
  template = scratch + '-content-prefs.sqlite'
  copyFileSync(join(dir, 'content-prefs.sqlite'), template)
  rmSync(dir, { recursive: true, force: true })
  return template
}

/** Makes `dir` a profile that holds `setting` and returns it. */
export async function profileWith(engineName, setting, dir) {
  mkdirSync(dir, { recursive: true })
  if (engineName === 'firefox') {
    if (!setting.zoom) return dir
    const file = join(dir, 'content-prefs.sqlite')
    copyFileSync(await firefoxTemplate(dir), file)
    const db = new DatabaseSync(file)
    try {
      db.prepare('INSERT INTO settings (name) VALUES (?)').run('browser.content.full-zoom')
      const setting_ = db.prepare('SELECT id FROM settings WHERE name = ?').get('browser.content.full-zoom').id
      let group = null
      if (setting.zoom.site) {
        db.prepare('INSERT INTO groups (name) VALUES (?)').run(SITE)
        group = db.prepare('SELECT id FROM groups WHERE name = ?').get(SITE).id
      }
      db.prepare('INSERT INTO prefs (groupID, settingID, value, timestamp) VALUES (?, ?, ?, 0)').run(group, setting_, setting.zoom.site || setting.zoom.global)
    } finally {
      db.close()
    }
    return dir
  }
  const prefs = { ...(setting.prefs || {}) }
  if (setting.zoom) {
    const level = Math.log(setting.zoom.site || setting.zoom.global) / Math.log(1.2)
    prefs.partition = setting.zoom.site
      ? { per_host_zoom_levels: { x: { [SITE]: { zoom_level: level, last_modified: '13380000000000000' } } } }
      : { default_zoom_level: { x: level } }
  }
  mkdirSync(join(dir, 'Default'), { recursive: true })
  writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify(prefs))
  return dir
}
