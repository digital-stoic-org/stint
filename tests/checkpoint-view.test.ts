import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const TRAILER = '<!-- ckpt decision: use code · reasoning: because -->'

// The test kit has no native transcript beneath the plugin: this stand-in draws the props it receives (after the mod's rewrite) as one Markdown.
const drawMessages = (on: On) => on('ui.render', { component: 'AssistantMessage' }, (_$, e) => ({ type: 'Markdown', props: { text: e.props.text } }) as never)

const mountMessage = ($: Engine, text: string, requestId = 'm1', isFullscreen = true) =>
  $.ui.mount({
    plugin: 'stint',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId,
    viewport: { columns: 100, rows: 40, isFullscreen },
    props: { text, isFirstOfReply: true },
  } as never)

const REPLY = `Hello.\n\n${TRAILER}`
const COLLAPSED = /▸ ckpt: decision, reasoning/
const EXPANDED = /▾ ckpt: decision, reasoning/
const found = async (ui: Awaited<ReturnType<typeof mountMessage>>, text: RegExp) => (await ui.findAll({ text })).length > 0

test('ui.render AssistantMessage: collapsed draw = reply + marker with clauses, no trailer text', async ($, on) => {
  drawMessages(on)
  const ui = await mountMessage($, REPLY)
  expect(await ui.findAll({ text: /<!-- ckpt/ })).toHaveLength(0)
  expect(await ui.findAll({ text: /use code/ })).toHaveLength(0)
  expect(await found(ui, COLLAPSED)).toBe(true)
  expect(await found(ui, /Hello\./)).toBe(true)
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(1)
  await ui.unmount()
})

test('ui.render AssistantMessage: press on the marker expands to the full trailer, a second press collapses', async ($, on) => {
  drawMessages(on)
  const ui = await mountMessage($, REPLY)
  await ui.press({ key: 'ckpt-toggle' })
  expect(await found(ui, EXPANDED)).toBe(true)
  expect(await found(ui, /use code · reasoning: because/)).toBe(true)
  expect(await found(ui, COLLAPSED)).toBe(false)
  await ui.press({ key: 'ckpt-toggle' })
  expect(await found(ui, COLLAPSED)).toBe(true)
  expect(await ui.findAll({ text: /use code/ })).toHaveLength(0)
  await ui.unmount()
})

test('ui.render AssistantMessage: two replies toggle independently (one requestId each)', async ($, on) => {
  drawMessages(on)
  const a = await mountMessage($, REPLY, 'ma')
  const b = await mountMessage($, REPLY, 'mb')
  await a.press({ key: 'ckpt-toggle' })
  expect(await found(a, EXPANDED)).toBe(true)
  expect(await found(b, COLLAPSED)).toBe(true)
  expect(await found(b, /use code/)).toBe(false)
  await b.press({ key: 'ckpt-toggle' })
  await a.press({ key: 'ckpt-toggle' })
  expect(await found(a, COLLAPSED)).toBe(true)
  expect(await found(b, EXPANDED)).toBe(true)
  await b.press({ key: 'ckpt-toggle' })
  await a.unmount()
  await b.unmount()
})

test('ui.render AssistantMessage: not fullscreen -> collapsed marker still drawn', async ($, on) => {
  drawMessages(on)
  const ui = await mountMessage($, REPLY, 'm1', false)
  expect(await found(ui, COLLAPSED)).toBe(true)
  expect(await found(ui, /use code/)).toBe(false)
  await ui.unmount()
})

test('ui.render AssistantMessage: streaming unclosed trailer rewritten as text, no marker', async ($, on) => {
  drawMessages(on)
  const ui = await mountMessage($, 'Working.\n\n<!-- ckpt decision: use co')
  expect(await found(ui, /Working\./)).toBe(true)
  expect(await ui.findAll({ text: /ckpt/ })).toHaveLength(0)
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  await ui.unmount()
})

test('ui.render AssistantMessage: no trailer -> drawn untouched', async ($, on) => {
  drawMessages(on)
  const ui = await mountMessage($, 'Just text.')
  expect(await found(ui, /Just text\./)).toBe(true)
  expect(await ui.findAll({ text: /ckpt/ })).toHaveLength(0)
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  await ui.unmount()
})

test('ui.render AssistantMessage: a body over 10,000 chars falls back to the text marker, no button', async ($, on) => {
  drawMessages(on)
  const ui = await mountMessage($, `${'x'.repeat(10_001)}\n\n${TRAILER}`)
  expect(await ui.findAll({ text: /<!-- ckpt/ })).toHaveLength(0)
  expect(await found(ui, /_ckpt: decision, reasoning_/)).toBe(true)
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  await ui.unmount()
})

test('ui.render AssistantMessage: a trailer alone (empty body) draws only the marker', async ($, on) => {
  drawMessages(on)
  const ui = await mountMessage($, TRAILER, 'solo')
  expect(await found(ui, COLLAPSED)).toBe(true)
  expect(await ui.findAll({ text: /<!-- ckpt/ })).toHaveLength(0)
  await ui.unmount()
})
