import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Runs under `claude plugin test .`: the band's hooks against the engine, with the
// poll's shell output and the files answered here instead of a real tmux.

const BAND = {
  plugin: 'subsessions',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 6, bodyColumns: 150,
    scroll: { offset: 0, bodyRows: 6 }, view: {},
  },
} as const

const POLL = 'CFG\t/h/.claude\n\x1esub-teste\t4242\t419840\n' +
  '{"sessionId":"s1","cwd":"/w","status":"busy","startedAt":1000}\n' +
  '❯ \nCtx Used: 5.0% | Model: Haiku 5.5\nCost: $0.21\n'

const engine = (on: On, stdout: string): void => {
  mock.clock(on, { now: 81_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.stat', () => ({ deny: 'no transcript in this test' }))
  on('session.receive', (_, e) => ({ text: e.text }))
}

const DELIVERY = '<cross-session-message from="uds:/tmp/x.sock" from-name="sub-teste" from-mode="bypass">\nprogress: git status (2/3)\n</cross-session-message>'

test('a running subsession gets a row in the terminal and the desktop app', async ($, on) => {
  engine(on, POLL)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const passed = await $.session.receive({ origin: { kind: 'peer-send-message' }, text: DELIVERY } as never)
  expect(passed).toEqual({ text: DELIVERY }) // the message reaches the model unchanged
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const row = await ui.find({ type: 'Text', text: /sub-teste/ })
    expect(row?.text).toBe('⚙ sub-teste · busy · 2/3 git status · 1m20s · $0.21 · ctx 5% · 410 MB')
    await ui.unmount()
  }
})

test('nothing is drawn while no subsession runs', async ($, on) => {
  engine(on, 'CFG\t/h/.claude\n')
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /sub-/ })).toBeUndefined()
    await ui.unmount()
  }
})
