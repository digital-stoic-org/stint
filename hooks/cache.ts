import type { CacheBucket } from './status.ts'

// Which prompt-cache TTL the main conversation is on, read from the tail of its transcript (JSONL). Pure: dash reads the tail through $.process, this only parses it.
// A turn that wrote the cache records both counts in usage.cache_creation: ephemeral_1h_input_tokens and ephemeral_5m_input_tokens. A pure cache-read turn writes none (0/0) and says nothing.

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// The bucket of the last main-conversation assistant record that wrote the cache; null when none in `text` did.
// A tail read starts mid-record: its first line may be cut, and a cut line does not parse, so it is skipped like any corrupt one. Mixed counts read as 1h.
export function bucketOf(text: string): CacheBucket | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string
    // cheap test before the parse: a transcript line can be huge
    if (!line.includes('"cache_creation"')) continue
    let rec: unknown
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof rec !== 'object' || rec === null) continue
    const r = rec as { type?: unknown; isSidechain?: unknown; message?: { usage?: { cache_creation?: { ephemeral_1h_input_tokens?: unknown; ephemeral_5m_input_tokens?: unknown } } } }
    if (r.type !== 'assistant' || r.isSidechain === true) continue
    const created = r.message?.usage?.cache_creation
    if (typeof created !== 'object' || created === null) continue
    const h1 = num(created.ephemeral_1h_input_tokens)
    const m5 = num(created.ephemeral_5m_input_tokens)
    if (h1 > 0) return '1h'
    if (m5 > 0) return '5m'
  }
  return null
}
