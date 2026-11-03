import { streamPaths } from './paths.ts'
import type { Mode } from './paths.ts'

// pit (stint), pure part: stream names, archive names, command arguments. Moved out of pit.ts verbatim; imports nothing from pit.ts.

export const DEFAULT_STREAM = 'main'

export const STREAM_RE = /^[a-zA-Z0-9_-]{1,50}$/
export const RESERVED = ['pit', 'rejoin']

// The fork runs in this very context: at or above this share of the wall (where auto-compaction fires) it would fail there.
export const WALL_CAP = 0.95

// ---------- pure helpers ----------

export const pad = (n: number) => String(n).padStart(2, '0')
export const notesPath = (cwd: string, stream: string, mode: Mode = 'off') => streamPaths(cwd, stream, mode).notes
const NOTES_FILE_RE = /^(.+)-notes\.md$/

// Stream names found in a `.stint` listing, sorted; anything that is not a valid `<stream>-notes.md` is ignored.
export function streamsFromNames(names: string[]): string[] {
  const out: string[] = []
  for (const name of names) {
    const m = name.match(NOTES_FILE_RE)
    if (m && STREAM_RE.test(m[1] as string) && !RESERVED.includes(m[1] as string)) out.push(m[1] as string)
  }
  return out.sort()
}

export const ARCHIVE_TRIES = 1_000

// Local time stamp of an archive file name: YYYYMMDD-HHMM.
export function archiveStamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

// n = 1 is the plain name; a same-minute collision adds -2, -3... before .md.
export const archiveName = (stream: string, ms: number, n = 1) => `${stream}-notes-${archiveStamp(ms)}${n > 1 ? `-${n}` : ''}.md`

// A /rename title that is not a valid stream name becomes one; empty or reserved = no stream.
export function slugify(title: string): string | null {
  const slug = STREAM_RE.test(title)
    ? title
    : title
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50)
        .replace(/-+$/, '')
  return slug === '' || RESERVED.includes(slug) ? null : slug
}

// The slash menu entries; the hint after the name is `argumentHint`.
export const COMMANDS = [
  { name: 'pit', description: 'Save the notes of a stream, then continue it in a fresh session (--save: save only, keep this session)', argumentHint: '[stream] [--save] [--trace]' },
  { name: 'rejoin', description: 'Load the notes of a stream as the first message of this session', argumentHint: '[stream]' },
]

export type Cmd = 'pit' | 'rejoin'
// `save`: /pit --save, the notes without the /clear (only /pit takes it).
export type ParsedArgs = { stream?: string; save?: boolean } | { error: string }

const USAGE: Record<Cmd, string> = { pit: 'Usage: /pit [stream]', rejoin: 'Usage: /rejoin [stream]' }
export const SAVE_FLAG = '--save'

export function parseArgs(args: string, cmd: Cmd): ParsedArgs {
  const all = args.split(/\s+/).filter(t => t !== '')
  const save = cmd === 'pit' && all.includes(SAVE_FLAG)
  const tokens = save ? all.filter(t => t !== SAVE_FLAG) : all
  const bad = tokens.find(t => t.startsWith('-'))
  if (bad) return { error: `unknown option ${bad}. ${USAGE[cmd]}` }
  if (tokens.length > 1) return { error: `too many arguments. ${USAGE[cmd]}` }
  const stream = tokens[0]
  if (stream === undefined) return save ? { save } : {}
  if (RESERVED.includes(stream)) return { error: `"${stream}" is a reserved word, not a stream name` }
  if (!STREAM_RE.test(stream)) return { error: `invalid stream "${stream}": use 1-50 chars of a-z A-Z 0-9 _ -` }
  return save ? { stream, save } : { stream }
}

// Explicit binding (a command argument) > session title (/rename) > this session's own name (autoStreamOf) > the default stream.
export function resolveStream(bound: string | null, title: string | null, auto: string | null = null): string {
  return bound ?? title ?? auto ?? DEFAULT_STREAM
}

// The stream of a session nobody named: <root folder>-<first 4 chars of the session id>. Two unnamed sessions started in one folder
// never share a journal or notes. No session id = the default stream.
export function autoStreamOf(root: string, sid: string): string {
  const tag = sid.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4)
  if (tag === '') return DEFAULT_STREAM
  const folder = (slugify(root.replace(/\/+$/, '').split('/').pop() ?? '') ?? 'session').slice(0, 45).replace(/-+$/, '') || 'session'
  return `${folder}-${tag}`
}

// The wall is where auto-compaction fires; a fork started at or above WALL_CAP of it would fail there.
export function overWall(tokens: number, wall: number): boolean {
  return wall > 0 && tokens >= WALL_CAP * wall
}
