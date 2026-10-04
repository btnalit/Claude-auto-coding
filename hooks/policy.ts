// The supervised task's hard boundary: no merge into a protected branch and
// no release. Pushing a branch and opening a PR stay allowed. Lexical and best
// effort: it reads the command as typed, so a script file, an alias or a
// variable it cannot see is outside it.

export type BoundaryContext = {
  /** The branch checked out where the command runs; undefined when unknown or detached. */
  branch?: string
  /** Exact names, or a prefix ending in `*` (`release/*`). */
  protectedBranches: readonly string[]
}

const SEPARATORS = /&&|\|\||\$\(|[;&|\n\r(){}`]/

const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'])
const PUSH_OPTIONS_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
const TAG_LIKE = /^v?\d+(\.\d+)+([-+.].*)?$/

const PUBLISHERS: Record<string, (words: string[]) => boolean> = {
  npm: w => w.includes('publish') || isVersionBump(w) || (w[0] === 'dist-tag' && w[1] === 'add'),
  pnpm: w => w.includes('publish') || isVersionBump(w),
  yarn: w => w.includes('publish') || isVersionBump(w),
  bun: w => w.includes('publish'),
  cargo: w => w.includes('publish'),
  poetry: w => w.includes('publish'),
  uv: w => w.includes('publish'),
  twine: w => w.includes('upload'),
  gem: w => w.includes('push'),
  dotnet: w => w.includes('nuget') && w.includes('push'),
  docker: w => w[0] === 'push',
  podman: w => w[0] === 'push',
  vsce: w => w.includes('publish'),
  ovsx: w => w.includes('publish'),
  lerna: w => w.includes('publish') || w.includes('version'),
  changeset: w => w.includes('publish'),
  goreleaser: w => w.length === 0 || w[0] === 'release',
  'semantic-release': () => true,
  'release-it': () => true,
}

/** Returns why the command crosses the boundary, or undefined when it does not. */
export function checkCommand(command: string, context: BoundaryContext): string | undefined {
  let branch = context.branch
  for (const tokens of segments(stripData(command))) {
    const reason = checkSegment(tokens, { ...context, branch })
    if (reason !== undefined) return reason
    branch = switchedTo(tokens) ?? branch
  }
  return undefined
}

/** Whether checking the command needs the current branch (a push, merge, rebase or checkout). */
export function needsBranch(command: string): boolean {
  return /\bgit\b/.test(command) && /\b(push|merge|rebase)\b/.test(command)
}

export function isProtected(name: string | undefined, protectedBranches: readonly string[]): boolean {
  if (name === undefined || name === '') return false
  const bare = name.replace(/^refs\/heads\//, '')
  return protectedBranches.some(p => (p.endsWith('*') ? bare.startsWith(p.slice(0, -1)) : bare === p))
}

/**
 * Drops text that is data, not commands: a heredoc body fed to anything but a
 * shell, a PowerShell here-string, and a quoted message, title or body.
 */
export function stripData(command: string): string {
  const kept: string[] = []
  let terminator: string | undefined
  for (const line of command.replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, ' ').split('\n')) {
    if (terminator !== undefined) {
      if (line.trim() === terminator) terminator = undefined
      continue
    }
    kept.push(line)
    const heredoc = /<<-?\s*(['"]?)(\w+)\1/.exec(line)
    if (heredoc !== null && !/\b(sh|bash|zsh|dash|pwsh|powershell)\s*<</.test(line)) terminator = heredoc[2]
  }
  return kept
    .join('\n')
    .replace(/(\s)(-[a-zA-Z]*m|-t|-b|--message|--title|--body|--notes)(\s+|=)("(?:[^"\\]|\\.)*"|'[^']*')/g, '$1$2 _')
}

/** The statements of a command, each as words; quotes are dropped so `sh -c '...'` is read too. */
export function segments(command: string): string[][] {
  return command
    .replace(/["']/g, ' ')
    .split(SEPARATORS)
    .map(part => part.trim().split(/\s+/).filter(Boolean))
    .filter(words => words.length > 0)
}

function programOf(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase()
}

function isVersionBump(words: string[]): boolean {
  return words[0] === 'version' && words.length > 1
}

function checkSegment(tokens: string[], context: BoundaryContext): string | undefined {
  // Only the first program the boundary knows in a statement: `git commit -m "git merge"` is a commit.
  const at = tokens.findIndex(t => {
    const p = programOf(t)
    return p === 'git' || p === 'gh' || Object.hasOwn(PUBLISHERS, p)
  })
  if (at === -1) return undefined
  const program = programOf(tokens[at] ?? '')
  const args = tokens.slice(at + 1)
  if (program === 'git') return checkGit(args, context)
  if (program === 'gh') return checkGh(args, context)
  const words = args.filter(a => !a.startsWith('-'))
  return PUBLISHERS[program]?.(words) === true ? `发布制品（${program} ${words.join(' ')}）` : undefined
}

function gitSubcommand(args: string[]): { sub: string; rest: string[] } | undefined {
  let i = 0
  for (let arg = args[i]; arg !== undefined && arg.startsWith('-'); arg = args[i]) {
    i += GIT_OPTIONS_WITH_VALUE.has(arg) ? 2 : 1
  }
  const sub = args[i]
  return sub === undefined ? undefined : { sub, rest: args.slice(i + 1) }
}

function checkGit(args: string[], context: BoundaryContext): string | undefined {
  const git = gitSubcommand(args)
  if (git === undefined) return undefined
  const { sub, rest } = git
  const flags = rest.filter(a => a.startsWith('-'))
  const words = rest.filter(a => !a.startsWith('-'))
  const onProtected = isProtected(context.branch, context.protectedBranches)

  if (sub === 'merge') {
    if (flags.some(f => f === '--abort' || f === '--quit' || f === '--continue')) return undefined
    return onProtected ? `在受保护分支 ${context.branch} 上 git merge` : undefined
  }
  if (sub === 'rebase') {
    if (flags.some(f => ['--abort', '--continue', '--skip', '--quit', '--edit-todo'].includes(f))) return undefined
    if (onProtected) return `在受保护分支 ${context.branch} 上 git rebase`
    return isProtected(words[1], context.protectedBranches) ? `git rebase 改写受保护分支 ${words[1]}` : undefined
  }
  if (sub === 'push') return checkPush(rest, context)
  if (sub === 'tag') {
    const isListing = flags.some(f => ['-l', '--list', '-v', '--verify', '--contains', '--no-contains', '--points-at', '--merged', '--no-merged'].includes(f))
    const isWriting = flags.some(f => ['-a', '-s', '-u', '-f', '-d', '-m', '-F', '--annotate', '--sign', '--force', '--delete'].includes(f))
    return isWriting || (words.length > 0 && !isListing) ? '创建或删除 git tag（发版触发点）' : undefined
  }
  if (sub === 'branch') {
    const isRewrite = flags.some(f => ['-f', '--force', '-D', '-d', '--delete', '-M', '-m', '--move'].includes(f))
    const target = words.find(w => isProtected(w, context.protectedBranches))
    return isRewrite && target !== undefined ? `git branch 改写受保护分支 ${target}` : undefined
  }
  if (sub === 'update-ref') {
    const ref = words[0] ?? ''
    if (ref.startsWith('refs/tags/')) return `git update-ref 写 tag ${ref}`
    return ref.startsWith('refs/heads/') && isProtected(ref, context.protectedBranches) ? `git update-ref 改写受保护分支 ${ref}` : undefined
  }
  return undefined
}

function checkPush(rest: string[], context: BoundaryContext): string | undefined {
  const positional: string[] = []
  let isDelete = false
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? ''
    if (arg === '--tags' || arg === '--follow-tags' || arg === '--mirror' || arg === '--all' || arg === '--branches') {
      return `git push ${arg}（会推送 tag 或受保护分支）`
    }
    if (arg === '-d' || arg === '--delete') isDelete = true
    if (PUSH_OPTIONS_WITH_VALUE.has(arg)) {
      i += 1
      continue
    }
    if (!arg.startsWith('-')) positional.push(arg)
  }
  const refspecs = positional.slice(1)
  if (refspecs.length === 0) {
    return isProtected(context.branch, context.protectedBranches)
      ? `直接推送受保护分支 ${context.branch}（等同绕过 PR 合并）`
      : undefined
  }
  for (const spec of refspecs) {
    const bare = spec.replace(/^\+/, '')
    if (bare.includes('refs/tags/')) return `git push 推送 tag ${bare}`
    const colon = bare.indexOf(':')
    let target = colon === -1 || isDelete ? bare : bare.slice(colon + 1)
    if (target === 'HEAD' || target === '@') target = context.branch ?? target
    if (TAG_LIKE.test(target)) return `git push 推送疑似版本 tag ${target}`
    if (isProtected(target, context.protectedBranches)) {
      return colon === 0 || isDelete ? `git push 删除受保护分支 ${target}` : `直接推送受保护分支 ${target}（等同绕过 PR 合并）`
    }
  }
  return undefined
}

function checkGh(args: string[], context: BoundaryContext): string | undefined {
  const [group, sub] = args
  if (group === 'pr' && sub === 'merge') return 'gh pr merge'
  if (group === 'release' && ['create', 'upload', 'edit', 'delete', 'delete-asset'].includes(sub ?? '')) return `gh release ${sub}`
  if (group !== 'api') return undefined
  const text = args.join(' ')
  if (/mergePullRequest|enablePullRequestAutoMerge|createRelease|updateRelease|createRef/.test(text)) return 'gh api graphql 合并或发版操作'
  const isMutation = /(^|\s)(-X|--method|-f|-F|--field|--raw-field|--input)(\s|=|$)/.test(text) && !/(-X|--method)[\s=]+GET\b/i.test(text)
  if (!isMutation) return undefined
  if (/\/pulls\/\d+\/merge\b|\/merges\b/.test(text)) return 'gh api 合并 PR'
  if (/\/releases\b|\/git\/refs\/tags\b|\/git\/tags\b/.test(text)) return 'gh api 发版或写 tag'
  const head = /\/git\/refs\/heads\/([\w./-]+)/.exec(text)
  return head !== null && isProtected(head[1], context.protectedBranches) ? `gh api 改写受保护分支 ${head[1]}` : undefined
}

function switchedTo(tokens: string[]): string | undefined {
  const at = tokens.findIndex(t => programOf(t) === 'git')
  if (at === -1) return undefined
  const git = gitSubcommand(tokens.slice(at + 1))
  if (git === undefined || (git.sub !== 'checkout' && git.sub !== 'switch')) return undefined
  const create = git.rest.findIndex(a => ['-b', '-B', '-c', '-C', '--orphan'].includes(a))
  if (create !== -1) return git.rest[create + 1]
  return git.rest.find(a => !a.startsWith('-') && a !== '--')
}
