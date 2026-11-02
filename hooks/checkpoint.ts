// Checkpoint trailers. The first part is pure logic (no `$`); the I/O part at the end (appendEntries, captureCkpt) takes the engine as a parameter, as
// top-level function declarations (the hooks compiler refuses `$` through an arrow). Ported from stoa hooks/pack.tsx.
// A trailer is one HTML comment the model ends a turn with: `<!-- ckpt decision: ... · learning: ... -->`.

import type { EngineInterface, On, PluginOptions } from 'claude-code'

export type Clause = 'decision' | 'reasoning' | 'learning' | 'pivot' | 'rejected' | 'constraint' | 'assumption' | 'open' | 'definition' | 'refs' | 'phase'
export type Section = 'read_first' | 'read_if_needed' | 'decisions' | 'learnings' | 'discarded' | 'in_progress' | 'next' | 'unknowns' | 'stale'
export type Entry = { n: number; id: string; trailer: string }

export const TRAILER_OPEN = '<!-- ckpt'

// stoa's ten, then `phase` (stint 0.4.0): what just closed, the cue for the /pit hint.
export const CLAUSES: Clause[] = ['decision', 'reasoning', 'learning', 'pivot', 'rejected', 'constraint', 'assumption', 'open', 'definition', 'refs', 'phase']

// null = journal only (addressable by id, never in the notes).
export const ROUTE: Record<Clause, Section | null> = {
  decision: 'decisions',
  constraint: 'decisions',
  learning: 'learnings',
  definition: 'learnings',
  rejected: 'discarded',
  open: 'next',
  assumption: 'unknowns',
  refs: 'read_if_needed',
  reasoning: null,
  pivot: null,
  phase: null,
}

export const pad = (n: number) => String(n).padStart(2, '0')

// Splits a trailer body on its clause keywords; separators (` · `, `|`, `;`, newlines) are stripped.
export function parseTrailer(trailer: string): { type: Clause; text: string }[] {
  const body = trailer.replace(/^\s*<!--\s*ckpt/, '').replace(/-->\s*$/, '')
  const re = new RegExp(`(?:^|[·|;\\n])\\s*(${CLAUSES.join('|')}):\\s*`, 'g')
  const hits = [...body.matchAll(re)]
  const out: { type: Clause; text: string }[] = []
  hits.forEach((hit, i) => {
    const start = (hit.index ?? 0) + hit[0].length
    const end = i + 1 < hits.length ? (hits[i + 1].index ?? body.length) : body.length
    const text = body.slice(start, end).replace(/[\s·|;]+$/, '').replace(/\s+/g, ' ').trim()
    if (text) out.push({ type: hit[1] as Clause, text })
  })
  return out
}

// Journal file: one `### cNN <iso> <session>` head per entry, the raw trailer below it.
export function parseJournal(text: string): Entry[] {
  const heads = [...text.matchAll(/^### c(\d+) .*$/gm)]
  return heads.map((h, i) => {
    const from = (h.index ?? 0) + h[0].length
    const to = i + 1 < heads.length ? (heads[i + 1].index ?? text.length) : text.length
    return { n: Number(h[1]), id: `c${h[1]}`, trailer: text.slice(from, to).trim() }
  })
}

export const maxId = (text: string) => parseJournal(text).reduce((m, e) => Math.max(m, e.n), 0)

export const entryText = (id: string, iso: string, sid: string, trailer: string) => `### ${id} ${iso} ${sid}\n${trailer}\n\n`

// Root-anchored: the caller passes the session root, never the cwd (a Bash `cd` moves the cwd).
export const journalPath = (root: string, stream: string) => `${root.replace(/\/+$/, '')}/.stint/${stream}-journal.md`

export function journalRule(path: string): string {
  return `Journal ${path}: never read it whole; to see an entry, grep by id: grep -A8 '^### cNN ' ${path} (the space after the id keeps c07 from matching c070)`
}

// Every <!-- ckpt ... --> comment of a final answer, in order, trimmed.
export function trailersOf(answer: string): string[] {
  return (answer.match(/<!-- ckpt[\s\S]*?-->/g) ?? []).map(t => t.trim())
}

// The answer closes a phase: one of its closed trailers holds a `phase:` clause.
export const hasPhase = (answer: string) => trailersOf(answer).some(t => parseTrailer(t).some(c => c.type === 'phase'))

// Display only: the stored message and the journal keep the raw trailer.
export function splitTrailer(text: string): { body: string; trailers: string[]; kinds: string[]; unclosed: boolean } {
  const kinds: string[] = []
  const trailers: string[] = []
  let body = text.replace(/\s*<!-- ckpt[\s\S]*?-->/g, raw => {
    const trailer = raw.trim()
    trailers.push(trailer)
    for (const c of parseTrailer(trailer)) if (!kinds.includes(c.type)) kinds.push(c.type)
    return ''
  })
  const open = body.indexOf(TRAILER_OPEN)
  const unclosed = open >= 0
  if (unclosed) body = body.slice(0, open)
  return { body: body.trimEnd(), trailers, kinds, unclosed }
}

const clauseList = (kinds: string[]) => (kinds.length ? `: ${kinds.join(', ')}` : '')

// Pure text rewrite: closed trailers and an unclosed streaming tail are cut; a closed one leaves one italic marker naming the clauses.
export function hideTrailer(text: string): string {
  if (!text.includes(TRAILER_OPEN)) return text
  const { body, kinds, unclosed } = splitTrailer(text)
  if (unclosed) return body
  const marker = `_ckpt${clauseList(kinds)}_`
  return body ? `${body}\n\n${marker}` : marker
}

// The rule stint ships to the model (prompt.context block, and the notes fallback). Generic: no project paths.
export const RULE_TEXT = `## Checkpoint trailer

When a turn settles a decision, reveals a non-obvious learning, rejects a path, shifts frame, leaves an open fork, or closes a unit of work, end your answer with one HTML comment starting \`${TRAILER_OPEN}\` and closing with \`-->\`. Skip it on clarifying, acknowledgement and pure-tool turns. It is recorded in a journal and may be hidden on screen; do not mention it in prose.

Inside, use any of these clauses, omit the empty ones, one clause of about 20 words at most, written in your own words rather than quoted, clauses separated by \` · \` or a new line:
- \`decision:\` choice + why
- \`reasoning:\` consequence derived this turn (even with no decision)
- \`learning:\` non-obvious fact or gotcha found
- \`pivot:\` frame or scope that changed
- \`rejected:\` path + why
- \`constraint:\` hard rule in force
- \`assumption:\` unverified premise the work rests on
- \`open:\` unresolved fork
- \`definition:\` term=meaning
- \`refs:\` path→anchor or URL
- \`phase:\` what just closed; only when that unit is closed, verified, and its result and open points sit in a deliverable file a fresh session could resume from; never for an ordinary decision

Keep the \`${TRAILER_OPEN}\` opener exactly as written: tools find trailers by it.`


// ---------- setting (userConfig `checkpoint`) ----------

// `checkpoint` (on | off, default on) is one /config choice row. Off = no capture, no journal write, no hide, no rule block, no rule after the notes.
// Read from the options at load, then kept by the config.set hook; an unknown value reads as the default.
export const CHECKPOINT_KEY = 'stint.checkpoint'
let enabled = true
export const checkpointOn = () => enabled
export function setCheckpoint(value: unknown) {
  enabled = value !== 'off'
}

export function registerCheckpointSetting(on: On, userOptions: PluginOptions) {
  setCheckpoint(userOptions.checkpoint)
  // Applied at once: the messages already on screen are redrawn (trailer shown or hidden). The rule block already sent stays until /clear or /compact.
  on('config.set', { key: CHECKPOINT_KEY }, async ($, e, next) => {
    const result = await next(e)
    if ('deny' in result && result.deny !== undefined) return result
    setCheckpoint(e.value)
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // the redraw is cosmetic
    }
    return result
  }).catch(($, e, next) => next(e))
}

// ---------- rule delivery (prompt.context) ----------

export const RULE_BLOCK = 'stintCheckpoint'
type CtxBlock = { readonly name: string; readonly text: string }

// True when the project's own instructions (the claudeMd block of the engine's input) already teach the trailer. Never test the injected block with this: RULE_TEXT holds the opener too.
export const claudeMdHasRule = (blocks: readonly CtxBlock[]) => blocks.some(b => b.name === 'claudeMd' && b.text.includes(TRAILER_OPEN))

// The blocks the conversation carries: the engine's own, plus one stint block with the rule unless the instructions already hold it.
export function withRule<B extends CtxBlock>(blocks: readonly B[], path: string): readonly (B | CtxBlock)[] {
  if (claudeMdHasRule(blocks) || blocks.some(b => b.name === RULE_BLOCK)) return blocks
  return [...blocks, { name: RULE_BLOCK, text: `${RULE_TEXT}\n\n${journalRule(path)}` }]
}

// ---------- I/O: journal write ----------

export type Item = { iso: string; sid: string; trailer: string }

export const APPEND_TRIES = 3

// What says the file changed under us: size and mtime (absent file = its own stamp).
const stampOf = (s: { size: number; mtimeMs: number } | null) => (s === null ? 'none' : `${s.size}:${s.mtimeMs}`)

// $.fs has no append, so a write replaces the whole file and a second session writing the same journal can erase our entries (or reuse our ids). Narrowed, not removed:
//   stat, read, stat (changed = another writer, start over) -> build the entries from THIS read -> stat again right before the write (changed = start over, ids recomputed)
//   -> write -> read back and check every entry we added is there; a later writer that erased them makes us start over on the fresh content.
// At most APPEND_TRIES tries. The window left is the few ms between the last stat and the write; the read-back catches a write that lands after ours.
// Null = not written (or not proved written); a failed read-back after a write that did land can leave a duplicate on the retry. Never throws.
export async function appendEntries($: EngineInterface, path: string, items: Item[]): Promise<string[] | null> {
  const stat = () => $.fs.stat(path).then(s => ({ size: s.size, mtimeMs: s.mtimeMs })).catch(() => null)
  for (let attempt = 0; attempt < APPEND_TRIES; attempt++) {
    try {
      const before = await stat()
      const old = before ? await $.fs.read(path) : ''
      const after = await stat()
      if (stampOf(before) !== stampOf(after)) continue
      let n = maxId(old)
      const ids: string[] = []
      const entries: string[] = []
      for (const item of items) {
        n++
        const id = `c${pad(n)}`
        ids.push(id)
        entries.push(entryText(id, item.iso, item.sid, item.trailer))
      }
      if (stampOf(await stat()) !== stampOf(after)) continue
      await $.fs.write(path, `${old}${old === '' || old.endsWith('\n') ? '' : '\n'}${entries.join('')}`)
      const written = await $.fs.read(path)
      if (entries.every(entry => written.includes(entry))) return ids
    } catch {
      // start over, then give up
    }
  }
  return null
}

// Writes are serialized inside the process: two answers close together must not read the same old text.
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

// Journals every trailer of a final answer, in order. ok=false: there were trailers and none was written (the caller says so); never throws.
export async function captureCkpt($: EngineInterface, root: string, stream: string, answer: string): Promise<{ ids: string[]; ok: boolean }> {
  try {
    const trailers = trailersOf(answer)
    if (trailers.length === 0) return { ids: [], ok: true }
    const iso = new Date(await $.clock.now()).toISOString()
    const sid = await $.session.id().catch(() => 'unknown')
    const items = trailers.map(trailer => ({ iso, sid, trailer }))
    const ids = await enqueue(() => appendEntries($, journalPath(root, stream), items))
    return ids === null ? { ids: [], ok: false } : { ids, ok: true }
  } catch {
    return { ids: [], ok: false }
  }
}
