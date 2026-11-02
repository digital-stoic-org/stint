import { expect, test } from 'claude-code/testing'
import { CLAUSES, RULE_TEXT, ROUTE, checkpointOn, entryText, hideTrailer, journalPath, journalRule, maxId, pad, parseJournal, parseTrailer, setCheckpoint, splitTrailer, trailersOf } from '../hooks/checkpoint.ts'

const TRAILER = '<!-- ckpt decision: keep A · reasoning: B follows -->'

// ---------- menu and routing ----------

test('CLAUSES: stoa\'s ten, in order', () => {
  expect(CLAUSES).toEqual(['decision', 'reasoning', 'learning', 'pivot', 'rejected', 'constraint', 'assumption', 'open', 'definition', 'refs'])
})

test('ROUTE: every clause has an entry; reasoning and pivot are journal-only', () => {
  expect(Object.keys(ROUTE).sort()).toEqual([...CLAUSES].sort())
  expect(ROUTE.reasoning).toBeNull()
  expect(ROUTE.pivot).toBeNull()
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
  expect(r).toContain("grep -A8 '^### cNN'")
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

test('RULE_TEXT: teaches the opener and all ten clauses, names no project path', () => {
  expect(RULE_TEXT).toContain('<!-- ckpt')
  for (const c of CLAUSES) expect(RULE_TEXT).toContain(`\`${c}:\``)
  expect(RULE_TEXT).not.toMatch(/praxis|CLAUDE\.md|\.claude\/|\/repos\//i)
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
