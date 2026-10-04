import type { ElementTable } from 'claude-code'

import type { SuperviseEvent, SuperviseRole, SuperviseTask } from '../types'
import { LABEL, isActive, isWorking } from './logic'

// The live panel: a fixed layout whose motion is the task's own state, in the
// look of live-panel's terminal-dark theme (github.com/ythx-101/live-panel-skill).
// Pure drawing: register.tsx reads the state and hands it here with the
// surface's element table and the handlers the buttons call.

/** live-panel's terminal-dark palette, plus a danger red it has no use for. */
export const TOKENS = {
  bg: '#14171c',
  surface: '#262a32',
  line: '#4a5367',
  line2: '#3a4154',
  dim: '#6f788c',
  mute: '#aab1c0',
  fg: '#e4e8f0',
  wh: '#ffffff',
  cy: '#86e1e6',
  bl: '#8fb4f6',
  gr: '#7fdba8',
  pu: '#b9a2f2',
  ye: '#e3c07a',
  rd: '#f08c8c',
  hl: '#302d45',
  dots: '#566078',
} as const

export const ROLE_COLOR: Record<SuperviseRole, string> = {
  worker: TOKENS.cy,
  decide: TOKENS.bl,
  verify: TOKENS.gr,
  review: TOKENS.pu,
  boundary: TOKENS.ye,
  task: TOKENS.mute,
}

export const TICK_MS = 200
const WIDE = 72

export type PanelActions = {
  pause: () => void
  resume: () => void
  stop: () => void
  clear: () => void
  open: () => void
  hide: () => void
}

export type PanelModel = {
  task: SuperviseTask | null
  events: readonly SuperviseEvent[]
  denials: readonly string[]
  now: number
  columns: number
  rows: number
  actions: PanelActions
}

type Tone = 'active' | 'done' | 'pending' | 'warn' | 'bad'
type StageView = { key: string; name: string; sub: string; color: string; tone: Tone }

const STAGES = [
  { key: 'worker', name: 'Worker', color: TOKENS.cy },
  { key: 'decide', name: '决策', color: TOKENS.bl },
  { key: 'verify', name: '验收', color: TOKENS.gr },
  { key: 'review', name: 'Review', color: TOKENS.pu },
  { key: 'done', name: '完成', color: TOKENS.gr },
] as const

const ACTIVE_STAGE: Partial<Record<SuperviseTask['status'], number>> = {
  running: 0,
  deciding: 1,
  verifying: 2,
  reviewing: 3,
  publishing: 4,
}

const STATUS_COLOR: Record<SuperviseTask['status'], string> = {
  running: TOKENS.cy,
  deciding: TOKENS.bl,
  verifying: TOKENS.gr,
  reviewing: TOKENS.pu,
  publishing: TOKENS.bl,
  paused: TOKENS.ye,
  completed: TOKENS.gr,
  blocked: TOKENS.ye,
  failed: TOKENS.rd,
  stopped: TOKENS.dim,
}

const SPINNER = ['◐', '◓', '◑', '◒']

// ---------------------------------------------------------------- pure parts

export const spinner = (now: number): string => SPINNER[Math.floor(now / 300) % SPINNER.length] ?? '◐'

/** A wire `cells` long ending in an arrow head; with a packet and its trail when `frame` is given. */
export function wireCells(cells: number, frame?: number): string {
  const track = Array.from({ length: Math.max(2, cells - 1) }, () => '─')
  if (frame !== undefined) {
    const at = frame % track.length
    track[at] = '●'
    if (at > 0) track[at - 1] = '·'
  }
  return `${track.join('')}▶`
}

export function barCells(fraction: number, width: number): { fill: string; rest: string } {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return { fill: '█'.repeat(filled), rest: '░'.repeat(width - filled) }
}

/** live-panel's gauges flip colour past a threshold: here 75% of a budget, and red once it is spent. */
export const budgetColor = (fraction: number, base: string): string => (fraction >= 1 ? TOKENS.rd : fraction >= 0.75 ? TOKENS.ye : base)

export function span(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000))
  return total >= 60 ? `${Math.floor(total / 60)}h${String(total % 60).padStart(2, '0')}m` : `${total}m`
}

/** Pads to `cells` terminal columns, a CJK character taking two. */
export function padCells(text: string, cells: number): string {
  let width = 0
  for (const ch of text) width += /[\u2e80-\uffef]/.test(ch) ? 2 : 1
  return text + ' '.repeat(Math.max(0, cells - width))
}

export function clockOf(at: number): string {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

/** How far the task got: 0 Worker, 1 decision, 2 checks, 3 review. */
function reached(task: SuperviseTask): number {
  if (task.lastReview !== undefined) return 3
  if (task.lastChecks !== undefined) return 2
  return task.turns > 0 ? 1 : 0
}

export function stageViews(task: SuperviseTask | null, events: readonly SuperviseEvent[], now: number): StageView[] {
  if (task === null) return STAGES.map(s => ({ key: s.key, name: s.name, sub: '—', color: s.color, tone: 'pending' }))
  const active = ACTIVE_STAGE[task.status] ?? -1
  // On a repair round the Worker is active again while the checks or review that sent it back stay lit.
  const furthest = Math.max(active, reached(task))
  const spin = spinner(now)
  const checks = task.lastChecks
  const passed = checks?.filter(c => c.isPassed).length ?? 0
  const lastDecision = [...events].reverse().find(e => e.who === 'decide')?.text.split('：')[0] ?? '—'
  const subs = [
    active === 0 ? `${spin} 第 ${task.turns + 1} 轮` : `${task.turns} 轮`,
    active === 1 ? `${spin} 判断中` : lastDecision,
    active === 2 ? `${spin} 运行检查` : checks === undefined ? '—' : `${passed}/${checks.length} ${passed === checks.length ? '✓' : '✗'}`,
    active === 3 ? `${spin} ${task.reviewerModel}` : (task.lastReview?.verdict ?? '—'),
    active === 4 ? `${spin} ${task.publish}` : isActive(task.status) ? '—' : LABEL[task.status],
  ]
  return STAGES.map((s, i) => {
    let tone: Tone = i === active ? 'active' : i <= furthest && i < 4 ? 'done' : 'pending'
    if (i === 2 && tone === 'done' && checks !== undefined && passed < checks.length) tone = 'bad'
    if (i === 3 && tone === 'done' && task.lastReview !== undefined && task.lastReview.verdict !== 'pass') tone = 'warn'
    if (i === 4 && !isActive(task.status)) {
      tone = task.status === 'completed' ? 'done' : task.status === 'failed' ? 'bad' : task.status === 'blocked' ? 'warn' : 'pending'
    }
    return { key: s.key, name: s.name, sub: subs[i] ?? '—', color: s.color, tone }
  })
}

const toneColor = (view: StageView): string =>
  view.tone === 'bad' ? TOKENS.rd : view.tone === 'warn' ? TOKENS.ye : view.tone === 'pending' ? TOKENS.line2 : view.color

/** Which side-rail trigger a denial lights. */
export function railOf(denial: string): '合并' | 'tag' | '发版' | '发布' {
  if (/\btag\b|refs\/tags/.test(denial)) return 'tag'
  if (/release/.test(denial)) return '发版'
  if (/发布制品/.test(denial)) return '发布'
  return '合并'
}

// ---------------------------------------------------------------- drawing

type Run = { text: string; color: string; isBold?: boolean }

function Runs(el: ElementTable, runs: readonly Run[], key?: string) {
  const { Text } = el
  return (
    <Text key={key} wrap="truncate-end">
      {runs.map(r => (
        <Text color={r.color} bold={r.isBold === true}>
          {r.text}
        </Text>
      ))}
    </Text>
  )
}

function Wire(el: ElementTable, cells: number, color: string, frame?: number) {
  const runs: Run[] = []
  for (const ch of wireCells(cells, frame)) {
    const c = ch === '●' || ch === '·' ? color : frame === undefined ? TOKENS.line2 : TOKENS.line
    const last = runs.at(-1)
    if (last !== undefined && last.color === c) last.text += ch
    else runs.push({ text: ch, color: c })
  }
  return Runs(el, runs)
}

function Pipeline(el: ElementTable, model: PanelModel, width: number) {
  const { Box, Text } = el
  const { task } = model
  const views = stageViews(task, model.events, model.now)
  const active = task === null ? -1 : (ACTIVE_STAGE[task.status] ?? -1)
  const frame = task !== null && isWorking(task.status) ? Math.floor(model.now / TICK_MS) : undefined
  if (width < WIDE) {
    return (
      <Box flexDirection="column" key="pipeline">
        {views.map((v, i) => (
          <Box key={`stage-${v.key}`}>
            <Text color={toneColor(v)} bold={v.tone === 'active'}>
              {i === active ? '▶ ' : v.tone === 'pending' ? '  ' : '· '}
              {padCells(v.name, 8)}
            </Text>
            <Text color={v.tone === 'pending' ? TOKENS.dim : TOKENS.fg} wrap="truncate-end">
              {v.sub}
            </Text>
          </Box>
        ))}
      </Box>
    )
  }
  const wireCellsWide = 5
  const boxWidth = Math.max(9, Math.floor((width - wireCellsWide * STAGES.length) / STAGES.length))
  const parts = views.flatMap((v, i) => {
    const into = i === active && frame !== undefined ? frame : undefined
    const isLit = i <= active || v.tone !== 'pending'
    return [
      <Box key={`wire-${v.key}`} width={wireCellsWide}>
        {Wire(el, wireCellsWide, v.color, into)}
      </Box>,
      <Box
        key={`stage-${v.key}`}
        width={boxWidth}
        flexDirection="column"
        alignItems="center"
        borderStyle="dashed"
        borderColor={isLit ? toneColor(v) : TOKENS.line2}
      >
        <Text color={toneColor(v)} bold={v.tone === 'active' || v.tone === 'done'} wrap="truncate-end">
          {v.name}
        </Text>
        <Text color={v.tone === 'pending' ? TOKENS.dim : v.tone === 'active' ? TOKENS.wh : TOKENS.fg} wrap="truncate-end">
          {v.sub}
        </Text>
      </Box>,
    ]
  })
  return (
    <Box key="pipeline" alignItems="center">
      {parts}
    </Box>
  )
}

function Gauge(el: ElementTable, key: string, label: string, fraction: number, base: string, value: string, width: number) {
  const { Box, Text } = el
  const { fill, rest } = barCells(fraction, width)
  return (
    <Box key={key}>
      <Text color={TOKENS.mute}>{padCells(label, 6)}</Text>
      <Text color={budgetColor(fraction, base)}>{fill}</Text>
      {/* A dark track, so the filled part reads as progress and the rows do not merge into one grey block. */}
      <Text color={TOKENS.line2}>{rest}</Text>
      <Text color={fraction >= 0.75 ? budgetColor(fraction, base) : TOKENS.fg} bold={fraction >= 0.75}>
        {`  ${value}`}
      </Text>
    </Box>
  )
}

function Budget(el: ElementTable, task: SuperviseTask | null, now: number, width: number) {
  const { Box, Text } = el
  const barWidth = Math.max(8, Math.min(24, width - 34))
  const end = task?.endedAt ?? now
  const total = task === null ? 1 : task.deadlineAt - task.startedAt
  const used = task === null ? 0 : end - task.startedAt
  const checks = task?.lastChecks
  return (
    <Box key="budget" flexDirection="column" borderStyle="dashed" borderColor={TOKENS.line} paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={TOKENS.gr} bold>
          预算 · 验收
        </Text>
        <Text color={TOKENS.dim}>{task === null ? '' : `已运行 ${span(used)} · 剩余 ${span(task.deadlineAt - end)}`}</Text>
      </Box>
      {Gauge(el, 'g-turns', '轮次', task === null ? 0 : task.turns / task.maxTurns, TOKENS.cy, task === null ? '—' : `${task.turns}/${task.maxTurns}`, barWidth)}
      {Gauge(el, 'g-time', '时间', used / total, TOKENS.bl, task === null ? '—' : `${span(used)}/${span(total)}`, barWidth)}
      {Gauge(
        el,
        'g-repair',
        '修复',
        task === null || task.maxRepairRounds === 0 ? 0 : task.repairRound / task.maxRepairRounds,
        TOKENS.pu,
        task === null ? '—' : `${task.repairRound}/${task.maxRepairRounds}`,
        barWidth,
      )}
      <Box key="checks" flexWrap="wrap" columnGap={2}>
        <Text color={TOKENS.mute}>检查</Text>
        {checks === undefined ? (
          <Text color={TOKENS.dim}>{task === null ? '—' : `git diff --check${task.checks.length === 0 ? '' : ` + ${task.checks.length} 项`} · 尚未运行`}</Text>
        ) : (
          checks.map(c => (
            <Text key={`check-${c.id}`} color={c.isPassed ? TOKENS.gr : TOKENS.rd} bold={!c.isPassed}>
              {c.isPassed ? `${c.id} ✓` : `${c.id} ✗ exit ${c.exitCode}`}
            </Text>
          ))
        )}
      </Box>
    </Box>
  )
}

function Rail(el: ElementTable, denials: readonly string[]) {
  const { Box, Text } = el
  const lit = new Set(denials.map(railOf))
  const last = denials.at(-1)
  return (
    <Box
      key="rail"
      flexDirection="column"
      borderStyle="dashed"
      borderColor={denials.length === 0 ? TOKENS.line2 : TOKENS.ye}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text color={TOKENS.ye} bold>
          边界 · on guard
        </Text>
        <Text color={denials.length === 0 ? TOKENS.dim : TOKENS.ye}>{`拦截 ${denials.length}`}</Text>
      </Box>
      <Box columnGap={3} flexWrap="wrap">
        {(['合并', 'tag', '发版', '发布'] as const).map(name =>
          lit.has(name) ? (
            <Text key={`rail-${name}`} color={TOKENS.ye} backgroundColor={TOKENS.hl} bold>
              {`◆ ${name}`}
            </Text>
          ) : (
            <Text key={`rail-${name}`} color={TOKENS.dim}>
              {`◇ ${name}`}
            </Text>
          ),
        )}
      </Box>
      <Text color={last === undefined ? TOKENS.dim : TOKENS.ye} wrap="truncate-end">
        {last === undefined ? 'silent on every routine command' : `» ${last.replace(/^\w+: /, '')}`}
      </Text>
    </Box>
  )
}

function Log(el: ElementTable, events: readonly SuperviseEvent[], rows: number) {
  const { Box, Text } = el
  const shown = events.slice(-rows)
  return (
    <Box key="log" flexDirection="column" borderStyle="single" borderColor={TOKENS.line2} paddingX={1}>
      <Text color={TOKENS.dim}>session log</Text>
      {shown.length === 0 ? (
        <Text color={TOKENS.dim}>等待第一个事件…</Text>
      ) : (
        shown.map((event, i) => {
          const isNewest = i === shown.length - 1
          const toneColor = event.tone === 'bad' ? TOKENS.rd : event.tone === 'warn' ? TOKENS.ye : event.tone === 'ok' ? TOKENS.gr : undefined
          return Runs(
            el,
            [
              { text: `${clockOf(event.at)}  `, color: TOKENS.dim },
              { text: event.who.padEnd(9), color: ROLE_COLOR[event.who], isBold: isNewest },
              { text: event.text, color: isNewest ? (toneColor ?? TOKENS.wh) : TOKENS.dim, isBold: isNewest },
            ],
            `log-${events.length - shown.length + i}`,
          )
        })
      )}
    </Box>
  )
}

function StatusBar(el: ElementTable, model: PanelModel) {
  const { Box, Button } = el
  const { task, actions } = model
  const repo = task?.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? 'repo'
  const isBlinkOn = task !== null && isWorking(task.status) && Math.floor(model.now / 500) % 2 === 0
  const checks = task?.lastChecks
  const field = (label: string, value: string, color: string): Run[] => [
    { text: `${label} [`, color: TOKENS.dim },
    { text: value, color, isBold: true },
    { text: ']  ', color: TOKENS.dim },
  ]
  const buttons = []
  if (task !== null && task.status === 'paused') buttons.push(<Button key="resume" label="恢复" variant="primary" onPress={actions.resume} />)
  else if (task !== null && isWorking(task.status)) buttons.push(<Button key="pause" label="暂停" onPress={actions.pause} />)
  if (task !== null && isActive(task.status)) buttons.push(<Button key="stop" label="停止" onPress={actions.stop} />)
  else if (task !== null) buttons.push(<Button key="clear" label="清除" onPress={actions.clear} />)
  return (
    <Box key="status" flexDirection="column">
      {Runs(el, [
        { text: `~/${repo} `, color: TOKENS.gr, isBold: true },
        { text: '$ ', color: TOKENS.dim },
        { text: task === null ? '/supervise start <任务>' : `/supervise start ${task.goal}`, color: TOKENS.fg },
        { text: isBlinkOn ? ' █' : '  ', color: TOKENS.cy },
      ])}
      <Box justifyContent="space-between">
        {Runs(el, [
          ...field('turns', task === null ? '—' : `${task.turns}/${task.maxTurns}`, TOKENS.cy),
          ...field('repair', task === null ? '—' : `${task.repairRound}/${task.maxRepairRounds}`, TOKENS.pu),
          ...field('checks', checks === undefined ? '—' : `${checks.filter(c => c.isPassed).length}/${checks.length}`, TOKENS.gr),
          ...field('review', task?.lastReview?.verdict ?? '—', TOKENS.pu),
          ...field('boundary', String(model.denials.length), TOKENS.ye),
        ])}
        <Box columnGap={1}>{buttons}</Box>
      </Box>
    </Box>
  )
}

export function drawPanel(el: ElementTable, model: PanelModel) {
  const { Box, Text } = el
  const { task } = model
  const width = Math.max(40, model.columns)
  const status = task === null ? 'IDLE' : `${isWorking(task.status) ? `${spinner(model.now)} ` : ''}${LABEL[task.status]}`
  // The log streams, so it sits right under the pipeline and takes the rows the pane can spare.
  const logRows = Math.max(4, Math.min(10, model.rows - 27))
  return (
    <Box flexDirection="column" backgroundColor={TOKENS.bg}>
      <Box flexDirection="column" key="head">
        <Box justifyContent="center">
          {Runs(el, [
            { text: 'AUTO-CODING', color: TOKENS.wh, isBold: true },
            { text: '  ·  ', color: TOKENS.dim },
            { text: task?.id ?? 'no task', color: TOKENS.cy, isBold: true },
            { text: '  ·  ', color: TOKENS.dim },
            { text: status, color: task === null ? TOKENS.dim : STATUS_COLOR[task.status], isBold: true },
          ])}
        </Box>
        <Text color={TOKENS.line2} wrap="truncate-end">
          {'═'.repeat(width)}
        </Text>
        <Box justifyContent="center" columnGap={3} flexWrap="wrap">
          {(['worker', 'decide', 'verify', 'review', 'boundary'] as const).map(role =>
            Runs(el, [
              { text: '■ ', color: ROLE_COLOR[role] },
              { text: role, color: TOKENS.mute },
            ], `legend-${role}`),
          )}
        </Box>
      </Box>
      <Box flexDirection="column" key="task">
        {Runs(el, [
          { text: '任务  ', color: TOKENS.dim },
          { text: task?.goal ?? '没有监督任务 · /supervise start <任务> 启动', color: task === null ? TOKENS.dim : TOKENS.fg },
        ])}
        {task === null
          ? undefined
          : Runs(el, [
              { text: `分支 ${task.branch} · baseline ${task.baseline.slice(0, 7)} · reviewer ${task.reviewerModel} · 通过后 ${task.publish}`, color: TOKENS.dim },
            ])}
      </Box>
      <Box key="flow" flexDirection="column" marginY={1}>
        {Pipeline(el, model, width)}
        {task?.note === undefined ? undefined : Runs(el, [{ text: `» ${task.note}`, color: STATUS_COLOR[task.status] }], 'note')}
      </Box>
      {Log(el, model.events, logRows)}
      {Budget(el, task, model.now, width)}
      {Rail(el, model.denials)}
      {StatusBar(el, model)}
    </Box>
  )
}

export function drawBand(el: ElementTable, model: PanelModel) {
  const { Box, Button, Text } = el
  const { task, actions } = model
  if (task === null) return undefined
  const buttons = [<Button key="panel" label="面板" variant="primary" onPress={actions.open} />]
  if (task.status === 'paused') buttons.push(<Button key="resume" label="恢复" onPress={actions.resume} />)
  else if (isWorking(task.status)) buttons.push(<Button key="pause" label="暂停" onPress={actions.pause} />)
  if (isActive(task.status)) buttons.push(<Button key="stop" label="停止" onPress={actions.stop} />)
  else buttons.push(<Button key="clear" label="清除" onPress={actions.clear} />)
  buttons.push(<Button key="hide" label="隐藏" plain onPress={actions.hide} />)
  return (
    <Box flexDirection="column">
      <Box columnGap={2}>
        {Runs(el, [
          { text: isWorking(task.status) ? `${spinner(model.now)} ` : '● ', color: STATUS_COLOR[task.status] },
          { text: 'AUTO-CODING ', color: TOKENS.wh, isBold: true },
          { text: `${task.id} `, color: TOKENS.cy },
          { text: LABEL[task.status], color: STATUS_COLOR[task.status], isBold: true },
          { text: `  turns [${task.turns}/${task.maxTurns}]  repair [${task.repairRound}/${task.maxRepairRounds}]  ${task.branch}`, color: TOKENS.dim },
        ])}
      </Box>
      <Text color={TOKENS.mute} wrap="truncate-end">
        {task.goal}
      </Text>
      {task.note === undefined ? undefined : (
        <Text color={STATUS_COLOR[task.status]} wrap="truncate-end">
          {`» ${task.note}`}
        </Text>
      )}
      <Box columnGap={1}>{buttons}</Box>
    </Box>
  )
}
