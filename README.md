# Stint

Run your agent in stints. Pit before the redline.

Requires Claude Code 2.1.311+.

More at https://stint.digitalstoic.net.

## Install

```
/plugin marketplace add digital-stoic-org/stint
/plugin install stint@pitlane
```

## Load from a local copy

```bash
claude --plugin-dir <path-to>/stint
claude plugin validate <path-to>/stint --strict
claude plugin test <path-to>/stint
```

## Commands

| command | does |
|---|---|
| `/pit [stream]` | The car comes into the pit: the agent writes its notes to a file, `/clear` runs by itself, and the notes are injected as the first message of the fresh context. The progress, the outcome and a refusal show on the band's board (red for a failure, until the next command); the transcript gets one line, `pit: saved .stint/<stream>-notes.md`. If the host refuses the `/clear`, the board says to type it. |
| `/rejoin [stream]` | The car goes back on track: the notes of a stream are injected as the first message of a new session. With no stream it takes the only notes file of the folder, lists them when there are several, and says so when there are none. |
| `/brief @name <task>` | A prompt template, no code of its own: it asks the model to brief a session (`@name` from ListAgents) or a sub-agent for the task, by the two crew lines on what a brief holds and on the human gate (the same words as in the Crew block). Typed as `/stint:brief` while the team plugin is loaded, whose `/team:brief` skill shares the name. |

At session start, if the folder holds notes and no stream is set, the board reads `notes found: /rejoin x` (the status line `Notes for stream "x" found: /rejoin x` where there is no band).

A `/pit` is refused, and nothing is cleared, when the save fails, when another `/pit` is running, or when the context is at 95% of the limit where Claude Code compacts on its own: the save runs in that same context and would fail there.

Stream name, in order: the argument (`a-z A-Z 0-9 _ -`, up to 50 characters, kept for the session and across `/clear`), the session title set by `/rename`, then the session's own name. The session's own name is `<project folder>-<first 4 characters of the session id>`, such as `stint-92a8`: two sessions started in one folder without `/rename` never share notes or a journal. stint sets it as the session title, so it shows above the prompt and in `/resume`, and a resumed session keeps it. `main` is used only when Claude Code gives no session id. `pit` and `rejoin` are reserved.

## Dash

A band above the prompt carries the car's instruments, on by default (`dash`: `full`). It is drawn on the terminal and the desktop app. Where there is no such band (VS Code, mobile) the same line goes to the status line instead. While `/pit` runs, or after a pit outcome, the notes hint or the pit hint (see Checkpoints), the band's board carries them above every other board message; only where there is no band do they take the status line.

```
🚀 revs <n>% ▮▮▯▯▯▯▯▯▯▯ ↑<n> · ⛽ <n>% · 🏁 <n> · 📋 —
```

| term | reads |
|---|---|
| `revs` | Context fill, as a share of the model window (the figure of Claude Code's own status line). The bar has ten cells, one per 10%. When the window is not 200k its size follows the percentage, e.g. `revs <n>%/1M`. |
| zone emoji | 🚀 under the soft threshold · 🔥 orange from the soft threshold · 🚨 bold red from the hard threshold, fixed, it does not pulse. |
| thresholds | Soft 80k tokens, hard 120k tokens, which is 40% and 60% of a 200k window. A window under 200k caps them at 40% and 60% of itself. They are not the point where Claude Code compacts; that wall is read by `/pit` alone. |
| `↑<n>` | The last rise of revs, for 3 seconds. |
| `⛽` | What is left of the tighter of the five-hour and seven-day plan windows. Shown only below 30%, and only when the host reports rate limits. |
| `🏁` | The stint counter, shown from the second stint: +1 at each successful `/pit`, taken from the notes by `/rejoin`. |
| `📋` | Pit board: the sign the crew holds over the pit wall; one short message, `—` when empty. It is cut first when the line is too wide. |

The revs figure flashes for half a second at each upward crossing of a threshold, and the fuel segment flashes when it appears. Nothing else repeats.

A toast appears once per upward crossing: at the soft threshold (5 s, `plan your pit`) and at the hard one (10 s, `REDLINE · box this lap: /pit`, and the board keeps that message while the zone lasts). A successful `/pit` shows `✅ pit done · revs <n>% → <n>% ↓<n>` for 3 s: the revs of the last measure before the `/clear`, then those of the first measure of the fresh context (never an estimate), and a dim `↓<n>` after the revs on the band for 3 s. With no pre-pit value, no measure within 30 s, or no drop, it shows `✅ pit done · fresh window` and no `↓`. The plugin has one toast slot: a redline toast is never replaced by a zone toast, nor a zone toast by the pit one. Toasts re-arm after `/pit`, `/clear` or a new session.

Option (`/config`, row `stint · Dash`, or `pluginConfigs.stint.options.dash`), applied as soon as it changes:

| `dash` | does |
|---|---|
| `full` (default) | The emoji band and the toasts. |
| `ascii` | An ASCII-only band without hex colours (`revs <n>% ##........ | board -`) and ASCII toasts, for terminals that misjudge emoji width. |
| `off` | No band, no dash status line, no toasts. The `/pit` and `/rejoin` lines are unaffected. |

### Board slot

The board draws what other parts of the plugin write to the session state, `{ plugin: 'stint', key: 'board' }`, typed in `types/index.d.ts`:

```ts
type Board = { text: string; level: 'info' | 'warn' | 'alert'; from: string; until?: number }
```

`until` is a time in milliseconds on the host clock; past it the slot reads `—` again. With several candidates the order is `alert`, then the built-in redline message (`box this lap: /pit`), then `warn`, then `info`. Only stint writes this value.

Figures come from Claude Code's `session.measure` event; until it fires, one `$.session.usage()` read after each main-thread turn gives the same reading.

## Debug

Off by default. Turn it on in `/config` (row `stint · Debug`, `off|on`). Once on, stint keeps a ring buffer of the last 200 events (pit start, notes written, pending persisted, clear, session start, pending lookup with the reason for a miss, injection, prompt seen, turn start) and mirrors them to the debug log. It records metadata only: paths, sizes, ids, never the notes.

After an armed `/pit`, if the injected prompt does not reach a turn within 10 seconds of the fresh session, or the pending notes were saved but not found, stint writes `<pit folder>/.stint/debug-<time>.md`, raises a red line on the board (`notes not loaded: /rejoin <stream> - trace saved`) and a toast with the path. `/pit --trace` writes the buffer on demand and never runs a pit. With debug off nothing is written and no timer runs.

## Checkpoints

On by default. stint teaches the model to end a turn that settles a decision, a learning, a rejected path, a change of frame, an open fork or the close of a unit of work with one HTML comment, the trailer: `<!-- ckpt decision: ... · learning: ... -->`. The rule reaches the model as one context block (`stintCheckpoint`) at the start of each conversation, and again after `/clear` and `/compact`. It is left out when your own instructions (`CLAUDE.md`) already hold the opener `<!-- ckpt`. The clauses are `decision`, `reasoning`, `learning`, `pivot`, `rejected`, `constraint`, `assumption`, `open`, `definition`, `refs`, `phase`. `phase` says what just closed; the rule asks for it only when that unit is closed, verified, and its result and open points sit in a deliverable file a fresh session could resume from, never for an ordinary decision. With lifecycle on (see [Lifecycle](#lifecycle-experimental)), a twelfth clause, `promote`, moves a work file into the project; the lifecycle block teaches it, not this rule.

What stint does with a trailer:

- **Journal.** Each trailer of a final answer is written, raw, to `<project root>/.stint/<stream>-journal.md` (same root and stream as the notes; `.stint/<stream>/journal.md` with lifecycle on). A `/rename` before the first save copies the journal to the new name, unless that name already has a journal; otherwise the entries written before the `/rename` stay under the old name, and a message says so. One entry per trailer: a `### cNN <time> <session>` line, then the comment. Entries are only added; to read one, grep its id with the space after it (`grep -A8 '^### c07 ' <journal>`), never read the file whole. A failed write shows `checkpoint not journaled: write failed` on the board for a few seconds and the turn goes on.
- **Screen.** The trailer is hidden in the reply. A marker stands in its place, `▸ ckpt: decision, learning`, naming the clauses it holds. In fullscreen a press on the marker shows the raw trailer and a second press hides it. Outside fullscreen only the marker is drawn and the press does nothing; the raw text is then in the journal. The stored message is not changed.
- **Pit hint.** When the last main-thread answer holds `phase:` and the context holds at least 80k tokens, or 40 % of the window when the window is under 200k (the 🔥 zone of the band), the board reads `good moment to /pit` (with `· auto at <n>%` when it covers the auto-pit message of the red zone). It ranks with the pit's own lines, above the zone messages, and goes at the next prompt, at the next answer without `phase:`, at `/clear` and in a new session. It is a hint only: stint never pits on it.

Option (`/config`, row `stint · Checkpoint`, or `pluginConfigs.stint.options.checkpoint`), applied as soon as it changes:

| `checkpoint` | does |
|---|---|
| `on` (default) | The rule, the journal, the marker and the pit hint. |
| `off` | None of them: no rule sent, no journal write, nothing hidden, no pit hint. A trailer the model still writes (from your own instructions) shows as plain text. The rule already sent stays in the current conversation until `/clear` or `/compact`. |

## Crew

On by default. stint sends the model a short, fixed set of working principles that tell it how to route work by what must stay in its context: the context is a budget re-read every turn until the next pit; short answers stay inline while the cache is warm; reading-heavy or fan-out work goes to a fresh sub-agent, which starts cold; a side task that needs the session's decisions goes to a fork, which starts warm from the session's cache; the model tier follows the work and is set in every delegation, the session stays on the top tier and changes model only at a pit. Five more lines set the rules between sessions: only a brief, a readback, a blocker or a debrief, short and with pointers; what a brief holds, whether a sub-agent prompt or a mandate file sent to a session, and a readback before a session works; a human gate for irreversible, outward-facing, costly or scope-changing work; what a debrief holds; and the paths of your notes and journal on first contact. It arrives as one context block (`stintCrew`) at the start of each conversation, and again after `/clear` and `/compact`, like the checkpoint rule. Sub-agents started with the Agent tool read it too, so every line is written to hold for a delegate as well. The text never changes inside a conversation and names no model. It is left out when your own instructions (`CLAUDE.md`) already hold its heading `## Crew (stint)`, for instance when you keep your own version of it there.

The text sent, with its default figures:

```
## Crew (stint)
- Context is the budget: what you read inline stays, re-read every turn, until the next pit. Route by what must stay in your context, not by price per call.
- Inline: short answers while the cache is warm; re-reading cached context costs little.
- Fresh sub-agent: self-contained, reading-heavy work (> ~7k tokens to read) or fan-out. It starts cold (~11k tokens here, none of your cache) and returns only its conclusion. Few workers beat many: each pays its own cold start.
- Fork: a side task that needs your decisions and state (a parallel variant, a review in your frame); it starts warm from your cache; not when your context is already heavy or the task needs another model.
- Model by the work, set explicitly in every delegation: smallest tier for mechanical reading or extraction, middle tier for routine judgment, top tier for framing, audits, irreversible steps. Keep the session on the top tier; spend cheaper tiers on fresh contexts.
- Switch the session's model only at a pit (the cache is per model). A closed phase or a pause longer than the cache life: pit rather than carry or delegate the rest.
- Between sessions, send only what the receiver needs to act: a brief, a readback, a blocker, a debrief. No acknowledgements, thanks, "standing by" or recap; 1-3 lines, pointers not content; never answer a message that asks nothing.
- When you brief (a sub-agent prompt, or a mandate file whose path you send to a session): goal, absolute paths, files it alone writes, closed reading list, stop conditions, deliverable, what you don't know, gate; ask a session for a readback before work.
- Gate: human when the work is irreversible, outward-facing, costly or changes scope (commits, pushes, deletes, spending, public text, settings), or when unsure; otherwise the sender may confirm the readback. The human answers in the receiver's window.
- When you debrief: deliverable path, checkpoint ids (cNN), the proof command for each fact, what you don't know. Re-check a debrief you receive on disk before relaying it.
- The first time you exchange with a session, give the absolute paths of your notes and journal.
```

The two figures in the `Fresh sub-agent` line come from your own setup once stint has measured it:

- **Cold start** (`~11k` by default, a general-purpose sub-agent's first request in a folder with no `CLAUDE.md`): the size of a sub-agent's first request, as the API reports it (uncached, cache-written and cache-read input together). stint reads it when a sub-agent makes its first request, once per sub-agent, and keeps the last 5 per project folder in its plugin store (numbers and times only, at most 20 folders). The text quotes their median, in thousands of tokens. A folder with no figure of its own takes the last 5 across all folders; with none at all, the default stays. The figure differs per project because a sub-agent's prompt carries the project's `CLAUDE.md`.
- **Delegate threshold** (`> ~7k` by default): an estimate, 0.65 times the cold start. Reading inline costs in proportion to the tokens read, delegating costs a cold start, so the point where delegating pays moves with the cold start.

The figures are filled in when a conversation starts (first request, `/clear`, `/compact`, a pit) and stay fixed for that conversation. A figure measured mid-conversation shows from the next one.

Option (`/config`, row `stint · Crew`, or `pluginConfigs.stint.options.crew`):

| `crew` | does |
|---|---|
| `on` (default) | The block is sent. |
| `off` | No block and no measuring. A block already sent stays in the current conversation until `/clear` or `/compact`. |

## Notes file

`<project root>/.stint/<stream>-notes.md` (the folder the session started in, not the shell's current folder; `/clear` and `/rejoin` use the same root). Before each save the previous notes are copied to `.stint/archive/<stream>-notes-<YYYYMMDD-HHMM>.md`. stint never deletes them: Claude Code gives plugins no way to delete a file, so the folder grows until you clean it (`rm .stint/archive/*`). A saved note that /clear cannot re-inject shows `notes not loaded (<reason>): /rejoin <stream>` on the board. At most 8,000 characters. Header: `stream`, `saved`, `status`, `previous_session`, `goal`, `stint`, `journal`, `journal_cursor`. `stint` is the number of the stint the notes hand over to: each successful `/pit` writes the previous value plus one, `/pit --save` keeps it, and a file without the field counts as 1. `journal` is the path of the stream's journal and `journal_cursor` the last entry the notes took in (`c00` when none; a file without it counts as `c00`).

Each save takes in the journal entries after the cursor, then moves the cursor to the last one. Code copies their clauses word for word into the notes, each line ending with its entry id, such as `use A (c07)`: `decision` and `constraint` go to `decisions`, `learning` and `definition` to `learnings`, `rejected` to `discarded`, `open` to `next`, `assumption` to `unknowns`, `refs` to `read_if_needed`. `reasoning`, `pivot` and `phase` stay in the journal. The fork also writes `crew`: one line per session this stream exchanged with since the last pit and still pending (its name, who briefed whom, what is pending, its notes path only when a message quoted it); a line goes when nothing is pending. Older notes without `crew` load as before. Past the size cap, `crew` lines are cut before the fork's own decisions. The same text twice in a section is kept once, under the lower id. One model fork sees the previous notes and the new entries. It writes the scalars and every line without an id, and it can retire an id: a reversed or superseded decision moves to `discarded` with its id, and an answered question, a finished step or an obsolete learning is removed. The fork cannot write or reword a line ending with an id. With the checkpoint option off, or no journal, the fork writes the whole notes. A cursor past the end of the journal (a journal cut by hand) starts again from `c00`.

Body lists: `read_first`, `read_if_needed`, `deliverable`, `decisions`, `learnings`, `discarded`, `in_progress`, `next`, `unknowns`, `stale`. Over the cap, code marks the status `degraded`, shortens long `read_if_needed` lines, then drops items oldest first from `stale` and `in_progress`. Still over, it drops items oldest first from `discarded` and `learnings`, then the lines with an id, lowest id first, then the fork's lines from `read_if_needed`, `next`, `unknowns`, `decisions`. Those cuts are named on an `overflow:` line at the end of `stale`, with every dropped id; the journal still holds them. The header, `read_first`, `deliverable` and the running agents are never cut; if they alone exceed the cap, nothing is written and the pit is refused. Agents still running are listed in `in_progress` by code.

Do not load stint and stoa together.

## Lifecycle (experimental)

Off by default. Agents leave briefs, reports, analyses and logs behind, and these scratch files pile up in the project next to your own. With lifecycle on, each stream gets its own scratch folder under `.stint/`, the model is told to write its intermediate files there, and every pit clears that folder into an archive. stint never deletes a file.

Turn it on per project, in two steps: set `stint · Lifecycle (experimental)` to `on` in `/config` (or `pluginConfigs.stint.options.lifecycle`), then create the marker file in the project root with `mkdir -p .stint && touch .stint/lifecycle`. With the setting `off`, or without the marker file, stint behaves as in 0.5.5: flat files, no block, no sweep, no promote.

Layout, per stream:

```
.stint/<stream>/notes.md
.stint/<stream>/journal.md
.stint/<stream>/archive/        previous notes; swept files in archive/work/
.stint/<stream>/work/           the stream's scratch folder
```

The names `archive` and `work` cannot be stream names while lifecycle is on. stint reads both layouts and takes the newest `saved:` of the two, so an older flat file never hides newer notes; it never moves, rewrites or deletes a file of the other layout.

**Rule block.** Like the crew text, one context block (`stintLifecycle`) reaches the model at the start of each conversation and after `/clear` and `/compact`. It names the stream's work folder and tells the model to write every intermediate there by absolute path, never to create a file named `BRIEF-*`, `REPORT-*`, `ANALYSIS-*` or `PROBE-*` in the project, to use no versioned names (`-v2`, `-final`), and how to promote a finished file. It is left out when your own instructions (`CLAUDE.md`) already hold its heading `## Work files (stint)`. Its token cost has not been measured.

**Sweep.** At every pit (`/pit`, `/pit --save`, auto-pit), once the notes are written, the files directly in the pitting stream's `work/` move to `archive/work/` in the same stream folder, except:

- files named `PLAN-*` or `SPEC-*`, which stay until you promote them;
- files whose name appears in the new notes (cited), which stay for the next pit;
- files whose name starts with a dot, which are never touched.

Any other name counts as scratch. The pit line reports it: `work/ swept: 2 moved to archive/work/, 1 kept (cited in the notes), 0 failed (left in place)`. A move that fails leaves the file in place and is counted.

**Promote.** A finished file leaves the scratch folder through the `promote` checkpoint clause (the twelfth, taught by the lifecycle block and not by the checkpoint rule): `promote: <absolute work path> -> <absolute project path>`, one clause per file, no `·`, `|` or `;` in the paths. The model designates, the code moves at the next pit, before the notes are assembled, so the notes cite the new place. A move never overwrites. stint checks, and refuses with a reason in the pit line (`promote failed: <source>: <reason>`), unless:

- both paths are absolute, without `..` and without a trailing slash, and use the project root as Claude Code sees it (the same folder reached through a symlink is refused);
- the source is a file inside a `work/` folder of this project;
- the target is inside the project and outside `.stint/`;
- the target's folder exists and the target does not.

A refused file stays in `work/`, and the sweep leaves it alone, so you can correct the clause in a later trailer and retry. A successful promote reads `promoted 1: <target>`. Like `phase`, a `promote` clause counts as a closed unit for the pit hint.

**Turn it off.** Set the option to `off`, or delete `.stint/lifecycle`. Nothing is moved back: the per-stream files stay where they are and both layouts keep being read, the newest notes winning.

Limits:

- Tested on a mock host only; the file moves, the folder listing and the stat of a directory have not run on a real host.
- A scratch file written in the pit's own turn is archived unless the notes cite it. It is archived, not deleted.
- The rule is text sent to the model; nothing blocks a write, through Bash or any other tool.
- A target folder that is a symlink leading outside the project is not detected. This is hygiene, not security.
- Only files directly in `work/` are swept; a subfolder stays where it is. A source that is a directory is refused.
- The block names the work folder of the stream the conversation started on. After a `/rename` or `/rejoin` of another stream it points to the old folder; a pit followed by `/clear` gives a block for the new stream.
- With auto-pit, a refused promote shows only in the text of the pit, not in the fresh session.

## License

MIT
