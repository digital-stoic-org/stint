// Where a stream's notes, journal and archive live. One resolver, `streamPaths`, for every site; nothing else builds these paths.
//   off (default): flat files, `.stint/<stream>-notes.md`, `.stint/<stream>-journal.md`, `.stint/archive/`
//   on (experimental, userConfig `lifecycle` AND a `.stint/lifecycle` marker file in the project root): `.stint/<stream>/{notes.md, journal.md, archive/}`
// Code never moves, deletes or rewrites a file of the other layout; reads look at both (see readNotes here, readJournal in checkpoint.ts).

import type { EngineInterface, On, PluginOptions } from 'claude-code'

export type Mode = 'off' | 'on'

export const NOTES_DIR = '.stint'
export const ARCHIVE_DIR = 'archive'
export const WORK_DIR = 'work'
export const LIFECYCLE_MARKER = 'lifecycle'
// Stream names the per-stream layout cannot hold: `archive` is the flat layout's archive folder, `work` is reserved for the stream's scratch folder.
export const LAYOUT_RESERVED = ['archive', 'work']

const trim = (root: string) => root.replace(/\/+$/, '')

export type StreamPaths = {
  // The folder holding the stream's files.
  dir: string
  notes: string
  journal: string
  archive: string
  // The stream's scratch folder `<dir>/work` (absolute, no trailing slash). Only the lifecycle block and the sweep/promote read it; mode off has no such folder in use.
  work: string
  // Relative to the root, as shown to the user: `.stint/<stream>-notes.md` or `.stint/<stream>/notes.md`.
  rel: string
  // The notes file as named inside `.stint/` : `<stream>-notes.md` or `<stream>/notes.md`.
  name: string
}

export function streamPaths(root: string, stream: string, mode: Mode): StreamPaths {
  const base = `${trim(root)}/${NOTES_DIR}`
  if (mode === 'on') {
    const dir = `${base}/${stream}`
    return { dir, notes: `${dir}/notes.md`, journal: `${dir}/journal.md`, archive: `${dir}/${ARCHIVE_DIR}`, work: `${dir}/${WORK_DIR}`, rel: `${NOTES_DIR}/${stream}/notes.md`, name: `${stream}/notes.md` }
  }
  return { dir: base, notes: `${base}/${stream}-notes.md`, journal: `${base}/${stream}-journal.md`, archive: `${base}/${ARCHIVE_DIR}`, work: `${base}/${stream}/${WORK_DIR}`, rel: `${NOTES_DIR}/${stream}-notes.md`, name: `${stream}-notes.md` }
}

export const otherMode = (mode: Mode): Mode => (mode === 'on' ? 'off' : 'on')

// The refusal text when `stream` cannot exist under `mode`; null = fine.
export function forbiddenStream(stream: string, mode: Mode): string | null {
  if (mode === 'on' && LAYOUT_RESERVED.includes(stream)) return `"${stream}" is reserved by the per-stream layout (lifecycle on): pick another stream name, or turn lifecycle off`
  return null
}

// Names of the directories of `.stint/` that can be streams of the per-stream layout (the caller still checks they hold a notes.md).
export function streamDirNames(names: string[], valid: (name: string) => boolean): string[] {
  return names.filter(name => valid(name) && !LAYOUT_RESERVED.includes(name)).sort()
}

// ---------- setting (userConfig `lifecycle`) ----------

export const LIFECYCLE_KEY = 'stint.lifecycle'
let setting: Mode = 'off'
export const lifecycleSetting = () => setting
export function setLifecycle(value: unknown) {
  setting = value === 'on' ? 'on' : 'off'
}

// Read from the options at load, then kept by the config.set hook; an unknown value reads as off.
export function registerLifecycleSetting(on: On, userOptions: PluginOptions) {
  setLifecycle(userOptions.lifecycle)
  on('config.set', { key: LIFECYCLE_KEY }, async ($, e, next) => {
    const result = await next(e)
    if ('deny' in result && result.deny !== undefined) return result
    setLifecycle(e.value)
    return result
  }).catch(($, e, next) => next(e))
}

// The layout in force for a project root: on only when the setting is on AND the marker file `<root>/.stint/lifecycle` exists. Off touches no file.
export async function modeOf($: EngineInterface, root: string): Promise<Mode> {
  if (setting !== 'on') return 'off'
  try {
    return (await $.fs.exists(`${trim(root)}/${NOTES_DIR}/${LIFECYCLE_MARKER}`)) ? 'on' : 'off'
  } catch {
    return 'off'
  }
}

// ---------- notes: newest `saved:` across both layouts ----------

const savedMs = (text: string): number => {
  const m = text.match(/^saved: (\S+)/m)
  const ms = m ? Date.parse(m[1] as string) : Number.NaN
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms
}

// The notes of a stream in the layout of `mode`, or the other layout's when its `saved:` is strictly newer. A read error of the layout in force propagates; the other layout's is ignored.
export async function readNotes($: EngineInterface, root: string, stream: string, mode: Mode): Promise<string | null> {
  const own = streamPaths(root, stream, mode).notes
  const ownText = (await $.fs.exists(own)) ? await $.fs.read(own) : null
  const other = streamPaths(root, stream, otherMode(mode)).notes
  let otherText: string | null = null
  try {
    otherText = (await $.fs.exists(other)) ? await $.fs.read(other) : null
  } catch {
    otherText = null
  }
  if (otherText === null) return ownText
  if (ownText === null) return otherText
  return savedMs(otherText) > savedMs(ownText) ? otherText : ownText
}
