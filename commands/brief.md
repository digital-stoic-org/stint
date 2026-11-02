---
description: Brief a session or a sub-agent by the crew rules (brief contents, gate, readback)
argument-hint: "@name <task>"
---
Brief now. Target: the first word of `$ARGUMENTS` (`@name`: a session from ListAgents, or a sub-agent you start). Task: the rest of `$ARGUMENTS`. Follow these two rules of the stint crew block:

- When you brief (a sub-agent prompt, or a mandate file whose path you send to a session): goal, absolute paths, files it alone writes, closed reading list, stop conditions, deliverable, what you don't know, gate; ask a session for a readback before work.
- Gate: human when the work is irreversible, outward-facing, costly or changes scope (commits, pushes, deletes, spending, public text, settings), or when unsure; otherwise the sender may confirm the readback. The human answers in the receiver's window.
