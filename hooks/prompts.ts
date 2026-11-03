import type { Entry } from './checkpoint.ts'
import type { AutoKind } from './autopit.ts'
import { NOTES_MAX } from './notes.ts'
import { streamPaths } from './paths.ts'
import type { Mode } from './paths.ts'

// pit (stint), pure part: the fork prompt and the texts injected after the notes. Moved out of pit.ts verbatim; imports nothing from pit.ts.

// Injected after the notes, verbatim from the previous generation (the "wait for my go" variant).
export const UNPACK_RULES = `Reply with one line saying you are ready, then stop there.
Do nothing without my explicit go — no file read, no command, no sub-agent, no continuation of what is in progress.
Do not read the notes back to me. One line of acknowledgement is the whole answer.
Write a message only when something changes. The rest of the time stay silent.
Questions go to me, in this window.
After my go, read the \`read_first\` files before acting.`

export const FORK_PROMPT = `You are writing the notes of this work stream for yourself. After a /clear the notes file is the ONLY thing the fresh context receives. Code assembles the file: you DESIGNATE, you never copy. Lines coming from checkpoint trailers are routed and copied verbatim by code, each ending with its id (cNN).
First line, exactly one of:
GATE: ok
GATE: blocked - <one-line reason>
Blocked = you are in the middle of a cross-item step (synthesis, deduplication, global arbitration across all units). Then output nothing else.
If ok, from line 2 output ONLY the block below, keys in this order, no markdown, no prose, no blank line. Scalar = one line \`key: value\`. List = \`key:\` then one \`- item\` line per item; a missing list = empty.
status: <one word or short phrase: building | blocked | review ...>
goal: <1 sentence, carried from PREVIOUS NOTES unless it changed>
read_first:
- <path — role>   (closed list, read only after the human's go, never before the go)
read_if_needed:
- <path or URL — when to read it>   (extras only)
deliverable: <path where the written work lives>
decisions:
- <choice — why>   (ONLY decisions no trailer covers; the why is mandatory; do not reopen)
learnings:
- <non-obvious fact — command or path that proves it>   (extras only)
discarded:
- <path or approach tried — why rejected>   (extras only)
in_progress:
- <half-done item — where it stands>
next:
- <action>   (2-4 actions, extras only)
crew:
- <session — who briefed whom — what is pending>   (sessions exchanged with)
unknowns:
- <what is not known>   (never empty)
stale:
- <path — replaced by X; do not reload>
retire_answered: <ids, e.g. c03, c07>
retire_done: <ids>
retire_learned: <ids>
retire_reversed: <ids, e.g. c05>
retire_superseded: <ids>
Rules:
- Every list except read_if_needed, learnings, discarded, next and decisions is yours entirely, and for those five you give EXTRAS only: whatever the trailers below and the (cNN) lines of PREVIOUS NOTES do not already say.
- Return the COMPLETE current content of every list you own: merge PREVIOUS NOTES with what this conversation added. Carry forward the still-valid lines that have no (cNN) suffix; drop what is done, answered, replaced or reversed (a reversed decision of yours goes to discarded). Never restart from scratch.
- A line ending with (cNN) belongs to code: never output one, never reword one. To remove one, designate its id in a retire key.
- Never restate an item a (cNN) line or an entry below already holds, even reworded and without the id: one item, one line. Wrong: with \`- pick a strict YAML 1.2 parser or a schema check (c01)\` in next, adding \`- choose between a YAML 1.2 parser and schema validation\`. Add a line only for what no (cNN) line says.
- Retire keys take ids from PREVIOUS NOTES or from the entries below. retire_answered: open: / assumption: items now resolved. retire_done: next items now done. retire_learned: learnings now obsolete (a bug since fixed, a fact replaced by a later one). retire_reversed: decisions proved wrong and reversed. retire_superseded: decisions overtaken by a later decision without being wrong. Omit a retire key when it is empty.
- crew: one line per session exchanged with since the last pit and still pending: name, who briefed whom, what is pending, their notes path only if quoted verbatim in a message. Drop a line when nothing is pending.
- Lines starting "agent in flight:" are written by code: never write one.
- A pointer (absolute path, path:line, command) replaces any explanation. Do not run commands; write them.`

// The entries go to the fork with their ids, as journaled; the fork never gets the journal path to read.
export function forkPrompt(prev: string | null, entries: Entry[] = []): string {
  const n = (v: number) => v.toLocaleString('en-US')
  const room = NOTES_MAX - (prev?.length ?? 0)
  const budget = `SIZE: the notes file may not exceed ${n(NOTES_MAX)} characters; past it code cuts, in this order, read_if_needed, stale, in_progress, discarded, learnings, then the rest. PREVIOUS NOTES are ${n(prev?.length ?? 0)} characters: ${room >= 0 ? `${n(room)} left` : `${n(-room)} over`} for what this conversation adds.${room < 1_500 ? ' Room is tight: designate retire ids first, drop obsolete lines and shorten the rest.' : ''}`
  const journal = entries.length ? entries.map(e => `### ${e.id}\n${e.trailer}`).join('\n\n') : '(none)'
  return `${FORK_PROMPT}\n\n${budget}\n\nPREVIOUS NOTES:\n${prev ?? '(none)'}\n\nJOURNAL ENTRIES TO ROUTE (code copies their clauses; you may retire their ids):\n${journal}`
}

// Auto-pit only: the user did not ask for this, so the first answer is the line below, a short summary, then silence.
// `warn`: the overwrite warning, shown on the line right after the auto line.
export const autoUnpackRules = (line: string, kind: AutoKind = 'idle', warn?: string) => `Your first line is exactly this, with nothing before it:
${line}
${warn === undefined ? '' : `The line right after it is exactly this warning, nothing between them:\n${warn}\n`}Then summarize the notes in 3 to 5 short lines: status, goal, what is in progress, the next action.
Then stop and wait for me. ${kind === 'ceiling' ? 'The session was saved and cleared automatically because the context was nearly full: do not resume the task.' : 'The session was saved and cleared while I was away: do not resume the task.'}
Do nothing without my explicit go — no file read, no command, no sub-agent.
Write a message only when something changes. The rest of the time stay silent.
Questions go to me, in this window.
After my go, read the \`read_first\` files before acting.`

// The text injected as the first message: the notes, then the rules (the auto-pit variant when `auto` is the line to show first).
export const injectText = (notes: string, auto?: string, kind: AutoKind = 'idle', warn?: string) =>
  `${notes.trimEnd()}\n\n${auto === undefined ? UNPACK_RULES : autoUnpackRules(auto, kind, warn)}`

export const overwriteWarning = (stream: string, mode: Mode = 'off') =>
  `⚠️ ${streamPaths('', stream, mode).name} was rewritten by another session; its content was merged into these notes and its previous version is in archive/`

export function forkFailure(reason: string): string {
  return reason === 'nothing-to-fork' ? 'nothing to save yet: this conversation has no response' : `fork failed (${reason})`
}
