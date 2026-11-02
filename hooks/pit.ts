import type { EngineInterface, On } from 'claude-code'

import { pitDone, pitStart, refresh as refreshDash, setLap, zoneOf } from './dash.ts'
import { ROUTE, RULE_TEXT, captureCkpt, checkpointOn, claudeMdHasRule, hasPhase, journalPath, journalRule, parseJournal, parseTrailer, withRule } from './checkpoint.ts'
import type { Entry } from './checkpoint.ts'
import { CREW_STORE, addSample, crewOn, crewText, numbersOf, promptTokens, withCrew } from './crew.ts'
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

export const FORK_PROMPT = `You are writing the notes of this work stream for yourself. After a /clear the notes file is the ONLY thing the fresh context receives. Code assembles the file: you DESIGNATE, you never copy. Lines coming from checkpoint trailers are routed and copied verbatim by code, each ending with its id (cNN).
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
- <path or URL — when to read it>   (extras only)
deliverable: <path where the written work lives>
decisions:
- <choice — why>   (ONLY decisions no trailer covers; the why is mandatory; do not reopen)
learnings:
- <non-obvious fact — command or path that proves it>   (extras only)
discarded:
- <path or approach tried — why rejected>   (extras only)
in_progress:
- <half-done item — where it stands>
next:
- <action>   (2-4 actions, extras only)
unknowns:
- <what is not known>   (never empty)
stale:
- <path — replaced by X; do not reload>
retire_answered: <ids, e.g. c03, c07>
retire_done: <ids>
retire_learned: <ids>
retire_reversed: <ids, e.g. c05>
retire_superseded: <ids>
Rules:
- Every list except read_if_needed, learnings, discarded, next and decisions is yours entirely, and for those five you give EXTRAS only: whatever the trailers below and the (cNN) lines of PREVIOUS NOTES do not already say.
- Return the COMPLETE current content of every list you own: merge PREVIOUS NOTES with what this conversation added. Carry forward the still-valid lines that have no (cNN) suffix; drop what is done, answered, replaced or reversed (a reversed decision of yours goes to discarded). Never restart from scratch.
- A line ending with (cNN) belongs to code: never output one, never reword one. To remove one, designate its id in a retire key.
- Never restate an item a (cNN) line or an entry below already holds, even reworded and without the id: one item, one line. Wrong: with \`- pick a strict YAML 1.2 parser or a schema check (c01)\` in next, adding \`- choose between a YAML 1.2 parser and schema validation\`. Add a line only for what no (cNN) line says.
- Retire keys take ids from PREVIOUS NOTES or from the entries below. retire_answered: open: / assumption: items now resolved. retire_done: next items now done. retire_learned: learnings now obsolete (a bug since fixed, a fact replaced by a later one). retire_reversed: decisions proved wrong and reversed. retire_superseded: decisions overtaken by a later decision without being wrong. Omit a retire key when it is empty.
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

// ---------- phase hint: pure parts ----------

// An answer whose trailer holds `phase:` (a unit of work closed) at or above this share of the window shows the hint until the next prompt. A hint only: never a pit.
export const PHASE_HINT_FLOOR = 0.4
export const PHASE_HINT = 'good moment to /pit'
// A /pit this many main turns or fewer after a phase answer is traced as following it (measurement only).
export const PHASE_FOLLOW_TURNS = 3

// The hint outranks the zone messages on the board; when it hides the auto-pit one (the red zone), it carries the ceiling. `ceilingPct` null = auto-pit off.
export function phaseHintText(tokens: number, window: number, ceilingPct: number | null): string {
  return ceilingPct !== null && zoneOf(tokens, window, ceilingPct) === 3 ? `${PHASE_HINT} · auto at ${ceilingPct}%` : PHASE_HINT
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
  if (mark.kind === 'ceiling') return `⛔ auto-pitted (ceiling ${mark.pct ?? Math.round(AUTOPIT_CEILING * 100)}%) at ${hm} · ${k}k → notes ${path}`
  return `⏸  auto-pitted at ${hm} · ${mark.idleMin} min idle · ${k}k → notes ${path}`
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

// journal / journal_cursor: the journal of the stream and the last entry the notes took in (absent in older notes = c00).
export const SCALARS_HEADER = ['stream', 'saved', 'status', 'previous_session', 'goal', 'journal', 'journal_cursor']
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

export const RETIRE_KEYS = ['retire_answered', 'retire_done', 'retire_learned', 'retire_reversed', 'retire_superseded']
const FORK_SCALARS = ['status', 'goal', 'deliverable', ...RETIRE_KEYS]
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

// ---------- checkpoint entries in the notes ----------

// A line ending with ` (cNN)` came from a journal entry: code owns it, the fork never writes one.
const ID_END = /\s\(c(\d+)\)\s*$/
export const idOf = (line: string): number | null => {
  const m = line.match(ID_END)
  return m ? Number(m[1]) : null
}
const stripId = (line: string) => line.replace(ID_END, '')
// Dedupe key of a code-owned line: its text without the id, whitespace collapsed (a retried journal write can leave byte-identical entries).
const dedupeKey = (line: string) => oneLine(stripId(line))

// `journal_cursor: cNN` of a notes file; absent or malformed = 0.
export function cursorOf(notes: string | null): number {
  const raw = notes ? parseNotes(notes).scalars.journal_cursor : undefined
  const m = (raw ?? '').match(/^c?(\d{1,6})$/)
  return m ? Number(m[1]) : 0
}

// The journal entries a save takes in: those after the cursor of the previous notes. A cursor past the journal's last id (journal trimmed by hand) starts over at 0.
// No journal text (none yet, unreadable, checkpoint off) = no entry, the cursor carried as it is.
export function takeEntries(prev: string | null, journal: string | null): { entries: Entry[]; from: number } {
  const from = cursorOf(prev)
  if (journal === null) return { entries: [], from }
  const all = parseJournal(journal)
  const max = all.reduce((m, e) => Math.max(m, e.n), 0)
  const start = from > max ? 0 : from
  return { entries: all.filter(e => e.n > start), from: start }
}

// `c03, c07` (or `3 7`) -> {3, 7}.
const idSet = (raw: string | undefined) => new Set((raw ?? '').match(/\d+/g)?.map(Number) ?? [])

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
  // Journal entries after the cursor (takeEntries), their clauses routed verbatim by code; none = fork-only notes.
  entries?: Entry[]
  // Cursor the entries were taken after (takeEntries().from); default: the cursor of the previous notes.
  cursorFrom?: number
  // Path written in the `journal:` header line; default: the previous one, else none.
  journal?: string
}
export type Assembled =
  | { kind: 'ok'; state: string; cut: string[]; degraded: boolean; cursor: string }
  | { kind: 'blocked'; reason: string }

// Code-owned lines (cNN) = carried from the previous notes + the clauses of the new entries, routed by ROUTE, deduped, then retired as the fork designated.
// Fork-owned lines = every line without an id. Then the header, the agent lines and the cap.
export function assemble(input: AssembleInput): Assembled {
  const prev = input.prev ? parseNotes(input.prev) : null
  const fields = input.fork
  const entries = input.entries ?? []

  // 1. carried id'd lines + routed clauses, deduped per section on their text: the lowest id survives, a dropped duplicate's id points to it.
  const alias = new Map<number, number>()
  const lists: Record<string, string[]> = {}
  for (const sec of LISTS) {
    const routed: string[] = []
    for (const entry of entries) {
      for (const clause of parseTrailer(entry.trailer)) if (ROUTE[clause.type] === sec) routed.push(`${clause.text} (${entry.id})`)
    }
    const out: string[] = []
    const at = new Map<string, number>()
    for (const line of [...(prev?.lists[sec] ?? []).filter(l => idOf(l) !== null), ...routed]) {
      const key = dedupeKey(line)
      const id = idOf(line) as number
      const i = at.get(key)
      if (i === undefined) {
        at.set(key, out.length)
        out.push(line)
        continue
      }
      const kept = idOf(out[i] as string) as number
      if (id === kept) continue
      if (id < kept) {
        alias.set(kept, id)
        out[i] = line
      } else alias.set(id, kept)
    }
    lists[sec] = out
  }

  // 2. retire: answered open/assumption items, done next items and obsolete learnings vanish; reversed or superseded decisions move to discarded with their id.
  const retired = (key: string) => {
    const set = idSet(fields.scalars[key])
    for (const [dup, kept] of alias) if (set.has(dup)) set.add(kept)
    return set
  }
  const answered = retired('retire_answered')
  const done = retired('retire_done')
  const learned = retired('retire_learned')
  const reversed = retired('retire_reversed')
  const superseded = retired('retire_superseded')
  const moved: string[] = []
  for (const sec of LISTS) {
    lists[sec] = (lists[sec] as string[]).filter(line => {
      const id = idOf(line) as number
      if ((sec === 'next' || sec === 'unknowns') && answered.has(id)) return false
      if (sec === 'next' && done.has(id)) return false
      if (sec === 'learnings' && learned.has(id)) return false
      if (sec === 'decisions' && (reversed.has(id) || superseded.has(id))) {
        moved.push(`${stripId(line)} — ${reversed.has(id) ? 'reversed' : 'superseded'} (c${pad(id)})`)
        return false
      }
      return true
    })
  }

  // 3. fork-owned lines: any line the fork ends with (cNN) is dropped, code owns those.
  for (const sec of LISTS) {
    let own = (fields.lists[sec] ?? []).map(oneLine).filter(l => l !== '' && idOf(l) === null)
    if (sec === 'decisions') own = own.map(l => (l.includes('—') ? l : `${l} — why missing`))
    if (sec === 'in_progress') own = own.filter(l => !l.startsWith(AGENT_LINE) && l !== AGENTS_UNKNOWN) // code writes those, never the fork
    lists[sec] = uniq([...(lists[sec] as string[]), ...own])
  }
  if (moved.length) {
    const have = new Set((lists.discarded as string[]).map(dedupeKey))
    lists.discarded = [...(lists.discarded as string[]), ...moved.filter(l => !have.has(dedupeKey(l)))]
  }
  if (lists.unknowns?.length === 0) lists.unknowns = ['nothing recorded — treat every fact as unverified']

  // 4. header.
  const from = input.cursorFrom ?? cursorOf(input.prev)
  const cursor = `c${pad(Math.max(from, ...entries.map(e => e.n)))}`
  const prevWriter = (prev?.scalars.saved ?? '').split(/\s+/)[1]
  const previousSession = prevWriter && prevWriter !== input.sid ? prevWriter : prev?.scalars.previous_session || 'none'
  const scalars: Record<string, string> = {
    stream: input.stream,
    saved: `${input.saved} ${input.sid}`,
    status: oneLine(fields.scalars.status || prev?.scalars.status || 'unknown'),
    previous_session: previousSession,
    goal: oneLine(fields.scalars.goal || prev?.scalars.goal || 'unknown'),
    journal: input.journal ?? prev?.scalars.journal ?? 'none',
    journal_cursor: cursor,
    deliverable: oneLine(fields.scalars.deliverable || prev?.scalars.deliverable || 'none'),
  }

  // The overflow line is the last line of stale, outside `lists` so no cut step can drop it; the agent lines sit the same way in front of in_progress.
  let overflowLine: string | null = null
  let degraded = false
  const render = () => {
    const header: Record<string, string | undefined> = { ...scalars, status: degraded ? `degraded (${scalars.status})` : scalars.status }
    // `stint:` right after goal (where 0.3.0 wrote it), then the journal lines.
    const keys = SCALARS_HEADER.flatMap(k => (k === 'goal' && input.stint !== undefined ? [k, STINT_KEY] : [k]))
    const head = keys.map(k => `${k}: ${k === STINT_KEY ? input.stint : header[k]}`).join('\n')
    const agents = input.agents ?? []
    const shown = (k: string) => {
      const list = lists[k] ?? []
      return k === 'stale' && overflowLine ? [...list, overflowLine] : k === 'in_progress' ? [...agents, ...list] : list
    }
    const body = BODY_ORDER.map(k => (k === 'deliverable' ? `deliverable: ${scalars.deliverable}` : `${k}:${shown(k).map(l => `\n- ${l}`).join('')}`)).join('\n')
    return `${head}\n\n${body}\n`
  }

  // Hard cap, enforced here whatever the fork wrote. First, silently: read_if_needed compressed (its id kept), then stale and in_progress, oldest first.
  // Still over, with the overflow line on: discarded, learnings (oldest first), then the id'd lines left, lowest cNN first, then the un-id'd lines of
  // read_if_needed, next, unknowns, decisions. Every dropped id is named on the overflow line (the journal keeps it).
  // Never cut: header scalars, read_first, deliverable, the agent lines.
  const cut: string[] = []
  let text = render()
  const over = () => text.length > NOTES_MAX
  if (over()) {
    degraded = true
    text = render()
  }
  const dropped: Record<string, number> = {}
  const droppedIds = new Set<number>()
  const overflow = () => {
    const ids = [...droppedIds].sort((x, y) => x - y).map(n => `c${pad(n)}`)
    return `overflow: cut to fit ${NOTES_MAX} chars: ${Object.entries(dropped).map(([s, n]) => `${s} -${n}`).join(', ') || 'nothing yet'}${ids.length ? `; journal ids dropped: ${ids.join(', ')} — grep the journal by id` : ''}`
  }
  const dropAt = (sec: string, i: number) => {
    const [line] = (lists[sec] as string[]).splice(i, 1)
    const id = idOf(line as string)
    if (id !== null) droppedIds.add(id)
    dropped[sec] = (dropped[sec] ?? 0) + 1
    if (overflowLine !== null) overflowLine = overflow()
    text = render()
  }
  if (over()) {
    const before = (lists.read_if_needed as string[]).join('\n')
    lists.read_if_needed = (lists.read_if_needed as string[]).map(l => {
      if (l.length <= SHRINK_LINE) return l
      const id = idOf(l)
      const head = `${stripId(l).slice(0, SHRINK_LINE - 1)}…`
      return id === null ? head : `${head} (c${pad(id)})`
    })
    text = render()
    if ((lists.read_if_needed as string[]).join('\n') !== before) cut.push('read_if_needed compressed')
  }
  for (const sec of ['stale', 'in_progress']) {
    while (over() && (lists[sec] as string[]).length > 0) dropAt(sec, 0)
  }
  if (over()) {
    overflowLine = overflow()
    text = render()
    for (const sec of ['discarded', 'learnings']) {
      while (over() && (lists[sec] as string[]).length > 0) dropAt(sec, 0)
    }
    // The oldest id'd line across the body sections left (never read_first).
    while (over()) {
      let best: { sec: string; i: number; n: number } | null = null
      for (const sec of LISTS) {
        if (sec === 'read_first') continue
        const list = lists[sec] as string[]
        for (let i = 0; i < list.length; i++) {
          const n = idOf(list[i] as string)
          if (n !== null && (best === null || n < best.n)) best = { sec, i, n }
        }
      }
      if (best === null) break
      dropAt(best.sec, best.i)
    }
    for (const sec of ['read_if_needed', 'next', 'unknowns', 'decisions']) {
      while (over() && (lists[sec] as string[]).length > 0) dropAt(sec, 0)
    }
  }
  for (const [sec, n] of Object.entries(dropped)) cut.push(`${sec} -${n}`)
  if (over()) {
    return {
      kind: 'blocked',
      reason: `notes ${text.length} chars > ${NOTES_MAX} after cutting ${cut.join(', ') || 'nothing cuttable'}; the header, read_first and the agent lines alone exceed the cap: shorten read_first by hand. Nothing written.`,
    }
  }
  return { kind: 'ok', state: text, cut, degraded, cursor }
}

// The entries go to the fork with their ids, as journaled; the fork never gets the journal path to read.
export function forkPrompt(prev: string | null, entries: Entry[] = []): string {
  const n = (v: number) => v.toLocaleString('en-US')
  const room = NOTES_MAX - (prev?.length ?? 0)
  const budget = `SIZE: the notes file may not exceed ${n(NOTES_MAX)} characters; past it code cuts, in this order, read_if_needed, stale, in_progress, discarded, learnings, then the rest. PREVIOUS NOTES are ${n(prev?.length ?? 0)} characters: ${room >= 0 ? `${n(room)} left` : `${n(-room)} over`} for what this conversation adds.${room < 1_500 ? ' Room is tight: designate retire ids first, drop obsolete lines and shorten the rest.' : ''}`
  const journal = entries.length ? entries.map(e => `### ${e.id}\n${e.trailer}`).join('\n\n') : '(none)'
  return `${FORK_PROMPT}\n\n${budget}\n\nPREVIOUS NOTES:\n${prev ?? '(none)'}\n\nJOURNAL ENTRIES TO ROUTE (code copies their clauses; you may retire their ids):\n${journal}`
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
// This session's own stream name (autoStreamOf), set at session start; kept across /clear, recomputed on startup/resume/fork.
let autoStream: string | null = null
// The pit's message: running flow, then last sticky outcome, then the session-start hint. `status` goes to the status line
// (only where the band was never raised), `board` to the band's board slot; `bad` draws it red. An empty status writes nothing.
type Line = { status: string; board: string; bad?: boolean }
let flowLine: Line | undefined
let ticker: { cancel: () => void } | null = null
let outcome: Line | undefined
let hint: Line | undefined
// The phase hint (0.4.0): board only (empty status), the lowest of pit's lines. Shown after an answer with `phase:` at fill >= PHASE_HINT_FLOOR, gone at the next prompt, the next answer and every session start.
let phase: Line | undefined
// Main-loop turn ends of this session, and the last one whose answer held `phase:` (with its session id): what the follow trace measures from.
let mainTurns = 0
let phaseAt: { turn: number; sid: string | undefined; hinted: boolean } | null = null

const current = () => resolveStream(boundArg, titleStream, autoStream)

async function setAutoStream($: EngineInterface) {
  autoStream = autoStreamOf(await rootNow($), await $.session.id().catch(() => ''))
}

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

// pit's own lines (flow, outcome, hint) come first; with none, the dash line (status.ts).
function paint($: EngineInterface) {
  const line = flowLine ?? outcome ?? hint ?? phase
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
// Workflows are NOT in $.agent.list() (index.d.ts:3286 in .claude-plugin/types/claude-code): a running workflow is not counted. Known gap, accepted.
async function busyAgents($: EngineInterface): Promise<number | null> {
  const listed = await listAgents($)
  if (typeof listed === 'string') return null
  return listed.filter(a => BUSY_STATUS.includes(a.status)).length
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
    // The journal entries after the cursor of the previous notes (a --save advances the cursor too). Checkpoint off or an unreadable journal = none: fork-only notes.
    const journal = journalPath(cwd, stream)
    const taken = takeEntries(prev, checkpointOn() ? await readOptional($, journal).catch(() => null) : null)
    // One fork per save: an over-cap answer is cut by assemble(), never re-asked.
    const asked = await askFork($, forkPrompt(prev, taken.entries))
    if (asked.kind === 'blocked') return asked
    const stint = stintOf(prev) + (save ? 0 : 1)
    const nowMs = await $.clock.now()
    const result = assemble({ stream, saved: new Date(nowMs).toISOString(), sid, prev, fork: asked.fork, agents, stint, entries: taken.entries, cursorFrom: taken.from, journal })
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

// Set by the prompt.context hook: the project's instructions already teach the checkpoint trailer.
let claudeHasRule = false

// Streams journaled by this process -> journal path. A stream with a journal gets the rule refreshed after its notes; one with no entry yet adds nothing
// (the prompt.context block carries the rule from the first request on). Memory only: the injection stays synchronous.
const journaled = new Map<string, string>()

// What follows the notes: how to read the journal, and the trailer rule unless the project's instructions already hold it.
const ckptTail = (stream: string): string => {
  if (!checkpointOn()) return ''
  const path = journaled.get(stream)
  if (path === undefined) return ''
  return claudeHasRule ? journalRule(path) : `${RULE_TEXT}\n\n${journalRule(path)}`
}

// Injection = $.prompt.submit({ asUser: true }): it starts a turn, so UNPACK_RULES can hold the model at its acknowledgement line.
// The host REFUSES prompt.submit called from inside the command.run hook, so /rejoin passes `defer` and the submit runs from a $.clock.after
// dispatch, after the hook returned. SessionStart submits directly.
type AutoShow = { line: string; kind: AutoKind; warn?: string | undefined }

function inject($: EngineInterface, stream: string, notes: string, defer: boolean, auto?: AutoShow) {
  const run = () => {
    const tail = ckptTail(stream)
    const shown = tail === '' ? notes : `${notes.trimEnd()}\n\n${tail}`
    trace($, 'inject.submit', { state: 'call', chars: shown.length }, stream)
    $.prompt.submit({ text: injectText(shown, auto?.line, auto?.kind, auto?.warn), asUser: true }).then(
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
  })
  trace($, 'save.done', { stream })
  turnRunning = false
  if (lastTurnAt === null) return
  const spent = (await $.clock.now()) - lastTurnAt
  const delay = autopitDelayMs(await modeNow($))
  if (delay !== null && spent < delay) await armAutopit($, spent)
}

// ---------- auto-pit (idle trigger) ----------
// Armed at the end of each main-loop turn, cancelled by the next prompt or turn. At the fire every guard of autopitSkip() is read; any miss skips.
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
  return runPit($, parsed.stream, undefined, parsed.save === true)
}

// The pit proper, shared by /pit and the idle trigger (`auto`: the mark the fresh session shows).
// `save` (/pit --save): the same fork, notes and archive, then stop: no pending, no /clear, no lap change, the context is untouched.
async function runPit($: EngineInterface, argStream: string | undefined, auto?: AutoMark, save = false) {
  const cwd = await rootNow($)
  const room = await headroom($)
  trace($, 'pit.start', { cwd: await $.session.cwd(), root: cwd, headroom: room, ...(auto ? { auto: true } : {}), ...(save ? { save: true } : {}) }, current())
  if (debugOn()) await traceFollow($, auto !== undefined, save)
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

async function noteTitle($: EngineInterface, title: string | undefined) {
  if (title === undefined) return
  const slug = slugify(title)
  if (slug === null || slug === titleStream) return
  // A /rename while the session ran under its own name: the journal follows the new name.
  const from = boundArg === null && (titleStream === null || titleStream === autoStream) ? autoStream : null
  titleStream = slug
  if (from !== null && from !== slug) await followRename($, from, slug)
}

// $.fs cannot delete or move, so the journal is copied: the old file stays, unlisted (only notes files are streams).
// Not copied when the old name already has notes (both stay, the user is told) or the new name already has a journal (the stream already exists).
async function followRename($: EngineInterface, from: string, to: string) {
  try {
    const root = await rootNow($)
    const src = journalPath(root, from)
    if (!(await $.fs.exists(src))) return
    const dst = journalPath(root, to)
    if ((await $.fs.exists(notesPath(root, from))) || (await $.fs.exists(dst))) {
      $.ui.toast(`stint: this session now saves to stream "${to}"; what was journaled before /rename stays under "${from}" (/rejoin ${from})`, { timeoutMs: ERROR_TOAST_MS })
      return
    }
    await $.fs.write(dst, await $.fs.read(src))
    if (journaled.has(from)) {
      journaled.delete(from)
      journaled.set(to, dst)
    }
  } catch (err) {
    $.ui.log(`stint: journal not carried over to "${to}": ${String(err)}`, { to: 'debug' })
  }
}

// Journals the trailers of a main-loop answer under the session root; a failed write shows one red board line for a few seconds. Never throws.
async function journalCkpt($: EngineInterface, answer: string) {
  if (!checkpointOn()) return
  try {
    const stream = current()
    const root = await rootNow($)
    const res = await captureCkpt($, root, stream, answer)
    if (res.ok) {
      if (res.ids.length > 0) journaled.set(stream, journalPath(root, stream))
      return
    }
    const board = 'checkpoint not journaled: write failed'
    const line: Line = { status: `⚠ ${board}`, board, bad: true }
    outcome = line
    paint($)
    $.clock.after(ERROR_TOAST_MS, () => {
      if (outcome !== line) return
      outcome = undefined
      paint($)
    })
  } catch (err) {
    $.ui.log(`stint: checkpoint not journaled: ${String(err)}`, { to: 'debug' })
  }
}

// ---------- crew figures (0.5.1) ----------

// Sub-agents already sampled in this process.
const sampledAgents = new Set<string>()
// Store writes are serialized: parallel sub-agents start together.
let crewWrites: Promise<unknown> = Promise.resolve()

function recordColdStart($: EngineInterface, tokens: number) {
  crewWrites = crewWrites
    .then(async () => {
      const root = await rootNow($)
      await $.store.set(CREW_STORE, addSample(await $.store.get(CREW_STORE), root, tokens, await $.clock.now()))
    })
    .catch(err => $.ui.log(`stint: crew sample not stored: ${String(err)}`, { to: 'debug' }))
  return crewWrites
}

// The crew text for a conversation starting now: this root's measured figures, else any root's, else the defaults.
async function crewTextNow($: EngineInterface): Promise<string> {
  try {
    return crewText(numbersOf(await $.store.get(CREW_STORE), await rootNow($)))
  } catch {
    return crewText()
  }
}

// ---------- phase hint ----------

// The fill of the context as dash shows it (% of the model window), the tokens behind it, and the auto-pit ceiling this read gives (null = auto-pit off). null = no figure.
async function phaseFill($: EngineInterface): Promise<{ pct: number; tokens: number; window: number; ceiling: number | null } | null> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const window = context.window > 0 ? context.window : 200_000
    const pct = context.percent ?? (context.tokens !== undefined ? (context.tokens / window) * 100 : undefined)
    if (pct === undefined) return null
    const wall = context.breakdown?.autoCompactThreshold ?? context.breakdown?.rawMaxTokens ?? window
    const ceiling = autopitDelayMs(await modeNow($)) === null ? null : wall > 0 ? ceilingPercent(window, wall) : (ceilingPct ?? Math.round(AUTOPIT_CEILING * 100))
    return { pct, tokens: context.tokens ?? Math.round((pct / 100) * window), window, ceiling }
  } catch {
    return null
  }
}

function dropPhase($: EngineInterface, why: string) {
  if (phase === undefined) return
  phase = undefined
  trace($, 'phase.hint', { state: 'cleared', why }, current())
}

// After each main-loop turn end: the hint of the previous answer goes; this answer's `phase:` shows it again when the context is full enough. Checkpoint off = never shown. Never throws.
async function notePhase($: EngineInterface, answer: string) {
  try {
    mainTurns++
    const was = phase !== undefined
    dropPhase($, 'answer')
    if (!checkpointOn() || !hasPhase(answer)) {
      if (was) paint($)
      return
    }
    const fill = await phaseFill($)
    const show = fill !== null && fill.pct >= PHASE_HINT_FLOOR * 100
    phaseAt = { turn: mainTurns, sid: await sidNow($), hinted: show }
    trace($, 'phase.emitted', { pct: fill === null ? null : Math.round(fill.pct), floor: PHASE_HINT_FLOOR * 100, hint: show, turn: mainTurns }, current())
    if (show) {
      phase = { status: '', board: phaseHintText(fill.tokens, fill.window, fill.ceiling) }
      trace($, 'phase.hint', { state: 'shown', why: 'answer', pct: Math.round(fill.pct) }, current())
    }
    if (show || was) paint($)
  } catch (err) {
    $.ui.log(`stint: phase hint not updated: ${String(err)}`, { to: 'debug' })
  }
}

// Debug only: a pit that comes within PHASE_FOLLOW_TURNS main turns of a `phase:` answer of this session.
async function traceFollow($: EngineInterface, auto: boolean, save: boolean) {
  if (phaseAt === null) return
  const turns = mainTurns - phaseAt.turn
  if (turns > PHASE_FOLLOW_TURNS || phaseAt.sid !== (await sidNow($))) return
  trace($, 'phase.followed', { turns, hinted: phaseAt.hinted, ...(auto ? { auto: true } : {}), ...(save ? { save: true } : {}) }, current())
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
        // The checkpoint trailers of this answer are journaled before an auto-pit can fork: the fork then sees them.
        if (e.reason === 'answer') await journalCkpt($, e.answer)
        // The same answer's `phase:` decides the hint; an aborted or failed turn just drops it.
        await notePhase($, e.reason === 'answer' ? e.answer : '')
        // The ready turn of an auto-pit never re-triggers: neither the idle wait nor the ceiling.
        if (skipNextArm) skipNextArm = false
        else {
          await armAutopit($)
          if (autopitDelayMs(await modeNow($)) === null) await publishAutopit($)
          else $.clock.after(1, () => void ceilingPit($))
        }
      } catch (err) {
        $.ui.log(`stint: auto-pit not armed: ${String(err)}`, { to: 'debug' })
      }
    }
    return result
  }).catch(($, e, next) => next(e))

  // The rule that teaches the trailer reaches the model as one context block per conversation (first request, again after /clear and /compact),
  // unless the project's own instructions already hold it. The crew block (crew.ts) rides the same hook, after it, with its own setting and skip:
  // the host takes one unmatched prompt.context hook per plugin.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    let blocks = result.blocks
    if (checkpointOn()) {
      try {
        claudeHasRule = claudeMdHasRule(blocks)
        blocks = withRule(blocks, journalPath(await rootNow($), current()))
      } catch {
        // no rule this time; the crew block still goes
      }
    }
    if (crewOn()) blocks = withCrew(blocks, await crewTextNow($))
    return blocks === result.blocks ? result : { ...result, blocks }
  }).catch(($, e, next) => next(e))

  // The crew block's figures: a sub-agent's first request is its cold start. Taken once per sub-agent (a resumed one carries its history), numbers only.
  // stint holds no other turn.step hook. The stream passes through untouched; the sample is stored after it, off the stream.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (crewOn() && e.agentId !== undefined && r.index === 0 && r.usage && !sampledAgents.has(e.agentId)) {
      sampledAgents.add(e.agentId)
      void recordColdStart($, promptTokens(r.usage))
    }
    return r
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  on('config.set', { key: AUTOPIT_KEY }, async ($, e, next) => {
    const result = await next(e)
    if ('deny' in result && result.deny !== undefined) return result
    autopitMode = String(e.value)
    try {
      if (autopitDelayMs(autopitMode) === null) {
        cancelAutopit($)
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
    // The hints were seen: they go at the first prompt.
    if (hint !== undefined || phase !== undefined) {
      hint = undefined
      dropPhase($, 'prompt')
      paint($)
    }
    // A mod loaded mid-session never saw the session start.
    if (autoStream === null) await setAutoStream($)
    await noteTitle($, e.session_title)
    return next(e)
  }).catch(($, e, next) => {
    noteCaught($, 'classic.UserPromptSubmit', next.error)
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    trace($, 'session.start', { source: e.source, sid: e.session_id, cwd: e.cwd })
    hint = undefined
    // A new context: the phase hint and the follow measure belong to the old one.
    dropPhase($, 'session')
    phaseAt = null
    mainTurns = 0
    outcome = undefined
    // A new context: no idle period carries over, and the next turn.complete starts a fresh one.
    cancelAutopit($)
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
        autoStream = null
        pending = null
        saving = false
        stopProgress()
        flowLine = undefined
        lastPersist = null
        seenNotes.clear()
        journaled.clear()
        claudeHasRule = false
        stopWatch()
      }
      await noteTitle($, e.session_title)
      if (autoStream === null) await setAutoStream($)
      if (boundArg === null) {
        const streams = await listStreams($)
        if (streams.length > 0) hint = { status: hintText(streams), board: hintBoard(streams) }
      }
      paint($)
      if (e.source === 'startup' || e.source === 'resume') await idleCompactionNotice($)
      const result = await next(e)
      // An untitled session takes its stream name as title: visible in /resume, and a resumed session finds its stream again through it.
      // /rename replaces it like any title.
      if (e.session_title === undefined && titleStream === null && boundArg === null && autoStream !== null && result.sessionTitle === undefined) {
        return { ...result, sessionTitle: autoStream }
      }
      return result
    }

    if (autoStream === null) await setAutoStream($)
    await noteTitle($, e.session_title)
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
