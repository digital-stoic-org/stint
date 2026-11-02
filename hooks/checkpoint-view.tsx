import type { On } from 'claude-code'

import { TRAILER_OPEN, splitTrailer, hideTrailer } from './checkpoint.ts'

// Checkpoint trailers on screen. Display only: the stored message and the journal keep the raw trailer, ctrl+o shows it.
// <Markdown> refuses more than this many characters; a longer body is rewritten as text instead.
const MARKDOWN_MAX = 10_000
// Message ids (e.requestId) whose trailer is expanded. Module scope: a press flips it and redraws; lost on mod reload (all collapsed again).
const expanded = new Set<string>()

const clauseList = (kinds: string[]) => (kinds.length ? `: ${kinds.join(', ')}` : '')

export function registerCheckpointView(on: On) {
  // Closed trailer: a tree in place of the row (the reply without the trailer + a pressable marker, the trailer dim under it when expanded).
  // Streaming (unclosed): a cheap text rewrite. Else untouched. Runs per distinct text while a reply streams: one includes() first.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    try {
      const text = e.props.text
      if (typeof text !== 'string' || !text.includes(TRAILER_OPEN)) return next(e)
      const { body, trailers, kinds, unclosed } = splitTrailer(text)
      if (unclosed) return next({ ...e, props: { ...e.props, text: hideTrailer(text) } })
      if (trailers.length === 0) return next(e)
      if (body.length > MARKDOWN_MAX) return next({ ...e, props: { ...e.props, text: hideTrailer(text) } })

      const id = e.requestId
      const isOpen = expanded.has(id)
      const full = trailers.join('\n')
      const { Box, Text, Markdown, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {body === '' ? null : <Markdown text={body} />}
          <Button
            key="ckpt-toggle"
            plain
            dimColor
            onPress={() => {
              if (expanded.has(id)) expanded.delete(id)
              else expanded.add(id)
              $.ui.invalidate('ui.render')
            }}
          >
            {`${isOpen ? '▾' : '▸'} ckpt${clauseList(kinds)}`}
          </Button>
          {isOpen ? <Text dimColor>{full.length > MARKDOWN_MAX ? `${full.slice(0, MARKDOWN_MAX - 1)}…` : full}</Text> : null}
        </Box>
      )
    } catch {
      return next(e)
    }
  })
}
