import { zoneOf } from './dash.ts'
import { AUTOPIT_CEILING, AUTOPIT_MIN_TOKENS } from './status.ts'
import { pad } from './streams.ts'

// pit (stint), pure part: auto-pit gates, phase hint, board and progress texts. Moved out of pit.ts verbatim; imports nothing from pit.ts.

// A flow line older than this says it may be stuck ($.model.fork cannot be cancelled).
export const SLOW_MS = 3 * 60 * 1000

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

// An answer whose trailer holds `phase:` (a unit of work closed) shows the hint until the next prompt when the context is in the dash soft zone (pit.ts, notePhase). A hint only: never a pit.
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
export const shortReason = (reason: string) => {
  const one = reason.replace(/\s+/g, ' ').trim()
  return one.length > SHORT_REASON ? `${one.slice(0, SHORT_REASON - 1)}…` : one
}
