import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, ProcessRunResult, Register, Timer } from 'claude-code'

import type { SuperviseCheck, SuperviseEvent, SuperviseReview, SuperviseRole, SuperviseStatus, SuperviseTask } from '../types'
import {
  CHECK_TIMEOUT_MS,
  DECISION_RETRY,
  EMPTY_TREE,
  LABEL,
  MAX_API_ERRORS,
  MAX_UNTRACKED_FILE,
  MAX_UNTRACKED_TOTAL,
  REVIEW_SYSTEM,
  REVIEW_TIMEOUT_MS,
  checksFeedback,
  decisionPrompt,
  diffSection,
  errorText,
  hasBudget,
  head,
  isActive,
  isWorking,
  parseDecision,
  parseReview,
  reviewFeedback,
  reviewPrompt,
  startPrompt,
  statusLine,
  supervisorObservations,
  unattendedSection,
  tail,
  untrackedPaths,
} from './logic'
import type { Decision, TurnEnd } from './logic'
import { TICK_MS, drawBand, drawPanel } from './panel'
import type { PanelActions } from './panel'
import { checkCommand, isProtected, needsBranch } from './policy'

// This session's main loop is the Worker; this module is its Supervisor.
// Every step re-checks the task's `seq` before it writes, so a step overtaken
// by a pause, a stop or a reload drops its result instead of acting on it.

type Engine = EngineInterface

const TASK = atom({ plugin: 'auto-coding', key: 'task' } as const, null)
const BAND_HIDDEN = atom({ plugin: 'auto-coding', key: 'isBandHidden' } as const, false)
const DENIALS = atom({ plugin: 'auto-coding', key: 'denials' } as const, [])
const EVENTS = atom({ plugin: 'auto-coding', key: 'events' } as const, [])
const WORKER_TURN = atom({ plugin: 'auto-coding', key: 'workerTurn' } as const, null)
const PROJECT_CONFIG = '.claude/auto-coding.json'
const PANE = 'auto-coding'
const MAX_EVENTS = 40

type Settings = {
  reviewerModel: string
  maxTurns: number
  maxRepairRounds: number
  deadlineMinutes: number
  protectedBranches: string[]
  publish: 'none' | 'push' | 'pr'
}

function settingsOf(options: PluginOptions): Settings {
  const count = (value: unknown, fallback: number) => (typeof value === 'number' && value > 0 ? Math.floor(value) : fallback)
  const publish = options.publish
  return {
    reviewerModel: typeof options.reviewerModel === 'string' && options.reviewerModel !== '' ? options.reviewerModel : 'opus',
    maxTurns: count(options.maxTurns, 40),
    maxRepairRounds: count(options.maxRepairRounds, 3),
    deadlineMinutes: count(options.deadlineMinutes, 240),
    protectedBranches: String(options.protectedBranches ?? 'main,master')
      .split(',')
      .map(name => name.trim())
      .filter(name => name !== ''),
    publish: publish === 'push' || publish === 'pr' ? publish : 'none',
  }
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options)

  on('session.start', async ($, e, next) => {
    // session.start comes before the first prompt or at a reload, which waits for the turn to end:
    // a turn still marked in flight now is one whose turn.complete never came.
    await update($, WORKER_TURN, () => null)
    await $.command.register({
      name: 'supervise',
      description: '无人值守开发监督：start <任务> | panel | status | pause | resume | stop | clear',
      argumentHint: 'start <任务> | panel | status | pause | resume | stop | clear',
    })
    const task = await read($, TASK)
    if (task !== null) {
      $.ui.status(statusLine(task))
      if (isWorking(task.status)) animate($)
      // A reload drops the step that was running; pick it up again.
      if (task.status === 'deciding' || task.status === 'verifying' || task.status === 'reviewing') {
        $.clock.after(1_000, () => detach($, inFlight(() => resumeStep($, task))))
      }
    }
    return next(e)
  })

  on('command.run', { command: 'supervise' }, async ($, e) => {
    const args = e.args.trim()
    const verb = args.split(/\s+/)[0] ?? ''
    const task = await read($, TASK)
    if (verb === '' || verb === 'status') return { text: describe(task) }
    if (verb === 'help') return { text: usage() }
    if (verb === 'panel') {
      const opened = await $.ui.open({ id: PANE, title: 'auto-coding' })
      return { text: opened.isPlaced ? '已打开 auto-coding 面板。' : `面板暂未显示：${opened.reason}` }
    }
    if (verb === 'start') return start($, settings, args.slice(verb.length).trim())
    if (!['pause', 'resume', 'stop', 'clear'].includes(verb)) return start($, settings, args)
    if (task === null) return { text: `没有监督任务。\n${usage()}` }
    if (verb === 'pause') {
      if (!isWorking(task.status)) return { text: `任务 ${task.id} ${LABEL[task.status]}，无需暂停。` }
      await patch($, task, { status: 'paused', note: '手动暂停；/supervise resume 恢复' })
      return { text: `已暂停 ${task.id}。当前这一轮会跑完，之后不再自动推进。` }
    }
    if (verb === 'resume') {
      const isStuck = task.status === 'deciding' || task.status === 'verifying' || task.status === 'reviewing'
      if (task.status !== 'paused' && !isStuck) return { text: `任务 ${task.id} ${LABEL[task.status]}，不在暂停状态。` }
      // Only a step a reload cut off is stuck; one still running here would run twice, side by side.
      if (isStuck && stepsInFlight > 0) return { text: `任务 ${task.id} ${LABEL[task.status]}：这一步仍在运行，无需恢复。` }
      const isTurnRunning = task.status === 'paused' && (await read($, WORKER_TURN)) !== null
      $.clock.after(0, () => detach($, inFlight(() => resumeStep($, task))))
      return {
        text: isTurnRunning
          ? `恢复 ${task.id}：Worker 这一轮还在进行，等这一轮结束后再决策。`
          : `恢复 ${task.id}：决策步骤先读一遍当前对话，再决定继续还是验收。`,
      }
    }
    if (verb === 'stop') {
      if (!isActive(task.status)) return { text: `任务 ${task.id} 已经${LABEL[task.status]}。` }
      await finish($, task, 'stopped', '手动停止')
      return { text: `已停止 ${task.id}。正在运行的这一轮不会被打断；硬边界随任务一起解除。` }
    }
    if (isActive(task.status)) return { text: `任务 ${task.id} 仍在进行，先 /supervise stop。` }
    await clearTask($)
    return { text: '已清除。' }
  })

  // Only the main loop raises turn.start: a resume waits for the turn in flight instead of deciding on half of it.
  on('turn.start', async ($, e, next) => {
    await update($, WORKER_TURN, () => e.turnId)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn is the Worker's own business, not a Worker turn.
    if (e.agentId !== undefined) return next(e)
    // The turn has ended whatever happens beneath: a failure there must not leave it marked in flight.
    await update($, WORKER_TURN, () => null)
    const result = await next(e)
    const task = await read($, TASK)
    if (task === null) return result
    const end: TurnEnd = {
      reason: e.reason,
      answer: e.answer,
      refusal: e.reason === 'refusal' ? (e.refusal.explanation ?? e.refusal.category ?? undefined) : undefined,
    }
    if (task.status === 'paused') {
      await notePausedTurn($, task, end)
      return result
    }
    if (task.status !== 'running' && task.status !== 'publishing') return result
    // The step runs inside this dispatch: the session stays busy until the next
    // Worker turn is queued, so a headless run does not exit half way.
    try {
      await inFlight(() => onWorkerTurn($, task, end, next.signal))
    } catch (error) {
      $.ui.log(`auto-coding: ${errorText(error)}`)
    }
    return result
  })

  // While the task is working, the system prompt says what is pre-authorized and that "stop and ask"
  // means "assume and go on"; a pause (a person typing) takes it away again.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const task = await read($, TASK)
    if (task === null || !isWorking(task.status)) return composed
    return { ...composed, sections: [...composed.sections, { id: 'auto-coding:unattended', text: unattendedSection(task), scope: 'session' }] }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      const task = await read($, TASK)
      if (task !== null && isWorking(task.status) && !e.text.trimStart().startsWith('/')) {
        await patch($, task, { status: 'paused', note: '你在会话里输入了消息，自动监督已暂停；/supervise resume 恢复' })
      }
    }
    return next(e)
  })

  // A machine registers Bash, PowerShell or both, so the shells are matched by name, not by its tools table.
  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    const command = 'command' in e && typeof e.command === 'string' ? e.command : undefined
    if (command === undefined) return next(e)
    const task = await read($, TASK)
    if (task === null || !isActive(task.status)) return next(e)
    const branch = needsBranch(command) ? await currentBranch($, task.cwd) : task.branch
    const reason = checkCommand(command, { branch, protectedBranches: task.protectedBranches })
    if (reason === undefined) return next(e)
    const tool = String(e.tool)
    void log($, task, 'boundary_denied', { tool, command: command.slice(0, 500), reason })
    await update($, DENIALS, list => [...list, `${tool}: ${command.slice(0, 300)} — ${reason}`].slice(-20))
    await record($, 'boundary', `拦截 ${command.slice(0, 120)}（${reason}）`, 'warn')
    return {
      deny:
        `[auto-coding] 硬边界：监督任务期间禁止合并与发版（${reason}）。` +
        '推送功能分支、gh pr create 不受影响；确需合并或发版，由人在 /supervise stop 之后执行。',
    }
  })

  on('tool.call', { tool: ['AskUserQuestion', 'EnterPlanMode'] }, async ($, e, next) => {
    const task = await read($, TASK)
    if (task === null || !isWorking(task.status)) return next(e)
    return {
      deny:
        e.tool === 'AskUserQuestion'
          ? '[auto-coding] 无人值守任务：不要提问。选择与任务最相容的合理假设，在回复里写明假设，然后继续。'
          : '[auto-coding] 无人值守任务：不要进入 Plan Mode（它要等人批准）。在回复里简述计划后直接实施。',
    }
  })

  on('session.end', async ($, e, next) => {
    const task = await read($, TASK)
    if (task !== null && isActive(task.status)) await finish($, task, 'stopped', `会话结束（${e.reason}）`)
    // No turn outlives its session, and after a /clear no session.start comes to drop the marker.
    await update($, WORKER_TURN, () => null)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const task = await read($, TASK)
    if (task === null || e.props.hasSurvey || (await read($, BAND_HIDDEN))) return next(e)
    const model = { task, events: [], denials: [], now: await $.clock.now(), columns: e.props.bodyColumns, rows: 0, actions: actionsFor($) }
    return drawBand($.ui.resolve(e), model) ?? next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    drawPanel($.ui.resolve(e), {
      task: await read($, TASK),
      events: await read($, EVENTS),
      denials: await read($, DENIALS),
      now: await $.clock.now(),
      columns: e.props.bodyColumns,
      rows: e.props.scroll.bodyRows,
      actions: actionsFor($),
    }),
  )
}

// ---------------------------------------------------------------- state

/** Runs a step outside the dispatch that started it; a failure is logged, never left unhandled. */
function detach($: Engine, step: Promise<unknown>): void {
  step.catch(error => {
    try {
      $.ui.log(`auto-coding: ${errorText(error)}`)
    } catch {
      // the session that started the step is gone
    }
  })
}

async function patch($: Engine, task: SuperviseTask, change: Partial<SuperviseTask>): Promise<SuperviseTask | undefined> {
  let applied: SuperviseTask | undefined
  await update($, TASK, current => {
    applied = undefined
    if (current === null || current.id !== task.id || current.seq !== task.seq) return current
    applied = { ...current, ...change, seq: current.seq + 1 }
    return applied
  })
  if (applied === undefined) return undefined
  $.ui.status(statusLine(applied))
  if (isWorking(applied.status)) animate($)
  if (change.status !== undefined && change.status !== task.status) {
    void log($, applied, 'status', { from: task.status, to: applied.status, note: applied.note })
    if (!isWorking(applied.status)) {
      const tone = applied.status === 'completed' ? 'ok' : applied.status === 'failed' ? 'bad' : applied.status === 'stopped' ? undefined : 'warn'
      await record($, 'task', `${LABEL[applied.status]}${applied.note === undefined ? '' : `：${applied.note}`}`, tone)
    }
  }
  return applied
}

/** Adds a row to the panel's session log. */
async function record($: Engine, who: SuperviseRole, text: string, tone?: SuperviseEvent['tone']): Promise<void> {
  const event: SuperviseEvent = { at: await $.clock.now(), who, text: head(text, 300) }
  if (tone !== undefined) event.tone = tone
  await update($, EVENTS, list => [...list, event].slice(-MAX_EVENTS))
}

let ticker: Timer | undefined

/** Redraws the band and the panel a few times a second, only while the task is working. */
function animate($: Engine): void {
  if (ticker !== undefined) return
  ticker = $.clock.every(TICK_MS, () => detach($, tick($)))
}

async function tick($: Engine): Promise<void> {
  const task = await read($, TASK)
  if (task === null || !isWorking(task.status)) {
    ticker?.cancel()
    ticker = undefined
  }
  $.ui.invalidate('ui.render')
}

function actionsFor($: Engine): PanelActions {
  return {
    pause: () => detach($, pauseFromBand($)),
    resume: () => void $.clock.after(0, () => detach($, resumeFromBand($))),
    stop: () => detach($, stopFromBand($)),
    clear: () => detach($, clearTask($)),
    open: () => detach($, $.ui.open({ id: PANE, title: 'auto-coding' })),
    hide: () => detach($, update($, BAND_HIDDEN, () => true)),
  }
}

async function finish($: Engine, task: SuperviseTask, status: SuperviseStatus, note: string): Promise<void> {
  const done = await patch($, task, { status, note, endedAt: await $.clock.now() })
  if (done !== undefined) $.ui.toast(`auto-coding ${done.id}：${LABEL[status]}。${note}`)
}

let logQueue: Promise<void> = Promise.resolve()

/** Appends one JSON line to `<gitDir>/auto-coding/<id>.jsonl`; never throws. */
function log($: Engine, task: SuperviseTask, type: string, detail?: unknown): Promise<void> {
  logQueue = logQueue
    .then(async () => {
      const path = `${task.gitDir}/auto-coding/${task.id}.jsonl`
      const at = new Date(await $.clock.now()).toISOString()
      const line = `${JSON.stringify({ at, task: task.id, seq: task.seq, status: task.status, type, detail })}\n`
      let before = ''
      try {
        before = String(await $.fs.read(path))
      } catch {
        before = ''
      }
      await $.fs.write(path, before + line)
    })
    .catch(() => undefined)
  return logQueue
}

// ---------------------------------------------------------------- the loop

// Steps running in this environment. A reload starts it at 0: that is how a deciding, verifying
// or reviewing task a reload cut off is told from one whose step is still at work.
let stepsInFlight = 0

async function inFlight(step: () => Promise<void>): Promise<void> {
  stepsInFlight += 1
  try {
    await step()
  } finally {
    stepsInFlight -= 1
  }
}

/** `signal` is the turn.complete dispatch's: it aborts when the person presses Esc during the steps. */
async function onWorkerTurn($: Engine, task: SuperviseTask, end: TurnEnd, signal: AbortSignal): Promise<void> {
  if (task.status === 'publishing') return finishPublish($, task)
  const turns = task.turns + 1
  await record($, 'worker', `第 ${turns} 轮结束${end.reason === 'answer' ? '' : `（${end.reason}）`}`, end.reason === 'answer' ? undefined : 'warn')
  if (end.reason === 'aborted') {
    await patch($, task, { status: 'paused', turns, note: '你中断了这一轮；/supervise resume 恢复自动监督' })
    return
  }
  if (end.reason === 'refusal') return finish($, task, 'blocked', `模型拒绝继续：${end.refusal ?? '未说明'}`)
  if (end.reason === 'error') {
    const errors = task.errors + 1
    if (errors > MAX_API_ERRORS) return finish($, task, 'failed', `Worker 连续 ${errors} 轮 API 错误`)
    const waiting = await patch($, task, { status: 'deciding', turns, errors, note: `API 错误，${errors * 30}s 后重试` })
    if (waiting !== undefined) {
      $.clock.after(errors * 30_000, () => detach($, send($, waiting, 'running', '上一轮因 API 错误中断。从中断处继续完成任务。')))
    }
    return
  }
  const deciding = await patch($, task, { status: 'deciding', turns, errors: 0, lastAnswer: tail(end.answer, 4000), note: undefined })
  if (deciding !== undefined) await decide($, deciding, signal)
}

/**
 * A turn that ends while paused (the one the pause let finish, or the person's own) is still a turn
 * of the task's session and its latest reply: it counts against the budget, and the decision on
 * resume reads it. Not a transition, so `seq` stays and a resume already on its way still applies.
 */
async function notePausedTurn($: Engine, task: SuperviseTask, end: TurnEnd): Promise<void> {
  let noted: SuperviseTask | undefined
  await update($, TASK, current => {
    noted = undefined
    if (current === null || current.id !== task.id || current.status !== 'paused') return current
    noted = { ...current, turns: current.turns + 1 }
    if (end.reason === 'answer') noted.lastAnswer = tail(end.answer, 4000)
    return noted
  })
  if (noted === undefined) return
  $.ui.status(statusLine(noted))
  void log($, noted, 'turn_while_paused', { reason: end.reason, turns: noted.turns })
}

/** Picks up a step a reload cut off, or a paused task being resumed. */
async function resumeStep($: Engine, task: SuperviseTask): Promise<void> {
  if (task.status === 'verifying' || task.status === 'reviewing') return verify($, task, '重新验收（上一次被重载打断）')
  if (task.status !== 'deciding' && task.status !== 'paused') return
  // The turn in flight decides at its own turn.complete; deciding now would read half a turn and queue a second.
  if (task.status === 'paused' && (await read($, WORKER_TURN)) !== null) {
    await patch($, task, { status: 'running', note: '已恢复：等 Worker 这一轮结束后再决策' })
    return
  }
  const deciding = await patch($, task, { status: 'deciding', note: undefined })
  if (deciding !== undefined) await decide($, deciding)
}

async function decide($: Engine, task: SuperviseTask, signal?: AbortSignal): Promise<void> {
  const now = await $.clock.now()
  if (!hasBudget(task, now)) return verify($, task, '轮次或时间预算已用尽，做最终验收', undefined, signal)
  const decision = await askDecision($, task, now)
  void log($, task, 'decision', decision)
  // The panel logs a decision once the transition it causes is written: a decision a
  // pause, a stop or a reload overtook never shows. park and pause log as the task's own row.
  if (decision.action === 'continue') {
    if (await send($, task, 'running', decision.message)) await record($, 'decide', `continue：${decision.message}`)
    return
  }
  if (decision.action === 'park') return finish($, task, 'blocked', `决策挂起：${decision.reason}`)
  if (decision.action === 'pause') {
    await patch($, task, { status: 'paused', note: decision.reason })
    return
  }
  return verify($, task, decision.reason === '' ? undefined : `准备验收：${decision.reason}`, `verify：${decision.reason}`, signal)
}

async function askDecision($: Engine, task: SuperviseTask, now: number): Promise<Decision> {
  const prompt = decisionPrompt(task, now)
  let ask = prompt
  let canFork = true
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reply = canFork
      ? await $.model.fork({ prompt: ask })
      : await $.model.complete({ model: task.reviewerModel, prompt: ask, maxTokens: 2048, timeoutMs: 180_000 })
    if (!reply.isAnswered) {
      if (reply.reason === 'aborted') return { action: 'pause', reason: '决策被中断或超时；/supervise resume 重试' }
      if (reply.reason === 'nothing-to-fork') canFork = false
      continue
    }
    const decision = parseDecision(reply.text)
    if (decision !== undefined) return decision
    ask = `${prompt}\n\n${DECISION_RETRY}`
  }
  return { action: 'verify', reason: '决策步骤没有给出有效动作，直接验收' }
}

/** `signal`: the turn.complete dispatch's, when the step runs inside one. */
async function verify($: Engine, task: SuperviseTask, note?: string, decided?: string, signal?: AbortSignal): Promise<void> {
  const verifying = await patch($, task, { status: 'verifying', note })
  if (verifying === undefined) return
  if (decided !== undefined) await record($, 'decide', decided)
  const checks = await runChecks($, verifying)
  void log($, verifying, 'checks', checks.map(({ id, command, isPassed, exitCode }) => ({ id, command, isPassed, exitCode })))
  // Esc while the checks ran: a check it cut short says nothing of the work, and the person took over.
  if (signal?.aborted === true) {
    await patch($, verifying, { status: 'paused', note: '验收被中断；/supervise resume 重新验收' })
    return
  }
  const checked = await patch($, verifying, { lastChecks: checks })
  if (checked === undefined) return
  const failed = checks.filter(check => !check.isPassed)
  await record(
    $,
    'verify',
    failed.length === 0 ? `检查 ${checks.length}/${checks.length} 通过` : failed.map(c => `${c.id} 失败（exit ${c.exitCode}）`).join('、'),
    failed.length === 0 ? 'ok' : 'bad',
  )
  if (failed.length > 0) {
    return repair($, checked, checksFeedback(failed), `验收检查未通过：${failed.map(check => check.id).join('、')}`)
  }
  return review($, checked)
}

async function runChecks($: Engine, task: SuperviseTask): Promise<SuperviseCheck[]> {
  const planned = [
    { id: 'diff-check', command: `git diff --check ${task.baseline.slice(0, 12)}`, argv: ['git', 'diff', '--check', task.baseline] },
    ...task.checks.map((command, i) => ({ id: `check-${i + 1}`, command, argv: [...task.shell, command] })),
  ]
  const results: SuperviseCheck[] = []
  for (const { id, command, argv } of planned) {
    try {
      const run = await $.process.run(argv, { cwd: task.cwd, timeoutMs: CHECK_TIMEOUT_MS })
      const output = `${run.stdout}\n${run.stderr}`.trim()
      results.push({ id, command, isPassed: run.exitCode === 0, exitCode: run.exitCode, tail: tail(output, 3000) })
    } catch (error) {
      results.push({ id, command, isPassed: false, exitCode: -1, tail: `未能运行（超时或命令不存在）：${errorText(error)}` })
    }
  }
  return results
}

async function review($: Engine, task: SuperviseTask): Promise<void> {
  const reviewing = await patch($, task, { status: 'reviewing' })
  if (reviewing === undefined) return
  const observed = supervisorObservations(reviewing, await read($, DENIALS))
  const result = await askReviewer($, reviewing, `${await collectEvidence($, reviewing)}\n\n${observed}`)
  void log($, reviewing, 'review', result)
  if ('error' in result && result.isInterrupted === true) {
    await patch($, reviewing, { status: 'paused', note: 'Review 被中断或超时；/supervise resume 重新验收' })
    return
  }
  if ('error' in result) return finish($, reviewing, 'blocked', `Reviewer 不可用：${result.error}`)
  const reviewed = await patch($, reviewing, { lastReview: result })
  if (reviewed === undefined) return
  await record($, 'review', `${result.verdict}：${result.summary}`, result.verdict === 'pass' ? 'ok' : 'warn')
  if (result.verdict === 'revise') return repair($, reviewed, reviewFeedback(result), `Review 要求修改：${result.summary}`)
  if (result.verdict === 'human') return finish($, reviewed, 'blocked', `Review 需要人工判断：${result.summary}`)
  if (reviewed.publish === 'none') return finish($, reviewed, 'completed', `验收与独立 Review 通过：${result.summary}`)
  return startPublish($, reviewed)
}

async function collectEvidence($: Engine, task: SuperviseTask): Promise<string> {
  const commits = await gitOrEmpty($, task.cwd, task.baseline === EMPTY_TREE ? ['log', '--oneline', '-n', '50'] : ['log', '--oneline', `${task.baseline}..HEAD`])
  const stat = await gitOrEmpty($, task.cwd, ['diff', '--stat', task.baseline])
  const diff = await gitOrEmpty($, task.cwd, ['diff', task.baseline])
  const status = await gitOrEmpty($, task.cwd, ['status', '--porcelain', '-z', '--untracked-files=all'])
  const sections = [
    `## Commits since baseline\n${commits.stdout.trim() || '(none)'}`,
    `## git diff --stat\n${stat.stdout.trim() || '(no tracked changes)'}`,
    diffSection(diff.stdout),
  ]
  const untracked = untrackedPaths(status.stdout)
  const unread: string[] = []
  let budget = MAX_UNTRACKED_TOTAL
  for (const [i, path] of untracked.entries()) {
    if (budget <= 0) {
      sections.push(`## Untracked files not shown (budget spent)\n${untracked.slice(i).join('\n')}`)
      break
    }
    let text: string
    try {
      text = String(await $.fs.read(`${task.cwd}/${path}`))
    } catch {
      unread.push(path)
      continue
    }
    if (text.includes('\u0000')) {
      sections.push(`## Untracked file ${path} (binary, not shown)`)
      continue
    }
    const shown = text.slice(0, Math.min(MAX_UNTRACKED_FILE, budget))
    budget -= shown.length
    const cut = shown.length < text.length ? ` (TRUNCATED: ${shown.length} of ${text.length} characters shown)` : ''
    sections.push(`## Untracked file ${path}${cut}\n${shown}`)
  }
  // A file the Supervisor could not read is still named: the Reviewer should know it exists.
  if (unread.length > 0) sections.push(`## Untracked files that could not be read (not shown)\n${unread.join('\n')}`)
  return sections.join('\n\n')
}

async function askReviewer($: Engine, task: SuperviseTask, evidence: string): Promise<SuperviseReview | { error: string; isInterrupted?: true }> {
  const prompt = reviewPrompt(task, evidence)
  let ask = prompt
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let text: string
    try {
      const reply = await $.model.complete({
        model: task.reviewerModel,
        system: REVIEW_SYSTEM,
        prompt: ask,
        maxTokens: 8192,
        effort: 'high',
        timeoutMs: REVIEW_TIMEOUT_MS,
      })
      if (!reply.isAnswered) {
        if (reply.reason === 'aborted') return { error: reply.reason, isInterrupted: true }
        lastError = reply.reason
        continue
      }
      text = reply.text
    } catch (error) {
      lastError = errorText(error)
      continue
    }
    const parsed = parseReview(text)
    if (!('error' in parsed)) return parsed
    lastError = parsed.error
    ask = `${prompt}\n\nYour previous reply could not be used (${parsed.error}). Reply with only the JSON object.`
  }
  return { error: lastError }
}

async function repair($: Engine, task: SuperviseTask, feedback: string, reason: string): Promise<void> {
  if (task.repairRound >= task.maxRepairRounds || !hasBudget(task, await $.clock.now())) {
    return finish($, task, 'blocked', `${reason}（修复轮次或预算已用尽）`)
  }
  const round = task.repairRound + 1
  const repairing = await patch($, task, { repairRound: round, note: reason })
  if (repairing === undefined) return
  await record($, 'worker', `修复轮 ${round}/${task.maxRepairRounds}：${reason}`, 'warn')
  const text = `验收未通过，第 ${round}/${task.maxRepairRounds} 轮修复。\n\n${feedback}\n\n修复后重新运行相关检查并本地提交，最后简述改了什么、怎么验证的。`
  await send($, repairing, 'running', text)
}

async function startPublish($: Engine, task: SuperviseTask): Promise<void> {
  const branch = await currentBranch($, task.cwd)
  const newBranch = isProtected(branch, task.protectedBranches) ? `当前在受保护分支 ${branch} 上：先从 HEAD 新建分支 auto/${task.id}，然后` : ''
  const action =
    task.publish === 'pr'
      ? '把当前分支推到 origin，再用 gh pr create 开一个 PR（不要合并）。最后回复 PR 链接。'
      : '把当前分支推到 origin。最后回复推送的分支名。'
  await send($, task, 'publishing', `验收检查和独立 Review 已通过。${newBranch}${action}`)
}

async function finishPublish($: Engine, task: SuperviseTask): Promise<void> {
  const head = await gitOrEmpty($, task.cwd, ['rev-parse', 'HEAD'])
  const upstream = await gitOrEmpty($, task.cwd, ['rev-parse', '@{u}'])
  const isPushed = head.exitCode === 0 && upstream.exitCode === 0 && head.stdout.trim() === upstream.stdout.trim()
  let url = ''
  if (task.publish === 'pr') {
    try {
      const pr = await $.process.run(['gh', 'pr', 'view', '--json', 'url', '--jq', '.url'], { cwd: task.cwd, timeoutMs: 30_000 })
      if (pr.exitCode === 0) url = pr.stdout.trim()
    } catch {
      url = ''
    }
  }
  if (isPushed && (task.publish !== 'pr' || url !== '')) {
    return finish($, task, 'completed', url === '' ? '验收通过，分支已推送' : `验收通过，已开 PR：${url}`)
  }
  const missing = isPushed ? '没找到 PR' : '远端分支与本地 HEAD 不一致'
  return finish($, task, 'completed', `本地候选已通过验收；发布未核实（${missing}）`)
}

/** Moves the task to `status` and queues the Worker's next turn; false when the step was overtaken. */
async function send($: Engine, task: SuperviseTask, status: 'running' | 'publishing', text: string): Promise<boolean> {
  const sent = await patch($, task, { status })
  if (sent === undefined) return false
  void log($, sent, 'worker_input', { text: tail(text, 2000) })
  $.prompt.submit({ text: `[auto-coding ${sent.id}] ${text}` }).catch(error => {
    detach($, finish($, sent, 'failed', `无法向 Worker 提交下一轮：${errorText(error)}`))
  })
  return true
}

// ---------------------------------------------------------------- commands and band

async function pauseFromBand($: Engine): Promise<void> {
  const task = await read($, TASK)
  if (task !== null && isWorking(task.status)) await patch($, task, { status: 'paused', note: '手动暂停；/supervise resume 恢复' })
}

async function resumeFromBand($: Engine): Promise<void> {
  const task = await read($, TASK)
  if (task !== null && task.status === 'paused') await inFlight(() => resumeStep($, task))
}

async function stopFromBand($: Engine): Promise<void> {
  const task = await read($, TASK)
  if (task !== null && isActive(task.status)) await finish($, task, 'stopped', '手动停止')
}

async function clearTask($: Engine): Promise<void> {
  const task = await read($, TASK)
  if (task === null || isActive(task.status)) return
  await update($, TASK, () => null)
  await update($, EVENTS, () => [])
  await update($, DENIALS, () => [])
  $.ui.status(undefined)
}

async function start($: Engine, settings: Settings, goal: string): Promise<{ text: string }> {
  if (goal === '') return { text: usage() }
  const existing = await read($, TASK)
  if (existing !== null && isActive(existing.status)) {
    return { text: `已有监督任务 ${existing.id}（${LABEL[existing.status]}）。先 /supervise stop。` }
  }
  // The turn in flight (a stopped task's last, or the person's own) would end as this task's first turn.
  if ((await read($, WORKER_TURN)) !== null) {
    return { text: '会话里还有一轮在进行（/supervise stop 不会打断它）。等这一轮结束后再 /supervise start。' }
  }
  let cwd: string
  try {
    const top = await git($, undefined, ['rev-parse', '--show-toplevel'])
    if (top.exitCode !== 0) return { text: '当前目录不是 git 仓库：auto-coding 需要 git 记录 baseline 并给 Reviewer 生成 diff。' }
    cwd = top.stdout.trim()
  } catch (error) {
    return { text: `无法运行 git：${errorText(error)}` }
  }
  const head = await git($, cwd, ['rev-parse', 'HEAD'])
  const gitDir = await git($, cwd, ['rev-parse', '--absolute-git-dir'])
  const project = await readProjectConfig($, cwd)
  if ('error' in project) return { text: project.error }

  const now = await $.clock.now()
  const task: SuperviseTask = {
    id: `T${new Date(now).toISOString().replace(/[-:T]/g, '').slice(2, 14)}`,
    goal,
    cwd,
    gitDir: gitDir.stdout.trim(),
    baseline: head.exitCode === 0 ? head.stdout.trim() : EMPTY_TREE,
    branch: (await currentBranch($, cwd)) ?? 'HEAD',
    status: 'running',
    seq: 0,
    turns: 0,
    maxTurns: settings.maxTurns,
    repairRound: 0,
    maxRepairRounds: settings.maxRepairRounds,
    errors: 0,
    startedAt: now,
    deadlineAt: now + settings.deadlineMinutes * 60_000,
    checks: project.checks,
    shell: project.shell ?? ((await $.env.get('OS')) === 'Windows_NT' ? ['cmd.exe', '/d', '/s', '/c'] : ['sh', '-c']),
    protectedBranches: settings.protectedBranches,
    publish: settings.publish,
    reviewerModel: settings.reviewerModel,
  }
  await update($, TASK, () => task)
  await update($, BAND_HIDDEN, () => false)
  await update($, DENIALS, () => [])
  await update($, EVENTS, () => [])
  await record($, 'task', `启动：${goal}`)
  $.ui.status(statusLine(task))
  animate($)
  void log($, task, 'task_started', { goal, baseline: task.baseline, branch: task.branch, checks: task.checks, settings })
  // The panel is a view of the task: a surface that cannot place it does not stop the task.
  try {
    await $.ui.open({ id: PANE, title: 'auto-coding' })
  } catch (error) {
    $.ui.log(`auto-coding: 面板未打开：${errorText(error)}`)
  }
  // A prompt submitted from inside command.run would wait on this very dispatch.
  $.clock.after(0, () => {
    $.prompt.submit({ text: `[auto-coding ${task.id}] ${startPrompt(task)}` }).catch(error => {
      detach($, finish($, task, 'failed', `无法提交任务：${errorText(error)}`))
    })
  })
  const checks = task.checks.length === 0 ? `只有 git diff --check（在 ${PROJECT_CONFIG} 里配置 checks）` : task.checks.join('；')
  return {
    text: [
      `已启动监督任务 ${task.id}`,
      `分支 ${task.branch} · baseline ${task.baseline.slice(0, 12)} · 预算 ${task.maxTurns} 轮 / ${settings.deadlineMinutes} 分钟 · 修复 ${task.maxRepairRounds} 轮`,
      `验收检查：${checks}`,
      `Reviewer：${task.reviewerModel} · 通过后：${task.publish}`,
      `审计日志：${task.gitDir}/auto-coding/${task.id}.jsonl`,
    ].join('\n'),
  }
}

async function readProjectConfig($: Engine, cwd: string): Promise<{ checks: string[]; shell?: string[] } | { error: string }> {
  const path = `${cwd}/${PROJECT_CONFIG}`
  if (!(await $.fs.exists(path))) return { checks: [] }
  let value: unknown
  try {
    value = JSON.parse(String(await $.fs.read(path)))
  } catch (error) {
    return { error: `${PROJECT_CONFIG} 不是有效 JSON：${errorText(error)}` }
  }
  const config = (value ?? {}) as { checks?: unknown; shell?: unknown }
  const isStrings = (list: unknown): list is string[] => Array.isArray(list) && list.every(item => typeof item === 'string' && item !== '')
  if (config.checks !== undefined && !isStrings(config.checks)) return { error: `${PROJECT_CONFIG}：checks 必须是字符串数组` }
  if (config.shell !== undefined && !isStrings(config.shell)) return { error: `${PROJECT_CONFIG}：shell 必须是字符串数组，如 ["bash", "-lc"]` }
  return { checks: config.checks ?? [], shell: config.shell }
}

// ---------------------------------------------------------------- git

function git($: Engine, cwd: string | undefined, args: string[]): Promise<ProcessRunResult> {
  return $.process.run(['git', ...args], { cwd, timeoutMs: 60_000 })
}

async function gitOrEmpty($: Engine, cwd: string, args: string[]): Promise<ProcessRunResult> {
  try {
    return await git($, cwd, args)
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: errorText(error), isStdoutTruncated: false, isStderrTruncated: false }
  }
}

async function currentBranch($: Engine, cwd: string | undefined): Promise<string | undefined> {
  try {
    const run = await git($, cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])
    return run.exitCode === 0 ? run.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- text

function describe(task: SuperviseTask | null): string {
  if (task === null) return `没有监督任务。\n${usage()}`
  const lines = [
    `auto-coding ${task.id} · ${LABEL[task.status]}`,
    `任务：${task.goal}`,
    `分支 ${task.branch} · baseline ${task.baseline.slice(0, 12)} · 轮次 ${task.turns}/${task.maxTurns} · 修复 ${task.repairRound}/${task.maxRepairRounds}`,
  ]
  if (task.lastChecks !== undefined) lines.push(`检查：${task.lastChecks.map(c => `${c.id} ${c.isPassed ? '✓' : '✗'}`).join(' · ')}`)
  if (task.lastReview !== undefined) lines.push(`Review：${task.lastReview.verdict} — ${task.lastReview.summary}`)
  if (task.note !== undefined) lines.push(`说明：${task.note}`)
  lines.push(`审计日志：${task.gitDir}/auto-coding/${task.id}.jsonl`)
  return lines.join('\n')
}

function usage(): string {
  return [
    '用法：',
    '  /supervise start <任务>   启动（或直接 /supervise <任务>）',
    '  /supervise panel          打开实时面板',
    '  /supervise status         查看状态',
    '  /supervise pause|resume   暂停 / 恢复自动推进',
    '  /supervise stop           停止，解除硬边界',
    '  /supervise clear          清除已结束的任务',
    `项目验收命令写在 ${PROJECT_CONFIG}：{ "checks": ["npm test"] }`,
  ].join('\n')
}
