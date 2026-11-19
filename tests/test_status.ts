// Unit tests for the status band's parsing (hooks/status.ts). Plain Node 22.18+ (runs .ts directly).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildRow, describeTool, emptyTranscript, foldTranscript, formatDuration, formatRow, parseDelivery,
  parsePoll, parseProtocol, parseScreen, rowText, transcriptPath,
} from '../hooks/status.ts'
import type { Polled } from '../hooks/status.ts'

test('parseProtocol reads progress with step and count', () => {
  assert.deepEqual(parseProtocol('progress: read the files (2/5)', 7), { kind: 'progress', text: 'read the files', n: 2, total: 5, at: 7 })
  const p = parseProtocol('progress: listar repos (1/3) — 29 repos')
  assert.equal(p?.text, 'listar repos — 29 repos')
  assert.equal(p?.n, 1)
  assert.equal(p?.total, 3)
})

test('parseProtocol reads done, question, and progress without a count', () => {
  assert.equal(parseProtocol('done: 29 repos, 1 dirty')?.kind, 'done')
  assert.equal(parseProtocol('Question: which branch?')?.text, 'which branch?')
  assert.deepEqual(parseProtocol('progress: warming up'), { kind: 'progress', text: 'warming up', at: 0 })
  assert.equal(parseProtocol('just chatting'), null)
  assert.equal(parseProtocol(''), null)
  assert.equal(parseProtocol('done: first line\nmore lines')?.text, 'first line')
})

test('parseDelivery takes the sender from a wrapped message, or the bare body', () => {
  const wrapped = 'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/x.sock" from-name="sub-a" from-mode="bypass">\nprogress: one (1/2)\n</cross-session-message>\n\nThis came from another session.'
  assert.deepEqual(parseDelivery(wrapped), [{ from: 'sub-a', body: 'progress: one (1/2)' }])
  assert.deepEqual(parseDelivery('done: ok'), [{ body: 'done: ok' }])
  assert.deepEqual(parseDelivery(''), [])
})

test('describeTool names the call briefly', () => {
  assert.equal(describeTool('Bash', { command: 'git  status\n--short' }), 'Bash: git status --short')
  assert.equal(describeTool('Read', { file_path: '/a/b/c.ts' }), 'Read: c.ts')
  assert.equal(describeTool('REPL', { code: 'const to="x";\nconst out = await $`rg -l foo`.text();' }), 'REPL: const out = await $`rg -l foo`.text();')
  assert.equal(describeTool('Mystery', {}), 'Mystery')
})

const rec = (o: object): string => JSON.stringify(o)
const USER_TASK = rec({ type: 'user', timestamp: '2026-11-19T08:27:16.000Z', message: { role: 'user', content: 'Another Claude session sent a message:\n<cross-session-message from-name="main">do it</cross-session-message>' } })
const REPL_CALL = rec({ type: 'assistant', timestamp: '2026-11-19T08:27:28.000Z', message: { id: 'm1', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', name: 'REPL', input: { code: 'await tools.Bash({command:"ls"})' } }], usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 400 } } })
const REPL_CALL_DUP = REPL_CALL // the same message id, written again (one record per content block)
const INNER_BASH = rec({ type: 'assistant', timestamp: '2026-11-19T08:27:43.000Z', message: { id: 'm2', model: '<synthetic>', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status --porcelain' } }], usage: { input_tokens: 0, output_tokens: 0 } } })
const SEND = rec({ type: 'assistant', timestamp: '2026-11-19T08:28:01.000Z', message: { id: 'm3', model: '<synthetic>', content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'uds:x', message: 'progress: git status (2/3)' } }] } })
const TOOL_RESULT = rec({ type: 'user', timestamp: '2026-11-19T08:28:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } })
const BLOB = rec({ type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'text', text: 'big' }] } })
const FINAL = rec({ type: 'assistant', timestamp: '2026-11-19T08:28:05.000Z', message: { id: 'm4', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, cache_read_input_tokens: 10500, output_tokens: 50 } } })

test('foldTranscript follows the task, the last action, tokens and protocol lines', () => {
  const t = emptyTranscript()
  foldTranscript(t, [USER_TASK, REPL_CALL, REPL_CALL_DUP, BLOB, INNER_BASH].join('\n') + '\n')
  assert.equal(t.taskAt, Date.parse('2026-11-19T08:27:16.000Z'))
  assert.equal(t.action, 'Bash: git status --porcelain')
  assert.equal(t.tokensIn, 10002) // counted once despite the repeated record
  assert.equal(t.tokensOut, 400)
  assert.equal(t.ctxTokens, 10002)
  assert.equal(t.turnOpen, true)
  // A record cut in two by the read is finished by the next chunk.
  foldTranscript(t, SEND.slice(0, 40))
  assert.equal(t.protocol, null)
  foldTranscript(t, SEND.slice(40) + '\n' + TOOL_RESULT + '\n' + FINAL + '\n')
  assert.equal(t.protocol?.kind, 'progress')
  assert.equal(t.protocol?.n, 2)
  assert.equal(t.taskAt, Date.parse('2026-11-19T08:27:16.000Z')) // a tool result is no new task
  assert.equal(t.turnOpen, false)
  assert.equal(t.ctxTokens, 10501)
  // A new task clears the old step.
  foldTranscript(t, USER_TASK.replace('08:27:16', '08:30:00') + '\n')
  assert.equal(t.protocol, null)
  assert.equal(t.action, '')
})

test('parseScreen reads the status line and a permission prompt', () => {
  const s = parseScreen('❯ \n Ctx Used: 5.0% | Model: Sonnet 5.5\n Cost: $0.27 | Session: 2m')
  assert.equal(s.ctxPct, 5)
  assert.equal(s.cost, 0.27)
  assert.equal(s.permission, false)
  assert.equal(parseScreen(' Do you want to proceed?\n ❯ 1. Yes\n   2. No').permission, true)
  assert.deepEqual(parseScreen(''), { permission: false })
})

test('parsePoll splits subsessions', () => {
  const out = 'CFG\t/h/.claude\n\x1esub-a\t123\t419840\n{"sessionId":"s1","cwd":"/w/x.y","status":"busy","startedAt":1000}\nline 1\nCost: $0.10\n\x1esub-b\t456\t\n\nnothing\n'
  const { configDir, subs } = parsePoll(out)
  assert.equal(configDir, '/h/.claude')
  assert.equal(subs.length, 2)
  assert.equal(subs[0]?.name, 'sub-a')
  assert.equal(subs[0]?.pid, 123)
  assert.equal(subs[0]?.rssKb, 419840)
  assert.equal(subs[0]?.session.sessionId, 's1')
  assert.match(subs[0]?.screen ?? '', /Cost: \$0.10/)
  assert.deepEqual(subs[1]?.session, {})
  assert.deepEqual(parsePoll('CFG\t/h\n').subs, [])
  assert.equal(transcriptPath('/h/.claude', '/w/x.y/AI-Tools', 's1'), '/h/.claude/projects/-w-x-y-AI-Tools/s1.jsonl')
})

const polled = (o: Partial<Polled> = {}): Polled => ({
  name: 'sub-teste', pid: 1, rssKb: 410 * 1024,
  session: { sessionId: 's', cwd: '/w', status: 'busy', startedAt: 0 },
  screen: 'Ctx Used: 5.0% | Model: Sonnet 5.5\nCost: $0.21', ...o,
})

test('buildRow picks the state', () => {
  const t = emptyTranscript()
  foldTranscript(t, [USER_TASK, REPL_CALL, INNER_BASH].join('\n') + '\n')
  const now = Date.parse('2026-11-19T08:28:36.000Z')
  const busy = buildRow(polled(), t, null, now)
  assert.equal(busy.state, 'busy')
  assert.equal(busy.elapsedMs, 80_000)
  assert.equal(busy.cost, 0.21)
  assert.equal(busy.ctxPct, 5)
  assert.equal(busy.action, 'Bash: git status --porcelain')
  const step = buildRow(polled(), t, parseProtocol('progress: git status (2/3)', now - 1000), now)
  assert.equal(step.step, '2/3 git status')
  assert.equal(buildRow(polled({ screen: 'Do you want to proceed?\n❯ 1. Yes' }), t, null, now).state, 'permission')
  assert.equal(buildRow(polled(), t, parseProtocol('question: which one?', now), now).state, 'question')
  const idle = polled({ session: { sessionId: 's', cwd: '/w', status: 'idle' } })
  const done = buildRow(idle, t, parseProtocol('done: 29 repos', now), now)
  assert.equal(done.state, 'done')
  assert.equal(done.action, undefined)
  assert.equal(buildRow(idle, t, null, now).state, 'idle')
  // A received line older than the current task is ignored.
  assert.equal(buildRow(polled(), t, parseProtocol('done: old', 5), now).step, undefined)
  // Without a screen status line, tokens stand in for cost and context.
  const plain = buildRow(polled({ screen: '' }), t, null, now)
  assert.equal(plain.cost, undefined)
  assert.equal(plain.tokens, 10402)
  assert.equal(plain.ctxTokens, 10002)
})

test('formatRow fits the width, cutting the action first', () => {
  const row = {
    name: 'sub-teste', state: 'busy' as const, step: '2/3 git status', action: 'REPL: ' + 'rg -l something '.repeat(20),
    elapsedMs: 80_000, cost: 0.21, ctxPct: 5, rssKb: 410 * 1024,
  }
  const wide = rowText(formatRow(row, 150))
  assert.ok(wide.length <= 150, `${wide.length}`)
  assert.match(wide, /^⚙ sub-teste · busy · 2\/3 git status · REPL: rg -l .*… · 1m20s · \$0\.21 · ctx 5% · 410 MB$/)
  const narrow = formatRow(row, 60)
  assert.equal(narrow.action, '')
  assert.ok(rowText(narrow).length <= 60, rowText(narrow))
  assert.equal(rowText(formatRow({ name: 'x', state: 'done', step: 'all good' }, 100)), '✓ x · done · all good')
  assert.equal(rowText(formatRow({ name: 'x', state: 'idle', tokens: 12_345, ctxTokens: 52_000 }, 100)), '· x · idle · 12k tok · ctx 52k')
})

test('formatDuration', () => {
  assert.equal(formatDuration(5_400), '5s')
  assert.equal(formatDuration(80_000), '1m20s')
  assert.equal(formatDuration(3_725_000), '1h02m')
})
