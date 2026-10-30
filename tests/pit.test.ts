import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  AGENT_LINE,
  AGENTS_UNKNOWN,
  AUTOPIT_CEILING,
  AUTOPIT_KEY,
  COMMANDS,
  AUTOPIT_MAX_AGE_MS,
  AUTOPIT_MIN_TOKENS,
  NOTES_MAX,
  SLOW_MS,
  UNPACK_RULES,
  WALL_CAP,
  agentLinesOf,
  archiveName,
  archiveStamp,
  ceilingPercent,
  ceilingSkip,
  ceilingTokens,
  autoLine,
  autoUnpackRules,
  autopitDelayMs,
  autopitSkip,
  boardProgress,
  hintBoard,
  savedBoard,
  assemble,
  elapsed,
  forkPrompt,
  hintText,
  injectText,
  notesPath,
  overWall,
  overwriteWarning,
  parseArgs,
  parseFork,
  parseForkBody,
  parseNotes,
  progressText,
  resolveStream,
  slugify,
  streamsFromNames,
} from '../hooks/pit.ts'

// ---------- pure functions ----------

test('parseArgs: no argument, a valid stream, usage errors', () => {
  expect(parseArgs('', 'pit')).toEqual({})
  expect(parseArgs('  proj  ', 'pit')).toEqual({ stream: 'proj' })
  expect(parseArgs('a_b-9', 'rejoin')).toEqual({ stream: 'a_b-9' })
  expect(parseArgs('a b', 'pit')).toEqual({ error: 'too many arguments. Usage: /pit [stream]' })
  expect(parseArgs('--review', 'pit')).toEqual({ error: 'unknown option --review. Usage: /pit [stream]' })
  expect(parseArgs('-y', 'rejoin')).toEqual({ error: 'unknown option -y. Usage: /rejoin [stream]' })
  expect(parseArgs('a/b', 'pit')).toEqual({ error: 'invalid stream "a/b": use 1-50 chars of a-z A-Z 0-9 _ -' })
  expect(parseArgs('x'.repeat(51), 'pit')).toHaveProperty('error')
  expect(parseArgs('x'.repeat(50), 'pit')).toEqual({ stream: 'x'.repeat(50) })
})

test('parseArgs: reserved words are refused', () => {
  expect(parseArgs('pit', 'pit')).toEqual({ error: '"pit" is a reserved word, not a stream name' })
  expect(parseArgs('rejoin', 'rejoin')).toEqual({ error: '"rejoin" is a reserved word, not a stream name' })
})

test('slugify: a valid name stays, a title becomes a slug, empty or reserved is no stream', () => {
  expect(slugify('proj-1')).toBe('proj-1')
  expect(slugify('Ship the v2 plugin!')).toBe('ship-the-v2-plugin')
  expect(slugify('  --Éclair--  ')).toBe('clair')
  expect(slugify('???')).toBeNull()
  expect(slugify('')).toBeNull()
  expect(slugify('pit')).toBeNull()
  expect(slugify('  REJOIN ')).toBeNull()
  expect(slugify('a'.repeat(80))).toBe('a'.repeat(50))
  expect(slugify(`${'a'.repeat(49)} bbb`)).toBe('a'.repeat(49))
})

test('resolveStream: explicit binding > title > main', () => {
  expect(resolveStream('arg', 'title')).toBe('arg')
  expect(resolveStream(null, 'title')).toBe('title')
  expect(resolveStream(null, null)).toBe('main')
})

test('notesPath: <cwd>/.stint/<stream>-notes.md', () => {
  expect(notesPath('/work', 'proj')).toBe('/work/.stint/proj-notes.md')
  expect(notesPath('/work/', 'proj')).toBe('/work/.stint/proj-notes.md')
})

test('streamsFromNames: only <stream>-notes.md files, sorted', () => {
  expect(streamsFromNames(['b-notes.md', 'a-notes.md', 'readme.md', 'x-notes.txt', '-notes.md', 'a b-notes.md', 'a-notes-notes.md'])).toEqual(['a', 'a-notes', 'b'])
  expect(streamsFromNames([])).toEqual([])
})

test('streamsFromNames: archive-looking names and the archive directory are not streams', () => {
  expect(streamsFromNames(['archive', 'proj-notes.md', 'proj-notes-20261029-1405.md', 'proj-notes-20261029-1405-2.md', 'archive-notes.md.bak'])).toEqual(['proj'])
  expect(streamsFromNames(['archive'])).toEqual([])
})

test('overWall: at or above 95% of the wall', () => {
  expect(WALL_CAP).toBe(0.95)
  expect(overWall(94_999, 100_000)).toBe(false)
  expect(overWall(95_000, 100_000)).toBe(true)
  expect(overWall(120_000, 100_000)).toBe(true)
  expect(overWall(10, 0)).toBe(false)
})

test('progress text: ticks, then says slow or stuck', () => {
  expect(elapsed(12_000)).toBe('12s')
  expect(elapsed(125_000)).toBe('2m 05s')
  expect(progressText('Pitting stream "x"', 0)).toBe('Pitting stream "x"...')
  expect(progressText('Pitting stream "x"', 12_000)).toBe('Pitting stream "x"... 12s')
  expect(progressText('Pitting stream "x"', SLOW_MS)).toContain('slow or stuck')
})

test('hintText: one stream names the command, several ask for a pick', () => {
  expect(hintText(['x'])).toBe('Notes for stream "x" found: /rejoin x')
  expect(hintText(['a', 'b'])).toBe('Notes found for streams "a", "b": /rejoin <stream>')
})

// ---------- fork output ----------

const FORK_LINES = [
  'status: building',
  'goal: ship v2',
  'read_first:',
  '- /w/spec.md — the spec',
  'read_if_needed:',
  '- /w/extra.md — when X',
  'deliverable: /w/out.md',
  'decisions:',
  '- notes by one fork — simpler',
  'learnings:',
  '- the fork cannot run commands — see the prompt',
  'discarded:',
  '- a second fork — too slow',
  'in_progress:',
  '- parser half done',
  'next:',
  '- write tests',
  'unknowns:',
  '- does clear work from a hook',
  'stale:',
  '- /w/old.md — replaced by spec.md',
]
const OK = (lines: string[] = FORK_LINES) => `GATE: ok\n${lines.join('\n')}`
const section = (text: string, key: string) => {
  const lines = text.split('\n')
  const from = lines.indexOf(`${key}:`)
  if (from < 0) return []
  const out: string[] = []
  for (const l of lines.slice(from + 1)) {
    if (!l.startsWith('- ')) break
    out.push(l.slice(2))
  }
  return out
}
const asm = (lines: string[] = FORK_LINES, extra: { prev?: string | null; agents?: string[] } = {}) => {
  const parsed = parseFork(OK(lines))
  if (parsed.kind !== 'ok') throw new Error('blocked')
  const fork = parseForkBody(parsed.body)
  if (!fork) throw new Error('unparseable')
  return assemble({ stream: 'proj', saved: '2026-10-22T10:00:00.000Z', sid: 's2', prev: extra.prev ?? null, fork, agents: extra.agents })
}

test('parseFork: ok, blocked with reason, malformed, empty', () => {
  expect(parseFork('GATE: ok\nstatus: x')).toEqual({ kind: 'ok', body: 'status: x' })
  expect(parseFork('GATE: blocked - mid synthesis')).toEqual({ kind: 'blocked', reason: 'mid synthesis' })
  expect(parseFork('GATE: blocked')).toEqual({ kind: 'blocked', reason: 'no reason given' })
  expect(parseFork('hello')).toEqual({ kind: 'blocked', reason: 'malformed first line: hello' })
  expect(parseFork('GATE: ok\n')).toEqual({ kind: 'blocked', reason: 'empty fork output' })
})

test('parseForkBody: scalars and lists, unknown lines ignored, nothing parseable is null', () => {
  const fields = parseForkBody(FORK_LINES.join('\n') + '\nretire_done: c01\nnoise')
  expect(fields?.scalars).toEqual({ status: 'building', goal: 'ship v2', deliverable: '/w/out.md' })
  expect(fields?.lists.read_first).toEqual(['/w/spec.md — the spec'])
  expect(fields?.lists.next).toEqual(['write tests'])
  expect(fields?.lists).not.toHaveProperty('retire_done')
  expect(parseForkBody('just some prose')).toBeNull()
})

// ---------- assemble ----------

test('assemble: header scalars, body in order, ends with a newline', () => {
  const r = assemble0()
  expect(r.kind).toBe('ok')
  const state = r.kind === 'ok' ? r.state : ''
  expect(state.split('\n').slice(0, 5)).toEqual([
    'stream: proj',
    'saved: 2026-10-22T10:00:00.000Z s2',
    'status: building',
    'previous_session: none',
    'goal: ship v2',
  ])
  const keys = state.split('\n').filter(l => /^[a-z_]+:/.test(l)).map(l => l.split(':')[0])
  expect(keys).toEqual(['stream', 'saved', 'status', 'previous_session', 'goal', 'read_first', 'read_if_needed', 'deliverable', 'decisions', 'learnings', 'discarded', 'in_progress', 'next', 'unknowns', 'stale'])
  expect(state).not.toContain('journal')
  expect(state.endsWith('\n')).toBe(true)
  expect(r.kind === 'ok' && r.degraded).toBe(false)
})
const assemble0 = () => asm()

test('assemble: previous header carried (previous_session, status, goal), the fork wins when it writes one', () => {
  const prev = 'stream: proj\nsaved: 2026-10-21T10:00:00.000Z s1\nstatus: review\nprevious_session: s0\ngoal: old goal\n\nread_first:\ndeliverable: /w/old.md\n'
  const r = asm(['read_first:', '- /a — b'], { prev })
  const state = r.kind === 'ok' ? r.state : ''
  expect(state).toContain('previous_session: s1')
  expect(state).toContain('status: review')
  expect(state).toContain('goal: old goal')
  expect(state).toContain('deliverable: /w/old.md')
  const same = asm(['status: done'], { prev: prev.replace('s1', 's2') })
  expect(same.kind === 'ok' && same.state).toContain('previous_session: s0')
  expect(same.kind === 'ok' && same.state).toContain('status: done')
})

test('assemble: a decision without a why gets one, an empty unknowns gets a default, duplicates collapse', () => {
  const r = asm(['decisions:', '- plain choice', '- plain choice', 'unknowns:'])
  const state = r.kind === 'ok' ? r.state : ''
  expect(section(state, 'decisions')).toEqual(['plain choice — why missing'])
  expect(section(state, 'unknowns')).toEqual(['nothing recorded — treat every fact as unverified'])
})

test('assemble: agent lines first in in_progress, written by code; the fork cannot write one', () => {
  const r = asm(['in_progress:', `- ${AGENT_LINE} ghost [g1] running — copied`, `- ${AGENTS_UNKNOWN}`, '- half done'], { agents: [`${AGENT_LINE} scout [a1] running — task`] })
  const state = r.kind === 'ok' ? r.state : ''
  expect(section(state, 'in_progress')).toEqual([`${AGENT_LINE} scout [a1] running — task`, 'half done'])
})

test('agentLinesOf: format, live statuses only, capped at 10 with a count line', () => {
  const mk = (i: number, status = 'running') => ({ id: `a${i}`, name: i === 1 ? 'scout' : '', type: 'general-purpose', status, description: `task   of\n a${i}` })
  expect(agentLinesOf([mk(1), mk(2, 'idle'), mk(3, 'completed'), mk(4, 'failed')])).toEqual([
    'agent in flight: scout [a1] running — task of a1',
    'agent in flight: general-purpose [a2] idle — task of a2',
  ])
  expect(agentLinesOf([{ id: 'z', type: 'Explore', status: 'pending' }])).toEqual(['agent in flight: Explore [z] pending'])
  const many = agentLinesOf(Array.from({ length: 13 }, (_, i) => mk(i + 1)))
  expect(many).toHaveLength(11)
  expect(many[10]).toBe('agent in flight: +3 more, not listed')
  expect(agentLinesOf([{ id: 'l', type: 't', status: 'running', description: 'x'.repeat(300) }])[0]?.length).toBeLessThan(160)
})

// ---------- the cap ----------

const filler = (tag: string, n: number, len = 70) => Array.from({ length: n }, (_, i) => `- ${tag}${String(i).padStart(3, '0')} ${'.'.repeat(len)}`)
const big = (extra: Record<string, string[]>) =>
  [
    'status: building',
    'goal: g',
    'read_first:',
    '- /w/spec.md — the spec',
    ...Object.entries(extra).flatMap(([k, v]) => [`${k}:`, ...v]),
  ]

test('cap: under the cap nothing is cut', () => {
  const r = asm()
  expect(r.kind === 'ok' && r.cut).toEqual([])
})

test('cap: read_if_needed is compressed first, then stale, in_progress, discarded, learnings go oldest first, status marked degraded', () => {
  // ~9.4 KB: after the compression, stale then in_progress go, then discarded; learnings are untouched.
  const lines = big({
    read_if_needed: filler('r', 10, 150),
    stale: filler('s', 10),
    in_progress: filler('p', 10),
    discarded: filler('d', 30),
    learnings: filler('l', 60),
    next: ['- keep next'],
  })
  const r = asm(lines)
  expect(r.kind).toBe('ok')
  if (r.kind !== 'ok') return
  expect(r.state.length).toBeLessThanOrEqual(NOTES_MAX)
  expect(r.degraded).toBe(true)
  expect(r.state).toContain('status: degraded (building)')
  expect(r.cut[0]).toBe('read_if_needed compressed')
  // order: stale is exhausted before in_progress is touched, in_progress before discarded, discarded before learnings
  const cutKeys = r.cut.slice(1).map(c => c.split(' ')[0])
  const order = ['stale', 'in_progress', 'discarded', 'learnings']
  expect(cutKeys).toEqual(order.filter(k => cutKeys.includes(k)))
  expect(cutKeys.slice(0, 2)).toEqual(['stale', 'in_progress'])
  expect(section(r.state, 'stale')).toEqual([])
  expect(section(r.state, 'in_progress')).toEqual([])
  expect(section(r.state, 'learnings')).toHaveLength(60)
  // never cut
  expect(section(r.state, 'read_first')).toEqual(['/w/spec.md — the spec'])
  expect(section(r.state, 'next')).toEqual(['keep next'])
  for (const l of section(r.state, 'read_if_needed')) expect(l.length).toBeLessThanOrEqual(80)
})

test('cap: learnings are the last of the five; the oldest line goes first', () => {
  const r = asm(big({ stale: filler('s', 5), in_progress: filler('p', 5), discarded: filler('d', 5), learnings: filler('l', 110) }))
  expect(r.kind).toBe('ok')
  if (r.kind !== 'ok') return
  expect(r.cut.map(c => c.split(' ')[0])).toEqual(['stale', 'in_progress', 'discarded', 'learnings'])
  expect(section(r.state, 'stale')).toEqual([])
  const kept = section(r.state, 'learnings')
  expect(kept.length).toBeGreaterThan(0)
  expect(kept[0]).not.toContain('l000')
  expect(kept[kept.length - 1]).toContain('l109')
  expect(r.state.length).toBeLessThanOrEqual(NOTES_MAX)
})

test('cap: the first cut is read_if_needed compression alone when that is enough', () => {
  const r = asm(big({ read_if_needed: filler('r', 40, 190) }))
  expect(r.kind).toBe('ok')
  if (r.kind !== 'ok') return
  expect(r.cut).toEqual(['read_if_needed compressed'])
  expect(r.degraded).toBe(true)
})

test('cap: past the five sections the rest is cut and the cut is named in stale; the agent lines survive', () => {
  const agents = ['agent in flight: scout [a1] running — task']
  const r = asm(big({ decisions: filler('x', 40, 190), next: filler('n', 20, 100) }), { agents })
  expect(r.kind).toBe('ok')
  if (r.kind !== 'ok') return
  expect(r.state.length).toBeLessThanOrEqual(NOTES_MAX)
  expect(section(r.state, 'in_progress')).toEqual(agents)
  expect(section(r.state, 'stale').some(l => l.startsWith('overflow: cut to fit 8000 chars:'))).toBe(true)
  expect(section(r.state, 'read_first')).toEqual(['/w/spec.md — the spec'])
})

test('cap: header, read_first and agent lines alone over the cap is refused, nothing written', () => {
  const r = asm(['read_first:', ...filler('f', 120, 80)])
  expect(r.kind).toBe('blocked')
  expect(r.kind === 'blocked' && r.reason).toContain('shorten read_first')
})

// ---------- previous notes and the prompt ----------

test('forkPrompt: previous notes are passed to merge; none says (none); the room is told', () => {
  const prev = 'stream: proj\nstatus: building\n'
  const p = forkPrompt(prev)
  expect(p).toContain(`PREVIOUS NOTES:\n${prev}`)
  expect(p).toContain('Never restart from scratch')
  expect(p).toContain('8,000 characters')
  expect(forkPrompt(null)).toContain('PREVIOUS NOTES:\n(none)')
  expect(forkPrompt('x'.repeat(7_000))).toContain('Room is tight')
  expect(p).not.toContain('retire_')
  expect(p).not.toContain('ckpt')
  expect(parseNotes(prev).scalars.status).toBe('building')
})

// ---------- flows against a stubbed engine ----------

const CWD = '/work'
const NOTES = '/work/.stint/proj-notes.md'
const TOKENS = { tokens: 10_000, wall: 100_000 }

type World = {
  submits: string[]
  clears: number
  toasts: string[]
  statuses: (string | undefined)[]
  forkPrompts: string[]
  store: Map<string, unknown>
  files: Map<string, string>
  forkText: string | null
  gate: Promise<void> | null
  usage: { tokens?: number; wall: number; window?: number } | 'throws'
  clock: { advance: (ms: number) => Promise<void> }
  agents: { id: string; name?: string; description: string; type: string; status: string }[]
  // $.agent.list() fails: the busy count is unknown
  agentsDown: boolean
  refuseClear: boolean
  failWrites: boolean
  // writes under .stint/archive/ fail
  failArchive: boolean
  // a second row in the config list (the host's idle compaction row), or 'throws'
  idleRow: { key: string; label: string; value: unknown } | 'throws' | null
  // auto-pit: the Auto-pit row's value and the text in the prompt box
  mode: string
  draft: string | null
  cwd?: string
  root?: string
}

function world(on: On, forkText: string | null, now = 1_000_000): World {
  const w: World = {
    submits: [],
    clears: 0,
    toasts: [],
    statuses: [],
    forkPrompts: [],
    store: new Map(),
    files: new Map(),
    forkText,
    gate: null,
    usage: TOKENS,
    clock: { advance: async () => undefined },
    agents: [],
    agentsDown: false,
    refuseClear: false,
    failWrites: false,
    failArchive: false,
    idleRow: null,
    mode: 'on',
    draft: '',
  }
  on('store.get', (_$, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_$, e) => (w.store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_$, e) => (w.store.delete(e.key), { value: undefined }))
  w.clock = mock.clock(on, { now })
  on('model.fork', async (_$, e) => {
    w.forkPrompts.push(e.prompt)
    if (w.gate) await w.gate
    return {
      value: w.forkText === null ? { isAnswered: false, reason: 'nothing-to-fork' } : { isAnswered: true, text: w.forkText, usage: { input_tokens: 1, output_tokens: 1 } },
    } as never
  })
  on('agent.list', () => {
    if (w.agentsDown) throw new Error('agent list down')
    return { value: w.agents } as never
  })
  on('session.cwd', () => ({ value: w.cwd ?? CWD }))
  on('session.root', () => ({ value: w.root ?? CWD }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => {
    if (w.usage === 'throws') throw new Error('usage down')
    return { value: { startedAt: 0, context: { window: w.usage.window ?? 200_000, tokens: w.usage.tokens, breakdown: { autoCompactThreshold: w.usage.wall } }, rateLimits: [] } } as never
  })
  on('fs.exists', (_$, e) => ({ value: w.files.has(e.path) }))
  on('fs.read', (_$, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', (_$, e) => {
    if (w.failWrites || (w.failArchive && e.path.includes('/.stint/archive/'))) return { deny: 'EACCES' }
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_$, e) => {
    const prefix = `${e.path}/`
    const rest = [...w.files.keys()].filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length))
    const files = rest.filter(r => !r.includes('/'))
    // a nested path is a directory entry, once
    const dirs = [...new Set(rest.filter(r => r.includes('/')).map(r => r.slice(0, r.indexOf('/'))))]
    if (files.length + dirs.length === 0) return { deny: 'ENOENT' }
    return { value: [...files.map(name => ({ name, kind: 'file' })), ...dirs.map(name => ({ name, kind: 'dir' }))].map(e => ({ ...e, size: 1, mtimeMs: 0, isLink: false })) } as never
  })
  on('session.measure', (_$, e) => ({ changed: [...e.changed] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('config.list', () => {
    if (w.idleRow === 'throws') throw new Error('config down')
    const rows = [{ key: AUTOPIT_KEY, label: 'stint · Auto-pit', kind: 'choice', value: w.mode, provider: { plugin: 'stint', tier: 'plugin' }, isLocked: false }]
    if (w.idleRow) rows.push({ ...w.idleRow, kind: 'toggle', provider: { plugin: 'host', tier: 'builtin' }, isLocked: false } as never)
    return { value: rows } as never
  })
  on('config.set', { key: AUTOPIT_KEY }, (_$, e) => ({ value: e.value }))
  on('prompt.read', () => {
    if (w.draft === null) throw new Error('prompt box down')
    return { value: { text: w.draft, cursor: w.draft.length } } as never
  })
  on('ui.status', (_$, e) => (w.statuses.push(e.text), { value: undefined }))
  on('ui.toast', (_$, e) => (w.toasts.push(e.text), { value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('command.run', { command: 'clear' }, () => {
    if (w.refuseClear) throw new Error('refused')
    w.clears++
    return {}
  })
  on('prompt.submit', (_$, e) => {
    w.submits.push(e.text)
    return { text: e.text }
  })
  return w
}

const runCommand = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
const pit = ($: Engine, args = 'proj') => runCommand($, 'pit', args)
const rejoin = ($: Engine, args = '') => runCommand($, 'rejoin', args)
const fresh = ($: Engine) => $.classic.SessionStart({ source: 'startup' })
const clear = ($: Engine) => $.classic.SessionStart({ source: 'clear' })
const title = ($: Engine, session_title: string) => $.classic.UserPromptSubmit({ prompt: 'x', session_title })
const BAND = { plugin: 'stint', surface: 'terminal', component: 'AbovePrompt', requestId: 'band', viewport: { columns: 120, rows: 40, isFullscreen: false }, props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 110, scroll: { first: 1, last: 1, of: 1 }, view: {} } } as never
// The band's text now. Raising the band moves the pit lines off the status line, so call it after the status assertions.
async function bandNow($: Engine): Promise<string> {
  await $.session.measure({ context: { window: 200_000, tokens: 2_000, percent: 1 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount(BAND)
  const text = (await ui.findAll({ type: 'Text' }))[0]?.text ?? ''
  await ui.unmount()
  return text
}
const lastStatus = (w: World) => w.statuses[w.statuses.length - 1]

test('pit: saves, runs /clear after the hook, re-injects the notes + rules once after the clear', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  const out = await pit($)
  expect(out.text).toBe('pit: saved .stint/proj-notes.md')
  const notes = w.files.get(NOTES) ?? ''
  expect(notes).toContain('stream: proj')
  expect(notes).toContain('goal: ship v2')
  // the host rejects command.run inside the hook: the clear runs from a clock.after dispatch
  expect(w.clears).toBe(0)
  await w.clock.advance(5)
  expect(w.clears).toBe(1)
  expect(w.store.get('stint:pending')).toMatchObject({ stream: 'proj', root: CWD })
  await clear($)
  expect(w.submits).toEqual([`${notes.trimEnd()}\n\n${UNPACK_RULES}`])
  expect(w.store.get('stint:pending')).toBeUndefined()
  expect(w.toasts.some(t => t.includes('stream "proj"'))).toBe(true)
  // nothing is injected twice
  await clear($)
  expect(w.submits).toHaveLength(1)
})

test('pit: a fork gate that blocks, a fork without answer, a failed write: no /clear, status line warns, notes untouched', async ($, on) => {
  const w = world(on, 'GATE: blocked - mid synthesis')
  await fresh($)
  const blocked = await pit($)
  expect(blocked.text).toBe('pit: could not save stream "proj": mid synthesis. No /clear run, the session is unchanged.')
  expect(lastStatus(w)).toMatch(/^⚠ /)
  expect(w.files.has(NOTES)).toBe(false)
  // red and sticky on the board until the next command
  await w.clock.advance(60_000)
  expect(await bandNow($)).toContain('PIT FAILED, session kept')

  w.forkText = null
  const none = await pit($)
  expect(none.text).toContain('nothing to save yet')

  w.forkText = OK()
  w.failWrites = true
  const failed = await pit($)
  expect(failed.text).toContain('could not save stream "proj"')

  await w.clock.advance(5)
  expect(w.clears).toBe(0)
  expect(w.store.get('stint:pending')).toBeUndefined()
  await clear($)
  expect(w.submits).toHaveLength(0)
})

test('pit: refused before the fork when the context is at 95% of the wall', async ($, on) => {
  const w = world(on, OK())
  w.usage = { tokens: 95_000, wall: 100_000 }
  await fresh($)
  const out = await pit($)
  expect(out.text).toContain('pit: context is at 95%')
  expect(out.text).toContain('Nothing saved, the session is unchanged')
  expect(w.forkPrompts).toHaveLength(0)
  expect(lastStatus(w)).toMatch(/^⚠ Pit refused/)
  expect(await bandNow($)).toContain('PIT REFUSED at 95% of the limit, nothing saved')
  await w.clock.advance(5)
  expect(w.clears).toBe(0)
  // just under goes through
  w.usage = { tokens: 94_000, wall: 100_000 }
  const ok = await pit($)
  expect(ok.text).toContain('saved')
  // unknown figures do not block
  w.usage = 'throws'
  expect((await pit($)).text).toContain('saved')
})

test('pit: the stream binds for the session and survives /clear; the next pit without argument reuses it', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  await pit($, 'proj')
  await w.clock.advance(5)
  await clear($)
  const again = await pit($, '')
  expect(again.text).toBe('pit: saved .stint/proj-notes.md')
  expect(w.files.has('/work/.stint/main-notes.md')).toBe(false)
})

test('pit: stream = title (slugified) without argument, main without title', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  expect((await pit($, '')).text).toBe('pit: saved .stint/main-notes.md')
  await title($, 'Ship the v2 plugin')
  expect((await pit($, '')).text).toBe('pit: saved .stint/ship-the-v2-plugin-notes.md')
  expect(w.files.has('/work/.stint/ship-the-v2-plugin-notes.md')).toBe(true)
  // an explicit argument wins over the title
  expect((await pit($, 'proj')).text).toBe('pit: saved .stint/proj-notes.md')
  expect((await pit($, '')).text).toBe('pit: saved .stint/proj-notes.md')
})

test('pit: previous notes of the stream are fed to the fork and merged', async ($, on) => {
  const w = world(on, OK())
  w.files.set(NOTES, 'stream: proj\nsaved: 2026-10-21T10:00:00.000Z old-sess\nstatus: building\nprevious_session: none\ngoal: old goal\n\nread_first:\ndeliverable: none\n')
  await fresh($)
  await pit($)
  expect(w.forkPrompts[0]).toContain('goal: old goal')
  expect(w.files.get(NOTES)).toContain('previous_session: old-sess')
})

test('pit: agents in flight are listed in in_progress by code before the fork', async ($, on) => {
  const w = world(on, OK())
  w.agents = [{ id: 'a1', name: 'scout', description: 'look around', type: 'Explore', status: 'running' }]
  await fresh($)
  // --save: a plain /pit would wait for the running agent
  await pit($, 'proj --save')
  expect(section(w.files.get(NOTES) ?? '', 'in_progress')).toEqual(['agent in flight: scout [a1] running — look around', 'parser half done'])
})

test('boardProgress, savedBoard, hintBoard: short board texts', () => {
  expect(boardProgress('x', 0)).toBe('pitting "x"...')
  expect(boardProgress('x', 12_000)).toBe('pitting "x"... 12s')
  expect(boardProgress('x', SLOW_MS)).toContain('slow or stuck')
  expect(savedBoard(9_800)).toBe('saved 9.8k -> clearing')
  expect(savedBoard(420)).toBe('saved 420 -> clearing')
  expect(hintBoard(['a'])).toBe('notes found: /rejoin a')
  expect(hintBoard(['a', 'b'])).toBe('/rejoin <stream>: several notes found')
})

test('pit: a second pit while one runs is refused; progress ticks on the status line, slow past 3 min', async ($, on) => {
  const w = world(on, OK())
  let release = () => {}
  w.gate = new Promise<void>(r => (release = r))
  await fresh($)
  const first = pit($)
  await new Promise(r => setTimeout(r, 20))
  expect(lastStatus(w)).toBe('Pitting stream "proj"...')
  await w.clock.advance(12_000)
  expect(lastStatus(w)).toBe('Pitting stream "proj"... 12s')
  const second = await pit($)
  expect(second.text).toBe('pit: a pit is already running, its outcome will show in the status line')
  await w.clock.advance(SLOW_MS)
  expect(lastStatus(w)).toContain('slow or stuck')
  expect(await bandNow($)).toContain('pitting "proj": slow or stuck, 3m 12s')
  release()
  const done = await first
  expect(done.text).toContain('saved')
  expect(w.forkPrompts).toHaveLength(1)
})

test('pit: when the host refuses /clear the status line says to type it, and the clear still injects', async ($, on) => {
  const w = world(on, OK())
  w.refuseClear = true
  await fresh($)
  await pit($)
  await w.clock.advance(5)
  await new Promise(r => setTimeout(r, 10))
  expect(lastStatus(w)).toBe('Ready: type /clear to continue in a fresh session')
  expect(await bandNow($)).toContain('type /clear to continue')
  await clear($)
  expect(w.submits).toHaveLength(1)
})

test('pit: a stale armed entry (> 10 min) is not injected', async ($, on) => {
  const w = world(on, null, 11 * 60 * 1000)
  w.store.set('stint:pending', { text: 'n', createdAt: 0, root: CWD, stream: 'proj' })
  await clear($)
  expect(w.submits).toHaveLength(0)
  expect(w.store.get('stint:pending')).toBeUndefined()
})

test('pit: a fresh armed entry in the store (mod reloaded) is injected and re-binds its stream', async ($, on) => {
  const w = world(on, OK(), 60 * 1000)
  w.store.set('stint:pending', { text: 'n', createdAt: 0, root: CWD, stream: 'proj' })
  await clear($)
  expect(w.submits).toEqual([`n\n\n${UNPACK_RULES}`])
  expect((await pit($, '')).text).toBe('pit: saved .stint/proj-notes.md')
})

test('pit: bad arguments are refused with the usage', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  expect((await pit($, 'a b')).text).toBe('pit: too many arguments. Usage: /pit [stream]')
  expect((await pit($, 'rejoin')).text).toContain('reserved word')
  expect(w.forkPrompts).toHaveLength(0)
})

test('rejoin: a named stream becomes the first message (after the hook) and binds', async ($, on) => {
  const w = world(on, OK())
  w.files.set(NOTES, 'stream: proj\ngoal: g\n')
  await fresh($)
  const out = await rejoin($, 'proj')
  expect(out.text).toBe('rejoin: loading stream "proj" as the first message.')
  expect(w.submits).toHaveLength(0)
  await w.clock.advance(5)
  expect(w.submits).toEqual([`stream: proj\ngoal: g\n\n${UNPACK_RULES}`.replace('g\n\n', 'g\n\n')])
  // bound: a pit without argument uses it
  expect((await pit($, '')).text).toBe('pit: saved .stint/proj-notes.md')
})

test('rejoin: no argument takes the only notes file, or says none', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  expect((await rejoin($)).text).toBe('rejoin: no notes in .stint/ of this folder. Nothing loaded.')
  w.files.set(NOTES, 'stream: proj\n')
  expect((await rejoin($)).text).toBe('rejoin: loading stream "proj" as the first message.')
  await w.clock.advance(5)
  expect(w.submits).toHaveLength(1)
})

test('rejoin: no argument lists several notes files', async ($, on) => {
  const w2 = world(on, OK())
  w2.files.set('/work/.stint/a-notes.md', 'x')
  w2.files.set('/work/.stint/b-notes.md', 'y')
  await fresh($)
  expect((await rejoin($)).text).toBe('rejoin: several notes here, pick one with /rejoin <stream>: a, b')
  await w2.clock.advance(5)
  expect(w2.submits).toHaveLength(0)
})

test('rejoin: an unknown stream says so and lists what exists; bad arguments are refused', async ($, on) => {
  const w = world(on, OK())
  w.files.set('/work/.stint/a-notes.md', 'x')
  await fresh($)
  expect((await rejoin($, 'nope')).text).toBe('rejoin: no notes for stream "nope" in this folder. Nothing loaded. Notes here: a.')
  expect((await rejoin($, 'a b')).text).toBe('rejoin: too many arguments. Usage: /rejoin [stream]')
  expect((await rejoin($, 'pit')).text).toContain('reserved word')
  await w.clock.advance(5)
  expect(w.submits).toHaveLength(0)
})

test('session start: a hint when notes exist and no stream is bound; none otherwise; gone once bound', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  expect(w.statuses.filter(s => s !== undefined)).toHaveLength(0)

  w.files.set(NOTES, 'x')
  await fresh($)
  expect(lastStatus(w)).toBe('Notes for stream "proj" found: /rejoin proj')
  await title($, 'whatever')
  expect(lastStatus(w)).toBeUndefined()

  await fresh($)
  expect(lastStatus(w)).toBe('Notes for stream "proj" found: /rejoin proj')
  await rejoin($, 'proj')
  expect(lastStatus(w)).toBeUndefined()

  // a bound stream (survives /clear) shows no hint
  await clear($)
  expect(lastStatus(w)).toBeUndefined()
})

// ---------- debug ----------

const DEBUG = { options: { debug: 'on' } }
const settle = () => new Promise(r => setTimeout(r, 30))
type Ev = { t: number; sid?: string; cwd?: string; stream?: string; ev: string; detail: Record<string, unknown> }
const traced = async (w: World): Promise<Ev[]> => {
  await settle()
  return (w.store.get('stint:trace') as Ev[] | undefined) ?? []
}
const names = (evs: Ev[]) => evs.map(e => e.ev)
const debugFiles = (w: World) => [...w.files.keys()].filter(p => p.includes('/.stint/debug-'))
const injected = ($: Engine) => $.prompt.submit({ text: 'notes', origin: { kind: 'plugin', name: 'stint', asUser: true }, wait: false } as never)
const turnStart = ($: Engine) => $.turn.start({ text: 'notes', turnId: 't1' })
// the nominal path up to the fresh session: the host starts it, then the /clear command resolves
const pitAndClear = async ($: Engine, w: World) => {
  await pit($)
  await clear($)
  await w.clock.advance(5)
}

test('debug off: no trace, no report, no timer, the pit is as before', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  await pitAndClear($, w)
  await w.clock.advance(60_000)
  await settle()
  expect(w.store.has('stint:trace')).toBe(false)
  expect(debugFiles(w)).toEqual([])
  expect(w.submits).toHaveLength(1)
  // the pending carries no session id while debug is off
  expect((await pit($, '')).text).toBe('pit: saved .stint/proj-notes.md')
  expect(w.store.get('stint:pending')).not.toHaveProperty('sid')
  // --trace says how to turn it on and writes nothing
  const out = await pit($, '--trace')
  expect(out.text).toContain('debug is off')
  expect(out.text).toContain('/config')
  expect(debugFiles(w)).toEqual([])
})

test('debug on: the nominal path is traced in order, metadata only', { ...DEBUG }, async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  await pitAndClear($, w)
  await injected($)
  await turnStart($)
  const evs = await traced(w)
  const order = names(evs)
  const want = ['module.load', 'session.start', 'pit.start', 'notes.written', 'pending.persisted', 'session.start', 'pending.lookup', 'inject.submit', 'prompt.seen', 'inject.submit', 'clear.run', 'turn.start']
  expect(order[0]).toBe('module.load')
  let at = -1
  for (const ev of want.slice(1)) {
    const i = order.indexOf(ev, at + 1)
    expect(i).toBeGreaterThan(at)
    at = i
  }
  const get = (ev: string, pick: (e: Ev) => boolean = () => true) => evs.find(e => e.ev === ev && pick(e))!
  expect(get('pit.start').detail).toEqual({ cwd: CWD, root: CWD, headroom: { tokens: 10_000, wall: 100_000 } })
  expect(get('pit.start').sid).toBe('sess-1')
  expect(get('notes.written').detail.path).toBe(NOTES)
  expect(typeof get('notes.written').detail.chars).toBe('number')
  expect(get('pending.persisted').detail).toEqual({ ok: true })
  expect(get('clear.run').detail).toEqual({ result: 'resolve' })
  expect(get('session.start', e => e.detail.source === 'clear').detail.source).toBe('clear')
  expect(get('pending.lookup').detail).toMatchObject({ hit: true, source: 'module', storedSid: 'sess-1', sid: 'sess-1' })
  expect(get('prompt.seen').detail.chars).toBeGreaterThan(0)
  // no notes content anywhere in the trace
  expect(JSON.stringify(evs)).not.toContain('ship v2')
  expect(w.toasts.some(t => t.includes('Pit incident'))).toBe(false)
})

test('debug on: turn.start in time means no incident, whatever the clock does after', { ...DEBUG }, async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  await pitAndClear($, w)
  await w.clock.advance(3_000)
  await injected($)
  await turnStart($)
  await w.clock.advance(30_000)
  expect(debugFiles(w)).toEqual([])
  expect(w.toasts.some(t => t.includes('Pit incident'))).toBe(false)
})

test('debug on: no turn.start within 10 s writes the report next to the notes and puts a red sticky line on the board', { ...DEBUG }, async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  await pitAndClear($, w)
  await injected($)
  await w.clock.advance(9_000)
  expect(debugFiles(w)).toEqual([])
  await w.clock.advance(1_500)
  const files = debugFiles(w)
  expect(files).toHaveLength(1)
  expect(files[0]).toMatch(/^\/work\/\.stint\/debug-\d{4}-\d\d-\d\dT[\d-]+Z\.md$/)
  const report = w.files.get(files[0]!) ?? ''
  expect(report).toContain('why: no turn.start')
  expect(report).toContain('- turn.start: MISSING')
  expect(report).toContain('- prompt.seen: reached')
  expect(report).toContain('- pit.start: reached')
  expect(report).not.toContain('ship v2')
  expect(w.toasts.some(t => t.includes(files[0]!))).toBe(true)
  expect(await bandNow($)).toContain('notes not loaded: /rejoin proj - trace saved')
})

test('debug on: a lookup that finds nothing after a persisted pit is traced with its reason and is an incident (stale, other cwd)', { ...DEBUG }, async ($, on) => {
  const stale = world(on, OK())
  await fresh($)
  await pit($)
  await stale.clock.advance(11 * 60 * 1000)
  await clear($)
  const evs = await traced(stale)
  expect(evs.find(e => e.ev === 'pending.lookup')?.detail).toMatchObject({ hit: false, reason: 'stale', storedSid: 'sess-1', sid: 'sess-1' })
  expect(debugFiles(stale)).toHaveLength(1)
  expect(stale.files.get(debugFiles(stale)[0]!)).toContain('why: pending skipped: stale')
  expect(stale.submits).toHaveLength(0)
})

test('debug on: other root between the pit and the clear', { ...DEBUG }, async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  await pit($)
  w.root = '/elsewhere'
  await clear($)
  const evs = await traced(w)
  expect(evs.find(e => e.ev === 'pending.lookup')?.detail).toMatchObject({ hit: false, reason: 'other-root', storedRoot: CWD, root: '/elsewhere' })
  // the report goes next to the notes of the pit, not to the new folder
  expect(debugFiles(w)[0]?.startsWith('/work/.stint/')).toBe(true)
})

test('debug on: a clear with nothing armed is traced as none and is not an incident', { ...DEBUG }, async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  await clear($)
  const evs = await traced(w)
  expect(evs.find(e => e.ev === 'pending.lookup')?.detail).toMatchObject({ hit: false, reason: 'none' })
  expect(debugFiles(w)).toEqual([])
})

test('debug on: a mod reload (module empty, store hit) is traced', { ...DEBUG }, async ($, on) => {
  const w = world(on, OK(), 60 * 1000)
  w.store.set('stint:pending', { text: 'n', createdAt: 0, root: CWD, stream: 'proj', sid: 'old-sid' })
  await clear($)
  const evs = await traced(w)
  expect(names(evs)).toContain('reload.detected')
  expect(evs.find(e => e.ev === 'pending.lookup')?.detail).toMatchObject({ hit: true, source: 'store', storedSid: 'old-sid', sid: 'sess-1' })
})

test('debug on: /pit --trace writes the buffer and returns the path, it never runs a pit', { ...DEBUG }, async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  await settle()
  const out = await pit($, '--trace')
  expect(out.text).toMatch(/^pit: trace saved to \/work\/\.stint\/debug-.*\.md$/)
  const path = (out.text ?? '').replace('pit: trace saved to ', '')
  expect(w.files.get(path)).toContain('why: on demand')
  expect(w.forkPrompts).toHaveLength(0)
  expect(w.files.has(NOTES)).toBe(false)
  expect(w.clears).toBe(0)
})

test('debug on: the ring buffer never grows past 200 events', { ...DEBUG }, async ($, on) => {
  const w = world(on, OK())
  for (let i = 0; i < 230; i++) await fresh($)
  const evs = await traced(w)
  expect(evs).toHaveLength(200)
  expect(evs.at(-1)?.ev).toBe('session.start')
})

// ---------- project root ----------

const SUB = '/work/sub/deep'

test('root: a pit run from a sub-folder writes at the root, and the clear (cwd reset to the root) injects it', async ($, on) => {
  const w = world(on, OK())
  w.cwd = SUB
  await fresh($)
  await pit($)
  expect(w.files.has(NOTES)).toBe(true)
  expect([...w.files.keys()].some(p => p.startsWith(SUB))).toBe(false)
  w.cwd = CWD
  await clear($)
  await w.clock.advance(5)
  expect(w.submits).toHaveLength(1)
  expect(w.toasts.some(t => t.includes('notes not loaded'))).toBe(false)
})

test('root: rejoin from a sub-folder finds the notes at the root, and the start hint lists them', async ($, on) => {
  const w = world(on, OK())
  w.files.set(NOTES, 'stream: proj\ngoal: g\n')
  w.cwd = SUB
  await fresh($)
  expect(await bandNow($)).toContain('/rejoin proj')
  expect((await rejoin($)).text).toBe('rejoin: loading stream "proj" as the first message.')
})

test('root: stale pending shows its reason on the board, a toast and no injection', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  await pit($)
  await w.clock.advance(11 * 60 * 1000)
  await clear($)
  expect(w.submits).toHaveLength(0)
  expect(await bandNow($)).toContain('notes not loaded (stale): /rejoin proj')
  expect(w.toasts.some(t => t.includes('notes not loaded (stale): /rejoin proj'))).toBe(true)
  expect(debugFiles(w)).toEqual([])
})

test('root: a pending from another root shows its reason', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  await pit($)
  w.root = '/other'
  await clear($)
  expect(w.submits).toHaveLength(0)
  expect(await bandNow($)).toContain('notes not loaded (other-root): /rejoin proj')
})

test('root: a normal clear with nothing saved shows nothing', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  await clear($)
  expect(await bandNow($)).not.toContain('notes not loaded')
  expect(w.toasts).toEqual([])
})

test('root: a reload with the pending in the store (root recorded) injects after a clear from the root', async ($, on) => {
  const w = world(on, OK(), 60 * 1000)
  w.store.set('stint:pending', { text: 'n', createdAt: 0, root: CWD, stream: 'proj' })
  w.cwd = CWD
  await clear($)
  await w.clock.advance(5)
  expect(w.submits).toHaveLength(1)
})

test('root: no root from the host falls back to the cwd', async ($, on) => {
  const w = world(on, OK())
  w.cwd = SUB
  w.root = ''
  await fresh($)
  await pit($)
  expect(w.files.has(`${SUB}/.stint/proj-notes.md`)).toBe(true)
})

// ---------- auto-pit (idle trigger) ----------

test('autopitDelayMs: on = 50 min, off = null, an unknown value (even an old on-55m / on-40m) reads as the default', () => {
  expect(autopitDelayMs('on')).toBe(50 * 60_000)
  expect(autopitDelayMs('on-55m')).toBe(50 * 60_000)
  expect(autopitDelayMs('on-40m')).toBe(50 * 60_000)
  expect(autopitDelayMs('off')).toBeNull()
  expect(autopitDelayMs('on-60m')).toBe(50 * 60_000)
  expect(autopitDelayMs(undefined)).toBe(50 * 60_000)
})

const GATE = { mode: 'on', saving: false, turnRunning: false, sinceMs: 50 * 60_000, tokens: 90_000, draft: '', busyAgents: 0 }

test('autopitSkip: every guard names its reason; all clear = null; an unreadable figure skips', () => {
  expect(autopitSkip(GATE)).toBeNull()
  expect(autopitSkip({ ...GATE, mode: 'off' })).toBe('setting is off')
  expect(autopitSkip({ ...GATE, saving: true })).toBe('a pit is already running')
  expect(autopitSkip({ ...GATE, turnRunning: true })).toBe('a turn is running')
  expect(autopitSkip({ ...GATE, sinceMs: AUTOPIT_MAX_AGE_MS })).toBeNull()
  expect(autopitSkip({ ...GATE, sinceMs: AUTOPIT_MAX_AGE_MS + 1 })).toBe('the prompt cache is probably expired')
  expect(autopitSkip({ ...GATE, sinceMs: null })).toBe('the prompt cache is probably expired')
  expect(autopitSkip({ ...GATE, tokens: AUTOPIT_MIN_TOKENS })).toBeNull()
  expect(autopitSkip({ ...GATE, tokens: AUTOPIT_MIN_TOKENS - 1 })).toBe('context below the threshold')
  expect(autopitSkip({ ...GATE, tokens: null })).toBe('context size unknown')
  expect(autopitSkip({ ...GATE, draft: 'half a sent' })).toBe('a draft is in the prompt box')
  expect(autopitSkip({ ...GATE, draft: '  \n' })).toBeNull()
  expect(autopitSkip({ ...GATE, draft: null })).toBe('prompt box unreadable')
  expect(autopitSkip({ ...GATE, busyAgents: 1 })).toBe('agents are running')
  expect(autopitSkip({ ...GATE, busyAgents: null })).toBe('agents unknown')
})

test('autoLine and injectText: the auto variant carries the line and the wait rules, the manual text is unchanged', () => {
  const at = new Date(2026, 9, 29, 14, 5).getTime()
  const line = autoLine({ kind: 'idle', at, idleMin: 50, tokens: 91_400 }, '.stint/proj-notes.md')
  expect(line).toBe('⏸ auto-pit at 14:05 · 50 min idle · 91k → notes .stint/proj-notes.md')
  // a mark stored before `kind` existed reads as idle
  expect(autoLine({ at, idleMin: 50, tokens: 91_400 } as never, '.stint/proj-notes.md')).toBe(line)
  expect(injectText('notes\n')).toBe(`notes\n\n${UNPACK_RULES}`)
  const auto = injectText('notes\n', line)
  expect(auto).toBe(`notes\n\n${autoUnpackRules(line)}`)
  expect(auto).toContain(`exactly this, with nothing before it:\n${line}`)
  expect(auto).toContain('do not resume the task')
  expect(auto).not.toContain(UNPACK_RULES)
  // the idle text is the pass-1 text, byte for byte
  expect(autoUnpackRules('L')).toBe(`Your first line is exactly this, with nothing before it:
L
Then summarize the notes in 3 to 5 short lines: status, goal, what is in progress, the next action.
Then stop and wait for me. The session was saved and cleared while I was away: do not resume the task.
Do nothing without my explicit go — no file read, no command, no sub-agent.
Write a message only when something changes. The rest of the time stay silent.
Questions go to me, in this window.
After my go, read the \`read_first\` files before acting.`)
  expect(autoUnpackRules('L', 'idle')).toBe(autoUnpackRules('L'))
})

test('autoLine and autoUnpackRules: the ceiling variant, and the overwrite warning after the line', () => {
  const at = new Date(2026, 9, 29, 9, 7).getTime()
  const line = autoLine({ kind: 'ceiling', at, tokens: 141_400 }, '.stint/proj-notes.md')
  expect(line).toBe('⛔ auto-pit (ceiling 80%) at 09:07 · 141k → notes .stint/proj-notes.md')
  // the wall can cap the ceiling under the nominal one: the line says the real one
  expect(autoLine({ kind: 'ceiling', at, tokens: 150_400, pct: 75 }, '.stint/proj-notes.md')).toBe('⛔ auto-pit (ceiling 75%) at 09:07 · 150k → notes .stint/proj-notes.md')
  const rules = autoUnpackRules(line, 'ceiling')
  expect(rules).toContain(`exactly this, with nothing before it:\n${line}\nThen summarize`)
  expect(rules).toContain('saved and cleared automatically because the context was nearly full')
  expect(rules).toContain('do not resume the task')
  expect(rules).not.toContain('while I was away')
  expect(rules).toContain('Do nothing without my explicit go')
  const warn = overwriteWarning('proj')
  expect(warn).toBe('⚠️ proj-notes.md was rewritten by another session; its content was merged into these notes and its previous version is in archive/')
  const withWarn = autoUnpackRules(line, 'ceiling', warn)
  expect(withWarn).toContain(`${line}\nThe line right after it is exactly this warning, nothing between them:\n${warn}\nThen summarize`)
  expect(autoUnpackRules('L', 'idle', warn)).toContain('while I was away')
  expect(injectText('n\n', line, 'ceiling', warn)).toBe(`n\n\n${withWarn}`)
})

const CGATE = { mode: 'on', saving: false, turnRunning: false, tokens: 160_000, window: 200_000, draft: '', busyAgents: 0 }

test('ceilingTokens and ceilingPercent: 80% of the window, capped by 90% of the wall, whole % rounded down', () => {
  expect(AUTOPIT_CEILING).toBe(0.8)
  // the wall is far: the window decides
  expect(ceilingTokens(200_000, 200_000)).toBe(160_000)
  expect(ceilingTokens(1_000_000, 967_000)).toBe(800_000)
  expect(ceilingPercent(1_000_000, 967_000)).toBe(80)
  // a 200k window compacts at ~167k: 90% of it is 150.3k = 75%
  expect(ceilingTokens(200_000, 167_000)).toBe(150_300)
  expect(ceilingPercent(200_000, 167_000)).toBe(75)
  // 90% of the wall just over 80% of the window: the window decides; just under: the wall does, and the % rounds down
  expect(ceilingTokens(100_000, 88_889)).toBe(80_000)
  expect(ceilingPercent(100_000, 88_888)).toBe(79)
  expect(ceilingPercent(100_000, 80_000)).toBe(72)
})

test('ceilingSkip: the threshold is 80% of the window, capped by 90% of the wall; every guard names its reason, unreadable skips', () => {
  expect(ceilingSkip(CGATE)).toBeNull()
  expect(ceilingSkip({ ...CGATE, tokens: 159_999 })).toBe('context below the ceiling')
  // the wall caps it: 90% of 167k is 150.3k
  expect(ceilingSkip({ ...CGATE, wall: 167_000, tokens: 150_299 })).toBe('context below the ceiling')
  expect(ceilingSkip({ ...CGATE, wall: 167_000, tokens: 150_300 })).toBeNull()
  // no wall, or an unreadable one: the window stands in
  expect([null, 0, undefined].map(wall => ceilingSkip({ ...CGATE, wall: wall as never, tokens: 159_999 }))).toEqual(['context below the ceiling', 'context below the ceiling', 'context below the ceiling'])
  expect(ceilingSkip({ ...CGATE, tokens: null })).toBe('context size unknown')
  expect(ceilingSkip({ ...CGATE, window: null })).toBe('context size unknown')
  expect(ceilingSkip({ ...CGATE, window: 0 })).toBe('context size unknown')
  expect(ceilingSkip({ ...CGATE, mode: 'off' })).toBe('setting is off')
  expect(ceilingSkip({ ...CGATE, mode: 'on-40m' })).toBeNull()
  expect(ceilingSkip({ ...CGATE, saving: true })).toBe('a pit is already running')
  expect(ceilingSkip({ ...CGATE, turnRunning: true })).toBe('a turn is running')
  expect(ceilingSkip({ ...CGATE, draft: 'half' })).toBe('a draft is in the prompt box')
  expect(ceilingSkip({ ...CGATE, draft: ' \n' })).toBeNull()
  expect(ceilingSkip({ ...CGATE, draft: null })).toBe('prompt box unreadable')
  expect(ceilingSkip({ ...CGATE, busyAgents: 2 })).toBe('agents are running')
  expect(ceilingSkip({ ...CGATE, busyAgents: null })).toBe('agents unknown')
})

test('archiveName and archiveStamp: local YYYYMMDD-HHMM, -2 / -3 before .md', () => {
  const at = new Date(2026, 9, 29, 9, 7).getTime()
  expect(archiveStamp(at)).toBe('20261029-0907')
  expect(archiveName('proj', at)).toBe('proj-notes-20261029-0907.md')
  expect(archiveName('proj', at, 1)).toBe('proj-notes-20261029-0907.md')
  expect(archiveName('proj', at, 3)).toBe('proj-notes-20261029-0907-3.md')
})

const IDLE_MS = 50 * 60_000
const BIG = { tokens: 90_000, wall: 200_000 }
const turnDone = ($: Engine, extra: Record<string, unknown> = {}) => $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...extra } as never)
const typed = ($: Engine) => $.classic.UserPromptSubmit({ prompt: 'x' })
const setAutopit = ($: Engine, value: string) => $.config.set({ key: AUTOPIT_KEY, value, previous: 'on', provider: { plugin: 'stint', tier: 'plugin' }, origin: { kind: 'composer' } } as never)

// A started session on stream "proj", one turn done, the context big.
async function idleWorld($: Engine, on: On) {
  const w = world(on, OK())
  w.usage = BIG
  await fresh($)
  await title($, 'proj')
  await turnDone($)
  return w
}

test('auto-pit: 50 min idle with a big context saves, clears, and the fresh session opens with the auto line and the wait rules', async ($, on) => {
  const w = await idleWorld($, on)
  await w.clock.advance(IDLE_MS - 1)
  expect(w.forkPrompts).toHaveLength(0)
  await w.clock.advance(1)
  expect(w.forkPrompts).toHaveLength(1)
  const notes = w.files.get(NOTES) ?? ''
  expect(notes).toContain('stream: proj')
  expect(w.store.get('stint:pending')).toMatchObject({ stream: 'proj', auto: { kind: 'idle', idleMin: 50, tokens: 90_000 } })
  await w.clock.advance(5)
  expect(w.clears).toBe(1)
  await clear($)
  const line = autoLine({ kind: 'idle', at: 1_000_000 + IDLE_MS, idleMin: 50, tokens: 90_000 }, '.stint/proj-notes.md')
  expect(w.submits).toEqual([`${notes.trimEnd()}\n\n${autoUnpackRules(line)}`])
  expect(w.store.get('stint:pending')).toBeUndefined()
})

test('auto-pit: a prompt before the fire cancels it; the next turn end arms a fresh wait', async ($, on) => {
  const w = await idleWorld($, on)
  await w.clock.advance(IDLE_MS - 60_000)
  await typed($)
  await w.clock.advance(30 * 60_000)
  expect(w.forkPrompts).toHaveLength(0)
  await turnDone($)
  await w.clock.advance(IDLE_MS)
  expect(w.forkPrompts).toHaveLength(1)
})

test('auto-pit: a subagent turn end does not arm or re-arm; only the main loop does', async ($, on) => {
  const w = world(on, OK())
  w.usage = BIG
  await fresh($)
  await turnDone($, { agentId: 'a1' })
  await w.clock.advance(IDLE_MS + 1)
  expect(w.forkPrompts).toHaveLength(0)
  await turnDone($)
  await w.clock.advance(IDLE_MS - 1_000)
  await turnDone($, { agentId: 'a1' })
  await w.clock.advance(1_000)
  expect(w.forkPrompts).toHaveLength(1)
})

test('auto-pit: skipped, never postponed, when the context is under 80k or a draft is typed; running agents make it wait', async ($, on) => {
  const w = await idleWorld($, on)
  w.usage = { tokens: AUTOPIT_MIN_TOKENS - 1, wall: 200_000 }
  await w.clock.advance(IDLE_MS)
  expect(w.forkPrompts).toHaveLength(0)

  w.usage = BIG
  w.draft = 'a half-written question'
  await turnDone($)
  await w.clock.advance(IDLE_MS)
  expect(w.forkPrompts).toHaveLength(0)
  // not postponed: nothing fires later either, and the draft is untouched
  await w.clock.advance(IDLE_MS)
  expect(w.forkPrompts).toHaveLength(0)
  expect(w.clears).toBe(0)

  w.draft = null
  await turnDone($)
  await w.clock.advance(IDLE_MS)
  expect(w.forkPrompts).toHaveLength(0)

  w.draft = ''
  w.agents = [{ id: 'a9', name: 'builder', description: 'writing', type: 'general-purpose', status: 'running' }]
  await turnDone($)
  await w.clock.advance(IDLE_MS)
  expect(w.forkPrompts).toHaveLength(0)

  // an idle teammate is not work in progress: it goes in the notes and the pit runs (here it also releases the wait above)
  w.agents = [{ id: 'a9', name: 'builder', description: 'writing', type: 'general-purpose', status: 'idle' }]
  await turnDone($)
  await w.clock.advance(IDLE_MS)
  expect(w.forkPrompts).toHaveLength(1)
  expect(w.files.get(NOTES)).toContain('agent in flight: builder [a9] idle')
})

test('auto-pit: off never arms; the setting is followed live (on counts from the last turn, off cancels)', async ($, on) => {
  const w = world(on, OK())
  w.usage = BIG
  w.mode = 'off'
  await fresh($)
  await title($, 'proj')
  await turnDone($)
  await w.clock.advance(10 * 60_000)
  expect(w.forkPrompts).toHaveLength(0)

  // 10 min already spent: the 50 min wait ends 40 min from now
  await setAutopit($, 'on')
  await w.clock.advance(40 * 60_000 - 1)
  expect(w.forkPrompts).toHaveLength(0)
  await w.clock.advance(1)
  expect(w.forkPrompts).toHaveLength(1)
  await clear($)
  await w.clock.advance(5)

  // a second period: off before the fire cancels it
  await turnDone($)
  await w.clock.advance(10 * 60_000)
  await setAutopit($, 'off')
  await w.clock.advance(IDLE_MS)
  expect(w.forkPrompts).toHaveLength(1)
})

test('auto-pit: the ready turn of an auto-pit does not arm a second one; the turn after it does', async ($, on) => {
  const w = await idleWorld($, on)
  await w.clock.advance(IDLE_MS + 5)
  await clear($)
  expect(w.submits).toHaveLength(1)
  // the ready turn
  await typed($)
  await turnDone($)
  await w.clock.advance(IDLE_MS * 2)
  expect(w.forkPrompts).toHaveLength(1)
  // the user answers: that turn arms as usual
  await typed($)
  await turnDone($)
  await w.clock.advance(IDLE_MS)
  expect(w.forkPrompts).toHaveLength(2)
})

test('auto-pit: the user comes back while the fork runs: nothing is cleared, nothing pending, the notes file stays', async ($, on) => {
  const w = await idleWorld($, on)
  let release: () => void = () => undefined
  w.gate = new Promise<void>(resolve => (release = resolve))
  await w.clock.advance(IDLE_MS)
  expect(w.forkPrompts).toHaveLength(1)
  await typed($)
  release()
  await w.clock.advance(5)
  expect(w.clears).toBe(0)
  expect(w.store.get('stint:pending')).toBeUndefined()
  await clear($)
  expect(w.submits).toHaveLength(0)
})

test('auto-pit: a failed save (fork blocked) leaves the session as it is and shows the failure', async ($, on) => {
  const w = await idleWorld($, on)
  w.forkText = 'GATE: blocked - mid synthesis'
  await w.clock.advance(IDLE_MS + 5)
  expect(w.clears).toBe(0)
  expect(w.files.has(NOTES)).toBe(false)
  expect(w.toasts.some(t => t.includes('failed'))).toBe(true)
})

test('auto-pit: /clear and a new session reset the idle clock; the manual /pit is untouched by the setting', async ($, on) => {
  const w = await idleWorld($, on)
  await clear($)
  await w.clock.advance(IDLE_MS * 2)
  expect(w.forkPrompts).toHaveLength(0)
  w.mode = 'off'
  const out = await pit($)
  expect(out.text).toBe('pit: saved .stint/proj-notes.md')
  await w.clock.advance(5)
  expect(w.clears).toBe(1)
  await clear($)
  expect(w.submits).toEqual([injectText(w.files.get(NOTES) ?? '')])
})

// ---------- auto-pit (ceiling trigger) ----------

// 80% of a 90k window: the ceiling is met, the idle trigger (80k) is not, so one trigger is tested at a time.
const CEIL = { tokens: 72_000, wall: 90_000, window: 90_000 }
const dirOf = (w: World) => `${w.root ?? CWD}/.stint/archive`
const archived = (w: World) => [...w.files.keys()].filter(p => p.includes('/.stint/archive/')).sort()

async function ceilWorld($: Engine, on: On) {
  const w = world(on, OK())
  w.usage = CEIL
  await fresh($)
  await title($, 'proj')
  return w
}

test('ceiling: fires right after a turn at 80% and not under it; the fresh session opens with the ceiling line and the wait rules', async ($, on) => {
  const w = await ceilWorld($, on)
  w.usage = { ...CEIL, tokens: 71_999 }
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(0)

  w.usage = CEIL
  await typed($)
  await turnDone($)
  expect(w.forkPrompts).toHaveLength(0)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(1)
  const notes = w.files.get(NOTES) ?? ''
  expect(notes).toContain('stream: proj')
  expect(w.store.get('stint:pending')).toMatchObject({ stream: 'proj', auto: { kind: 'ceiling', tokens: 72_000, pct: 80 } })
  expect(w.store.get('stint:pending')).not.toHaveProperty('warn')
  await w.clock.advance(5)
  expect(w.clears).toBe(1)
  await clear($)
  const line = autoLine({ kind: 'ceiling', at: 1_000_000, tokens: 72_000, pct: 80 }, '.stint/proj-notes.md')
  expect(line).toMatch(/^⛔ auto-pit \(ceiling 80%\) at \d\d:\d\d · 72k → notes \.stint\/proj-notes\.md$/)
  expect(w.submits).toEqual([`${notes.trimEnd()}\n\n${autoUnpackRules(line, 'ceiling')}`])
})

test('ceiling: a draft skips it, it retries only at the next turn end and never fires later by timer', async ($, on) => {
  const w = await ceilWorld($, on)
  w.draft = 'half a sentence'
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(0)
  w.draft = ''
  await w.clock.advance(IDLE_MS * 2)
  expect(w.forkPrompts).toHaveLength(0)
  expect(w.clears).toBe(0)
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(1)
})

test('ceiling: skipped on a busy agent, an unreadable prompt box, unreadable usage; an idle teammate does not block', async ($, on) => {
  const w = await ceilWorld($, on)
  w.agents = [{ id: 'a9', name: 'builder', description: 'writing', type: 'general-purpose', status: 'running' }]
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(0)

  w.agents = []
  w.draft = null
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(0)

  w.draft = ''
  w.usage = 'throws'
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(0)

  w.usage = CEIL
  w.agents = [{ id: 'a9', name: 'builder', description: 'writing', type: 'general-purpose', status: 'idle' }]
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(1)
  expect(w.files.get(NOTES)).toContain('agent in flight: builder [a9] idle')
})

test('ceiling: a subagent turn end does not trigger it', async ($, on) => {
  const w = await ceilWorld($, on)
  await turnDone($, { agentId: 'a1' })
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(0)
})

test('ceiling: the ready turn of a ceiling pit does not re-trigger; the next turn does', async ($, on) => {
  const w = await ceilWorld($, on)
  await turnDone($)
  await w.clock.advance(5)
  await w.clock.advance(5)
  await clear($)
  expect(w.forkPrompts).toHaveLength(1)
  expect(w.submits).toHaveLength(1)
  // the ready turn: the usage is still high, nothing fires
  await typed($)
  await turnDone($)
  await w.clock.advance(IDLE_MS * 2)
  expect(w.forkPrompts).toHaveLength(1)
  // the turn after it triggers as usual
  await typed($)
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(2)
})

test('ceiling: the ready turn of an idle pit triggers neither the ceiling nor a new idle wait', async ($, on) => {
  const w = await idleWorld($, on)
  await w.clock.advance(IDLE_MS + 5)
  await clear($)
  expect(w.forkPrompts).toHaveLength(1)
  w.usage = { tokens: 160_000, wall: 200_000 }
  await typed($)
  await turnDone($)
  await w.clock.advance(IDLE_MS * 2)
  expect(w.forkPrompts).toHaveLength(1)
  // control: the next turn end does fire the ceiling at 80%
  await typed($)
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(2)
})

test('ceiling: idle and ceiling never both fire, a ceiling pit cancels the idle wait', async ($, on) => {
  const w = world(on, OK())
  // 85k of 100k: over the ceiling and over the idle threshold
  w.usage = { tokens: 85_000, wall: 100_000, window: 100_000 }
  await fresh($)
  await title($, 'proj')
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(1)
  expect(w.store.get('stint:pending')).toMatchObject({ auto: { kind: 'ceiling' } })
  // no /clear reached the mod: only the cancelled idle timer could still fire
  await w.clock.advance(IDLE_MS * 2)
  expect(w.forkPrompts).toHaveLength(1)
})

test('ceiling: the wall caps it under 80% on a 200k window; the mark and the line say the real %', async ($, on) => {
  const w = world(on, OK())
  // the host compacts at 167k: 90% of it is 150.3k, 75% of the window
  w.usage = { tokens: 150_299, wall: 167_000 }
  await fresh($)
  await title($, 'proj')
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(0)

  w.usage = { tokens: 150_300, wall: 167_000 }
  await typed($)
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(1)
  expect(w.store.get('stint:pending')).toMatchObject({ auto: { kind: 'ceiling', tokens: 150_300, pct: 75 } })
})

test('setting: an unknown value (on-40m) reads as the default on, 50 min', async ($, on) => {
  const w = world(on, OK())
  w.mode = 'on-40m'
  w.usage = BIG
  await fresh($)
  await title($, 'proj')
  await turnDone($)
  await w.clock.advance(40 * 60_000 + 5)
  expect(w.forkPrompts).toHaveLength(0)
  await w.clock.advance(10 * 60_000)
  expect(w.forkPrompts).toHaveLength(1)
})

test('setting: off disables both triggers', async ($, on) => {
  const off = world(on, OK())
  off.mode = 'off'
  off.usage = { tokens: 170_000, wall: 200_000 }
  await fresh($)
  await title($, 'proj')
  await turnDone($)
  await off.clock.advance(IDLE_MS * 2)
  expect(off.forkPrompts).toHaveLength(0)
  expect(off.clears).toBe(0)
})

// ---------- notes archive ----------

test('archive: three writes leave two archive files with the previous contents; the first write archives nothing', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  await pit($)
  const n1 = w.files.get(NOTES) ?? ''
  expect(archived(w)).toEqual([])
  await w.clock.advance(60_000)
  expect((await pit($)).text).toBe('pit: saved .stint/proj-notes.md')
  const n2 = w.files.get(NOTES) ?? ''
  await w.clock.advance(60_000)
  expect((await pit($)).text).toBe('pit: saved .stint/proj-notes.md')
  const n3 = w.files.get(NOTES) ?? ''
  expect(new Set([n1, n2, n3]).size).toBe(3)
  const first = `${dirOf(w)}/${archiveName('proj', 1_060_000)}`
  const second = `${dirOf(w)}/${archiveName('proj', 1_120_000)}`
  expect(archived(w)).toEqual([first, second].sort())
  expect(w.files.get(first)).toBe(n1)
  expect(w.files.get(second)).toBe(n2)
  expect(first).toMatch(/\/\.stint\/archive\/proj-notes-\d{8}-\d{4}\.md$/)
})

test('archive: a same-minute collision adds -2, -3 and overwrites nothing', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  await pit($)
  const n1 = w.files.get(NOTES) ?? ''
  await pit($)
  const n2 = w.files.get(NOTES) ?? ''
  await pit($)
  const base = `${dirOf(w)}/${archiveName('proj', 1_000_000)}`
  const two = base.replace(/\.md$/, '-2.md')
  expect(archived(w)).toEqual([base, two].sort())
  expect(w.files.get(base)).toBe(n1)
  expect(w.files.get(two)).toBe(n2)
  const n3 = w.files.get(NOTES) ?? ''
  await pit($)
  expect(w.files.get(base.replace(/\.md$/, '-3.md'))).toBe(n3)
  expect(w.files.get(base)).toBe(n1)
  expect(w.files.get(two)).toBe(n2)
})

test('archive: a failed archive write blocks the pit and overwrites nothing', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  await pit($)
  await w.clock.advance(5)
  const n1 = w.files.get(NOTES)
  w.failArchive = true
  const out = await pit($)
  expect(out.text).toContain('could not save stream "proj"')
  expect(out.text).toContain('previous notes not archived')
  expect(out.text).toContain('No /clear run')
  expect(w.files.get(NOTES)).toBe(n1)
  await w.clock.advance(5)
  expect(w.clears).toBe(1)
})

test('archive: the listing ignores the archive directory and the archived files (hint, rejoin)', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  await pit($)
  await w.clock.advance(60_000)
  await pit($)
  expect(archived(w)).toHaveLength(1)
  // the mock listing of .stint now returns archive as a 'dir' entry next to proj-notes.md
  await fresh($)
  expect(lastStatus(w)).toBe('Notes for stream "proj" found: /rejoin proj')
  expect((await rejoin($, 'nope')).text).toBe('rejoin: no notes for stream "nope" in this folder. Nothing loaded. Notes here: proj.')
  expect((await rejoin($)).text).toBe('rejoin: loading stream "proj" as the first message.')
})

// ---------- overwrite warning ----------

const WARN = overwriteWarning('proj')

test('overwrite warning: shown on a manual pit after another session rewrote the file; the old version is archived', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  await pit($)
  await w.clock.advance(60_000)
  w.files.set(NOTES, 'stream: proj\ngoal: written elsewhere\n')
  const out = await pit($)
  expect(out.text).toBe(`pit: saved .stint/proj-notes.md\n${WARN}`)
  expect(w.forkPrompts.at(-1)).toContain('goal: written elsewhere')
  expect(w.files.get(`${dirOf(w)}/${archiveName('proj', 1_060_000)}`)).toBe('stream: proj\ngoal: written elsewhere\n')
  // the pit that follows is by the same session over its own file: no warning
  await w.clock.advance(60_000)
  expect((await pit($)).text).toBe('pit: saved .stint/proj-notes.md')
})

test('overwrite warning: no baseline, no warning; a read by rejoin is a baseline; /clear keeps it, a new session drops it', async ($, on) => {
  const w = world(on, OK())
  w.files.set(NOTES, 'stream: proj\ngoal: old\n')
  await fresh($)
  expect((await pit($)).text).toBe('pit: saved .stint/proj-notes.md')

  // new session: file rewritten elsewhere, no baseline
  await fresh($)
  w.files.set(NOTES, 'stream: proj\ngoal: elsewhere 1\n')
  expect((await pit($)).text).toBe('pit: saved .stint/proj-notes.md')

  // rejoin reads the file: baseline
  await fresh($)
  w.files.set(NOTES, 'stream: proj\ngoal: elsewhere 2\n')
  await rejoin($, 'proj')
  await w.clock.advance(5)
  w.files.set(NOTES, 'stream: proj\ngoal: elsewhere 3\n')
  expect((await pit($)).text).toBe(`pit: saved .stint/proj-notes.md\n${WARN}`)

  // /clear keeps the baseline
  await w.clock.advance(5)
  await clear($)
  w.files.set(NOTES, 'stream: proj\ngoal: elsewhere 4\n')
  expect((await pit($)).text).toBe(`pit: saved .stint/proj-notes.md\n${WARN}`)

  // startup drops it
  await fresh($)
  w.files.set(NOTES, 'stream: proj\ngoal: elsewhere 5\n')
  expect((await pit($)).text).toBe('pit: saved .stint/proj-notes.md')
})

test('overwrite warning: an auto-pit carries it in the pending and the fresh session is told to show it right after the line', async ($, on) => {
  const w = await ceilWorld($, on)
  w.usage = { ...CEIL, tokens: 10_000 }
  await pit($)
  await w.clock.advance(5)
  await clear($)
  w.files.set(NOTES, 'stream: proj\ngoal: written elsewhere\n')
  w.usage = CEIL
  await typed($)
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(2)
  expect(w.store.get('stint:pending')).toMatchObject({ auto: { kind: 'ceiling' }, warn: WARN })
  await w.clock.advance(5)
  await clear($)
  const sent = w.submits.at(-1) ?? ''
  expect(sent).toMatch(/^[\s\S]*\nThe line right after it is exactly this warning, nothing between them:\n/)
  expect(sent).toContain(`\n${WARN}\nThen summarize`)
  expect(sent).toContain('saved and cleared automatically because the context was nearly full')
})

// ---------- startup notice ----------

const NOTICE = 'idleCompaction is on: it overlaps the auto-pit idle trigger; /config to turn it off'

test('startup notice: shown at startup and resume when the host row idleCompaction is on', async ($, on) => {
  const w = world(on, OK())
  w.idleRow = { key: 'idleCompaction', label: 'Idle compaction', value: true }
  await fresh($)
  expect(w.toasts).toEqual([NOTICE])
  await $.classic.SessionStart({ source: 'resume' })
  expect(w.toasts).toEqual([NOTICE, NOTICE])
})

test('startup notice: the row is also matched on its label', async ($, on) => {
  const l = world(on, OK())
  l.idleRow = { key: 'somethingElse', label: 'Idle compaction (minutes)', value: true }
  await fresh($)
  expect(l.toasts).toEqual([NOTICE])
})

const hidden = (name: string, setup: (w: World) => void, start = fresh) =>
  test(`startup notice: hidden when ${name}`, async ($, on) => {
    const w = world(on, OK())
    setup(w)
    await start($)
    expect(w.toasts).toEqual([])
  })

hidden('the row is false', w => (w.idleRow = { key: 'idleCompaction', label: 'Idle compaction', value: false }))
hidden('the row is absent', () => undefined)
hidden('the row is unreadable', w => (w.idleRow = 'throws'))
hidden('the auto-pit mode is off', w => {
  w.mode = 'off'
  w.idleRow = { key: 'idleCompaction', label: 'Idle compaction', value: true }
})
hidden('the source is clear', w => (w.idleRow = { key: 'idleCompaction', label: 'Idle compaction', value: true }), clear)

// ---------- /pit --save (a checkpoint: the notes without the /clear) ----------

test('parseArgs: --save is a flag of /pit, with or without a stream, in any place; /rejoin does not take it', () => {
  expect(parseArgs('--save', 'pit')).toEqual({ save: true })
  expect(parseArgs('proj --save', 'pit')).toEqual({ stream: 'proj', save: true })
  expect(parseArgs('--save proj', 'pit')).toEqual({ stream: 'proj', save: true })
  expect(parseArgs('--save --save', 'pit')).toEqual({ save: true })
  expect(parseArgs('proj', 'pit')).toEqual({ stream: 'proj' })
  expect(parseArgs('', 'pit')).toEqual({})
  expect(parseArgs('--save a b', 'pit')).toEqual({ error: 'too many arguments. Usage: /pit [stream]' })
  expect(parseArgs('--save --nope', 'pit')).toEqual({ error: 'unknown option --nope. Usage: /pit [stream]' })
  // a bare `save` is a stream name, which is why the flag has dashes
  expect(parseArgs('save', 'pit')).toEqual({ stream: 'save' })
  expect(parseArgs('--save', 'rejoin')).toEqual({ error: 'unknown option --save. Usage: /rejoin [stream]' })
})

test('/pit --save: the slash menu hint shows [stream] [--save] [--trace]; /rejoin keeps [stream]', () => {
  expect(COMMANDS.find(c => c.name === 'pit')?.argumentHint).toBe('[stream] [--save] [--trace]')
  expect(COMMANDS.find(c => c.name === 'rejoin')?.argumentHint).toBe('[stream]')
  expect(COMMANDS.find(c => c.name === 'pit')?.description).toContain('--save')
})

test('/pit --save: notes written, no /clear, no pending, nothing injected, the context is untouched', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  const out = await pit($, 'proj --save')
  expect(out.text).toBe('pit: saved .stint/proj-notes.md (no clear)')
  expect(w.files.get(NOTES)).toContain('goal: ship v2')
  expect(w.forkPrompts).toHaveLength(1)
  // the board says so for a moment, then is free again
  expect(await bandNow($)).toContain('notes saved')
  await w.clock.advance(60_000)
  expect(await bandNow($)).not.toContain('notes saved')
  expect(w.clears).toBe(0)
  expect(w.store.get('stint:pending')).toBeUndefined()
  await clear($)
  expect(w.submits).toHaveLength(0)
})

test('/pit --save: binds the stream like /pit <stream>; without a stream it uses the bound one or main', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  expect((await pit($, '--save')).text).toBe('pit: saved .stint/main-notes.md (no clear)')
  await pit($, 'proj --save')
  // bound for the session, saves and pits alike
  expect((await pit($, '--save')).text).toBe('pit: saved .stint/proj-notes.md (no clear)')
  expect((await pit($, '')).text).toBe('pit: saved .stint/proj-notes.md')
  expect(w.files.has('/work/.stint/main-notes.md')).toBe(true)
})

test('/pit --save: the stint number of the notes stays; the next real pit hands over to the next one', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  await pit($, 'proj --save')
  expect(parseNotes(w.files.get(NOTES) ?? '').scalars.stint).toBe('1')
  await pit($, 'proj --save')
  expect(parseNotes(w.files.get(NOTES) ?? '').scalars.stint).toBe('1')
  await pit($, 'proj')
  expect(parseNotes(w.files.get(NOTES) ?? '').scalars.stint).toBe('2')
  await pit($, 'proj --save')
  expect(parseNotes(w.files.get(NOTES) ?? '').scalars.stint).toBe('2')
})

test('/pit --save: archives the previous notes like a pit, and warns when another session rewrote the file', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  await pit($, 'proj --save')
  const first = w.files.get(NOTES) ?? ''
  const second = await pit($, 'proj --save')
  expect(second.text).toBe('pit: saved .stint/proj-notes.md (no clear)')
  const archived = [...w.files.keys()].filter(k => k.startsWith('/work/.stint/archive/proj-notes-'))
  expect(archived).toHaveLength(1)
  expect(w.files.get(archived[0] as string)).toBe(first)
  // another session rewrites the live file: this session's baseline no longer matches
  w.files.set(NOTES, 'stream: proj\nsaved: elsewhere\n')
  const third = await pit($, 'proj --save')
  expect(third.text).toContain('pit: saved .stint/proj-notes.md (no clear)\n⚠️ proj-notes.md was rewritten by another session')
  // the save updated the baseline: the next one is quiet
  expect((await pit($, 'proj --save')).text).toBe('pit: saved .stint/proj-notes.md (no clear)')
})

test('/pit --save: refused at 95% of the wall like a pit; a blocked fork reports a failed save and keeps the session', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  w.usage = { tokens: 95_000, wall: 100_000 }
  expect((await pit($, 'proj --save')).text).toContain('pit: context is at 95%')
  expect(w.forkPrompts).toHaveLength(0)
  w.usage = TOKENS
  w.forkText = 'GATE: blocked - mid synthesis'
  const out = await pit($, 'proj --save')
  expect(out.text).toBe('pit: could not save stream "proj": mid synthesis. No /clear run, the session is unchanged.')
  expect(lastStatus(w)).toMatch(/^⚠ Save of stream "proj" failed/)
  expect(w.files.has(NOTES)).toBe(false)
  await w.clock.advance(5)
  expect(w.clears).toBe(0)
})

test('/pit --save: a second save, or a pit, while one runs is refused: one write only', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  let release: () => void = () => undefined
  w.gate = new Promise<void>(resolve => (release = resolve))
  const first = pit($, 'proj --save')
  await w.clock.advance(1)
  const again = await pit($, 'proj --save')
  expect(again.text).toContain('a pit is already running')
  const manual = await pit($, 'proj')
  expect(manual.text).toContain('a pit is already running')
  release()
  expect((await first).text).toBe('pit: saved .stint/proj-notes.md (no clear)')
  expect(w.forkPrompts).toHaveLength(1)
  expect([...w.files.keys()].filter(k => k.includes('/archive/'))).toHaveLength(0)
})

test('/pit --save and auto-pit: a save leaves the idle wait on its original deadline, even when the slash command was seen as a prompt', async ($, on) => {
  const w = await idleWorld($, on)
  await w.clock.advance(10 * 60_000)
  // the host may raise classic.UserPromptSubmit for the slash command: that cancels the timer and raises the turn flag
  await typed($)
  await pit($, 'proj --save')
  expect(w.forkPrompts).toHaveLength(1)
  await w.clock.advance(IDLE_MS - 10 * 60_000 - 1)
  expect(w.forkPrompts).toHaveLength(1)
  await w.clock.advance(1)
  expect(w.forkPrompts).toHaveLength(2)
  await w.clock.advance(5)
  expect(w.clears).toBe(1)
})

test('/pit --save and auto-pit: an auto-pit that fires during a save skips, and is not retried right after: the user is at the keyboard', async ($, on) => {
  const w = await idleWorld($, on)
  let release: () => void = () => undefined
  w.gate = new Promise<void>(resolve => (release = resolve))
  await w.clock.advance(IDLE_MS - 1_000)
  const saveRun = pit($, 'proj --save')
  await w.clock.advance(1_000)
  // the idle wait ended while the save's fork was still out: no second fork, no clear
  expect(w.forkPrompts).toHaveLength(1)
  release()
  await saveRun
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(1)
  expect(w.clears).toBe(0)
  expect(w.store.get('stint:pending')).toBeUndefined()
})

// ---------- pit waits for agents ----------

const BUSY = { id: 'a9', name: 'builder', description: 'writing', type: 'general-purpose', status: 'running' }
const WAIT_IDLE = '⏳ auto-pit waits for agents'
const WAIT_ONE = '⏳ pit waits for 1 agent(s)'
const submitOf = ($: Engine, prompt: string, extra: Record<string, unknown> = {}) => $.classic.UserPromptSubmit({ prompt, ...extra } as never)

// The idle timer fired with a busy agent.
async function idleWaiting($: Engine, on: On) {
  const w = await idleWorld($, on)
  w.agents = [BUSY]
  await w.clock.advance(IDLE_MS)
  return w
}

test('wait: the idle fire with a running agent does not skip, it waits and shows it; the turn end with no agent pits', async ($, on) => {
  const w = await idleWaiting($, on)
  expect(w.forkPrompts).toHaveLength(0)
  expect(lastStatus(w)).toBe(WAIT_IDLE)
  expect(await bandNow($)).toContain('auto-pit waits for agents')
  w.agents = []
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(1)
  expect(w.store.get('stint:pending')).toMatchObject({ stream: 'proj', auto: { kind: 'idle' } })
  await w.clock.advance(5)
  expect(w.clears).toBe(1)
  // the armed idle timer of that turn end is gone: no second pit later
  await w.clock.advance(IDLE_MS * 2)
  expect(w.forkPrompts).toHaveLength(1)
})

test('wait: a turn end with the agent still busy keeps waiting, the line stays', async ($, on) => {
  const w = await idleWaiting($, on)
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(0)
  expect(lastStatus(w)).toBe(WAIT_IDLE)
  w.agents = []
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(1)
})

test('wait: the line goes once the pit starts (the pit shows its own flow)', async ($, on) => {
  const w = await idleWaiting($, on)
  w.agents = []
  await turnDone($)
  await w.clock.advance(5)
  expect(w.statuses).toContain('Starting a fresh session...')
})

test('wait: a prompt cancels the idle wait and its line', async ($, on) => {
  const w = await idleWaiting($, on)
  await typed($)
  expect(lastStatus(w)).not.toBe(WAIT_IDLE)
  w.agents = []
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(0)
})

test('wait: a prompt of the host itself (a task notification) does not cancel it', async ($, on) => {
  const w = await idleWaiting($, on)
  await submitOf($, 'agent a9 finished', { source: 'system' })
  expect(lastStatus(w)).toBe(WAIT_IDLE)
  w.agents = []
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(1)
})

test('wait: /clear (a new context) cancels the idle wait', async ($, on) => {
  const w = await idleWaiting($, on)
  await clear($)
  expect(lastStatus(w)).not.toBe(WAIT_IDLE)
  w.agents = []
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(0)
})

test('wait: the setting going off cancels the idle wait', async ($, on) => {
  const w = await idleWaiting($, on)
  w.mode = 'off'
  await setAutopit($, 'off')
  expect(lastStatus(w)).not.toBe(WAIT_IDLE)
  w.agents = []
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(0)
})

test('wait: the idle wait re-reads every guard at the release (a draft skips)', async ($, on) => {
  const w = await idleWaiting($, on)
  w.agents = []
  w.draft = 'half a sentence'
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(0)
  expect(w.clears).toBe(0)
})

test('wait: /pit with a running agent is queued, a second /pit is not a force, the turn end with no agent runs it', async ($, on) => {
  const w = world(on, OK())
  w.agents = [BUSY]
  await fresh($)
  const first = await pit($)
  expect(first.text).toBe('pit: 1 agent(s) still running. Waiting: the pit runs when they are done.')
  expect(lastStatus(w)).toBe(WAIT_ONE)
  expect(await bandNow($)).toContain('pit waits for 1 agent(s)')
  expect(w.forkPrompts).toHaveLength(0)
  const second = await pit($)
  expect(second.text).toBe('pit: already waiting for 1 agent(s)...')
  expect(w.forkPrompts).toHaveLength(0)
  // still busy at a turn end: the line stays
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(0)
  w.agents = []
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(1)
  expect(w.files.get(NOTES)).toContain('stream: proj')
  await w.clock.advance(5)
  expect(w.clears).toBe(1)
  await clear($)
  expect(w.submits).toEqual([injectText(w.files.get(NOTES) ?? '')])
})

test('wait: a queued /pit keeps its stream argument and the session binding', async ($, on) => {
  const w = world(on, OK())
  w.agents = [BUSY]
  await fresh($)
  await pit($, 'other')
  w.agents = []
  await turnDone($)
  await w.clock.advance(5)
  expect(w.files.has('/work/.stint/other-notes.md')).toBe(true)
})

test('wait: a prompt cancels a queued /pit', async ($, on) => {
  const w = world(on, OK())
  w.agents = [BUSY]
  await fresh($)
  await pit($)
  await typed($)
  expect(lastStatus(w)).not.toBe(WAIT_ONE)
  w.agents = []
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(0)
})

test('wait: /clear cancels a queued /pit', async ($, on) => {
  const w = world(on, OK())
  w.agents = [BUSY]
  await fresh($)
  await pit($)
  await clear($)
  w.agents = []
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(0)
})

test('wait: the host may raise the prompt event of the /pit command itself, before or after command.run: the queue holds either way', async ($, on) => {
  const w = world(on, OK())
  w.agents = [BUSY]
  await fresh($)
  // after command.run
  await pit($)
  await submitOf($, '/pit proj')
  expect(lastStatus(w)).toBe(WAIT_ONE)
  // before command.run: nothing queued yet, then a second /pit is still not a force
  await submitOf($, '/pit proj')
  expect((await pit($)).text).toBe('pit: already waiting for 1 agent(s)...')
  w.agents = []
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(1)
})

test('wait: /pit --save with a running agent runs now, and leaves a queued /pit queued', async ($, on) => {
  const w = world(on, OK())
  w.agents = [BUSY]
  await fresh($)
  const saved = await pit($, 'proj --save')
  expect(saved.text).toBe('pit: saved .stint/proj-notes.md (no clear)')
  expect(w.forkPrompts).toHaveLength(1)
  await pit($)
  await pit($, 'proj --save')
  expect(w.forkPrompts).toHaveLength(2)
  expect(w.clears).toBe(0)
  // the save's own flow reset took the line; it comes back once the save's outcome is gone
  await w.clock.advance(3000)
  expect(lastStatus(w)).toBe(WAIT_ONE)
  w.agents = []
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(3)
})

test('wait: an unknown agent list does not wait, /pit goes on as before', async ($, on) => {
  const w = world(on, OK())
  w.agentsDown = true
  await fresh($)
  const out = await pit($)
  expect(out.text).toBe('pit: saved .stint/proj-notes.md')
  await w.clock.advance(5)
  expect(w.clears).toBe(1)
})

test('wait: agents gone when /pit is typed: it pits now', async ($, on) => {
  const w = world(on, OK())
  await fresh($)
  const out = await pit($)
  expect(out.text).toBe('pit: saved .stint/proj-notes.md')
})

test('wait: a draft at the release drops the queued /pit with a toast, nothing saved; an unreadable box too', async ($, on) => {
  const w = world(on, OK())
  w.agents = [BUSY]
  await fresh($)
  await pit($)
  w.agents = []
  w.draft = 'half a sentence'
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(0)
  expect(w.clears).toBe(0)
  expect(w.toasts.some(t => t.includes('a draft is in the prompt box'))).toBe(true)
  expect(lastStatus(w)).not.toBe(WAIT_ONE)
  // dropped: a later turn end does not run it
  w.draft = ''
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(0)

  w.agents = [BUSY]
  await pit($)
  w.agents = []
  w.draft = null
  await turnDone($)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(0)
  expect(w.toasts.some(t => t.includes('prompt box is unreadable'))).toBe(true)
})

test('wait: a release does not also fire the ceiling trigger: one pit only', async ($, on) => {
  const w = await ceilWorld($, on)
  w.agents = [BUSY]
  await pit($)
  expect(w.forkPrompts).toHaveLength(0)
  w.agents = []
  await turnDone($)
  await w.clock.advance(5)
  await w.clock.advance(5)
  expect(w.forkPrompts).toHaveLength(1)
  expect(w.store.get('stint:pending')).not.toHaveProperty('auto')
})
