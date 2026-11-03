import { ROUTE, parseJournal, parseTrailer } from './checkpoint.ts'
import type { Entry } from './checkpoint.ts'
import { pad } from './streams.ts'

// pit (stint), pure part: the notes format (parse, assemble, cap) and the checkpoint entries in it. Moved out of pit.ts verbatim; imports nothing from pit.ts.

// Hard cap of the notes file, enforced by code: the fork is told the ceiling and the room left, assemble() cuts what still overflows.
export const NOTES_MAX = 8_000
const SHRINK_LINE = 80

// ---------- notes format ----------

// journal / journal_cursor: the journal of the stream and the last entry the notes took in (absent in older notes = c00).
export const SCALARS_HEADER = ['stream', 'saved', 'status', 'previous_session', 'goal', 'journal', 'journal_cursor']
// Written after the header scalars when the caller gives a stint number: the stint the notes hand over to (absent in older notes = 1).
export const STINT_KEY = 'stint'
// `crew` (0.5.3): fork-owned, the sessions this stream exchanges with and what is pending with each; absent in older notes = empty.
export const LISTS = ['read_first', 'read_if_needed', 'decisions', 'learnings', 'discarded', 'in_progress', 'next', 'crew', 'unknowns', 'stale']
// Body order of the notes file (deliverable is the only scalar among them).
export const BODY_ORDER = ['read_first', 'read_if_needed', 'deliverable', 'decisions', 'learnings', 'discarded', 'in_progress', 'next', 'crew', 'unknowns', 'stale']

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
export function takeEntries(prev: string | null, journal: string | Entry[] | null): { entries: Entry[]; from: number } {
  const from = cursorOf(prev)
  if (journal === null) return { entries: [], from }
  const all = typeof journal === 'string' ? parseJournal(journal) : journal
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
  // read_if_needed, next, unknowns, crew, decisions. Every dropped id is named on the overflow line (the journal keeps it).
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
    for (const sec of ['read_if_needed', 'next', 'unknowns', 'crew', 'decisions']) {
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
