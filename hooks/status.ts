// Pure helpers for the status band: no engine calls, so they run under plain Node in tests/.
// The band shows one row per running subsession, built from four sources:
//   1. the poll script below (tmux socket, the session file, process memory, the screen)
//   2. protocol lines ("progress:", "done:", "question:") the main session receives
//   3. the subsession's transcript (current action, task start, tokens)
//   4. its screen (status line cost and context, a permission prompt)

export type ProtocolKind = 'progress' | 'done' | 'question'

export type Protocol = {
  kind: ProtocolKind
  text: string // the step name, the result or the question
  n?: number
  total?: number
  at: number // ms
}

export type Message = { from?: string; body: string }

export type Transcript = {
  rest: string // an unfinished last line, kept for the next read
  seen: Record<string, true> // message ids already counted
  tokensIn: number
  tokensOut: number
  ctxTokens: number // context size at the last real model call
  action: string // the last tool call, "Bash: ls"
  actionAt: number
  taskAt: number // when the last task (a prompt or a cross-session message) arrived
  lastAt: number // the newest record's time
  turnOpen: boolean // a tool call ran after the last prompt and no final answer came yet
  protocol: Protocol | null // the newest protocol line the subsession sent
}

export type Screen = {
  ctxPct?: number
  cost?: number
  permission: boolean
}

export type Polled = {
  name: string
  pid: number
  rssKb: number
  session: { sessionId?: string; cwd?: string; status?: string; startedAt?: number }
  screen: string
}

export type Row = {
  name: string
  state: 'busy' | 'idle' | 'question' | 'permission' | 'done'
  step?: string // "2/3 git status"
  action?: string
  elapsedMs?: number
  cost?: number
  tokens?: number
  ctxPct?: number
  ctxTokens?: number
  rssKb?: number
}

const PROTOCOL_RE = /^\s*(progress|done|question)\s*:\s*([\s\S]*?)\s*$/i
const STEP_RE = /^([\s\S]*?)\s*\((\d+)\s*\/\s*(\d+)\)\s*(?:[—–-]\s*([\s\S]*))?$/

/** Reads one protocol line: "progress: read files (2/5)", "done: …", "question: …". */
export function parseProtocol(text: string, at = 0): Protocol | null {
  const first = (text || '').trim().split('\n')[0] ?? ''
  const m = PROTOCOL_RE.exec(first)
  if (!m) return null
  const kind = (m[1] ?? '').toLowerCase() as ProtocolKind
  const body = (m[2] ?? '').trim()
  if (kind === 'progress') {
    const s = STEP_RE.exec(body)
    if (s) {
      const step = [(s[1] ?? '').trim(), s[4]?.trim()].filter(Boolean).join(' — ')
      return { kind, text: step, n: Number(s[2]), total: Number(s[3]), at }
    }
  }
  return { kind, text: body, at }
}

const XSM_RE = /<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/g

/** Splits a delivery into its messages. A wrapped delivery names the sender (from-name). */
export function parseDelivery(text: string): Message[] {
  const out: Message[] = []
  for (const m of (text || '').matchAll(XSM_RE)) {
    const name = /\bfrom-name="([^"]*)"/.exec(m[1] ?? '')
    out.push({ from: name ? name[1] : undefined, body: (m[2] ?? '').trim() })
  }
  if (out.length === 0 && text && text.trim()) out.push({ body: text.trim() })
  return out
}

export function emptyTranscript(): Transcript {
  return {
    rest: '', seen: {}, tokensIn: 0, tokensOut: 0, ctxTokens: 0, action: '', actionAt: 0,
    taskAt: 0, lastAt: 0, turnOpen: false, protocol: null,
  }
}

const oneLine = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim()
const base = (p: unknown): string => String(p ?? '').split('/').pop() || ''

/** "Bash: git status", "Read: file.ts", "REPL: tools.Bash(...)". */
export function describeTool(name: string, input: Record<string, unknown> | undefined): string {
  const i = input || {}
  switch (name) {
    case 'Bash': return `Bash: ${oneLine(i.command)}`
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': return `${name}: ${base(i.file_path ?? i.notebook_path)}`
    case 'Grep': case 'Glob': return `${name}: ${oneLine(i.pattern)}`
    case 'SendMessage': return `SendMessage: ${oneLine(i.message)}`
    case 'WebFetch': return `WebFetch: ${oneLine(i.url)}`
    case 'Agent': case 'Task': return `${name}: ${oneLine(i.description)}`
    case 'REPL': {
      // The first line that does something, past declarations of constants.
      const lines = String(i.code ?? '').split('\n').map(l => l.trim()).filter(Boolean)
      const doing = lines.find(l => /await|tools\.|\$`/.test(l)) ?? lines[0] ?? ''
      return `REPL: ${oneLine(doing)}`
    }
    default: return name
  }
}

function isTaskPrompt(content: unknown): boolean {
  if (typeof content === 'string') return !content.startsWith('<command-') && content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some(b => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) &&
    !content.some(b => b && b.type === 'tool_result')
}

/** Folds new transcript text into the summary. Call it with each new chunk of the file. */
export function foldTranscript(t: Transcript, chunk: string): Transcript {
  const text = t.rest + chunk
  const lines = text.split('\n')
  t.rest = lines.pop() ?? ''
  for (const line of lines) {
    // Only conversation records matter; skip the large request records without parsing them.
    if (!line.startsWith('{') || (!line.includes('"type":"assistant"') && !line.includes('"type":"user"'))) continue
    let d: any
    try { d = JSON.parse(line) } catch { continue }
    const at = Date.parse(d.timestamp) || 0
    if (at > t.lastAt) t.lastAt = at
    const msg = d.message || {}
    if (d.type === 'user') {
      if (d.isMeta || d.isSidechain) continue
      if (isTaskPrompt(msg.content)) {
        t.taskAt = at
        t.turnOpen = true
        t.protocol = null
        t.action = ''
      }
      continue
    }
    if (d.type !== 'assistant') continue
    const usage = msg.usage
    const real = msg.model && msg.model !== '<synthetic>'
    if (real && usage && msg.id && !t.seen[msg.id]) {
      t.seen[msg.id] = true
      const ctx = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
      t.tokensIn += ctx
      t.tokensOut += usage.output_tokens || 0
      t.ctxTokens = ctx
    }
    const blocks = Array.isArray(msg.content) ? msg.content : []
    let used = false
    for (const b of blocks) {
      if (!b || b.type !== 'tool_use') continue
      used = true
      t.action = describeTool(b.name, b.input)
      t.actionAt = at
      if (b.name === 'SendMessage' && b.input && typeof b.input.message === 'string') {
        const p = parseProtocol(b.input.message, at)
        if (p) t.protocol = p
      }
    }
    if (used) t.turnOpen = true
    else if (real && msg.stop_reason === 'end_turn') t.turnOpen = false
  }
  return t
}

/** Reads the subsession's status line and looks for a permission prompt. */
export function parseScreen(screen: string): Screen {
  const s = screen || ''
  const out: Screen = { permission: false }
  const ctx = /Ctx(?:\s*Used)?\s*:?\s*(\d+(?:\.\d+)?)\s*%/i.exec(s) || /context[^\n%]{0,20}?(\d+(?:\.\d+)?)\s*%/i.exec(s)
  if (ctx) out.ctxPct = Number(ctx[1])
  const cost = /Cost\s*:?\s*\$\s*(\d+(?:\.\d+)?)/i.exec(s)
  if (cost) out.cost = Number(cost[1])
  out.permission = /Do you want to (?:proceed|make this edit|create|allow|run)|❯\s*1\.\s*Yes\b/.test(s)
  return out
}

export const POLL_SCRIPT = `S="\${CLAUDE_SUB_SOCKET:-claude-sub}"; CFG="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
printf 'CFG\\t%s\\n' "$CFG"
tmux -L "$S" list-panes -a -F '#{session_name} #{pane_pid}' 2>/dev/null | while read -r n p; do
  printf '\\036%s\\t%s\\t%s\\n' "$n" "$p" "$(ps -o rss= -p "$p" 2>/dev/null | tr -d ' ')"
  head -c 65536 "$CFG/sessions/$p.json" 2>/dev/null | tr -d '\\n'; printf '\\n'
  tmux -L "$S" capture-pane -p -J -t "=$n:" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -n 25
done`

/** Parses what POLL_SCRIPT printed. */
export function parsePoll(out: string): { configDir: string; subs: Polled[] } {
  const parts = (out || '').split('\x1e')
  const head = /^CFG\t(.*)$/m.exec(parts[0] || '')
  const subs: Polled[] = []
  for (const part of parts.slice(1)) {
    const lines = part.split('\n')
    const [name, pid, rss] = (lines[0] || '').split('\t')
    if (!name) continue
    let session = {}
    try { session = JSON.parse(lines[1] || '{}') } catch { /* no session file yet */ }
    subs.push({ name, pid: Number(pid) || 0, rssKb: Number(rss) || 0, session, screen: lines.slice(2).join('\n') })
  }
  return { configDir: head?.[1] ?? '', subs }
}

/** Where Claude Code keeps a session's transcript. */
export function transcriptPath(configDir: string, cwd: string, sessionId: string): string {
  return `${configDir}/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`
}

/** Builds a row from everything known about one subsession. */
export function buildRow(p: Polled, t: Transcript | null, received: Protocol | null, now: number): Row {
  const screen = parseScreen(p.screen)
  // The newest protocol line of the current task, from the transcript or a received message.
  let proto = t?.protocol ?? null
  if (received && (!proto || received.at > proto.at) && (!t || received.at >= t.taskAt - 1000)) proto = received
  const busy = p.session.status === 'busy' || (p.session.status === undefined && !!t?.turnOpen)
  let state: Row['state'] = busy ? 'busy' : 'idle'
  if (screen.permission) state = 'permission'
  else if (proto?.kind === 'question') state = 'question'
  else if (proto?.kind === 'done' && !busy) state = 'done'
  const row: Row = { name: p.name, state, rssKb: p.rssKb || undefined }
  if (proto?.kind === 'progress') row.step = (proto.n ? `${proto.n}/${proto.total} ` : '') + proto.text
  else if (proto) row.step = proto.text
  if (t && busy && t.action) row.action = t.action
  if (t && t.taskAt) row.elapsedMs = Math.max(0, (busy ? now : t.lastAt) - t.taskAt)
  else if (p.session.startedAt) row.elapsedMs = Math.max(0, now - p.session.startedAt)
  if (screen.cost !== undefined) row.cost = screen.cost
  else if (t && t.tokensIn + t.tokensOut > 0) row.tokens = t.tokensIn + t.tokensOut
  if (screen.ctxPct !== undefined) row.ctxPct = screen.ctxPct
  else if (t && t.ctxTokens) row.ctxTokens = t.ctxTokens
  return row
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function truncate(s: string, max: number): string {
  if (max <= 0) return ''
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…'
}

const ICON: Record<Row['state'], string> = { busy: '⚙', idle: '·', question: '?', permission: '⚠', done: '✓' }
const LABEL: Record<Row['state'], string> = {
  busy: 'busy', idle: 'idle', question: 'question', permission: 'waiting for permission', done: 'done',
}

export type Segments = { icon: string; name: string; state: string; step: string; action: string; tail: string }

/** Splits the row into the parts drawn, fitted to `width` columns: the action gives way first, then the step. */
export function formatRow(r: Row, width: number): Segments {
  const tail: string[] = []
  if (r.elapsedMs !== undefined) tail.push(formatDuration(r.elapsedMs))
  if (r.cost !== undefined) tail.push(`$${r.cost.toFixed(2)}`)
  else if (r.tokens) tail.push(`${formatCount(r.tokens)} tok`)
  if (r.ctxPct !== undefined) tail.push(`ctx ${Math.round(r.ctxPct)}%`)
  else if (r.ctxTokens) tail.push(`ctx ${formatCount(r.ctxTokens)}`)
  if (r.rssKb) tail.push(`${Math.round(r.rssKb / 1024)} MB`)
  const seg: Segments = {
    icon: ICON[r.state], name: r.name, state: LABEL[r.state],
    step: r.step ? oneLine(r.step) : '', action: r.action ? oneLine(r.action) : '',
    tail: tail.join(' · '),
  }
  const SEP = 3 // " · "
  const fixed = seg.icon.length + 1 + seg.name.length + SEP + seg.state.length + (seg.tail ? SEP + seg.tail.length : 0)
  let room = width - fixed
  if (seg.step) {
    const max = Math.min(seg.step.length, Math.max(12, Math.floor(room * 0.45)))
    seg.step = room - SEP >= 6 ? truncate(seg.step, Math.min(max, room - SEP)) : ''
    room -= seg.step ? seg.step.length + SEP : 0
  }
  seg.action = seg.action && room - SEP >= 8 ? truncate(seg.action, room - SEP) : ''
  return seg
}

/** The row as one plain line (tests, logs). */
export function rowText(s: Segments): string {
  return [`${s.icon} ${s.name}`, s.state, s.step, s.action, s.tail].filter(Boolean).join(' · ')
}
