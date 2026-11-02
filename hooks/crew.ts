// Crew principles: stint's routing heuristic (context budget, inline / fresh sub-agent / fork, model tier, pit) and the brief/report rules, sent to the model like the checkpoint rule.
// One copy per conversation (first request, again after /clear and /compact); sub-agents read it too (K0 probe), so every line holds for a delegate.
// The text never changes inside a conversation: no project paths, no model names; numbers in thousands of tokens.

import type { On, PluginOptions } from 'claude-code'

// The heading is the marker: instructions that already hold it skip the block.
export const CREW_MARKER = '## Crew (stint)'
export const CREW_BLOCK = 'stintCrew'

// The figures the text quotes, in thousands of tokens: a sub-agent's first request (its cold start) and the read size above which delegating pays.
export type CrewNumbers = { coldK: number; delegateK: number }
// Static defaults until stint has measured this setup: a general-purpose sub-agent's first request in a bare folder (no CLAUDE.md), Opus 5.5, ~11k (K10); 11 × 0.65.
export const CREW_DEFAULTS: CrewNumbers = { coldK: 11, delegateK: 7 }

export function crewText(n: CrewNumbers = CREW_DEFAULTS): string {
  return `${CREW_MARKER}
- Context is the budget: what you read inline stays, re-read every turn, until the next pit. Route by what must stay in your context, not by price per call.
- Inline: short answers while the cache is warm; re-reading cached context costs little.
- Fresh sub-agent: self-contained, reading-heavy work (> ~${n.delegateK}k tokens to read) or fan-out. It starts cold (~${n.coldK}k tokens here, none of your cache) and returns only its conclusion. Few workers beat many: each pays its own cold start.
- Fork: a side task that needs your decisions and state (a parallel variant, a review in your frame); it starts warm from your cache; not when your context is already heavy or the task needs another model.
- Model by the work, set explicitly in every delegation: smallest tier for mechanical reading or extraction, middle tier for routine judgment, top tier for framing, audits, irreversible steps. Keep the session on the top tier; spend cheaper tiers on fresh contexts.
- Switch the session's model only at a pit (the cache is per model). A closed phase or a pause longer than the cache life: pit rather than carry or delegate the rest.
- When you delegate: goal, absolute paths, files it alone writes, closed reading list, stop conditions, deliverable on disk.
- When you report, back each fact with its proof command; re-check a report you receive on disk before relaying it.`
}

export const CREW_TEXT = crewText()

// ---------- measured figures (0.5.1) ----------

// A sub-agent's first request (its cold start), in tokens, is sampled by pit.ts and kept in $.store, numbers only, per project root:
// a sub-agent's prompt carries the project's CLAUDE.md, so it differs per project. The text is filled when a conversation starts and stays fixed in it.
export const CREW_STORE = 'stint:crew'
export const CREW_SAMPLES = 5
export const CREW_ROOTS = 20
// The delegate threshold is an estimate: the break-even of a delegation scales with the cold start (inline cost grows with the tokens read, a delegation pays the cold start).
export const DELEGATE_RATIO = 0.65

type Sample = { t: number; at: number }
type RootSamples = { root: string; samples: Sample[] }
// Least recently sampled root first.
export type CrewStore = { roots: RootSamples[] }

const isSample = (x: unknown): x is Sample => typeof x === 'object' && x !== null && Number.isFinite((x as Sample).t) && (x as Sample).t > 0 && Number.isFinite((x as Sample).at)

// Whatever the store holds, as a CrewStore: malformed parts are dropped.
export function readCrewStore(raw: unknown): CrewStore {
  const roots = (raw as CrewStore | undefined)?.roots
  if (!Array.isArray(roots)) return { roots: [] }
  return {
    roots: roots
      .filter(r => typeof r?.root === 'string' && Array.isArray(r.samples))
      .map(r => ({ root: r.root, samples: r.samples.filter(isSample).slice(-CREW_SAMPLES) }))
      .filter(r => r.samples.length > 0),
  }
}

// One more cold start for this root: the root moves last, its last CREW_SAMPLES kept; past CREW_ROOTS roots the least recent goes.
export function addSample(raw: unknown, root: string, tokens: number, at: number): CrewStore {
  const store = readCrewStore(raw)
  const prev = store.roots.find(r => r.root === root)?.samples ?? []
  const rest = store.roots.filter(r => r.root !== root)
  return { roots: [...rest, { root, samples: [...prev, { t: Math.round(tokens), at }].slice(-CREW_SAMPLES) }].slice(-CREW_ROOTS) }
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2
}

// The figures for a conversation under `root`: its last samples, else the last samples across every root, else the defaults.
export function numbersOf(raw: unknown, root: string): CrewNumbers {
  const store = readCrewStore(raw)
  const own = store.roots.find(r => r.root === root)?.samples ?? []
  const all = store.roots.flatMap(r => r.samples).sort((a, b) => a.at - b.at).slice(-CREW_SAMPLES)
  const samples = own.length > 0 ? own : all
  if (samples.length === 0) return CREW_DEFAULTS
  const coldK = Math.max(1, Math.round(median(samples.map(s => s.t)) / 1000))
  return { coldK, delegateK: Math.max(1, Math.round(coldK * DELEGATE_RATIO)) }
}

// The prompt size of a request as the API reported it: uncached, cache-written and cache-read input together.
export const promptTokens = (u: { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }) => u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens

// ---------- setting (userConfig `crew`) ----------

// `crew` (on | off, default on) is one /config choice row. Off = no block. A block already sent stays until /clear or /compact.
export const CREW_KEY = 'stint.crew'
let enabled = true
export const crewOn = () => enabled
export function setCrew(value: unknown) {
  enabled = value !== 'off'
}

export function registerCrewSetting(on: On, userOptions: PluginOptions) {
  setCrew(userOptions.crew)
  on('config.set', { key: CREW_KEY }, async ($, e, next) => {
    const result = await next(e)
    if ('deny' in result && result.deny !== undefined) return result
    setCrew(e.value)
    return result
  }).catch(($, e, next) => next(e))
}

// ---------- delivery (through pit.ts's prompt.context hook) ----------

type CtxBlock = { readonly name: string; readonly text: string }

// The project's own instructions (the claudeMd block of the engine's input) already hold the crew text. Never test the injected block with this.
export const claudeMdHasCrew = (blocks: readonly CtxBlock[]) => blocks.some(b => b.name === 'claudeMd' && b.text.includes(CREW_MARKER))

export function withCrew<B extends CtxBlock>(blocks: readonly B[], text: string = CREW_TEXT): readonly (B | CtxBlock)[] {
  if (claudeMdHasCrew(blocks) || blocks.some(b => b.name === CREW_BLOCK)) return blocks
  return [...blocks, { name: CREW_BLOCK, text }]
}
