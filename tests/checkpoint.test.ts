import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { APPEND_TRIES, CLAUSES, RULE_TEXT, ROUTE, checkpointOn, entryText, hasPhase, hideTrailer, journalPath, journalRule, maxId, pad, parseJournal, parseTrailer, setCheckpoint, splitTrailer, trailersOf } from '../hooks/checkpoint.ts'

const TRAILER = '<!-- ckpt decision: keep A · reasoning: B follows -->'

// ---------- menu and routing ----------

test('CLAUSES: stoa\'s ten, in order, then phase', () => {
  expect(CLAUSES).toEqual(['decision', 'reasoning', 'learning', 'pivot', 'rejected', 'constraint', 'assumption', 'open', 'definition', 'refs', 'phase'])
})

test('ROUTE: every clause has an entry; reasoning, pivot and phase are journal-only', () => {
  expect(Object.keys(ROUTE).sort()).toEqual([...CLAUSES].sort())
  expect(ROUTE.reasoning).toBeNull()
  expect(ROUTE.pivot).toBeNull()
  expect(ROUTE.phase).toBeNull()
  expect(ROUTE.decision).toBe('decisions')
  expect(ROUTE.constraint).toBe('decisions')
  expect(ROUTE.learning).toBe('learnings')
  expect(ROUTE.definition).toBe('learnings')
  expect(ROUTE.rejected).toBe('discarded')
  expect(ROUTE.open).toBe('next')
  expect(ROUTE.assumption).toBe('unknowns')
  expect(ROUTE.refs).toBe('read_if_needed')
})

// ---------- parseTrailer ----------

test('parseTrailer: phase alone and among other clauses', () => {
  expect(parseTrailer('<!-- ckpt phase: L5 shipped and tested -->')).toEqual([{ type: 'phase', text: 'L5 shipped and tested' }])
  expect(parseTrailer('<!-- ckpt decision: keep A · phase: P1 closed\nopen: P2 order -->')).toEqual([
    { type: 'decision', text: 'keep A' },
    { type: 'phase', text: 'P1 closed' },
    { type: 'open', text: 'P2 order' },
  ])
})

test('hasPhase: a closed trailer with a phase clause; none, an empty one, an unclosed one or the word in prose do not count', () => {
  expect(hasPhase('done\n\n<!-- ckpt decision: a · phase: lot closed -->')).toBe(true)
  expect(hasPhase('<!-- ckpt decision: a -->\n<!-- ckpt phase: b -->')).toBe(true)
  expect(hasPhase('<!-- ckpt decision: a phase: b -->')).toBe(false)
  expect(hasPhase('<!-- ckpt phase:  -->')).toBe(false)
  expect(hasPhase('next phase: tests\n<!-- ckpt decision: a -->')).toBe(false)
  expect(hasPhase('<!-- ckpt phase: still streaming')).toBe(false)
  expect(hasPhase('')).toBe(false)
})

test('parseTrailer: splits on clause keywords, strips separators', () => {
  expect(parseTrailer(TRAILER)).toEqual([
    { type: 'decision', text: 'keep A' },
    { type: 'reasoning', text: 'B follows' },
  ])
})

test('parseTrailer: newline, pipe and semicolon separate clauses too', () => {
  expect(parseTrailer('<!-- ckpt decision: a\nlearning: b | open: c ; refs: d -->').map(c => c.type)).toEqual(['decision', 'learning', 'open', 'refs'])
})

test('parseTrailer: a keyword inside a clause text does not split it', () => {
  expect(parseTrailer('<!-- ckpt decision: the open: field stays -->')).toEqual([{ type: 'decision', text: 'the open: field stays' }])
})

test('parseTrailer: unknown keywords and empty clauses yield nothing', () => {
  expect(parseTrailer('<!-- ckpt done: x · plan: y -->')).toEqual([])
  expect(parseTrailer('<!-- ckpt decision:  · learning: z -->')).toEqual([{ type: 'learning', text: 'z' }])
  expect(parseTrailer('')).toEqual([])
})

test('parseTrailer: inner whitespace collapses', () => {
  expect(parseTrailer('<!-- ckpt decision: a   b\t c -->')).toEqual([{ type: 'decision', text: 'a b c' }])
})

// ---------- journal ----------

test('entryText + parseJournal: round trip, several entries', () => {
  const j = entryText('c01', '2026-11-01T10:00:00.000Z', 'abc', TRAILER) + entryText('c02', '2026-11-01T10:05:00.000Z', 'abc', '<!-- ckpt open: q -->')
  expect(j).toBe(`### c01 2026-11-01T10:00:00.000Z abc\n${TRAILER}\n\n### c02 2026-11-01T10:05:00.000Z abc\n<!-- ckpt open: q -->\n\n`)
  expect(parseJournal(j)).toEqual([
    { n: 1, id: 'c01', trailer: TRAILER },
    { n: 2, id: 'c02', trailer: '<!-- ckpt open: q -->' },
  ])
})

test('parseJournal: ignores text before the first head and non-head lines; empty is empty', () => {
  expect(parseJournal('')).toEqual([])
  expect(parseJournal('intro\n## not an entry\n')).toEqual([])
  expect(parseJournal('intro\n### c7 t s\nbody\n')).toEqual([{ n: 7, id: 'c7', trailer: 'body' }])
})

test('parseJournal: ids past 99 keep their digits', () => {
  expect(parseJournal('### c100 t s\nx\n')[0]).toEqual({ n: 100, id: 'c100', trailer: 'x' })
})

test('maxId: highest number, 0 on an empty or head-less file, not the last one', () => {
  expect(maxId('')).toBe(0)
  expect(maxId('no heads here')).toBe(0)
  expect(maxId('### c03 t s\na\n### c11 t s\nb\n### c05 t s\nc\n')).toBe(11)
})

test('pad: two digits minimum', () => {
  expect(pad(1)).toBe('01')
  expect(pad(12)).toBe('12')
  expect(pad(123)).toBe('123')
})

test('journalPath: under <root>/.stint, trailing slashes absorbed', () => {
  expect(journalPath('/work/repo', 'main')).toBe('/work/repo/.stint/main-journal.md')
  expect(journalPath('/work/repo/', 'stint-s')).toBe('/work/repo/.stint/stint-s-journal.md')
})

test('journalRule: names the path and the grep-by-id way, never read whole', () => {
  const r = journalRule('/r/.stint/main-journal.md')
  expect(r).toContain('/r/.stint/main-journal.md')
  expect(r).toContain('never read it whole')
  // the space after the id: c07 must not match c070-c079
  expect(r).toContain("grep -A8 '^### cNN '")
})

// ---------- trailersOf ----------

test('trailersOf: every closed trailer in order, an unclosed one ignored', () => {
  expect(trailersOf(`a\n${TRAILER}\nb\n<!-- ckpt open: q -->\n<!-- ckpt lear`)).toEqual([TRAILER, '<!-- ckpt open: q -->'])
  expect(trailersOf('no trailer')).toEqual([])
  expect(trailersOf('<!-- other comment -->')).toEqual([])
})

// ---------- splitTrailer ----------

test('splitTrailer: body, trailers, deduplicated kinds in first-seen order', () => {
  const t2 = '<!-- ckpt learning: x · decision: y -->'
  const s = splitTrailer(`a\n${TRAILER}\nb\n${t2}\n`)
  expect(s.body).toBe('a\nb')
  expect(s.trailers).toEqual([TRAILER, t2])
  expect(s.kinds).toEqual(['decision', 'reasoning', 'learning'])
  expect(s.unclosed).toBe(false)
})

test('splitTrailer: an unclosed tail is cut and flagged', () => {
  const s = splitTrailer('Working.\n\n<!-- ckpt decision: use co')
  expect(s).toEqual({ body: 'Working.', trailers: [], kinds: [], unclosed: true })
})

test('splitTrailer: no trailer = text untouched but right-trimmed', () => {
  expect(splitTrailer('plain  \n')).toEqual({ body: 'plain', trailers: [], kinds: [], unclosed: false })
})

// ---------- hideTrailer ----------

test('hideTrailer: closed trailer stripped, marker lists the clause keywords', () => {
  expect(hideTrailer(`Done.\n\n${TRAILER}\n`)).toBe('Done.\n\n_ckpt: decision, reasoning_')
})

test('hideTrailer: two trailers -> one marker, keywords deduplicated in first-seen order', () => {
  const t2 = '<!-- ckpt learning: x · decision: y -->'
  const out = hideTrailer(`a\n${TRAILER}\nb\n${t2}\n`)
  expect(out).not.toContain('<!--')
  expect(out).toBe('a\nb\n\n_ckpt: decision, reasoning, learning_')
})

test('hideTrailer: unclosed streaming trailer stripped, no marker yet', () => {
  expect(hideTrailer('Working on it.\n\n<!-- ckpt decision: use co')).toBe('Working on it.')
  expect(hideTrailer(`x\n${TRAILER}\n<!-- ckpt lear`)).toBe('x')
})

test('hideTrailer: no trailer -> same string', () => {
  const t = 'plain **md**\n\n<!-- other comment -->\n  '
  expect(hideTrailer(t)).toBe(t)
  expect(hideTrailer('')).toBe('')
})

test('hideTrailer: text before the trailer kept byte for byte; no recognized clause -> bare marker', () => {
  const before = '  Line one \t\n\n```ts\nconst a = 1\n```\n- item  \n\nlast line'
  expect(hideTrailer(`${before}\n\n${TRAILER}`).startsWith(`${before}\n\n_ckpt:`)).toBe(true)
  expect(hideTrailer(`${before}\n<!-- ckpt nothing known -->`)).toBe(`${before}\n\n_ckpt_`)
  expect(hideTrailer('<!-- ckpt open: q -->')).toBe('_ckpt: open_')
})

test('hideTrailer: idempotent', () => {
  const once = hideTrailer(`a\n${TRAILER}`)
  expect(hideTrailer(once)).toBe(once)
})

// ---------- RULE_TEXT ----------

test('RULE_TEXT: teaches the opener and all eleven clauses, names no project path', () => {
  expect(RULE_TEXT).toContain('<!-- ckpt')
  for (const c of CLAUSES) expect(RULE_TEXT).toContain(`\`${c}:\``)
  expect(RULE_TEXT).not.toMatch(/praxis|CLAUDE\.md|\.claude\/|\/repos\//i)
})

test('RULE_TEXT: phase is taught with the strict condition, and closing a unit of work is a reason to write a trailer', () => {
  const line = RULE_TEXT.split('\n').find(l => l.startsWith('- `phase:`')) ?? ''
  expect(line).toContain('what just closed')
  expect(line).toContain('closed, verified')
  expect(line).toContain('deliverable file')
  expect(line).toContain('fresh session could resume')
  expect(line).toContain('never for an ordinary decision')
  expect(RULE_TEXT).toContain('or closes a unit of work, end your answer')
})

test('RULE_TEXT: tells the model how to separate clauses (a clause glued after a space is not parsed)', () => {
  expect(RULE_TEXT).toMatch(/separated by `\s*·\s*` or a new line/)
  expect(parseTrailer('<!-- ckpt decision: a rejected: b -->').map(c => c.type)).toEqual(['decision'])
  expect(parseTrailer('<!-- ckpt decision: a · rejected: b -->').map(c => c.type)).toEqual(['decision', 'rejected'])
})

// ---------- setting (L6) ----------

test('setCheckpoint: only the value off turns it off, anything else reads as the default (on)', () => {
  setCheckpoint('off')
  expect(checkpointOn()).toBe(false)
  setCheckpoint('on')
  expect(checkpointOn()).toBe(true)
  setCheckpoint('off')
  setCheckpoint(undefined)
  expect(checkpointOn()).toBe(true)
  setCheckpoint('off')
  setCheckpoint('banana')
  expect(checkpointOn()).toBe(true)
})

// ---------- journal concurrency (appendEntries, driven through the plugin's own turn.complete) ----------

// The test engine has no `$.fs`: the journal write runs inside pit's turn.complete hook, over these one-file stand-ins. Another session can act at a chosen moment
// (the callbacks run after the call's value is fixed).
type FakeFs = {
  text: string | undefined
  mtime: number
  stats: number
  reads: number
  writes: number
  afterStat?: (n: number) => void
  afterRead?: (n: number) => void
  afterWrite?: (n: number) => void
}

function world(on: On, text?: string): FakeFs {
  const f: FakeFs = { text, mtime: 1, stats: 0, reads: 0, writes: 0 }
  mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('config.list', () => ({ value: [] }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, tokens: 1_000, breakdown: { autoCompactThreshold: 0 } }, rateLimits: [] } }) as never)
  on('session.measure', (_$, e) => ({ changed: [...e.changed] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  const store = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_$, e) => (store.delete(e.key), { value: undefined }))
  on('fs.stat', () => {
    f.stats++
    const out = f.text === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtime, isLink: false } }
    f.afterStat?.(f.stats)
    return out as never
  })
  on('fs.read', () => {
    f.reads++
    const out = f.text === undefined ? { deny: 'ENOENT' } : { value: f.text }
    f.afterRead?.(f.reads)
    return out as never
  })
  on('fs.write', (_$, e) => {
    f.writes++
    f.text = e.text
    f.mtime++
    f.afterWrite?.(f.writes)
    return { value: undefined } as never
  })
  return f
}

// Another session appends an entry (its own read-modify-write, done in one step here).
function otherAppends(f: FakeFs, id: string) {
  f.text = `${f.text ?? ''}${entryText(id, '2026-01-01T00:00:00.000Z', 'other', `<!-- ckpt open: from ${id} -->`)}`
  f.mtime++
}

const FIRST = entryText('c01', '2026-01-01T00:00:00.000Z', 'first', '<!-- ckpt decision: base -->')
const MINE = '<!-- ckpt decision: mine -->'
const answered = ($: Engine, answer: string, turnId = 't1') => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer' } as never)
const idsOf = (f: FakeFs) => parseJournal(f.text ?? '').map(e => e.id)

test('journal: a writer landing between our read and our check -> start over, nothing lost, no duplicate id', async ($, on) => {
  const f = world(on, FIRST)
  f.afterRead = n => { if (n === 1) otherAppends(f, 'c02') }
  await answered($, `Done.\n${MINE}`)
  expect(idsOf(f)).toEqual(['c01', 'c02', 'c03'])
  expect(parseJournal(f.text ?? '')[2]?.trailer).toBe(MINE)
  expect(f.writes).toBe(1)
})

test('journal: a writer landing between our check and the stat before the write -> start over, ids recomputed', async ($, on) => {
  const f = world(on, FIRST)
  f.afterStat = n => { if (n === 2) otherAppends(f, 'c02') }
  await answered($, `Done.\n${MINE}`)
  expect(idsOf(f)).toEqual(['c01', 'c02', 'c03'])
  expect(f.writes).toBe(1)
})

test('journal: an mtime change with the same size counts as another writer', async ($, on) => {
  const f = world(on, FIRST)
  f.afterStat = n => { if (n === 2) f.mtime++ }
  await answered($, `Done.\n${MINE}`)
  expect(idsOf(f)).toEqual(['c01', 'c02'])
  expect(f.writes).toBe(1)
  expect(f.reads).toBe(3)
})

test('journal: a writer that rewrites the file right after ours is caught by the read-back, our entry is added again on its content', async ($, on) => {
  const f = world(on, FIRST)
  f.afterWrite = n => {
    if (n !== 1) return
    f.text = FIRST
    otherAppends(f, 'c02')
  }
  await answered($, `Done.\n${MINE}`)
  expect(idsOf(f)).toEqual(['c01', 'c02', 'c03'])
  expect(parseJournal(f.text ?? '')[2]?.trailer).toBe(MINE)
  expect(f.writes).toBe(2)
})

test('journal: several trailers keep their order and consecutive ids, on a new file too', async ($, on) => {
  const f = world(on)
  await answered($, `Done.\n${MINE}\nand\n<!-- ckpt open: second -->`)
  expect(idsOf(f)).toEqual(['c01', 'c02'])
  expect((f.text ?? '').indexOf('decision: mine')).toBeLessThan((f.text ?? '').indexOf('open: second'))
  expect(f.writes).toBe(1)
})

test('journal: a file erased after every write gives up after APPEND_TRIES writes, leaves the file as it was, and the turn goes on', async ($, on) => {
  const f = world(on, FIRST)
  f.afterWrite = () => { f.text = FIRST; f.mtime++ }
  await answered($, `Done.\n${MINE}`)
  expect(f.writes).toBe(APPEND_TRIES)
  expect(f.text).toBe(FIRST)
})

test('journal: a file that never stops changing gives up after APPEND_TRIES tries without writing', async ($, on) => {
  const f = world(on, FIRST)
  f.afterStat = () => { f.mtime++ }
  await answered($, `Done.\n${MINE}`)
  expect(f.writes).toBe(0)
  expect(f.stats).toBe(2 * APPEND_TRIES)
  expect(f.text).toBe(FIRST)
})

test('journal: two answers closed together in one process are serialized, ids consecutive', async ($, on) => {
  const f = world(on, FIRST)
  await Promise.all([answered($, `A\n${MINE}`, 't1'), answered($, `B\n${MINE}`, 't2')])
  expect(idsOf(f)).toEqual(['c01', 'c02', 'c03'])
})
