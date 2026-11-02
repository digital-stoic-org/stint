import { expect, test } from 'claude-code/testing'
import { CREW_BLOCK, CREW_BRIEF_LINE, CREW_DEFAULTS, CREW_GATE_LINE, CREW_MARKER, CREW_ROOTS, CREW_SAMPLES, CREW_TEXT, DELEGATE_RATIO, addSample, claudeMdHasCrew, crewOn, crewText, median, numbersOf, promptTokens, readCrewStore, setCrew, withCrew } from '../hooks/crew.ts'
import { RULE_TEXT } from '../hooks/checkpoint.ts'

test('CREW_TEXT: starts with the marker heading, eleven principle lines, no wrapped line', () => {
  const lines = CREW_TEXT.split('\n')
  expect(lines[0]).toBe(CREW_MARKER)
  expect(CREW_MARKER).toBe('## Crew (stint)')
  expect(lines.slice(1)).toHaveLength(11)
  for (const l of lines.slice(1)) expect(l.startsWith('- ')).toBe(true)
})

test('CREW_TEXT: holds for a delegate too (conditional brief / debrief lines), no "pass it on" line', () => {
  expect(CREW_TEXT).toContain('- When you brief (a sub-agent prompt, or a mandate file whose path you send to a session):')
  expect(CREW_TEXT).toContain('- When you debrief:')
  expect(CREW_TEXT).not.toMatch(/pass (these|the) principles|in your briefs/i)
})

test('CREW_TEXT (0.5.3): the first six lines are 0.5.2\'s, then the five lines between sessions, word for word', () => {
  const lines = CREW_TEXT.split('\n').slice(1)
  expect(lines.slice(0, 6).map(l => l.split(':')[0])).toEqual(['- Context is the budget', '- Inline', '- Fresh sub-agent', '- Fork', '- Model by the work, set explicitly in every delegation', '- Switch the session\'s model only at a pit (the cache is per model). A closed phase or a pause longer than the cache life'])
  expect(lines.slice(6)).toEqual([
    '- Between sessions, send only what the receiver needs to act: a brief, a readback, a blocker, a debrief. No acknowledgements, thanks, "standing by" or recap; 1-3 lines, pointers not content; never answer a message that asks nothing.',
    '- When you brief (a sub-agent prompt, or a mandate file whose path you send to a session): goal, absolute paths, files it alone writes, closed reading list, stop conditions, deliverable, what you don\'t know, gate; ask a session for a readback before work.',
    '- Gate: human when the work is irreversible, outward-facing, costly or changes scope (commits, pushes, deletes, spending, public text, settings), or when unsure; otherwise the sender may confirm the readback. The human answers in the receiver\'s window.',
    '- When you debrief: deliverable path, checkpoint ids (cNN), the proof command for each fact, what you don\'t know. Re-check a debrief you receive on disk before relaying it.',
    '- The first time you exchange with a session, give the absolute paths of your notes and journal.',
  ])
})

test('CREW_TEXT: routing heuristic (0.5.2): budget, inline, fresh sub-agent, fork, model tier, pit', () => {
  for (const s of ['- Context is the budget:', 'Route by what must stay in your context, not by price per call.', '- Inline: short answers while the cache is warm', '- Fresh sub-agent: self-contained, reading-heavy work', 'starts cold', 'none of your cache', 'returns only its conclusion', 'Few workers beat many: each pays its own cold start.', '- Fork: a side task that needs your decisions and state', 'not when your context is already heavy or the task needs another model', '- Model by the work, set explicitly in every delegation:', 'smallest tier', 'middle tier', 'top tier for framing, audits, irreversible steps', 'Keep the session on the top tier; spend cheaper tiers on fresh contexts.', '- Switch the session\'s model only at a pit (the cache is per model).', 'pit rather than carry or delegate the rest']) expect(CREW_TEXT).toContain(s)
})

test('CREW_TEXT: the fork line says a fork starts warm from your cache (D11 overridden after K10 measured it)', () => {
  const fork = CREW_TEXT.split('\n').find(l => l.startsWith('- Fork:')) ?? ''
  expect(fork).toBe('- Fork: a side task that needs your decisions and state (a parallel variant, a review in your frame); it starts warm from your cache; not when your context is already heavy or the task needs another model.')
})

test('crewText: the static defaults are ~11k cold start and > ~7k to delegate (bare folder, 11 × 0.65); other figures fill the same places', () => {
  expect(CREW_DEFAULTS).toEqual({ coldK: 11, delegateK: 7 })
  expect(CREW_DEFAULTS.delegateK).toBe(Math.round(CREW_DEFAULTS.coldK * DELEGATE_RATIO))
  expect(CREW_TEXT).toBe(crewText(CREW_DEFAULTS))
  expect(CREW_TEXT).toContain('(~11k tokens here, none of your cache)')
  expect(CREW_TEXT).toContain('(> ~7k tokens to read)')
  const t = crewText({ coldK: 31, delegateK: 20 })
  expect(t).toContain('(~31k tokens here,')
  expect(t).toContain('(> ~20k tokens to read)')
  expect(t.split('\n')).toHaveLength(CREW_TEXT.split('\n').length)
})

test('CREW_TEXT: no model names, prices, project paths; short (under 2200 characters)', () => {
  expect(CREW_TEXT).not.toMatch(/opus|sonnet|haiku|fable|gpt|gemini|\$\s?\d|\d+\s?(usd|eur)|praxis|CLAUDE\.md|\/repos\//i)
  expect(CREW_TEXT.length).toBeLessThan(2200)
})

test('CREW_MARKER: distinctive: not in the checkpoint rule, not a bare "## Crew"', () => {
  expect(RULE_TEXT).not.toContain(CREW_MARKER)
  expect(CREW_MARKER).not.toBe('## Crew')
})

test('claudeMdHasCrew: the claudeMd block only', () => {
  expect(claudeMdHasCrew([{ name: 'claudeMd', text: `a\n${CREW_MARKER}\nb` }])).toBe(true)
  expect(claudeMdHasCrew([{ name: 'claudeMd', text: '## Crew\n' }])).toBe(false)
  expect(claudeMdHasCrew([{ name: 'attachedProject', text: CREW_MARKER }])).toBe(false)
  expect(claudeMdHasCrew([{ name: CREW_BLOCK, text: CREW_TEXT }])).toBe(false)
  expect(claudeMdHasCrew([])).toBe(false)
})

test('withCrew: appends one block; leaves the input alone when claudeMd holds the marker or the block is there', () => {
  const base = [{ name: 'claudeMd', text: 'x' }]
  expect(withCrew(base)).toEqual([...base, { name: CREW_BLOCK, text: CREW_TEXT }])
  const own = [{ name: 'claudeMd', text: CREW_MARKER }]
  expect(withCrew(own)).toBe(own)
  const twice = withCrew(withCrew(base))
  expect(twice.filter(b => b.name === CREW_BLOCK)).toHaveLength(1)
})

test('setCrew: only off turns it off; anything else reads as the default (on)', () => {
  setCrew('off')
  expect(crewOn()).toBe(false)
  setCrew('on')
  expect(crewOn()).toBe(true)
  setCrew('off')
  setCrew(undefined)
  expect(crewOn()).toBe(true)
  setCrew('off')
  setCrew('maybe')
  expect(crewOn()).toBe(true)
})

// ---------- measured figures (0.5.1) ----------

test('numbersOf: defaults when nothing was measured, or the store is malformed', () => {
  expect(numbersOf(undefined, '/a')).toEqual(CREW_DEFAULTS)
  expect(numbersOf({ roots: 'x' }, '/a')).toEqual(CREW_DEFAULTS)
  expect(numbersOf({ roots: [{ root: '/a', samples: [{ t: 'big', at: 1 }, { t: -5, at: 2 }] }] }, '/a')).toEqual(CREW_DEFAULTS)
})

test('numbersOf: the median of the root\'s samples in k, the delegate threshold at 0.65 of it', () => {
  expect(DELEGATE_RATIO).toBe(0.65)
  let st = addSample(undefined, '/a', 24_545, 1)
  expect(numbersOf(st, '/a')).toEqual({ coldK: 25, delegateK: 16 })
  st = addSample(st, '/a', 30_000, 2)
  st = addSample(st, '/a', 90_000, 3)
  expect(numbersOf(st, '/a')).toEqual({ coldK: 30, delegateK: 20 })
  expect(numbersOf(addSample(undefined, '/a', 23_000, 1), '/a')).toEqual({ coldK: 23, delegateK: 15 })
})

test('numbersOf: another root\'s samples serve a root never measured (the last CREW_SAMPLES across roots); a measured root keeps its own', () => {
  let st = addSample(undefined, '/a', 20_000, 1)
  st = addSample(st, '/b', 40_000, 2)
  expect(numbersOf(st, '/a').coldK).toBe(20)
  expect(numbersOf(st, '/b').coldK).toBe(40)
  expect(numbersOf(st, '/c').coldK).toBe(30)
  for (let i = 0; i < CREW_SAMPLES; i++) st = addSample(st, '/b', 50_000, 10 + i)
  expect(numbersOf(st, '/c').coldK).toBe(50)
})

test('addSample: last CREW_SAMPLES per root, at most CREW_ROOTS roots, the least recently sampled root dropped first; numbers only', () => {
  expect(CREW_SAMPLES).toBe(5)
  expect(CREW_ROOTS).toBe(20)
  let st = addSample(undefined, '/a', 1000, 0)
  for (let i = 1; i <= 7; i++) st = addSample(st, '/a', 1000 * (i + 1), i)
  expect(st.roots[0]!.samples.map(s => s.t)).toEqual([4000, 5000, 6000, 7000, 8000])
  for (let i = 0; i < CREW_ROOTS; i++) st = addSample(st, `/r${i}`, 1000, 100 + i)
  expect(st.roots).toHaveLength(CREW_ROOTS)
  expect(st.roots.some(r => r.root === '/a')).toBe(false)
  st = addSample(st, '/r0', 2000, 200)
  expect(st.roots.at(-1)?.root).toBe('/r0')
  expect(JSON.stringify(st)).toMatch(/^[\[\]{}"a-z0-9:,\/._-]*$/i)
})

test('readCrewStore, median, promptTokens', () => {
  expect(readCrewStore(null)).toEqual({ roots: [] })
  expect(median([3, 1, 2])).toBe(2)
  expect(median([1, 2, 3, 10])).toBe(2.5)
  expect(promptTokens({ input_tokens: 2, cache_creation_input_tokens: 16_243, cache_read_input_tokens: 8300 })).toBe(24_545)
})

test('withCrew: takes the filled text', () => {
  const text = crewText({ coldK: 31, delegateK: 20 })
  expect(withCrew([{ name: 'claudeMd', text: 'x' }], text).at(-1)).toEqual({ name: CREW_BLOCK, text })
})

// ---------- /brief (0.5.3, K18): commands/brief.md holds these two lines word for word (checked by script: the test world reads no file) ----------

test('crew brief and gate lines: exported once, used by the crew text in that order', () => {
  const lines = CREW_TEXT.split('\n')
  expect(lines).toContain(CREW_BRIEF_LINE)
  expect(lines).toContain(CREW_GATE_LINE)
  expect(lines.indexOf(CREW_GATE_LINE)).toBe(lines.indexOf(CREW_BRIEF_LINE) + 1)
  expect(CREW_BRIEF_LINE.startsWith('- When you brief (a sub-agent prompt, or a mandate file')).toBe(true)
  expect(CREW_GATE_LINE.startsWith('- Gate: human when')).toBe(true)
})
