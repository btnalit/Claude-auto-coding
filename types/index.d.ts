/**
 * running    the Worker (this session's main loop) is on a turn
 * deciding   the Decision step reads the transcript and picks continue / verify / park
 * verifying  acceptance checks run against the baseline
 * reviewing  an independent model reviews the diff
 * publishing the Worker pushes its branch or opens a PR (publish = push | pr)
 * paused     a person took over; nothing advances until /supervise resume
 * completed | blocked | failed | stopped  terminal
 */
export type SuperviseStatus =
  | 'running'
  | 'deciding'
  | 'verifying'
  | 'reviewing'
  | 'publishing'
  | 'paused'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'stopped'

export type SuperviseCheck = {
  id: string
  command: string
  isPassed: boolean
  exitCode: number
  /** The end of stdout and stderr together. */
  tail: string
}

export type SuperviseFinding = {
  severity: string
  message: string
  file?: string
  requiredFix?: string
}

export type SuperviseReview = {
  verdict: 'pass' | 'revise' | 'human'
  summary: string
  findings: SuperviseFinding[]
}

export type SuperviseTask = {
  id: string
  goal: string
  /** The repository's top level, where checks and git run. */
  cwd: string
  /** Where the audit log lives: `<gitDir>/auto-coding/<id>.jsonl`. */
  gitDir: string
  baseline: string
  branch: string
  status: SuperviseStatus
  /** Bumped on every transition; work started for an older value is dropped. */
  seq: number
  turns: number
  maxTurns: number
  repairRound: number
  maxRepairRounds: number
  errors: number
  startedAt: number
  deadlineAt: number
  endedAt?: number
  checks: string[]
  shell: string[]
  protectedBranches: string[]
  publish: 'none' | 'push' | 'pr'
  reviewerModel: string
  lastAnswer?: string
  lastChecks?: SuperviseCheck[]
  lastReview?: SuperviseReview
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    /** `denials`: what the boundary refused during the current task, newest last. */
    'auto-coding': { task: SuperviseTask | null; isBandHidden: boolean; denials: string[] }
  }
}
