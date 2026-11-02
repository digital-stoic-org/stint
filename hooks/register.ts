import type { Register } from 'claude-code'

import { registerBand } from './band.ts'
import { registerCheckpointView } from './checkpoint-view.tsx'
import { registerDash } from './dash.ts'
import { registerDebug } from './debug.ts'
import { registerPit } from './pit.ts'

export const register: Register = (on, options) => {
  registerPit(on)
  registerDash(on, options)
  registerBand(on)
  registerDebug(on, options)
  registerCheckpointView(on)
}
