// Artifact lifecycle (opt-in, userConfig `lifecycle` on AND the `.stint/lifecycle` marker): the rule text that tells the model where to write its intermediates, as one prompt.context block shaped like crew.ts.
// Pure: no state, no disk. The work folder path comes from streamPaths(...).work, filled into the text by code; the text holds no other project path.
// One copy per conversation (first request, again after /clear and /compact): after /rename or /rejoin of another stream the path stays the old one, the last line says so.

// The heading is the marker: instructions that already hold it skip the block.
export const WORK_MARKER = '## Work files (stint)'
export const LIFECYCLE_BLOCK = 'stintLifecycle'
// Replaced by the stream's work folder (absolute, no trailing slash) wherever it appears in the text.
export const WORK_PLACEHOLDER = '<WORK>'

export function lifecycleText(work: string): string {
  return `${WORK_MARKER}
- Your work folder is ${WORK_PLACEHOLDER}. Write every intermediate there by absolute path: briefs, reports, analyses, probes, logs, scratch.
- A delegate writes only in the folder its brief names. Never write in another session's work folder.
- Project space (everything outside .stint/) belongs to the user: never create a file there named BRIEF-*, REPORT-*, ANALYSIS-* or PROBE-*.
- No versioned names (-v2, -final, -new). Edit a file in place; regenerate a derived file (index, summary, status) in place, never hand-edit or copy it.
- \`promote:\` moves a finished work file into project space: <absolute work path> -> <absolute project path>; one clause per file, no \`·|;\` in paths, the target's folder must exist and the target must not. The move happens at the next /pit and never overwrites. A delegate names the file in its debrief and does not write the clause.
- After /rename or /rejoin of another stream, ${WORK_PLACEHOLDER} is stale: use the work/ folder beside the notes path /rejoin prints.`.replaceAll(WORK_PLACEHOLDER, work)
}

type CtxBlock = { readonly name: string; readonly text: string }

// The project's own instructions (the claudeMd block of the engine's input) already hold the block. Never test the injected block with this.
export const claudeMdHasLifecycle = (blocks: readonly CtxBlock[]) => blocks.some(b => b.name === 'claudeMd' && b.text.includes(WORK_MARKER))

export function withLifecycle<B extends CtxBlock>(blocks: readonly B[], text: string): readonly (B | CtxBlock)[] {
  if (claudeMdHasLifecycle(blocks) || blocks.some(b => b.name === LIFECYCLE_BLOCK)) return blocks
  return [...blocks, { name: LIFECYCLE_BLOCK, text }]
}

// ---------- sweep (L4): scratch files of a stream's work/ go to archive/work/ at pit ----------

// Scratch = these prefixes and any unknown one; chantier = never swept, only `promote:` moves it (PLAN-lifecycle Q2, Q4). Keep the scratch list equal to line 3 of the block text.
export const SCRATCH_PREFIXES = ['BRIEF-', 'REPORT-', 'ANALYSIS-', 'PROBE-']
export const CHANTIER_PREFIXES = ['PLAN-', 'SPEC-']
export const isChantier = (name: string) => CHANTIER_PREFIXES.some(p => name.startsWith(p))

export type SweepMove = { name: string; src: string; dst: string }
export type SweepPlan = { move: SweepMove[]; cited: string[] }

// `names`: the files (not folders) of `work`; `archiveWork`: where they go; `notes`: the notes text being written. Both folders without trailing slash.
// A file whose basename appears in the notes stays (the safer match: it also covers the absolute path, and a false hit only keeps a file), and so does a file in `keep` (absolute paths: the sources of promotes that failed,
// left in place so the clause can be fixed and retried). Chantier files and dotfiles are never touched.
export function sweepPlan(work: string, archiveWork: string, names: readonly string[], notes: string, keep: readonly string[] = []): SweepPlan {
  const move: SweepMove[] = []
  const cited: string[] = []
  for (const name of [...names].sort()) {
    if (name.startsWith('.') || isChantier(name)) continue
    if (notes.includes(name) || keep.includes(`${work}/${name}`)) cited.push(name)
    else move.push({ name, src: `${work}/${name}`, dst: `${archiveWork}/${name}` })
  }
  return { move, cited }
}

export type SweepCounts = { moved: number; cited: number; failed: number }

// The pit line part; null when the sweep had nothing to say (no scratch file, nothing cited, nothing failed).
export function sweepLine(c: SweepCounts): string | null {
  if (c.moved + c.cited + c.failed === 0) return null
  return `work/ swept: ${c.moved} moved to archive/work/, ${c.cited} kept (cited in the notes), ${c.failed} failed (left in place)`
}

// ---------- promote (L5): `promote: <work path> -> <project path>` ----------

export type PromoteItem = { src: string; dst: string }
export type PromoteFailure = { what: string; why: string }
export type PromoteCounts = { moved: PromoteItem[]; failed: PromoteFailure[]; already: number }

const trimRoot = (root: string) => root.replace(/\/+$/, '')
const dotdot = (p: string) => p.split('/').includes('..')

// The static checks of one clause, no disk: absolute paths without `..`, the source a file under `<root>/.stint/<any stream>/work/` (D20),
// the target inside the root and outside `.stint/` (D21). Returns the reason, or null when the clause may go on to the disk checks.
export function promoteCheck(root: string, item: PromoteItem): string | null {
  const r = trimRoot(root)
  for (const p of [item.src, item.dst]) if (!p.startsWith('/') || dotdot(p) || p.endsWith('/')) return 'path must be absolute, without ".." or a trailing slash'
  const base = `${r}/.stint/`
  const parts = item.src.startsWith(base) ? item.src.slice(base.length).split('/') : []
  if (parts.length < 3 || parts[0] === '' || parts[1] !== 'work' || parts.slice(2).some(s => s === '')) return 'not in a work/ folder of this project'
  if (item.dst === `${r}/.stint` || item.dst.startsWith(`${r}/.stint/`)) return 'target inside .stint/'
  if (!item.dst.startsWith(`${r}/`)) return 'target outside the project root'
  return null
}

// A moved file's old path in notes text becomes its new one, so the notes cite what exists.
export const rewritePaths = (text: string, moved: readonly PromoteItem[]): string => moved.reduce((t, m) => t.split(m.src).join(m.dst), text)

// The pit line part: `promoted N: <targets relative to the root>` then one `promote failed:` line per failure; null when there is nothing to say (an already-promoted clause is silent).
export function promoteLines(root: string, c: PromoteCounts): string | null {
  const r = `${trimRoot(root)}/`
  const rel = (p: string) => (p.startsWith(r) ? p.slice(r.length) : p)
  const lines: string[] = []
  if (c.moved.length > 0) lines.push(`promoted ${c.moved.length}: ${c.moved.map(m => rel(m.dst)).join(', ')}`)
  for (const f of c.failed) lines.push(`promote failed: ${rel(f.what)}: ${f.why}`)
  return lines.length === 0 ? null : lines.join('\n')
}
