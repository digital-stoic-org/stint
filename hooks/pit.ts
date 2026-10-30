import type { EngineInterface, On } from 'claude-code'

import { pitDone, pitStart, refresh as refreshDash, setLap } from './dash.ts'
import { debugOn, sidNow, startWatch, stopWatch, trace, writeReport } from './debug.ts'
import { AUTOPIT_CEILING, AUTOPIT_MIN_TOKENS, getAutopitInfo, getIdleFire, setAutopitInfo, setIdleFire, setPitBoard, setPitLine, writeStatus } from './status.ts'
import type { AutopitInfo } from './status.ts'

export { AUTOPIT_CEILING, AUTOPIT_MIN_TOKENS }

// pit (stint): one mod, two commands.
//   /pit [stream]      save notes (awaited fork) -> /clear (automatic) -> notes re-injected as the first message of the fresh context
//   /rejoin [stream]   notes of a stream -> first message of this session
// Notes live in <session root>/.stint/<stream>-notes.md. One $.model.fork designates every field; code parses, assembles and caps the file.
// Command names: `$.command.register` takes letters, digits, `_` and `-` only (CommandSpec.name), so no `stint:pit`: the commands are /pit and /rejoin.

const STORE_KEY = 'stint:pending'
const STALE_MS = 10 * 60 * 1000
export const NOTES_DIR = '.stint'
export const DEFAULT_STREAM = 'main'
// Hard cap of the notes file, enforced by code: the fork is told the ceiling and the room left, assemble() cuts what still overflows.
export const NOTES_MAX = 8_000
const SHRINK_LINE = 80
export const STREAM_RE = /^[a-zA-Z0-9_-]{1,50}$/
export const RESERVED = ['pit', 'rejoin']
// $.agent.list() is raced against this: a hang would leave a pit stuck without a word.
const AGENT_LIST_MS = 5_000
const ERROR_TOAST_MS = 12_000
// A flow line older than this says it may be stuck ($.model.fork cannot be cancelled).
export const SLOW_MS = 3 * 60 * 1000
// The fork runs in this very context: at or above this share of the wall (where auto-compaction fires) it would fail there.
export const WALL_CAP = 0.95

// Injected after the notes, verbatim from the previous generation (the "wait for my go" variant).
export const UNPACK_RULES = `Reply with one line saying you are ready, then stop there.
Do nothing without my explicit go — no file read, no command, no sub-agent, no continuation of what is in progress.
Do not read the notes back to me. One line of acknowledgement is the whole answer.
Write a message only when something changes. The rest of the time stay silent.
Questions go to me, in this window.
After my go, read the \`read_first\` files before acting.`

export const FORK_PROMPT = `You are writing the notes of this work stream for yourself. After a /clear the notes file is the ONLY thing the fresh context receives. You designate every field yourself; code only assembles and caps the file.
First line, exactly one of:
GATE: ok
GATE: blocked - <one-line reason>
Blocked = you are in the middle of a cross-item step (synthesis, deduplication, global arbitration across all units). Then output nothing else.
If ok, from line 2 output ONLY the block below, keys in this order, no markdown, no prose, no blank line. Scalar = one line \`key: value\`. List = \`key:\` then one \`- item\` line per item; a missing list = empty.
status: <one word or short phrase: building | blocked | review ...>
goal: <1 sentence, carried from PREVIOUS NOTES unless it changed>
read_first:
- <path — role>   (closed list, read only after the human's go, never before the go)
read_if_needed:
- <path or URL — when to read it>
deliverable: <path where the written work lives>
decisions:
- <choice — why>   (the why is mandatory; do not reopen)
learnings:
- <non-obvious fact — command or path that proves it>
discarded:
- <path or approach tried — why rejected>
in_progress:
- <half-done item — where it stands>
next:
- <action>   (2-4 actions)
unknowns:
- <what is not known>   (never empty)
stale:
- <path — replaced by X; do not reload>
Rules:
- You own every field. Return the COMPLETE current content of every list: merge PREVIOUS NOTES with what this conversation added. Carry forward what is still true; drop what is done, answered, replaced or reversed (a reversed decision goes to discarded). Never restart from scratch.
- Lines starting "agent in flight:" are written by code: never write one.
- A pointer (absolute path, path:line, command) replaces any explanation. Do not run commands; write them.`

// ---------- pure helpers ----------

export const pad = (n: number) => String(n).padStart(2, '0')
export const notesPath = (cwd: string, stream: string) => `${cwd.replace(/\/+$/, '')}/${NOTES_DIR}/${stream}-notes.md`
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

export const ARCHIVE_DIR = 'archive'
const ARCHIVE_TRIES = 1_000

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

// Explicit binding (a command argument) > session title (/rename) > the default stream.
export function resolveStream(bound: string | null, title: string | null): string {
  return bound ?? title ?? DEFAULT_STREAM
}

// The wall is where auto-compaction fires; a fork started at or above WALL_CAP of it would fail there.
export function overWall(tokens: number, wall: number): boolean {
  return wall > 0 && tokens >= WALL_CAP * wall
}

// ---------- auto-pit: pure parts ----------

// The setting row `stint.autopit` (plugin.json userConfig). An unknown value reads as the default.
export const AUTOPIT_KEY = 'stint.autopit'
export const AUTOPIT_DEFAULT = 'on'
const AUTOPIT_DELAY_MIN: Record<string, number> = { on: 50 }
// The main conversation's cache lives 1 h from its last request; a fire later than this (machine asleep) finds it dead.
export const AUTOPIT_MAX_AGE_MS = 58 * 60 * 1000
// The board shows the idle timer from this much inactivity on, until it fires.
export const AUTOPIT_SHOW_AFTER_MS = 15 * 60 * 1000
// Ceiling trigger (AUTOPIT_CEILING of the window, in status.ts) is capped by this share of the wall, where the host compacts on its own: a 200k window compacts well before 80%.
export const CEILING_WALL_PCT = 90

// The ceiling in tokens: the tighter of AUTOPIT_CEILING of the window and CEILING_WALL_PCT of the wall. Whole percents, so the edge values are exact.
export function ceilingTokens(window: number, wall: number): number {
  return Math.min((Math.round(AUTOPIT_CEILING * 100) * window) / 100, (CEILING_WALL_PCT * wall) / 100)
}

// The same ceiling as a whole % of the window, rounded down: what the board and the toast say ("auto-pit at 75%").
export function ceilingPercent(window: number, wall: number): number {
  return Math.floor((ceilingTokens(window, wall) / window) * 100 + 1e-9)
}

// null = off; else the idle wait before the pit, in ms.
export function autopitDelayMs(mode: unknown): number | null {
  if (mode === 'off') return null
  const min = typeof mode === 'string' ? AUTOPIT_DELAY_MIN[mode] : undefined
  return (min ?? (AUTOPIT_DELAY_MIN[AUTOPIT_DEFAULT] as number)) * 60_000
}

// What the fire reads before it pits; null = could not be read (that skips: an unverified guard is a failed guard).
export type AutopitGate = {
  mode: unknown
  saving: boolean
  turnRunning: boolean
  // ms since the last main-loop turn.complete; null = none seen since the last /clear or start
  sinceMs: number | null
  tokens: number | null
  draft: string | null
  // agents running, pending or waiting (an idle teammate survives the /clear and is written in the notes)
  busyAgents: number | null
}

// The reason to skip, or null when every guard holds. Order = cheapest first.
export function autopitSkip(g: AutopitGate): string | null {
  if (autopitDelayMs(g.mode) === null) return 'setting is off'
  if (g.saving) return 'a pit is already running'
  if (g.turnRunning) return 'a turn is running'
  if (g.sinceMs === null || g.sinceMs > AUTOPIT_MAX_AGE_MS) return 'the prompt cache is probably expired'
  if (g.tokens === null) return 'context size unknown'
  if (g.tokens < AUTOPIT_MIN_TOKENS) return 'context below the threshold'
  if (g.draft === null) return 'prompt box unreadable'
  if (g.draft.trim() !== '') return 'a draft is in the prompt box'
  if (g.busyAgents === null) return 'agents unknown'
  if (g.busyAgents > 0) return 'agents are running'
  return null
}

// What the fresh session shows for an auto-pit: when it fired, how long idle (idle trigger only), how big the context was.
// A mark stored without `kind` (an older pending) is an idle one.
export type AutoKind = 'idle' | 'ceiling'
// `pct` of a ceiling mark: the effective ceiling in % of the window (the wall may cap it under the nominal one).
export type AutoMark = { kind: 'idle'; at: number; idleMin: number; tokens: number } | { kind: 'ceiling'; at: number; tokens: number; pct?: number }

export function autoLine(mark: AutoMark, path: string): string {
  const d = new Date(mark.at)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const k = Math.round(mark.tokens / 1000)
  if (mark.kind === 'ceiling') return `⛔ auto-pit (ceiling ${mark.pct ?? Math.round(AUTOPIT_CEILING * 100)}%) at ${hm} · ${k}k → notes ${path}`
  return `⏸ auto-pit at ${hm} · ${mark.idleMin} min idle · ${k}k → notes ${path}`
}

// What the ceiling trigger reads after a turn; null = could not be read (that skips).
export type CeilingGate = {
  mode: unknown
  saving: boolean
  turnRunning: boolean
  tokens: number | null
  window: number | null
  // where the host compacts on its own; absent or unreadable = the window
  wall?: number | null
  draft: string | null
  busyAgents: number | null
}

export const CEILING_BELOW = 'context below the ceiling'

// The reason to skip, or null when every guard holds. CEILING_BELOW is the quiet one (nothing to say, not a skip worth tracing).
export function ceilingSkip(g: CeilingGate): string | null {
  if (g.tokens === null || g.window === null || !(g.window > 0)) return 'context size unknown'
  if (g.tokens < ceilingTokens(g.window, typeof g.wall === 'number' && g.wall > 0 ? g.wall : g.window)) return CEILING_BELOW
  if (autopitDelayMs(g.mode) === null) return 'setting is off'
  if (g.saving) return 'a pit is already running'
  if (g.turnRunning) return 'a turn is running'
  if (g.draft === null) return 'prompt box unreadable'
  if (g.draft.trim() !== '') return 'a draft is in the prompt box'
  if (g.busyAgents === null) return 'agents unknown'
  if (g.busyAgents > 0) return 'agents are running'
  return null
}

export const elapsed = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${pad(s % 60)}s`
}

export function progressText(label: string, ms: number): string {
  if (ms >= SLOW_MS) return `${label}: still running after ${elapsed(ms)}, slow or stuck; the outcome will show here`
  return ms < 1000 ? `${label}...` : `${label}... ${elapsed(ms)}`
}

// The same flow for the band's board slot: short, no quotes around nothing.
export function boardProgress(stream: string, ms: number): string {
  if (ms >= SLOW_MS) return `pitting "${stream}": slow or stuck, ${elapsed(ms)}`
  return ms < 1000 ? `pitting "${stream}"...` : `pitting "${stream}"... ${elapsed(ms)}`
}

export const savedBoard = (chars: number) => `saved ${chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : chars} -> clearing`

export function hintBoard(streams: string[]): string {
  return streams.length === 1 ? `notes found: /rejoin ${streams[0]}` : '/rejoin <stream>: several notes found'
}

export function hintText(streams: string[]): string {
  if (streams.length === 1) return `Notes for stream "${streams[0]}" found: /rejoin ${streams[0]}`
  return `Notes found for streams ${streams.map(s => `"${s}"`).join(', ')}: /rejoin <stream>`
}

const SHORT_REASON = 80
const shortReason = (reason: string) => {
  const one = reason.replace(/\s+/g, ' ').trim()
  return one.length > SHORT_REASON ? `${one.slice(0, SHORT_REASON - 1)}…` : one
}

// ---------- notes format ----------

export const SCALARS_HEADER = ['stream', 'saved', 'status', 'previous_session', 'goal']
// Written after the header scalars when the caller gives a stint number: the stint the notes hand over to (absent in older notes = 1).
export const STINT_KEY = 'stint'
export const LISTS = ['read_first', 'read_if_needed', 'decisions', 'learnings', 'discarded', 'in_progress', 'next', 'unknowns', 'stale']
// Body order of the notes file (deliverable is the only scalar among them).
export const BODY_ORDER = ['read_first', 'read_if_needed', 'deliverable', 'decisions', 'learnings', 'discarded', 'in_progress', 'next', 'unknowns', 'stale']

export type Keyed = { scalars: Record<string, string>; lists: Record<string, string[]> }

// `key: value` scalars and `key:` + `- item` lists; unknown lines are ignored.
export function parseKeyed(text: string, scalarKeys: string[], listKeys: string[]): Keyed {
  const out: Keyed = { scalars: {}, lists: {} }
  let current: string | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const key = line.match(/^([a-z_]+):\s*(.*)$/)
    if (key && scalarKeys.includes(key[1] as string)) {
      out.scalars[key[1] as string] = (key[2] as string).trim()
      current = null
    } else if (key && listKeys.includes(key[1] as string)) {
      const k = key[1] as string
      out.lists[k] = out.lists[k] ?? []
      current = k
      if ((key[2] as string).trim()) (out.lists[k] as string[]).push((key[2] as string).trim())
    } else if (current && line.startsWith('- ')) {
      ;(out.lists[current] as string[]).push(line.slice(2).trim())
    }
  }
  return out
}

const NOTES_SCALARS = [...SCALARS_HEADER, STINT_KEY, 'deliverable']
export const parseNotes = (text: string) => parseKeyed(text, NOTES_SCALARS, LISTS)

// The stint number in a notes file; missing, malformed or no file = 1.
export function stintOf(notes: string | null): number {
  const raw = notes ? parseNotes(notes).scalars[STINT_KEY] : undefined
  const n = raw !== undefined && /^\d{1,6}$/.test(raw) ? Number(raw) : 1
  return n >= 1 ? n : 1
}

const FORK_SCALARS = ['status', 'goal', 'deliverable']
export type ForkParse = { kind: 'ok'; body: string } | { kind: 'blocked'; reason: string }

export function parseFork(text: string): ForkParse {
  const lines = text.trim().split('\n')
  const first = (lines[0] ?? '').trim()
  if (first === 'GATE: ok') {
    const body = lines.slice(1).join('\n').trim()
    return body ? { kind: 'ok', body } : { kind: 'blocked', reason: 'empty fork output' }
  }
  const blocked = first.match(/^GATE:\s*blocked\s*[-—:]?\s*(.*)$/)
  if (blocked) return { kind: 'blocked', reason: blocked[1] || 'no reason given' }
  return { kind: 'blocked', reason: `malformed first line: ${first.slice(0, 80)}` }
}

export function parseForkBody(body: string): Keyed | null {
  const fields = parseKeyed(body, FORK_SCALARS, LISTS)
  if (Object.keys(fields.scalars).length === 0 && Object.keys(fields.lists).length === 0) return null
  return fields
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
export const AGENT_LINE = 'agent in flight:'
// The list did not answer in AGENT_LIST_MS: said once in the notes instead of silently listing nobody.
export const AGENTS_UNKNOWN = 'agents: unknown (list timed out)'
const AGENTS_MAX = 10
const AGENT_DESC_MAX = 100
const LIVE_STATUS = ['pending', 'running', 'waiting', 'idle']

export type AgentLike = { id: string; name?: string; type: string; status: string; description?: string }

// One code-written line per live background agent, so the fresh context after /clear knows whom it can still SendMessage.
export function agentLinesOf(listed: AgentLike[]): string[] {
  const live = listed.filter(a => LIVE_STATUS.includes(a.status))
  const lines = live.slice(0, AGENTS_MAX).map(a => {
    const desc = oneLine(a.description ?? '')
    return `${AGENT_LINE} ${oneLine(a.name || a.type)} [${a.id}] ${a.status}${desc ? ` — ${desc.slice(0, AGENT_DESC_MAX)}` : ''}`
  })
  if (live.length > AGENTS_MAX) lines.push(`${AGENT_LINE} +${live.length - AGENTS_MAX} more, not listed`)
  return lines
}

const uniq = (lines: string[]) => [...new Set(lines)]

export type AssembleInput = {
  stream: string
  saved: string
  sid: string
  prev: string | null
  fork: Keyed
  // The stint the notes hand over to; no line in the header when absent.
  stint?: number
  // In-flight agent lines (agentLines()), written by code; rendered first in in_progress and never cut.
  agents?: string[]
}
export type Assembled =
  | { kind: 'ok'; state: string; cut: string[]; degraded: boolean }
  | { kind: 'blocked'; reason: string }

// The fork designated every field; code merges nothing but the header and the agent lines, then enforces the cap.
export function assemble(input: AssembleInput): Assembled {
  const prev = input.prev ? parseNotes(input.prev) : null
  const fields = input.fork

  const lists: Record<string, string[]> = {}
  for (const sec of LISTS) {
    let own = uniq((fields.lists[sec] ?? []).map(oneLine).filter(l => l !== ''))
    if (sec === 'decisions') own = own.map(l => (l.includes('—') ? l : `${l} — why missing`))
    if (sec === 'in_progress') own = own.filter(l => !l.startsWith(AGENT_LINE) && l !== AGENTS_UNKNOWN) // code writes those, never the fork
    lists[sec] = own
  }
  if (lists.unknowns?.length === 0) lists.unknowns = ['nothing recorded — treat every fact as unverified']

  const prevWriter = (prev?.scalars.saved ?? '').split(/\s+/)[1]
  const previousSession = prevWriter && prevWriter !== input.sid ? prevWriter : prev?.scalars.previous_session || 'none'
  const scalars: Record<string, string> = {
    stream: input.stream,
    saved: `${input.saved} ${input.sid}`,
    status: oneLine(fields.scalars.status || prev?.scalars.status || 'unknown'),
    previous_session: previousSession,
    goal: oneLine(fields.scalars.goal || prev?.scalars.goal || 'unknown'),
    deliverable: oneLine(fields.scalars.deliverable || prev?.scalars.deliverable || 'none'),
  }

  // The overflow line is the last line of stale, outside `lists` so no cut step can drop it; the agent lines sit the same way in front of in_progress.
  let overflowLine: string | null = null
  let degraded = false
  const render = () => {
    const header: Record<string, string | undefined> = { ...scalars, status: degraded ? `degraded (${scalars.status})` : scalars.status }
    const head = [...SCALARS_HEADER.map(k => `${k}: ${header[k]}`), ...(input.stint !== undefined ? [`${STINT_KEY}: ${input.stint}`] : [])].join('\n')
    const agents = input.agents ?? []
    const shown = (k: string) => {
      const list = lists[k] ?? []
      return k === 'stale' && overflowLine ? [...list, overflowLine] : k === 'in_progress' ? [...agents, ...list] : list
    }
    const body = BODY_ORDER.map(k => (k === 'deliverable' ? `deliverable: ${scalars.deliverable}` : `${k}:${shown(k).map(l => `\n- ${l}`).join('')}`)).join('\n')
    return `${head}\n\n${body}\n`
  }

  // Hard cap, enforced here whatever the fork wrote. Cut order: read_if_needed (compressed), stale, in_progress, discarded, learnings (each oldest first).
  // Still over: what is left of read_if_needed, then next, unknowns, decisions. Never cut: header scalars, read_first, deliverable, the agent lines.
  const cut: string[] = []
  let text = render()
  const over = () => text.length > NOTES_MAX
  if (over()) {
    degraded = true
    text = render()
  }
  const dropped: Record<string, number> = {}
  const drop = (sec: string) => {
    ;(lists[sec] as string[]).shift()
    dropped[sec] = (dropped[sec] ?? 0) + 1
    text = render()
  }
  if (over()) {
    const before = (lists.read_if_needed as string[]).join('\n')
    lists.read_if_needed = (lists.read_if_needed as string[]).map(l => (l.length <= SHRINK_LINE ? l : `${l.slice(0, SHRINK_LINE - 1)}…`))
    text = render()
    if ((lists.read_if_needed as string[]).join('\n') !== before) cut.push('read_if_needed compressed')
  }
  for (const sec of ['stale', 'in_progress', 'discarded', 'learnings']) {
    while (over() && (lists[sec] as string[]).length > 0) drop(sec)
  }
  if (over()) {
    // The cut is announced in stale, inside the measured text.
    const overflow = () =>
      `overflow: cut to fit ${NOTES_MAX} chars: ${Object.entries(dropped).map(([s, n]) => `${s} -${n}`).join(', ') || 'nothing yet'}`
    overflowLine = overflow()
    text = render()
    for (const sec of ['read_if_needed', 'next', 'unknowns', 'decisions']) {
      while (over() && (lists[sec] as string[]).length > 0) {
        drop(sec)
        overflowLine = overflow()
        text = render()
      }
    }
  }
  for (const [sec, n] of Object.entries(dropped)) cut.push(`${sec} -${n}`)
  if (over()) {
    return {
      kind: 'blocked',
      reason: `notes ${text.length} chars > ${NOTES_MAX} after cutting ${cut.join(', ') || 'nothing cuttable'}; the header, read_first and the agent lines alone exceed the cap: shorten read_first by hand. Nothing written.`,
    }
  }
  return { kind: 'ok', state: text, cut, degraded: degraded }
}

export function forkPrompt(prev: string | null): string {
  const n = (v: number) => v.toLocaleString('en-US')
  const room = NOTES_MAX - (prev?.length ?? 0)
  const budget = `SIZE: the notes file may not exceed ${n(NOTES_MAX)} characters; past it code cuts, in this order, read_if_needed, stale, in_progress, discarded, learnings, then the rest. PREVIOUS NOTES are ${n(prev?.length ?? 0)} characters: ${room >= 0 ? `${n(room)} left` : `${n(-room)} over`} for what this conversation adds.${room < 1_500 ? ' Room is tight: drop obsolete lines and shorten the rest.' : ''}`
  return `${FORK_PROMPT}\n\n${budget}\n\nPREVIOUS NOTES:\n${prev ?? '(none)'}`
}

// Auto-pit only: the user did not ask for this, so the first answer is the line below, a short summary, then silence.
// `warn`: the overwrite warning, shown on the line right after the auto line.
export const autoUnpackRules = (line: string, kind: AutoKind = 'idle', warn?: string) => `Your first line is exactly this, with nothing before it:
${line}
${warn === undefined ? '' : `The line right after it is exactly this warning, nothing between them:\n${warn}\n`}Then summarize the notes in 3 to 5 short lines: status, goal, what is in progress, the next action.
Then stop and wait for me. ${kind === 'ceiling' ? 'The session was saved and cleared automatically because the context was nearly full: do not resume the task.' : 'The session was saved and cleared while I was away: do not resume the task.'}
Do nothing without my explicit go — no file read, no command, no sub-agent.
Write a message only when something changes. The rest of the time stay silent.
Questions go to me, in this window.
After my go, read the \`read_first\` files before acting.`

// The text injected as the first message: the notes, then the rules (the auto-pit variant when `auto` is the line to show first).
export const injectText = (notes: string, auto?: string, kind: AutoKind = 'idle', warn?: string) =>
  `${notes.trimEnd()}\n\n${auto === undefined ? UNPACK_RULES : autoUnpackRules(auto, kind, warn)}`

export const overwriteWarning = (stream: string) =>
  `⚠️ ${stream}-notes.md was rewritten by another session; its content was merged into these notes and its previous version is in archive/`

function forkFailure(reason: string): string {
  return reason === 'nothing-to-fork' ? 'nothing to save yet: this conversation has no response' : `fork failed (${reason})`
}

// ---------- module state (survives /clear, lost on mod reload; the pending injection is backed up in $.store) ----------

// `sid`: the session of the pit, kept only while debug is on.
type Pending = { text: string; createdAt: number; root: string; stream: string; sid?: string | undefined; auto?: AutoMark | undefined; warn?: string | undefined }

let pending: Pending | null = null
// Notes path -> the text this session last wrote or read there; a different text at pit time means another session rewrote the file.
// Kept across /clear, dropped on startup/resume/fork.
const seenNotes = new Map<string, string>()
// A pit is running (the fork is slow): refuse a second one meanwhile.
let saving = false
// Stream binding. Same session across /clear, so it survives /clear; reset on startup/resume/fork.
let boundArg: string | null = null
let titleStream: string | null = null
// The pit's message: running flow, then last sticky outcome, then the session-start hint. `status` goes to the status line
// (only where the band was never raised), `board` to the band's board slot; `bad` draws it red. An empty status writes nothing.
type Line = { status: string; board: string; bad?: boolean }
let flowLine: Line | undefined
let ticker: { cancel: () => void } | null = null
let outcome: Line | undefined
let hint: Line | undefined

const current = () => resolveStream(boundArg, titleStream)

// Auto-pit state. The mode is read from the /config row on first use and follows config.set; the rest is rebuilt by the next turn.complete.
let autopitMode: string | null = null
let autopitTimer: { cancel: () => void } | null = null
// Bumped by every cancel, so an arm that was awaiting the mode when the user typed does not start a timer after it.
let armGen = 0
let lastTurnAt: number | null = null
let turnRunning = false
// The ready turn of an auto-pit must not arm the next one.
let skipNextArm = false
// An auto-pit is between its guards and its /clear: a prompt or a turn starting then aborts it.
let autoRunning = false
let autoAborted = false
// Waits for agents: the idle trigger found agents running at its fire, or /pit was typed with agents running. Both end at the main-loop turn end that finds none busy.
// Not cleared by cancelAutopit (armAutopit calls it): only a prompt, a new context or the setting going off clears them.
let idleWaiting = false
let manualWait: { stream: string | undefined } | null = null
// The flow line the waits show (so a running pit's own line is never cleared by mistake).
let waitLine: Line | undefined

// pit's own lines (flow, outcome, hint) come first; with none, the dash line (status.ts).
function paint($: EngineInterface) {
  const line = flowLine ?? outcome ?? hint
  setPitLine(line?.status || undefined)
  setPitBoard(line ? { text: line.board, ...(line.bad ? { bad: true } : {}) } : undefined)
  writeStatus($)
  $.ui.invalidate('ui.render')
}

function flowStatus($: EngineInterface, line: Line | undefined) {
  stopProgress()
  flowLine = line
  paint($)
}

// A flow line with its elapsed time, ticking every second until the next flowStatus().
function startProgress($: EngineInterface, label: string, stream: string) {
  const at = (ms: number): Line => ({ status: progressText(label, ms), board: boardProgress(stream, ms) })
  flowStatus($, at(0))
  let ms = 0
  ticker = $.clock.every(1000, () => {
    ms += 1000
    flowLine = at(ms)
    paint($)
  })
}

function stopProgress() {
  ticker?.cancel()
  ticker = null
}

function showWait($: EngineInterface, text: string) {
  const line: Line = { status: `⏳ ${text}`, board: text }
  waitLine = line
  flowStatus($, line)
}

// `idleOnly`: the setting went off, a queued /pit stays.
function dropWaits($: EngineInterface, idleOnly = false) {
  idleWaiting = false
  if (!idleOnly) manualWait = null
  if (manualWait !== null || waitLine === undefined) return
  if (flowLine === waitLine) flowStatus($, undefined)
  waitLine = undefined
}

function fail($: EngineInterface, text: string, board: string) {
  outcome = { status: `⚠ ${shortReason(text)}`, board, bad: true }
  $.ui.toast(text, { timeoutMs: ERROR_TOAST_MS })
  flowStatus($, undefined)
}

// ---------- disk ----------

async function readOptional($: EngineInterface, path: string): Promise<string | null> {
  return (await $.fs.exists(path)) ? await $.fs.read(path) : null
}

// The project root: where the session started. A shell `cd` moves the cwd but not the root, and /clear resets the cwd to the root, so notes and the pending match are anchored here. Falls back to the cwd when the host gives no root. Function declaration: the hooks compiler refuses `$` passed to an arrow.
async function rootNow($: EngineInterface): Promise<string> {
  try {
    const root = await $.session.root()
    if (root) return root
  } catch {
    // no root: the cwd
  }
  return await $.session.cwd()
}

// Streams that have a notes file in the project root; a missing directory is no notes.
async function listStreams($: EngineInterface): Promise<string[]> {
  try {
    const entries = await $.fs.list(`${(await rootNow($)).replace(/\/+$/, '')}/${NOTES_DIR}`)
    return streamsFromNames(entries.filter(e => e.kind === 'file').map(e => e.name))
  } catch {
    return []
  }
}

// $.agent.list() raced against AGENT_LIST_MS.
async function listAgents($: EngineInterface): Promise<AgentLike[] | 'timeout' | 'error'> {
  let timer: { cancel: () => void } | null = null
  try {
    const timeout = new Promise<'timeout'>(resolve => {
      timer = $.clock.after(AGENT_LIST_MS, () => resolve('timeout'))
    })
    return await Promise.race([$.agent.list(), timeout])
  } catch {
    return 'error'
  } finally {
    ;(timer as { cancel: () => void } | null)?.cancel()
  }
}

// Called BEFORE the fork starts, so the fork never lists itself. Never fails the pit.
async function agentLines($: EngineInterface): Promise<string[]> {
  const listed = await listAgents($)
  if (listed === 'timeout') return [AGENTS_UNKNOWN]
  return listed === 'error' ? [] : agentLinesOf(listed)
}

const BUSY_STATUS = ['pending', 'running', 'waiting']

// Agents (subagents, teammates) at work now; null when the list did not answer.
// Workflows are NOT in $.agent.list() (index.d.ts:3286 in .claude-plugin/types/claude-code): a running workflow holds no wait. Known gap, accepted.
async function busyAgents($: EngineInterface): Promise<number | null> {
  const listed = await listAgents($)
  return typeof listed === 'string' ? null : listed.filter(a => BUSY_STATUS.includes(a.status)).length
}

// ---------- save ----------

type Built = { kind: 'ok'; state: string; cut: string[]; degraded: boolean; stint: number; warn?: string } | { kind: 'blocked'; reason: string }

async function askFork($: EngineInterface, prompt: string): Promise<{ kind: 'ok'; fork: Keyed } | { kind: 'blocked'; reason: string }> {
  const reply = await $.model.fork({ prompt })
  if (!reply.isAnswered) return { kind: 'blocked', reason: forkFailure(reply.reason) }
  const parsed = parseFork(reply.text)
  if (parsed.kind === 'blocked') return parsed
  const fork = parseForkBody(parsed.body)
  return fork ? { kind: 'ok', fork } : { kind: 'blocked', reason: 'unparseable fork output' }
}

// Copies the previous notes to <root>/.stint/archive/<stream>-notes-<YYYYMMDD-HHMM>.md; a name already taken gets -2, -3... Never overwrites, never prunes.
async function archivePrev($: EngineInterface, cwd: string, stream: string, prev: string, ms: number): Promise<string> {
  const dir = `${cwd.replace(/\/+$/, '')}/${NOTES_DIR}/${ARCHIVE_DIR}`
  for (let n = 1; n <= ARCHIVE_TRIES; n++) {
    const path = `${dir}/${archiveName(stream, ms, n)}`
    if (await $.fs.exists(path)) continue
    await $.fs.write(path, prev)
    return path
  }
  throw new Error(`no free archive name for ${archiveName(stream, ms)}`)
}

// `save`: a checkpoint inside the stint, not a hand-over: the stint number stays.
async function buildNotes($: EngineInterface, cwd: string, stream: string, save = false): Promise<Built> {
  try {
    const sid = await $.session.id()
    const path = notesPath(cwd, stream)
    const prev = await readOptional($, path)
    const agents = await agentLines($)
    // One fork per save: an over-cap answer is cut by assemble(), never re-asked.
    const asked = await askFork($, forkPrompt(prev))
    if (asked.kind === 'blocked') return asked
    const stint = stintOf(prev) + (save ? 0 : 1)
    const nowMs = await $.clock.now()
    const result = assemble({ stream, saved: new Date(nowMs).toISOString(), sid, prev, fork: asked.fork, agents, stint })
    if (result.kind === 'blocked') return result
    // The previous file is copied aside before it is overwritten; if the copy fails nothing is overwritten.
    if (prev !== null) {
      try {
        await archivePrev($, cwd, stream, prev, nowMs)
      } catch (err) {
        return { kind: 'blocked', reason: `previous notes not archived (${String(err)}); ${NOTES_DIR}/${stream}-notes.md left unchanged` }
      }
    }
    const seen = seenNotes.get(path)
    const warn = seen !== undefined && prev !== null && prev !== seen ? overwriteWarning(stream) : undefined
    await $.fs.write(path, result.state)
    if (!(await $.fs.exists(path))) return { kind: 'blocked', reason: `${path} not found after writing` }
    seenNotes.set(path, result.state)
    return { ...result, stint, ...(warn ? { warn } : {}) }
  } catch (err) {
    return { kind: 'blocked', reason: `error: ${String(err)}` }
  }
}

// Context fill against the wall; null when the host gives no figure (the pit then goes on).
async function headroom($: EngineInterface): Promise<{ tokens: number; wall: number } | null> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const b = context.breakdown
    const tokens = context.tokens ?? b?.totalTokens
    const wall = b?.autoCompactThreshold ?? b?.rawMaxTokens ?? context.window
    return tokens !== undefined && wall > 0 ? { tokens, wall } : null
  } catch (err) {
    $.ui.log(`stint: context figures unavailable, headroom not checked: ${String(err)}`, { to: 'debug' })
    return null
  }
}

async function persist($: EngineInterface) {
  if (pending) await $.store.set(STORE_KEY, pending satisfies Pending)
}

async function reset($: EngineInterface) {
  pending = null
  await $.store.delete(STORE_KEY)
  flowStatus($, undefined)
}

const READY: Line = { status: 'Ready: type /clear to continue in a fresh session', board: 'type /clear to continue', bad: true }
const DONE_MS = 3000

type Armed = { pending: Pending } | { miss: string; stream?: string; root?: string }

// The notes to re-inject after /clear: module var first, else a fresh store entry from this root. A miss carries its reason; 'none' (nothing was saved) is a normal /clear.
async function armedPending($: EngineInterface): Promise<Armed> {
  const fromModule = pending
  const stored = fromModule ?? ((await $.store.get(STORE_KEY)) as Pending | undefined)
  const dbg = debugOn()
  const sid = dbg ? await sidNow($) : undefined
  const miss = (reason: string, extra: Record<string, unknown> = {}): Armed => {
    trace($, 'pending.lookup', { hit: false, reason, storedSid: stored?.sid, sid, ...extra }, stored?.stream)
    return { miss: reason, ...(stored ? { stream: stored.stream, root: stored.root } : {}) }
  }
  if (!stored) return miss('none')
  // The module variable is gone but the store still holds the entry: the mod was reloaded after the pit.
  if (fromModule === null) trace($, 'reload.detected', { storedSid: stored.sid, sid }, stored.stream)
  const age = (await $.clock.now()) - stored.createdAt
  if (age >= STALE_MS) return miss('stale', { ageMs: age })
  const root = await rootNow($)
  if (stored.root !== root) return miss('other-root', { storedRoot: stored.root, root })
  trace($, 'pending.lookup', { hit: true, source: fromModule ? 'module' : 'store', storedSid: stored.sid, sid }, stored.stream)
  return { pending: stored }
}

// ---------- debug: incidents ----------

// The last pit whose pending was persisted and not yet looked up (debug only).
let lastPersist: { root: string; stream: string } | null = null

// Notes that should have been loaded were not. Always: a red board line (with the reason when there is one), a toast, a debug log line. Debug on: also the trace report next to the notes.
async function incident($: EngineInterface, why: string, root: string, stream: string, label?: string) {
  lastPersist = null
  trace($, 'incident', { why }, stream)
  let path: string | null = null
  if (debugOn()) {
    try {
      path = await writeReport($, root, why)
    } catch (err) {
      $.ui.log(`stint: debug report not written: ${String(err)}`, { to: 'debug' })
    }
  }
  const board = `notes not loaded${label ? ` (${label})` : ''}: /rejoin ${stream}${path ? ' - trace saved' : ''}`
  $.ui.log(`stint: ${board} [${why}]`, { to: 'debug' })
  outcome = { status: `⚠ ${board}`, board, bad: true }
  paint($)
  $.ui.toast(path ? `Pit incident (${why}): trace saved to ${path}` : debugOn() ? `Pit incident (${why}): the trace could not be saved` : board, { timeoutMs: ERROR_TOAST_MS })
}

// /pit --trace: the buffer on demand. Never runs a pit.
async function traceCommand($: EngineInterface) {
  if (!debugOn()) return { text: 'pit: debug is off. Turn it on in /config (stint · Debug), then run /pit --trace.' }
  try {
    const path = await writeReport($, await rootNow($), 'on demand')
    return { text: `pit: trace saved to ${path}` }
  } catch (err) {
    return { text: `pit: the trace could not be saved: ${String(err)}` }
  }
}

// ---------- inject (shared by the fresh start after /clear and /rejoin) ----------

// Injection = $.prompt.submit({ asUser: true }): it starts a turn, so UNPACK_RULES can hold the model at its acknowledgement line.
// The host REFUSES prompt.submit called from inside the command.run hook, so /rejoin passes `defer` and the submit runs from a $.clock.after
// dispatch, after the hook returned. SessionStart submits directly.
type AutoShow = { line: string; kind: AutoKind; warn?: string | undefined }

function inject($: EngineInterface, stream: string, notes: string, defer: boolean, auto?: AutoShow) {
  const run = () => {
    trace($, 'inject.submit', { state: 'call', chars: notes.length }, stream)
    $.prompt.submit({ text: injectText(notes, auto?.line, auto?.kind, auto?.warn), asUser: true }).then(
      () => trace($, 'inject.submit', { state: 'resolve' }, stream),
      err => {
        trace($, 'inject.submit', { state: 'reject', error: String(err) }, stream)
        fail($, `Loading the notes of stream "${stream}" failed: ${String(err)}. Try /rejoin ${stream}`, `LOADING NOTES FAILED, try /rejoin ${stream}`)
      },
    )
  }
  if (defer) $.clock.after(1, run)
  else run()
}

// The pit is done: a positive board message for a few seconds, then the board is free again. Nothing on the status line.
function backOnTrack($: EngineInterface, stint: number) {
  const line: Line = { status: '', board: `back on track, stint ${stint}` }
  outcome = line
  paint($)
  $.clock.after(DONE_MS, () => {
    if (outcome !== line) return
    outcome = undefined
    paint($)
  })
}

// /pit --save is done: a short positive board line, then the board is free again. Nothing else moves: no pending, no lap, no /clear.
// The slash command may have been seen as a prompt by classic.UserPromptSubmit (idle timer cancelled, turn flag raised) and no turn.complete follows it:
// the idle wait is put back on its original deadline, counted from the last turn end. A deadline already behind us stays dropped: the person just typed a command.
async function savedOnly($: EngineInterface, stream: string, built: { state: string }) {
  const line: Line = { status: '', board: `notes saved (${built.state.length >= 1000 ? `${(built.state.length / 1000).toFixed(1)}k` : built.state.length}), session kept` }
  flowStatus($, undefined)
  outcome = line
  paint($)
  $.clock.after(DONE_MS, () => {
    if (outcome !== line) return
    outcome = undefined
    paint($)
    // A queued wait lost its line to the save's flow reset: it is still waiting.
    if (waitLine !== undefined && flowLine === undefined && (manualWait !== null || idleWaiting)) flowStatus($, waitLine)
  })
  trace($, 'save.done', { stream })
  turnRunning = false
  if (lastTurnAt === null) return
  const spent = (await $.clock.now()) - lastTurnAt
  const delay = autopitDelayMs(await modeNow($))
  if (delay !== null && spent < delay) await armAutopit($, spent)
}

// ---------- auto-pit (idle trigger) ----------
// Armed at the end of each main-loop turn, cancelled by the next prompt or turn. At the fire every guard of autopitSkip() is read; any miss skips, except running agents: those make it wait
// (idleWaiting) until a turn end finds none busy, then it re-runs every guard.
// The pit itself is runPit(), unchanged. A timer callback is outside any command.run hook, so the host allows the fork, the /clear and the submit from it.

function cancelAutopit($: EngineInterface) {
  armGen++
  autopitTimer?.cancel()
  autopitTimer = null
  dropIdleFire($)
}

// The board shows the idle timer between showAt and fireAt; nothing is armed, so nothing to show.
function dropIdleFire($: EngineInterface) {
  if (getIdleFire() === undefined) return
  setIdleFire(undefined)
  refreshDash($).catch(err => $.ui.log(`stint: dash not refreshed: ${String(err)}`, { to: 'debug' }))
}

// The effective ceiling (% of the window) of the last turn end; the wall can move, so it is read again each time.
let ceilingPct: number | undefined

// What dash needs to know of the auto-pit: on or off, and the effective ceiling. Dash redraws only when it changed.
async function publishAutopit($: EngineInterface) {
  try {
    const on = autopitDelayMs(await modeNow($)) !== null
    const next: AutopitInfo = on && ceilingPct !== undefined ? { on, ceilingPct } : { on }
    const prev = getAutopitInfo()
    if (prev?.on === next.on && prev?.ceilingPct === next.ceilingPct) return
    setAutopitInfo(next)
    await refreshDash($)
  } catch (err) {
    $.ui.log(`stint: dash not told of the auto-pit: ${String(err)}`, { to: 'debug' })
  }
}

async function modeNow($: EngineInterface): Promise<string> {
  if (autopitMode !== null) return autopitMode
  try {
    const row = (await $.config.list()).find(r => r.key === AUTOPIT_KEY)
    autopitMode = typeof row?.value === 'string' ? row.value : AUTOPIT_DEFAULT
    return autopitMode
  } catch {
    return AUTOPIT_DEFAULT
  }
}

// `spentMs`: idle time already behind us (a setting changed mid-wait).
async function armAutopit($: EngineInterface, spentMs = 0) {
  cancelAutopit($)
  const gen = armGen
  const delay = autopitDelayMs(await modeNow($))
  if (delay === null || gen !== armGen) return
  const at = await $.clock.now()
  if (gen !== armGen) return
  const wait = Math.max(0, delay - spentMs)
  autopitTimer = $.clock.after(wait, () => {
    autopitTimer = null
    dropIdleFire($)
    void autoPit($)
  })
  // Counted from the last turn end (at - spentMs), the board shows the timer once the person has been away AUTOPIT_SHOW_AFTER_MS.
  setIdleFire({ fireAt: at + wait, showAt: Math.min(at + wait, at - spentMs + AUTOPIT_SHOW_AFTER_MS) })
  await refreshDash($)
}

async function autoPit($: EngineInterface) {
  try {
    const now = await $.clock.now()
    const base = { mode: await modeNow($), saving, turnRunning, sinceMs: lastTurnAt === null ? null : now - lastTurnAt }
    // The state guards first: nothing is read from the host when one of them already says no.
    let why = autopitSkip({ ...base, tokens: AUTOPIT_MIN_TOKENS, draft: '', busyAgents: 0 })
    let tokens: number | null = null
    if (why === null) {
      try {
        tokens = (await $.session.usage()).context.tokens ?? null
      } catch {
        tokens = null
      }
      let draft: string | null = null
      try {
        draft = (await $.prompt.read()).text
      } catch {
        draft = null
      }
      const busy = tokens !== null && tokens >= AUTOPIT_MIN_TOKENS && draft === '' ? await busyAgents($) : 0
      why = autopitSkip({ ...base, tokens, draft, busyAgents: busy })
    }
    if (why === 'agents are running') {
      // Every other guard held: fire-and-forget, the pit waits for the agents instead of being lost.
      idleWaiting = true
      trace($, 'autopit.wait', { why })
      if (flowLine === undefined) showWait($, 'auto-pit waits for agents')
      return
    }
    if (why !== null || tokens === null || lastTurnAt === null) {
      trace($, 'autopit.skip', { why })
      return
    }
    trace($, 'autopit.fire', { tokens, idleMs: now - lastTurnAt })
    await runPit($, undefined, { kind: 'idle', at: now, idleMin: Math.round((now - lastTurnAt) / 60_000), tokens })
  } catch (err) {
    autoRunning = false
    $.ui.log(`stint: auto-pit failed: ${String(err)}`, { to: 'debug' })
  }
}

// Ceiling trigger: runs right after a main-loop turn (deferred by the hook). A skip is final until the next turn end: no timer, no retry.
async function ceilingPit($: EngineInterface) {
  try {
    let tokens: number | null = null
    let win: number | null = null
    let wall: number | null = null
    try {
      const { context } = await $.session.usage({ breakdown: 'summary' })
      const b = context.breakdown
      tokens = context.tokens ?? null
      win = context.window
      wall = b?.autoCompactThreshold ?? b?.rawMaxTokens ?? context.window
      // dash says "auto-pit at N%" with the ceiling this very read gives
      if (win > 0 && wall > 0) ceilingPct = ceilingPercent(win, wall)
    } catch {
      tokens = null
    }
    await publishAutopit($)
    const mode = await modeNow($)
    // Read at call time: a prompt typed while the draft or the agents were being read must still skip.
    const gate = (draft: string | null, busy: number | null): CeilingGate => ({ mode, saving, turnRunning, tokens, window: win, wall, draft, busyAgents: busy })
    let why = ceilingSkip(gate('', 0))
    if (why === CEILING_BELOW) return
    if (why === null) {
      let draft: string | null = null
      try {
        draft = (await $.prompt.read()).text
      } catch {
        draft = null
      }
      const busy = draft === '' ? await busyAgents($) : 0
      why = ceilingSkip(gate(draft, busy))
    }
    if (why !== null || tokens === null) {
      trace($, 'autopit.skip', { why, trigger: 'ceiling' })
      return
    }
    // The idle wait is over for this period: both triggers never fire.
    cancelAutopit($)
    trace($, 'autopit.fire', { tokens, trigger: 'ceiling' })
    await runPit($, undefined, { kind: 'ceiling', at: await $.clock.now(), tokens, ...(ceilingPct !== undefined ? { pct: ceilingPct } : {}) })
  } catch (err) {
    autoRunning = false
    $.ui.log(`stint: ceiling auto-pit failed: ${String(err)}`, { to: 'debug' })
  }
}

// A wait ends at a main-loop turn end that finds no agent busy (a finished agent reports back through a turn). True when it was released here.
// The pit runs from a timer callback, never inside the hook. An unreadable list keeps the wait.
async function releaseWait($: EngineInterface): Promise<boolean> {
  const manual = manualWait
  const idle = idleWaiting
  if (manual === null && !idle) return false
  const n = await busyAgents($)
  // A prompt or a new context cleared the wait while the list was being read.
  if (manualWait !== manual || idleWaiting !== idle) return false
  if (n === null || n > 0) {
    if (manual !== null && n !== null) showWait($, `pit waits for ${n} agent(s)`)
    return false
  }
  dropWaits($)
  trace($, 'autopit.release', { trigger: manual !== null ? 'manual' : 'idle' })
  if (manual !== null) {
    $.clock.after(1, () => void releaseManual($, manual.stream).catch(err => $.ui.log(`stint: queued pit failed: ${String(err)}`, { to: 'debug' })))
  } else {
    // The idle wait of this period is over; autoPit re-reads every guard.
    $.clock.after(1, () => {
      cancelAutopit($)
      void autoPit($)
    })
  }
  return true
}

// The queued /pit, at the release: a draft that appeared meanwhile would be lost to the /clear, so the wait is dropped instead.
async function releaseManual($: EngineInterface, stream: string | undefined) {
  let draft: string | null = null
  try {
    draft = (await $.prompt.read()).text
  } catch {
    draft = null
  }
  if (draft === null || draft.trim() !== '') {
    trace($, 'pit.wait.drop', { why: draft === null ? 'prompt box unreadable' : 'a draft is in the prompt box' })
    $.ui.toast(`pit: the agents are done, but ${draft === null ? 'the prompt box is unreadable' : 'a draft is in the prompt box'}: nothing saved. Run /pit again.`)
    return
  }
  await runPit($, stream)
}

const IDLE_COMPACTION_TOAST = 'idleCompaction is on: it overlaps the auto-pit idle trigger; /config to turn it off'

// Startup notice only: shown when the host's own idle compaction row exists and is on. Row absent, off or unreadable = nothing. Read-only: no host key is ever written.
async function idleCompactionNotice($: EngineInterface) {
  try {
    if (autopitDelayMs(await modeNow($)) === null) return
    const row = (await $.config.list()).find(r => r.key === 'idleCompaction' || /idle compaction/i.test(String(r.label ?? '')))
    if (row?.value === true) $.ui.toast(IDLE_COMPACTION_TOAST)
  } catch {
    // unreadable: show nothing
  }
}

// ---------- commands ----------

async function pit($: EngineInterface, args: string) {
  if (args.trim() === '--trace') return traceCommand($)
  const parsed = parseArgs(args, 'pit')
  if ('error' in parsed) return { text: `pit: ${parsed.error}` }
  if (saving) return { text: `pit: a pit is already running, its outcome will show in the status line` }
  // Fire-and-forget: with agents running the pit is queued and runs at the turn end that finds none busy. --save never waits. An unknown list goes on as before.
  if (!parsed.save) {
    const n = await busyAgents($)
    if (n !== null && n > 0) {
      // A second /pit is not a force.
      if (manualWait !== null) return { text: `pit: already waiting for ${n} agent(s)...` }
      manualWait = { stream: parsed.stream }
      trace($, 'pit.wait', { agents: n }, parsed.stream)
      showWait($, `pit waits for ${n} agent(s)`)
      return { text: `pit: ${n} agent(s) still running. Waiting: the pit runs when they are done.` }
    }
    // Nothing busy any more: this pit supersedes a queued one.
    dropWaits($)
  }
  return runPit($, parsed.stream, undefined, parsed.save === true)
}

// The pit proper, shared by /pit and the idle trigger (`auto`: the mark the fresh session shows).
// `save` (/pit --save): the same fork, notes and archive, then stop: no pending, no /clear, no lap change, the context is untouched.
async function runPit($: EngineInterface, argStream: string | undefined, auto?: AutoMark, save = false) {
  const cwd = await rootNow($)
  const room = await headroom($)
  trace($, 'pit.start', { cwd: await $.session.cwd(), root: cwd, headroom: room, ...(auto ? { auto: true } : {}), ...(save ? { save: true } : {}) }, current())
  if (room && overWall(room.tokens, room.wall)) {
    const pct = Math.round((room.tokens / room.wall) * 100)
    const text = `pit: context is at ${pct}% of the limit where the host compacts on its own (${room.tokens} of ${room.wall} tokens); the save runs in this context and would fail there. Nothing saved, the session is unchanged.`
    outcome = { status: `⚠ Pit refused: context at ${pct}% of the compaction limit, nothing saved`, board: `PIT REFUSED at ${pct}% of the limit, nothing saved`, bad: true }
    paint($)
    return { text }
  }

  // Explicit argument binds for the session; a new command replaces the last outcome.
  if (argStream !== undefined) boundArg = argStream
  outcome = undefined
  hint = undefined
  const stream = current()

  // Two saves never overlap (a --save and an auto-pit that both passed their checks before either set the flag): the second leaves at once.
  if (saving) return { text: `pit: a pit is already running, its outcome will show in the status line` }
  saving = true
  autoAborted = false
  autoRunning = auto !== undefined
  startProgress($, `${save ? 'Saving' : 'Pitting'} stream "${stream}"`, stream)
  let built: Built
  try {
    built = await buildNotes($, cwd, stream, save)
  } finally {
    saving = false
  }
  if (auto && autoAborted) {
    // The user came back during the fork: their turn is not cleared. The notes file is written and valid; nothing else is.
    autoRunning = false
    flowStatus($, undefined)
    trace($, 'autopit.abort', { at: 'fork' }, stream)
    return { text: 'pit: auto-pit cancelled, you came back first. Notes kept.' }
  }
  if (built.kind === 'blocked') {
    autoRunning = false
    // Rail 1: nothing is cleared, the session stays as it is.
    fail($, `${save ? 'Save' : 'Pit'} of stream "${stream}" failed: ${built.reason.replace(/\.$/, '')}. Session kept.`, save ? 'SAVE FAILED, session kept' : 'PIT FAILED, session kept')
    return { text: `pit: could not save stream "${stream}": ${built.reason.replace(/\.$/, '')}. No /clear run, the session is unchanged.` }
  }

  trace($, 'notes.written', { path: `${cwd}/${NOTES_DIR}/${stream}-notes.md`, chars: built.state.length }, stream)
  if (save) {
    await savedOnly($, stream, built)
    return { text: `pit: saved ${NOTES_DIR}/${stream}-notes.md (no clear)${built.warn ? `\n${built.warn}` : ''}` }
  }
  pending = { text: built.state, createdAt: await $.clock.now(), root: cwd, stream, ...(debugOn() ? { sid: await sidNow($) } : {}), ...(auto ? { auto } : {}), ...(auto && built.warn ? { warn: built.warn } : {}) }
  try {
    await persist($)
    trace($, 'pending.persisted', { ok: true }, stream)
    if (debugOn()) lastPersist = { root: cwd, stream }
  } catch (err) {
    trace($, 'pending.persisted', { ok: false, error: String(err) }, stream)
    throw err
  }
  await setLap($, built.stint)
  pitStart()
  flowStatus($, { status: 'Starting a fresh session...', board: savedBoard(built.state.length) })
  // $.command.run rejects inside the hook the run waits on, so the /clear runs from a $.clock.after dispatch, after the hook returned.
  // If the host still refuses, the human types /clear.
  $.clock.after(1, () => {
    if (auto && autoAborted) {
      autoRunning = false
      void reset($)
      trace($, 'autopit.abort', { at: 'clear' }, stream)
      return
    }
    autoRunning = false
    $.command.run({ command: 'clear' }).then(
      () => {
        pitDone($)
        backOnTrack($, built.stint)
        trace($, 'clear.run', { result: 'resolve' }, stream)
      },
      () => {
        flowStatus($, READY)
        trace($, 'clear.run', { result: 'reject' }, stream)
      },
    )
  })
  return { text: `pit: saved ${NOTES_DIR}/${stream}-notes.md${!auto && built.warn ? `\n${built.warn}` : ''}` }
}

async function rejoin($: EngineInterface, args: string) {
  const parsed = parseArgs(args, 'rejoin')
  if ('error' in parsed) return { text: `rejoin: ${parsed.error}` }
  outcome = undefined
  const cwd = await rootNow($)
  const streams = await listStreams($)
  const list = streams.length ? ` Notes here: ${streams.join(', ')}.` : ''

  let stream = parsed.stream
  if (stream === undefined) {
    // No argument: the bound stream when it has notes, else the only notes file there is.
    if ((boundArg ?? titleStream) !== null && streams.includes(current())) stream = current()
    else if (streams.length === 1) stream = streams[0]
    else if (streams.length > 1) return { text: `rejoin: several notes here, pick one with /rejoin <stream>: ${streams.join(', ')}` }
    else return { text: `rejoin: no notes in ${NOTES_DIR}/ of this folder. Nothing loaded.` }
  }
  const chosen = stream as string

  let notes: string | null
  try {
    notes = await readOptional($, notesPath(cwd, chosen))
  } catch (err) {
    return { text: `rejoin: cannot read the notes of stream "${chosen}": ${String(err)}` }
  }
  if (notes === null) return { text: `rejoin: no notes for stream "${chosen}" in this folder. Nothing loaded.${list}` }

  boundArg = chosen
  hint = undefined
  seenNotes.set(notesPath(cwd, chosen), notes)
  await setLap($, stintOf(notes))
  paint($)
  inject($, chosen, notes, true)
  return { text: `rejoin: loading stream "${chosen}" as the first message.` }
}

// ---------- hooks ----------

function noteCaught($: EngineInterface, hook: string, error: { kind: string; message?: string }) {
  try {
    $.ui.log(`stint: ${hook} hook ${error.kind}${error.message ? `: ${error.message}` : ''}`, { to: 'debug' })
  } catch {
    // nothing left to do
  }
}

async function noteTitle(title: string | undefined) {
  if (title === undefined) return
  const slug = slugify(title)
  if (slug !== null) titleStream = slug
}

export function registerPit(on: On) {
  ceilingPct = undefined
  setAutopitInfo(undefined)
  setIdleFire(undefined)

  on('session.start', async ($, e, next) => {
    for (const command of COMMANDS) {
      try {
        await $.command.register(command)
      } catch (err) {
        $.ui.log(`stint: command ${command.name} not registered: ${String(err)}`)
      }
    }
    return next(e)
  })

  // dash.ts holds turn.complete, debug.ts holds turn.start and prompt.submit, each without a matcher, and the host refuses a second unmatched hook on an event:
  // the turn end is taken here with a matcher on every `reason`, the turn start and the prompt through classic.UserPromptSubmit below.
  on('turn.complete', { reason: ['answer', 'aborted', 'refusal', 'error'] }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      try {
        turnRunning = false
        lastTurnAt = await $.clock.now()
        // A wait for agents ends here when none is busy: that pit saves, so the ceiling is not tried as well.
        const released = await releaseWait($)
        // The ready turn of an auto-pit never re-triggers: neither the idle wait nor the ceiling.
        if (skipNextArm) skipNextArm = false
        else {
          await armAutopit($)
          if (autopitDelayMs(await modeNow($)) === null || released) await publishAutopit($)
          else $.clock.after(1, () => void ceilingPit($))
        }
      } catch (err) {
        $.ui.log(`stint: auto-pit not armed: ${String(err)}`, { to: 'debug' })
      }
    }
    return result
  }).catch(($, e, next) => next(e))

  on('config.set', { key: AUTOPIT_KEY }, async ($, e, next) => {
    const result = await next(e)
    if ('deny' in result && result.deny !== undefined) return result
    autopitMode = String(e.value)
    try {
      if (autopitDelayMs(autopitMode) === null) {
        cancelAutopit($)
        dropWaits($, true)
      } else if (lastTurnAt !== null && !turnRunning && !skipNextArm) await armAutopit($, (await $.clock.now()) - lastTurnAt)
      await publishAutopit($)
    } catch (err) {
      $.ui.log(`stint: auto-pit not re-armed: ${String(err)}`, { to: 'debug' })
    }
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'pit' }, ($, e) => pit($, e.args)).catch(($, e, next) => {
    noteCaught($, 'command.run pit', next.error)
    saving = false
    stopProgress()
    return { text: 'pit: failed unexpectedly, nothing was cleared. Run it again.' }
  })
  on('command.run', { command: 'rejoin' }, ($, e) => rejoin($, e.args)).catch(($, e, next) => {
    noteCaught($, 'command.run rejoin', next.error)
    return { text: 'rejoin: failed unexpectedly, nothing was loaded. Run it again.' }
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    // Any prompt, typed or injected, starts a turn and ends the idle period. One that lands while an auto-pit is saving aborts it before the /clear.
    turnRunning = true
    cancelAutopit($)
    if (autoRunning) autoAborted = true
    // A prompt of the person ends a wait for agents; so does not the host's own (a task notification reports an agent back), nor the /pit command itself (the host may raise this event for it, before or after command.run).
    if (e.source !== 'system' && !(manualWait !== null && /^\/pit(\s|$)/.test(e.prompt.trim()))) dropWaits($)
    // The hint was seen: it goes at the first prompt.
    if (hint !== undefined) {
      hint = undefined
      paint($)
    }
    await noteTitle(e.session_title)
    return next(e)
  }).catch(($, e, next) => {
    noteCaught($, 'classic.UserPromptSubmit', next.error)
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    trace($, 'session.start', { source: e.source, sid: e.session_id, cwd: e.cwd })
    hint = undefined
    outcome = undefined
    // A new context: no idle period carries over, and the next turn.complete starts a fresh one.
    cancelAutopit($)
    dropWaits($)
    lastTurnAt = null
    turnRunning = false
    autoRunning = false
    await publishAutopit($)
    if (e.source !== 'clear') {
      skipNextArm = false
      // A new, resumed or forked session is another session: unbind and drop any armed injection.
      if (e.source === 'startup' || e.source === 'resume' || e.source === 'fork') {
        boundArg = null
        titleStream = null
        pending = null
        saving = false
        stopProgress()
        flowLine = undefined
        lastPersist = null
        seenNotes.clear()
        stopWatch()
      }
      await noteTitle(e.session_title)
      if (boundArg === null) {
        const streams = await listStreams($)
        if (streams.length > 0) hint = { status: hintText(streams), board: hintBoard(streams) }
      }
      paint($)
      if (e.source === 'startup' || e.source === 'resume') await idleCompactionNotice($)
      return next(e)
    }

    await noteTitle(e.session_title)
    const found = await armedPending($)
    await reset($)
    if ('miss' in found) {
      if (found.stream !== undefined) {
        // A pending existed and was not injected: say why, always.
        await incident($, `pending skipped: ${found.miss}`, found.root ?? (await rootNow($)), found.stream, found.miss)
      } else if (lastPersist !== null && debugOn()) {
        // Debug: a pit persisted its notes and the lookup found nothing.
        await incident($, 'pending persisted but lookup found none', lastPersist.root, lastPersist.stream)
      }
      return next(e)
    }
    const armed = found.pending
    lastPersist = null
    if (debugOn()) startWatch($, missing => void incident($, missing, armed.root, armed.stream))

    // Rail 3: the binding survives /clear; restore it when a mod reload lost it.
    if (boundArg === null) boundArg = armed.stream
    if (armed.auto) skipNextArm = true
    inject($, armed.stream, armed.text, false, armed.auto ? { line: autoLine(armed.auto, `${NOTES_DIR}/${armed.stream}-notes.md`), kind: armed.auto.kind === 'ceiling' ? 'ceiling' : 'idle', warn: armed.warn } : undefined)
    $.ui.toast(`Fresh session started with the notes of stream "${armed.stream}"`)
    return next(e)
  }).catch(($, e, next) => {
    noteCaught($, 'classic.SessionStart', next.error)
    return next(e)
  })
}
