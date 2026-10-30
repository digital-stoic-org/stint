import { expect, test } from 'claude-code/testing'
import { bucketOf } from '../hooks/cache.ts'

// A transcript record as the host writes it; only the usage numbers matter here.
type Rec = { h1?: number; m5?: number; type?: string; side?: boolean; noSplit?: boolean }
const rec = ({ h1 = 0, m5 = 0, type = 'assistant', side = false, noSplit = false }: Rec) =>
  JSON.stringify({
    type,
    isSidechain: side,
    message: { usage: { ...(noSplit ? {} : { cache_creation: { ephemeral_1h_input_tokens: h1, ephemeral_5m_input_tokens: m5 } }), cache_creation_input_tokens: h1 + m5, cache_read_input_tokens: 500 } },
  })
const tail = (...lines: string[]) => lines.join('\n') + '\n'

test('bucketOf: 1h only reads 1h, 5m only reads 5m', () => {
  expect(bucketOf(tail(rec({ h1: 1200 })))).toBe('1h')
  expect(bucketOf(tail(rec({ m5: 1200 })))).toBe('5m')
})

test('bucketOf: mixed counts read as 1h', () => {
  expect(bucketOf(tail(rec({ h1: 10, m5: 900 })))).toBe('1h')
})

test('bucketOf: the last record that wrote the cache wins', () => {
  expect(bucketOf(tail(rec({ h1: 5 }), rec({ m5: 5 })))).toBe('5m')
  expect(bucketOf(tail(rec({ m5: 5 }), rec({ h1: 5 })))).toBe('1h')
})

test('bucketOf: a pure cache-read turn (0/0) is skipped for an older record', () => {
  expect(bucketOf(tail(rec({ m5: 70 }), rec({}), rec({})))).toBe('5m')
  expect(bucketOf(tail(rec({ h1: 70 }), rec({}), rec({ noSplit: true })))).toBe('1h')
})

test('bucketOf: a sidechain record and a non-assistant record are ignored', () => {
  expect(bucketOf(tail(rec({ m5: 10 }), rec({ h1: 10, side: true })))).toBe('5m')
  expect(bucketOf(tail(rec({ m5: 10 }), rec({ h1: 10, type: 'user' })))).toBe('5m')
  expect(bucketOf(tail(rec({ h1: 10, side: true })))).toBeNull()
})

test('bucketOf: no qualifying record is null', () => {
  expect(bucketOf(tail(rec({}), rec({ noSplit: true }), rec({ h1: 3, type: 'system' })))).toBeNull()
})

test('bucketOf: a cut first line, corrupt lines and blank lines are skipped silently', () => {
  const whole = rec({ m5: 40 })
  // a tail read starts mid-record: the cut line must not be taken for a record, nor hide the ones after it
  const cut = whole.slice(whole.indexOf('"message"'))
  expect(bucketOf(tail(cut, rec({ h1: 9 })))).toBe('1h')
  expect(bucketOf(tail(rec({ m5: 40 }), '{"type":"assistant","message":{"usage":{"cache_creation":{"ephemeral_1h', '', 'not json "cache_creation"', '[1]', 'null "cache_creation"'))).toBe('5m')
  expect(bucketOf(cut)).toBeNull()
  // a record cut at the end (no newline) does not parse either
  expect(bucketOf(rec({ m5: 40 }) + '\n' + rec({ h1: 40 }).slice(0, 60))).toBe('5m')
})

test('bucketOf: empty input is null', () => {
  expect(bucketOf('')).toBeNull()
  expect(bucketOf('\n\n')).toBeNull()
})

test('bucketOf: non-numeric counts count as zero', () => {
  const bad = JSON.stringify({ type: 'assistant', message: { usage: { cache_creation: { ephemeral_1h_input_tokens: 'x', ephemeral_5m_input_tokens: null } } } })
  expect(bucketOf(tail(rec({ m5: 1 }), bad))).toBe('5m')
})
