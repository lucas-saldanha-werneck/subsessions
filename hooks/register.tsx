import type { EngineInterface, Register } from 'claude-code'

import {
  POLL_SCRIPT, buildRow, emptyTranscript, foldTranscript, formatRow, parseDelivery, parsePoll,
  parseProtocol, transcriptPath,
} from './status'
import type { Polled, Protocol, Row, Transcript } from './status'

// The status band: one row per running subsession, directly above the prompt (terminal and desktop app).
// A timer polls the claude-sub tmux socket; nothing is drawn while no subsession runs.

const POLL_MS = 4000 // a subsession runs: state, action, time
const IDLE_MS = 10000 // none runs: only check whether one started
const MAX_ROWS = 4
const MAX_READ = 4 * 1024 * 1024

type Tail = { path: string; offset: number; t: Transcript }

let rows: Row[] = []
let polling = false
let timer: { cancel: () => void } | null = null
let period = 0
let lastDrawn = ''
const tails: Record<string, Tail> = {} // by sessionId
const received: Record<string, Protocol> = {} // by subsession name, from session.receive
let known: string[] = [] // names seen in the last poll

async function readTail($: EngineInterface, configDir: string, p: Polled): Promise<Transcript | null> {
  const sid = p.session.sessionId
  const cwd = p.session.cwd
  if (!sid || !cwd || !configDir) return null
  let tail = tails[sid]
  if (!tail) tail = tails[sid] = { path: transcriptPath(configDir, cwd, sid), offset: 0, t: emptyTranscript() }
  let size = 0
  try {
    size = (await $.fs.stat(tail.path)).size
  } catch {
    return tail.t
  }
  if (size < tail.offset) {
    tail.offset = 0
    tail.t = emptyTranscript()
  }
  if (size > tail.offset) {
    if (tail.offset === 0 && size > MAX_READ) tail.offset = size - MAX_READ // a long session: only its end
    const length = Math.min(size - tail.offset, MAX_READ)
    const chunk = await $.fs.read(tail.path, { offset: tail.offset, length })
    tail.offset += length
    foldTranscript(tail.t, chunk)
  }
  return tail.t
}

async function poll($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    const r = await $.process.run(['sh', '-c', POLL_SCRIPT], { timeoutMs: 15000 })
    const { configDir, subs } = parsePoll(r.stdout)
    known = subs.map(s => s.name)
    const now: number = await $.clock.now()
    const next: Row[] = []
    for (const p of subs.slice(0, MAX_ROWS)) {
      let t: Transcript | null = null
      try { t = await readTail($, configDir, p) } catch { t = null }
      next.push(buildRow(p, t, received[p.name] ?? null, now))
    }
    for (const name of Object.keys(received)) if (!known.includes(name)) delete received[name]
    rows = next
    const drawn = JSON.stringify(rows)
    if (drawn !== lastDrawn) {
      lastDrawn = drawn
      $.ui.invalidate('ui.render')
    }
    const want = subs.length ? POLL_MS : IDLE_MS
    if (want !== period) schedule($, want)
  } catch {
    // tmux or sh missing, or the call was refused: draw nothing
    if (rows.length) {
      rows = []
      lastDrawn = ''
      $.ui.invalidate('ui.render')
    }
  } finally {
    polling = false
  }
}

function schedule($: EngineInterface, ms: number): void {
  timer?.cancel()
  period = ms
  timer = $.clock.every(ms, () => poll($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const out = await next(e)
    schedule($, IDLE_MS)
    void poll($)
    return out
  })

  // Protocol lines arrive here as cross-session messages; read them, pass them on unchanged.
  on('session.receive', async ($, e, next) => {
    if (!e.agentId) {
      const at: number = await $.clock.now()
      for (const m of parseDelivery(e.text)) {
        const p = parseProtocol(m.body, at)
        if (!p) continue
        const from = m.from ?? (known.length === 1 ? known[0] : undefined)
        if (from) received[from] = p
      }
      void poll($)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The terminal and the desktop app draw it; the subsessions run on the computer either way.
    if ((e.surface !== 'terminal' && e.surface !== 'desktop') || e.props.hasSurvey || rows.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    // The terminal gets each row fitted to its columns; the app cuts a long row at its end itself.
    const width = e.surface === 'terminal' ? Math.max(40, e.props.bodyColumns) : Math.max(160, e.props.bodyColumns)
    return (
      <Box flexDirection="column">
        {rows.map(r => {
          const s = formatRow(r, width)
          const color = r.state === 'question' || r.state === 'permission' ? 'yellow' : r.state === 'done' ? 'green' : undefined
          return (
            <Text key={r.name} wrap="truncate">
              <Text color={color}>{s.icon} </Text>
              <Text bold>{s.name}</Text>
              <Text dimColor> · </Text>
              <Text color={color}>{s.state}</Text>
              {s.step ? <Text> · {s.step}</Text> : null}
              {s.action ? <Text dimColor> · {s.action}</Text> : null}
              {s.tail ? <Text dimColor> · {s.tail}</Text> : null}
            </Text>
          )
        })}
      </Box>
    )
  })
}
