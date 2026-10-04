import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'

// The test's hooks stand for the engine beneath the mod: git answers from a
// table, the decision fork and the reviewer from canned replies, and every
// prompt the mod submits is recorded instead of starting a turn.

const USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const PRESENTATION = { isFullscreen: false, columns: 120 }
const COMPOSER = { kind: 'composer' } as const
const PASS = '{"verdict":"pass","summary":"task accomplished","findings":[]}'
const VERIFY = '{"action":"verify","reason":"the worker reports done"}'
/** An answer whose turn.complete fails beneath the mod. */
const CORE_FAILS = 'core fails'

type Replies = {
  decision?: string
  review?: string
  checkExit?: number
  isReviewAborted?: boolean
  isForkHeld?: boolean
  isCheckHeld?: boolean
  /** What `git status` prints. */
  status?: string
}

function world(on: On, replies: Replies = {}) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 4, 8) })
  mock.env(on, { OS: 'Windows_NT' })
  const submitted: string[] = []
  const argvs: string[] = []
  const run = (stdout: string, exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  // A held check answers only once the test releases it, so the test can act while the checks run.
  let releaseCheck = () => {}
  const checkReleased = new Promise<void>(resolve => {
    releaseCheck = resolve
  })
  on('process.run', async ($, e) => {
    const line = e.argv.join(' ')
    argvs.push(line)
    if (line === 'git rev-parse --show-toplevel') return run('D:/repo\n')
    if (line === 'git rev-parse HEAD') return run('abc1234\n')
    if (line === 'git rev-parse --absolute-git-dir') return run('D:/repo/.git\n')
    if (line.startsWith('git symbolic-ref')) return run('feat/x\n')
    if (line.startsWith('git diff --check')) {
      if (replies.isCheckHeld === true) await checkReleased
      return run('', replies.checkExit ?? 0)
    }
    if (line.startsWith('git status')) return run(replies.status ?? '')
    return run('')
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.write', () => ({ value: undefined }))
  // A held fork answers only once the test releases it, so the test can act while a decision is in flight.
  let releaseFork = () => {}
  const forkReleased = new Promise<void>(resolve => {
    releaseFork = resolve
  })
  const forks: string[] = []
  on('model.fork', async ($, e) => {
    forks.push(e.prompt)
    if (replies.isForkHeld === true) await forkReleased
    return { value: { isAnswered: true, text: replies.decision ?? VERIFY, usage: USAGE } }
  })
  const reviews: string[] = []
  on('model.complete', ($, e) => {
    reviews.push(e.prompt)
    return replies.isReviewAborted === true
      ? { value: { isAnswered: false, reason: 'aborted', usage: USAGE } }
      : { value: { isAnswered: true, text: replies.review ?? PASS, usage: USAGE } }
  })
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => {
    if (e.answer === CORE_FAILS) throw new Error('turn.complete failed beneath the mod')
    return { text: e.answer }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return { clock, submitted, argvs, forks, reviews, releaseFork, releaseCheck }
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

test('the reviewer is told of every untracked file, whatever its name, even one it cannot read', async ($, on) => {
  // `-z` output: NUL-separated, never quoted; a rename carries its source as a field of its own.
  const w = world(on, { status: 'R  src/renamed.ts\0src/original.ts\0?? 说明.md\0?? src/new.ts\0' })
  await startTask($, w, 'start add notes')
  await endTurn($, 'done')
  await w.clock.settle()

  const review = w.reviews.at(-1) ?? ''
  expect(review).toContain('说明.md')
  expect(review).toContain('src/new.ts')
  expect(review).not.toContain('src/original.ts')
  expect(w.argvs).toContain('git status --porcelain -z --untracked-files=all')
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

test('a turn that ends while paused counts, and its reply is what the decision reads', async ($, on) => {
  const w = world(on)
  await startTask($, w, 'start refactor')
  await $.turn.start({ text: w.submitted[0] ?? '', turnId: 'turn-1' })
  await supervise($, 'pause')
  await endTurn($, 'the reply that ended after the pause')
  await w.clock.settle()
  const paused = await supervise($, 'status')
  expect(paused).toContain('已暂停')
  expect(paused).toContain('轮次 1/40')

  expect(await supervise($, 'resume')).not.toContain('这一轮结束')
  await w.clock.settle()
  expect(w.forks.at(-1)).toContain('the reply that ended after the pause')
  const status = await supervise($, 'status')
  expect(status).toContain('已完成')
  expect(status).toContain('轮次 1/40')
})

/** Pauses and resumes the task, and says whether the resume waited for a turn in flight. */
async function pauseAndResume($: Engine, w: { clock: { settle: () => Promise<void> } }): Promise<boolean> {
  await supervise($, 'pause')
  const waited = (await supervise($, 'resume')).includes('这一轮结束')
  await w.clock.settle()
  return waited
}

test('a fresh session start drops a turn marker whose end never came', async ($, on) => {
  const w = world(on)
  await startTask($, w, 'start refactor')
  await $.turn.start({ text: w.submitted[0] ?? '', turnId: 'turn-1' })
  await $.session.start({ cwd: 'D:/repo', surface: 'terminal', isInteractive: true })

  // No turn runs after the load, so a resume decides instead of waiting for a turn.complete that never comes.
  expect(await pauseAndResume($, w)).toBe(false)
  expect(await supervise($, 'status')).toContain('已完成')
})

test('a turn.complete that fails beneath the mod still ends the turn', async ($, on) => {
  const w = world(on)
  await startTask($, w, 'start refactor')
  await $.turn.start({ text: w.submitted[0] ?? '', turnId: 'turn-1' })
  await endTurn($, CORE_FAILS).catch(() => undefined)

  expect(await pauseAndResume($, w)).toBe(false)
  expect(await supervise($, 'status')).toContain('已完成')
})

test('a session that ends mid-turn leaves no turn in flight for the next task', async ($, on) => {
  const w = world(on)
  await startTask($, w, 'start refactor')
  await $.turn.start({ text: w.submitted[0] ?? '', turnId: 'turn-1' })
  await $.session.end({ reason: 'clear', sessionId: 's-1', resume: { id: 's-1' } })
  expect(await supervise($, 'status')).toContain('已停止')

  await w.clock.advance(1_000)
  expect(await startTask($, w, 'start add tests')).toContain('已启动监督任务')
  expect(await pauseAndResume($, w)).toBe(false)
  expect(await supervise($, 'status')).toContain('已完成')
})

test("a start waits for the stopped task's turn instead of taking it as its own", async ($, on) => {
  const w = world(on)
  await startTask($, w, 'start refactor')
  await $.turn.start({ text: w.submitted[0] ?? '', turnId: 'turn-1' })
  await supervise($, 'stop')
  expect(await supervise($, 'start add tests')).toContain('等这一轮结束')
  expect(w.submitted).toHaveLength(1)

  // The old turn ends under the stopped task and moves nothing; then the new task starts clean.
  await endTurn($, 'the old task answer')
  await w.clock.advance(1_000)
  expect(await startTask($, w, 'start add tests')).toContain('已启动监督任务')
  const status = await supervise($, 'status')
  expect(status).toContain('Worker 工作中')
  expect(status).toContain('轮次 0/40')
  expect(w.submitted).toHaveLength(2)
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

/** Settles turn.complete a second after it starts while the hooks beneath still run: the dispatch is abandoned, as Esc does. */
const IMPATIENT = {
  name: 'impatient',
  tier: 'prepend',
  register(on) {
    on('turn.complete', async ($, e, next) => {
      void next(e).catch(() => undefined)
      await $.clock.sleep(1_000)
      return { text: e.answer }
    })
  },
} as const satisfies Plugin

test('Esc during the checks pauses the task instead of sending a repair turn', { plugins: [IMPATIENT] }, async ($, on) => {
  const w = world(on, { checkExit: 2, isCheckHeld: true })
  await startTask($, w, 'start refactor')
  const ending = endTurn($, 'done')
  await w.clock.settle()
  expect(await supervise($, 'status')).toContain('验收检查中')

  await w.clock.advance(1_000)
  await ending
  w.releaseCheck()
  await w.clock.settle()
  const status = await supervise($, 'status')
  expect(status).toContain('已暂停')
  expect(status).toContain('验收被中断')
  expect(w.submitted).toHaveLength(1)
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

test('a long decision keeps its action at the head of the log row and the stage', async ($, on) => {
  const w = world(on, { decision: `{"action":"verify","reason":"${'x'.repeat(400)}"}` })
  await startTask($, w, 'start parse dates')
  await endTurn($, 'done')
  await w.clock.settle()
  const ui = await $.ui.mount({ plugin: 'auto-coding', surface: 'terminal', ...pane(60) })
  expect(await ui.find({ type: 'Text', text: /verify：x{20}/ })).toBeDefined()
  const stage = await ui.find({ key: 'stage-decide' })
  expect(stage?.text).toContain('verify')
  expect(stage?.text).not.toContain('xxxxxxxxxx')
  await ui.unmount()
})

test('a resume while a step still runs here does not run it a second time', async ($, on) => {
  const w = world(on, { isForkHeld: true })
  await startTask($, w, 'start refactor')
  const ending = endTurn($, 'done')
  await w.clock.settle()
  expect(await supervise($, 'status')).toContain('决策中')

  expect(await supervise($, 'resume')).toContain('仍在运行')
  await w.clock.settle()
  w.releaseFork()
  await ending
  await w.clock.settle()
  expect(w.forks).toHaveLength(1)
  expect(w.argvs.filter(line => line.startsWith('git diff --check'))).toHaveLength(1)
  expect(await supervise($, 'status')).toContain('已完成')
})

test('a decision a pause overtook is never logged or acted on', async ($, on) => {
  const w = world(on, { isForkHeld: true })
  await startTask($, w, 'start refactor')
  const ending = endTurn($, 'done')
  await w.clock.settle()
  await supervise($, 'pause')
  w.releaseFork()
  await ending
  await w.clock.settle()
  expect(await supervise($, 'status')).toContain('已暂停')
  const ui = await $.ui.mount({ plugin: 'auto-coding', surface: 'terminal', ...pane(110) })
  expect(await ui.find({ type: 'Text', text: /verify：/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /检查/ })).toBeDefined()
  await ui.unmount()
})

test('the system prompt carries the unattended rules only while the task is working', async ($, on) => {
  const w = world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'engine', scope: 'shared' as const }] }))
  const compose = async () =>
    (
      await $.prompt.compose({ model: 'opus', promptModel: 'opus', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    ).sections.find(s => s.id === 'auto-coding:unattended')

  expect(await compose()).toBeUndefined()
  await startTask($, w, 'start refactor')
  const section = await compose()
  expect(section?.scope).toBe('session')
  expect(section?.text).toContain('已预先授权')
  expect(section?.text).toContain('停下来问人')
  await supervise($, 'pause')
  expect(await compose()).toBeUndefined()
})
