import type { EngineInterface } from 'claude-code'

// The status line has one slot per plugin ($.ui.status), so stint writes it from one place.
// pit sets its own line (flow, outcome, hint); dash sets the instruments. Both reach the status line only where the AbovePrompt band is never raised (vscode, mobile): elsewhere the band's board carries them. pit's line wins while it has one.
// Also the small shared state between pit (which knows the auto-pit) and dash (which draws it): the ceiling, the idle fire time.

let pitLine: string | undefined
let dashLine: string | undefined
// The pit's message for the band's board slot, and whether the band was ever raised (then the status line stays empty).
export type PitBoard = { text: string; bad?: boolean }
let pitBoard: PitBoard | undefined
let bandUp = false

// Nominal ceiling trigger: right after a turn, at or above this share of the window (pit caps it by the wall, see ceilingTokens).
export const AUTOPIT_CEILING = 0.8
// Absolute tokens: a window of 1M makes a percent meaningless here. Below it the idle trigger skips and the board shows no idle timer.
export const AUTOPIT_MIN_TOKENS = 80_000

// What pit publishes for dash: whether the auto-pit is on, and the effective ceiling in whole % of the window once pit has read the wall.
// undefined = pit has not published yet (read as on, nominal ceiling).
export type AutopitInfo = { on: boolean; ceilingPct?: number }
let autopitInfo: AutopitInfo | undefined

// The armed idle timer: when it fires, and from when the board shows it. Epoch ms. undefined = not armed.
export type IdleFire = { fireAt: number; showAt: number }
let idleFire: IdleFire | undefined

export function setPitBoard(msg: PitBoard | undefined) {
  pitBoard = msg
}

export const getPitBoard = () => pitBoard

export function setAutopitInfo(info: AutopitInfo | undefined) {
  autopitInfo = info
}

export const getAutopitInfo = () => autopitInfo

export function setIdleFire(fire: IdleFire | undefined) {
  idleFire = fire
}

export const getIdleFire = () => idleFire

export function setBandUp(up: boolean) {
  bandUp = up
}

export function setPitLine(text: string | undefined) {
  pitLine = text
}

export function setDashLine(text: string | undefined) {
  dashLine = text
}

export function writeStatus($: EngineInterface) {
  $.ui.status(bandUp ? undefined : (pitLine ?? dashLine))
}
