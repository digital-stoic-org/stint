import type { EngineInterface, On } from 'claude-code'

import { pitDone, pitStart, refresh as refreshDash, setLap, thresholdsOf } from './dash.ts'
import { RULE_TEXT, captureCkpt, checkpointOn, claudeMdHasRule, hasPhase, journalPath, journalRule, readJournal, withRule } from './checkpoint.ts'
import { NOTES_DIR, forbiddenStream, modeOf, otherMode, readNotes, streamDirNames, streamPaths } from './paths.ts'
import type { Mode } from './paths.ts'
import { CREW_STORE, addSample, crewOn, crewText, numbersOf, promptTokens, withCrew } from './crew.ts'
import { debugOn, sidNow, startWatch, stopWatch, trace, writeReport } from './debug.ts'
import { AUTOPIT_CEILING, AUTOPIT_MIN_TOKENS, getAutopitInfo, getIdleFire, setAutopitInfo, setIdleFire, setPitBoard, setPitLine, writeStatus } from './status.ts'
import type { AutopitInfo } from './status.ts'
import { ARCHIVE_TRIES, archiveName, autoStreamOf, COMMANDS, notesPath, overWall, parseArgs, RESERVED, resolveStream, slugify, STREAM_RE, streamsFromNames } from './streams.ts'
import { autoLine, AUTOPIT_DEFAULT, AUTOPIT_KEY, AUTOPIT_SHOW_AFTER_MS, autopitDelayMs, autopitSkip, boardProgress, CEILING_BELOW, ceilingPercent, ceilingSkip, elapsed, hintBoard, hintText, PHASE_FOLLOW_TURNS, phaseHintText, progressText, savedBoard, shortReason } from './autopit.ts'
import type { AutoKind, AutoMark, CeilingGate } from './autopit.ts'
import { agentLinesOf, AGENTS_UNKNOWN, assemble, parseFork, parseForkBody, stintOf, takeEntries } from './notes.ts'
import type { AgentLike, Keyed } from './notes.ts'
import { forkFailure, forkPrompt, injectText, overwriteWarning, UNPACK_RULES } from './prompts.ts'

export { AUTOPIT_CEILING, AUTOPIT_MIN_TOKENS, NOTES_DIR }
// The pure parts moved out of this file (LS); everything they export stays importable from here.
export * from './streams.ts'
export * from './autopit.ts'
export * from './notes.ts'
export * from './prompts.ts'

// pit (stint): one mod, two commands.
//   /pit [stream]      save notes (awaited fork) -> /clear (automatic) -> notes re-injected as the first message of the fresh context
//   /rejoin [stream]   notes of a stream -> first message of this session
// Notes live in <session root>/.stint/<stream>-notes.md (paths.ts holds the per-stream layout, behind the `lifecycle` opt-in). One $.model.fork designates every field; code parses, assembles and caps the file.
// Command names: `$.command.register` takes letters, digits, `_` and `-` only (CommandSpec.name), so no `stint:pit`: the commands are /pit and /rejoin.

const STORE_KEY = 'stint:pending'
const STALE_MS = 10 * 60 * 1000
// $.agent.list() is raced against this: a hang would leave a pit stuck without a word.
const AGENT_LIST_MS = 5_000
const ERROR_TOAST_MS = 12_000

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
// The phase hint (0.4.0): board only (empty status), the lowest of pit's lines. Shown after an answer with `phase:` at a fill from the dash soft zone on (thresholdsOf(window).soft tokens), gone at the next prompt, the next answer and every session start.
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
    const root = await rootNow($)
    const entries = await $.fs.list(`${root.replace(/\/+$/, '')}/${NOTES_DIR}`)
    const flat = streamsFromNames(entries.filter(e => e.kind === 'file').map(e => e.name))
    // The per-stream layout: a folder counts only when it holds a notes.md (a stream folder with just work/ is no stream).
    const dirs = streamDirNames(entries.filter(e => e.kind === 'dir').map(e => e.name), name => STREAM_RE.test(name) && !RESERVED.includes(name))
    const nested: string[] = []
    for (const name of dirs) if (await $.fs.exists(streamPaths(root, name, 'on').notes)) nested.push(name)
    return nested.length === 0 ? flat : [...new Set([...flat, ...nested])].sort()
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

// Copies the previous notes to <root>/.stint/archive/<stream>-notes-<YYYYMMDD-HHMM>.md (on: <root>/.stint/<stream>/archive/); a name already taken gets -2, -3... Never overwrites, never prunes.
async function archivePrev($: EngineInterface, cwd: string, stream: string, prev: string, ms: number, mode: Mode): Promise<string> {
  const dir = streamPaths(cwd, stream, mode).archive
  for (let n = 1; n <= ARCHIVE_TRIES; n++) {
    const path = `${dir}/${archiveName(stream, ms, n)}`
    if (await $.fs.exists(path)) continue
    await $.fs.write(path, prev)
    return path
  }
  throw new Error(`no free archive name for ${archiveName(stream, ms)}`)
}

// `save`: a checkpoint inside the stint, not a hand-over: the stint number stays.
async function buildNotes($: EngineInterface, cwd: string, stream: string, mode: Mode, save = false): Promise<Built> {
  try {
    const sid = await $.session.id()
    const paths = streamPaths(cwd, stream, mode)
    const path = paths.notes
    const prev = await readNotes($, cwd, stream, mode)
    const agents = await agentLines($)
    // The journal entries after the cursor of the previous notes (a --save advances the cursor too). Checkpoint off or an unreadable journal = none: fork-only notes.
    const journal = paths.journal
    const taken = takeEntries(prev, checkpointOn() ? await readJournal($, cwd, stream, mode).catch(() => null) : null)
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
        await archivePrev($, cwd, stream, prev, nowMs, mode)
      } catch (err) {
        return { kind: 'blocked', reason: `previous notes not archived (${String(err)}); ${paths.rel} left unchanged` }
      }
    }
    const seen = seenNotes.get(path)
    const warn = seen !== undefined && prev !== null && prev !== seen ? overwriteWarning(stream, mode) : undefined
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
  const mode = await modeOf($, cwd)
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

  // A stream name the layout cannot hold is refused before it binds.
  const refused = forbiddenStream(argStream ?? current(), mode)
  if (refused !== null) {
    const text = `pit: ${refused}. Nothing saved, the session is unchanged.`
    outcome = { status: `⚠ ${shortReason(text)}`, board: 'PIT REFUSED, reserved stream name', bad: true }
    paint($)
    return { text }
  }
  // Explicit argument binds for the session; a new command replaces the last outcome.
  if (argStream !== undefined) boundArg = argStream
  outcome = undefined
  hint = undefined
  const stream = current()
  const paths = streamPaths(cwd, stream, mode)

  // Two saves never overlap (a --save and an auto-pit that both passed their checks before either set the flag): the second leaves at once.
  if (saving) return { text: `pit: a pit is already running, its outcome will show in the status line` }
  saving = true
  autoAborted = false
  autoRunning = auto !== undefined
  startProgress($, `${save ? 'Saving' : 'Pitting'} stream "${stream}"`, stream)
  let built: Built
  try {
    built = await buildNotes($, cwd, stream, mode, save)
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

  trace($, 'notes.written', { path: paths.notes, chars: built.state.length }, stream)
  if (save) {
    await savedOnly($, stream, built)
    return { text: `pit: saved ${paths.rel} (no clear)${built.warn ? `\n${built.warn}` : ''}` }
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
  return { text: `pit: saved ${paths.rel}${!auto && built.warn ? `\n${built.warn}` : ''}` }
}

async function rejoin($: EngineInterface, args: string) {
  const parsed = parseArgs(args, 'rejoin')
  if ('error' in parsed) return { text: `rejoin: ${parsed.error}` }
  outcome = undefined
  const cwd = await rootNow($)
  const mode = await modeOf($, cwd)
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
  const refused = forbiddenStream(chosen, mode)
  if (refused !== null) return { text: `rejoin: ${refused}. Nothing loaded.` }

  let notes: string | null
  try {
    notes = await readNotes($, cwd, chosen, mode)
  } catch (err) {
    return { text: `rejoin: cannot read the notes of stream "${chosen}": ${String(err)}` }
  }
  if (notes === null) return { text: `rejoin: no notes for stream "${chosen}" in this folder. Nothing loaded.${list}` }

  boundArg = chosen
  hint = undefined
  seenNotes.set(notesPath(cwd, chosen, mode), notes)
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
    const mode = await modeOf($, root)
    // The journal moves within the layout in force, from whichever layout holds it; notes or a journal of the new name in either layout stop the copy.
    const own = journalPath(root, from, mode)
    const src = (await $.fs.exists(own)) ? own : journalPath(root, from, otherMode(mode))
    if (!(await $.fs.exists(src))) return
    const dst = journalPath(root, to, mode)
    if ((await $.fs.exists(notesPath(root, from, mode))) || (await $.fs.exists(notesPath(root, from, otherMode(mode)))) || (await $.fs.exists(dst)) || (await $.fs.exists(journalPath(root, to, otherMode(mode))))) {
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
    const mode = await modeOf($, root)
    const refused = forbiddenStream(stream, mode)
    const res = refused === null ? await captureCkpt($, root, stream, answer) : { ids: [] as string[], ok: false }
    if (res.ok) {
      if (res.ids.length > 0) journaled.set(stream, journalPath(root, stream, mode))
      return
    }
    const board = refused === null ? 'checkpoint not journaled: write failed' : `checkpoint not journaled: stream name "${stream}" is reserved`
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
    // Floor = the dash soft zone: 80k tokens, 40 % of a window under 200k. Attention quality tracks absolute context tokens, not window share (rule of thumb, Horthy 2025, as dash; unmeasured, M1 to test).
    const floor = fill === null ? thresholdsOf(200_000).soft : thresholdsOf(fill.window).soft
    const show = fill !== null && fill.tokens >= floor
    phaseAt = { turn: mainTurns, sid: await sidNow($), hinted: show }
    trace($, 'phase.emitted', { pct: fill === null ? null : Math.round(fill.pct), floor, tokens: fill === null ? null : fill.tokens, hint: show, turn: mainTurns }, current())
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
        const root = await rootNow($)
        blocks = withRule(blocks, journalPath(root, current(), await modeOf($, root)))
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
    inject($, armed.stream, armed.text, false, armed.auto ? { line: autoLine(armed.auto, streamPaths(armed.root, armed.stream, await modeOf($, armed.root)).rel), kind: armed.auto.kind === 'ceiling' ? 'ceiling' : 'idle', warn: armed.warn } : undefined)
    $.ui.toast(`Fresh session started with the notes of stream "${armed.stream}"`)
    return next(e)
  }).catch(($, e, next) => {
    noteCaught($, 'classic.SessionStart', next.error)
    return next(e)
  })
}
