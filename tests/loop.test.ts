import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// The test's hooks stand for the engine beneath the mod: git answers from a
// table, the decision fork and the reviewer from canned replies, and every
// prompt the mod submits is recorded instead of starting a turn.

const USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const PRESENTATION = { isFullscreen: false, columns: 120 }
const COMPOSER = { kind: 'composer' } as const
const PASS = '{"verdict":"pass","summary":"task accomplished","findings":[]}'
const VERIFY = '{"action":"verify","reason":"the worker reports done"}'

type Replies = { decision?: string; review?: string; checkExit?: number; isReviewAborted?: boolean }

function world(on: On, replies: Replies = {}) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 4, 8) })
  mock.env(on, { OS: 'Windows_NT' })
  const submitted: string[] = []
  const argvs: string[] = []
  const run = (stdout: string, exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('process.run', ($, e) => {
    const line = e.argv.join(' ')
    argvs.push(line)
    if (line === 'git rev-parse --show-toplevel') return run('D:/repo\n')
    if (line === 'git rev-parse HEAD') return run('abc1234\n')
    if (line === 'git rev-parse --absolute-git-dir') return run('D:/repo/.git\n')
    if (line.startsWith('git symbolic-ref')) return run('feat/x\n')
    if (line.startsWith('git diff --check')) return run('', replies.checkExit ?? 0)
    return run('')
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.write', () => ({ value: undefined }))
  on('model.fork', () => ({ value: { isAnswered: true, text: replies.decision ?? VERIFY, usage: USAGE } }))
  on('model.complete', () =>
    replies.isReviewAborted === true
      ? { value: { isAnswered: false, reason: 'aborted', usage: USAGE } }
      : { value: { isAnswered: true, text: replies.review ?? PASS, usage: USAGE } },
  )
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return { clock, submitted, argvs }
}

function supervise($: Engine, args: string): Promise<string> {
  return $.command.run({ command: 'supervise', args, origin: COMPOSER, presentation: PRESENTATION }).then(r => r.text ?? '')
}

/** Starts a task and lets its first prompt reach the Worker, as it does before any Worker turn ends. */
async function startTask($: Engine, w: { clock: { settle: () => Promise<void> } }, args: string): Promise<string> {
  const text = await supervise($, args)
  await w.clock.settle()
  return text
}

/** A shell call by name: the tools table is this machine's (Bash on Linux and macOS, PowerShell on Windows). */
function shell($: Engine, tool: 'Bash' | 'PowerShell', command: string) {
  return $.tool.call({ tool, command } as unknown as Parameters<Engine['tool']['call']>[0])
}

function endTurn($: Engine, answer: string, extra: { agentId?: string; reason?: 'answer' | 'aborted' } = {}) {
  const reason = extra.reason ?? 'answer'
  return $.turn.complete({ answer, durationMs: 1000, isAborted: reason === 'aborted', turnId: 'turn-1', reason, agentId: extra.agentId })
}

test('a finished turn is verified, reviewed and completed', async ($, on) => {
  const w = world(on, { review: `Looks fine.\n${PASS}` })
  expect(await supervise($, 'start add a login page')).toContain('已启动监督任务')
  await w.clock.settle()
  expect(w.submitted[0]).toContain('add a login page')

  await endTurn($, 'done, committed')
  await w.clock.settle()

  const status = await supervise($, 'status')
  expect(status).toContain('已完成')
  expect(status).toContain('轮次 1/40')
  expect(status).toContain('Review：pass')
  expect(w.argvs).toContain('git diff --check abc1234')
})

test('a failed check sends a repair turn', async ($, on) => {
  const w = world(on, { checkExit: 2 })
  await startTask($, w, 'fix the bug')
  await endTurn($, 'fixed')
  await w.clock.settle()

  expect(await supervise($, 'status')).toContain('Worker 工作中')
  expect(w.submitted.at(-1)).toContain('第 1/3 轮修复')
  expect(w.submitted.at(-1)).toContain('diff-check')
})

test('a revise verdict sends the findings back', async ($, on) => {
  const w = world(on, {
    review: '{"verdict":"revise","summary":"empty input crashes","findings":[{"severity":"P1","message":"parse(\\"\\") throws","file":"src/parse.ts:12","requiredFix":"return null for empty input"}]}',
  })
  await startTask($, w, 'start parse dates')
  await endTurn($, 'parser written')
  await w.clock.settle()

  expect(w.submitted.at(-1)).toContain('return null for empty input')
  expect(await supervise($, 'status')).toContain('修复 1/3')
})

test('a continue decision hands the Worker its next instruction', async ($, on) => {
  const w = world(on, { decision: 'Sure.\n{"action":"continue","message":"Also add tests for the empty input case.","reason":"tests missing"}' })
  await startTask($, w, 'start parse dates')
  await endTurn($, 'parser written')
  await w.clock.settle()

  expect(await supervise($, 'status')).toContain('Worker 工作中')
  expect(w.submitted.at(-1)).toContain('Also add tests for the empty input case.')
})

test("a subagent's turn does not move the task", async ($, on) => {
  const w = world(on)
  await startTask($, w, 'start refactor')
  await endTurn($, 'subagent answer', { agentId: 'agent-1' })
  await w.clock.settle()

  const status = await supervise($, 'status')
  expect(status).toContain('Worker 工作中')
  expect(status).toContain('轮次 0/40')
})

test('an interrupted turn pauses the task until resume', async ($, on) => {
  const w = world(on)
  await startTask($, w, 'start refactor')
  await endTurn($, 'half way', { reason: 'aborted' })
  await w.clock.settle()
  expect(await supervise($, 'status')).toContain('已暂停')

  await supervise($, 'resume')
  await w.clock.settle()
  expect(await supervise($, 'status')).toContain('已完成')
})

test('a resume while the Worker turn still runs waits for that turn to end', async ($, on) => {
  const w = world(on)
  await startTask($, w, 'start refactor')
  await $.turn.start({ text: w.submitted[0] ?? '', turnId: 'turn-1' })
  await supervise($, 'pause')
  expect(await supervise($, 'resume')).toContain('这一轮结束')
  await w.clock.settle()

  // No decision on half a turn: nothing verified, no second instruction queued behind the running turn.
  expect(await supervise($, 'status')).toContain('Worker 工作中')
  expect(w.submitted).toHaveLength(1)
  expect(w.argvs.some(line => line.startsWith('git diff --check'))).toBe(false)

  await endTurn($, 'done, committed')
  await w.clock.settle()
  const status = await supervise($, 'status')
  expect(status).toContain('已完成')
  expect(status).toContain('轮次 1/40')
})

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('the band draws the task on every surface and its buttons act on it', async ($, on) => {
  const w = world(on)
  await startTask($, w, 'start add a login page')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'auto-coding', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /AUTO-CODING T\d+ Worker 工作中/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /add a login page/ })).toBeDefined()
    for (const key of ['panel', 'pause', 'stop', 'hide']) expect(await ui.find({ key })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'auto-coding', surface: 'terminal', ...BAND })
  await ui.press({ key: 'pause' })
  expect(await supervise($, 'status')).toContain('已暂停')
  expect(await ui.find({ key: 'resume' })).toBeDefined()
  await ui.press({ key: 'stop' })
  expect(await supervise($, 'status')).toContain('已停止')
  expect(await ui.find({ key: 'clear' })).toBeDefined()
  await ui.unmount()
})

const pane = (bodyColumns: number) =>
  ({
    component: 'Pane',
    requestId: 'auto-coding',
    props: { title: 'auto-coding', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  }) as const

const STAGES = ['worker', 'decide', 'verify', 'review', 'done']

test('the panel draws a complete layout before any task', async ($, on) => {
  world(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'auto-coding', surface, ...pane(110) })
    expect(await ui.find({ type: 'Text', text: /AUTO-CODING.*no task.*IDLE/ })).toBeDefined()
    for (const stage of STAGES) expect(await ui.find({ key: `stage-${stage}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /没有监督任务/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /等待第一个事件/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the panel follows the task: active stage, log, budget, boundary', async ($, on) => {
  const w = world(on, { checkExit: 2 })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  await startTask($, w, 'start add a login page')
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const columns of [110, 60]) {
      const ui = await $.ui.mount({ plugin: 'auto-coding', surface, ...pane(columns) })
      expect(await ui.find({ type: 'Text', text: /AUTO-CODING.*T\d+.*Worker 工作中/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /启动：add a login page/ })).toBeDefined()
      expect(await ui.find({ key: 'pause' })).toBeDefined()
      await ui.unmount()
    }
  }

  const ui = await $.ui.mount({ plugin: 'auto-coding', surface: 'terminal', ...pane(110) })
  expect((await ui.find({ key: 'stage-worker' }))?.props.borderColor).toBe('#86e1e6')
  expect((await ui.find({ key: 'stage-review' }))?.props.borderColor).toBe('#3a4154')

  await shell($, 'Bash', 'git tag v1.0.0')
  await endTurn($, 'done')
  await w.clock.settle()
  // the check failed, so the task is back with the Worker on a repair round
  expect(await ui.find({ type: 'Text', text: /diff-check 失败/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /修复轮 1\/3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◆ tag/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /拦截 1/ })).toBeDefined()
  expect((await ui.find({ key: 'stage-verify' }))?.props.borderColor).toBe('#f08c8c')
  await ui.unmount()
})

test('the panel animates only while the task is working', async ($, on) => {
  const w = world(on)
  let redraws = 0
  on('ui.invalidate', () => {
    redraws += 1
    return { value: undefined }
  })
  await startTask($, w, 'start refactor')
  await w.clock.advance(1_000)
  expect(redraws).toBeGreaterThan(2)

  await supervise($, 'pause')
  await w.clock.advance(400)
  const settled = redraws
  await w.clock.advance(2_000)
  expect(redraws).toBe(settled)
})

test('a review cut short pauses the task instead of parking it', async ($, on) => {
  const w = world(on, { isReviewAborted: true })
  await startTask($, w, 'start add a login page')
  await endTurn($, 'done')
  await w.clock.settle()
  const status = await supervise($, 'status')
  expect(status).toContain('已暂停')
  expect(status).toContain('Review 被中断或超时')
})

test('the boundary denies merges and releases only while a task is active', async ($, on) => {
  const w = world(on)
  const ran: string[] = []
  on('tool.call', ($, e) => {
    ran.push(String(e.tool))
    return { result: 'ok', text: 'ok' }
  })

  const idle = await shell($, 'Bash', 'gh pr merge 3')
  expect(idle.deny).toBeUndefined()

  await supervise($, 'start ship it')
  await w.clock.settle()
  const merge = await shell($, 'Bash', 'gh pr merge 3 --squash')
  const publish = await shell($, 'PowerShell', 'npm publish')
  const push = await shell($, 'Bash', 'git push -u origin HEAD')
  const pr = await shell($, 'PowerShell', 'gh pr create --fill')

  expect(merge.deny).toContain('gh pr merge')
  expect(publish.deny).toContain('npm publish')
  expect(push.deny).toBeUndefined()
  expect(pr.deny).toBeUndefined()
  expect(ran).toEqual(['Bash', 'Bash', 'PowerShell'])
})
