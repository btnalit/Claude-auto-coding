# auto-coding 代码审查

- 范围：`hooks/register.tsx`（状态机与 seq 守卫）、`hooks/policy.ts`（合并/发版边界）、`hooks/panel.tsx`（面板绘制），顺带 `hooks/logic.ts`、`types/index.d.ts`
- 基线：`bee6555`（分支 `worktree-self-review-2`）
- 方法：通读源码 → 对照本机引擎类型（2.1.289 `claude-code.d.ts`：`update` 为 ifVersion CAS 重试、`turn.start` 只由主循环触发、`$.prompt.submit` 排队到空闲才开轮、重载丢弃定时器）→ 用临时探针测试和回归测试实证 → 修复确定性的 P0/P1 → 其余只记录
- 行号：均指本次提交后的文件；已修复项另注基线行号
- 第二轮（P2 处理，任务 T261004160108）：基线 `5fd5296`，分支 `worktree-fix-p2`。P2 条目原有的「位置」仍指第一轮的文件；每条新增「状态」，已修的写明提交号和修复后的位置。独立 Review 补充的一条记为 P2-11。P3 本轮不处理。

| 级别 | 数量 | 处理 |
| --- | --- | --- |
| P0 | 0 | — |
| P1 | 5 | 已修复并补测试 |
| P2 | 11 | 9 条已修并补回归测试；P2-7 部分修复（heredoc 已修，`--input <文件>` 不修）；P2-5 不修（README 写明边界） |
| P3 | 17 | 记录，未改 |

分级口径：P0 = 数据破坏/安全边界整体失效；P1 = 核心路径上可确定复现的错误行为，或 README §5/§7 明确声称而实现做不到；P2 = 有实际影响但需特定条件、或属于词法边界的覆盖缺口；P3 = 体验、文档、极端输入。

---

## P0

无。

---

## P1（已修复）

### P1-1 暂停后在 Worker 回合进行中恢复：决策读半轮，可能提前验收并解除硬边界，或排队第二条指令

- 位置：`hooks/register.tsx:352-359`（`resumeStep`；基线 `:339-344`），`hooks/register.tsx:116-125`（`/supervise resume`；基线 `:115-119`），`hooks/register.tsx:584-587`（`resumeFromBand` 走同一路径）
- 问题：暂停文案明确说「当前这一轮会跑完」，但恢复时不区分 Worker 回合是否还在进行，直接 `patch(deciding)` → `decide()`。此时 `$.model.fork` 读到的是半轮对话。
- 影响（已用测试复现，旧代码输出 `已完成 · 轮次 0/40`）：
  - 决策为 `verify`：在 Worker 还在改代码时跑检查、做 Review，任务进入 `completed`，`isActive` 变 false，**合并/发版硬边界在 Worker 回合仍在执行时被解除**；
  - 决策为 `continue`：`send()` 把第二条指令排在正在跑的回合后面；该回合结束时 `turn.complete` 看到 `running`，又决策并再排一条——之后始终有两条指令在途，预算消耗翻倍，决策基于错位的回合。
- 修复：新增 `auto-coding.workerTurn`（`types/index.d.ts:88-92`）记录主循环在途回合：`turn.start` 写入（`register.tsx:137-141`；子 agent 不触发 `turn.start`），主循环 `turn.complete` 清空（`register.tsx:147`；清除点在第二轮改到 `next(e)` 之前并新增 `session.start`/`session.end` 两处，见 P2-11）。`resumeStep` 在「已暂停 + 有在途回合」时只把状态改回 `running`（等该回合的 `turn.complete` 正常决策），否则保持原逻辑；`/supervise resume` 的回复文字随之区分。用独立 atom 而不是写进 task：`patch` 会递增 `seq`，在 `turn.start` 里改 task 会让并行中的步骤被无谓作废；atom 也能跨热重载保留。
- 测试：`tests/loop.test.ts`「a resume while the Worker turn still runs waits for that turn to end」：start → `turn.start` → pause → resume → 断言仍为 `Worker 工作中`、只提交过 1 条 prompt、没跑 `git diff --check`；回合结束后 → `已完成`、`轮次 1/40`。

### P1-2 `gh api graphql` 的合并/发版检测是死代码

- 位置：`hooks/policy.ts:217-219`（基线 `:203`），根因 `hooks/policy.ts:13`（`SEPARATORS` 含 `(){}`）
- 问题：`checkGh` 只拿本语句的 `args.join(' ')` 匹配 `mergePullRequest|…`。真实 GraphQL 文本必含 `{`，被 `segments()` 切成多个语句，mutation 名落在不含 `gh` 的片段里。探针：`gh api graphql -f query='mutation { mergePullRequest(…) { … } }'` → 放行；同样文本去掉花括号才会被拦。
- 影响：README §5 声称拦截的「gh api 合并 PR」在 GraphQL 形式下完全失效。
- 修复：`checkCommand` 把 `stripData` 后的整条命令传给 `checkGh`，mutation 名对整条命令匹配；同类的 `mergeBranch`（GraphQL 把 head 合并进 base 分支）一并加入。代价：同一条命令里别的语句提到这些名字也会被拒（提交信息等已被 `stripData` 去掉），可接受。
- 测试：`tests/policy.test.ts` 拒绝 `mergePullRequest`、`mergeBranch` 两条；放行一条只读 `query { … mergeable }`。

### P1-3 `gh -R owner/repo pr merge` 绕过

- 位置：`hooks/policy.ts:205-211`（基线 `:198`）
- 问题：`checkGh` 直接取 `args[0]/args[1]` 当 group/sub，没有像 `gitSubcommand` 那样跳过前置选项。已在本机 gh 2.96.0 实测 `gh -R cli/cli pr merge --help` 解析到 `pr merge`，即该写法真实可用。
- 影响：`gh -R o/r pr merge 3`、`gh --repo o/r release create v1` 均放行。
- 修复：跳过 group 之前的选项，`-R/--repo` 连同取值一起跳过。
- 测试：拒绝 `gh -R o/r pr merge 3 --squash`、`gh --repo o/r release create v1.4.0`；放行 `gh -R o/r pr view 3`。

### P1-4 `git push origin tag <name>` 放行

- 位置：`hooks/policy.ts:183-185`（基线在 `:177` 之后缺失）
- 问题：`tag <name>` 是 git 推 tag 的显式简写（等价 `refs/tags/<name>:refs/tags/<name>`）。`checkPush` 只认 `refs/tags/` 和形如 `v1.2.3` 的名字，`tag rc-final` 两个词都不命中。
- 影响：README §5「推 tag」可被最直白的语法绕过。
- 修复：refspec 中出现 `tag` 一词即拒绝。
- 测试：拒绝 `git push origin tag rc-final`。

### P1-5 heredoc 经 `bash -s` 或管道喂给 shell 时被当成数据丢弃

- 位置：`hooks/policy.ts:79-81`（基线 `:77`）
- 问题：原判断 `/\b(sh|bash|…)\s*<</` 要求解释器紧挨 `<<`。`bash -s <<EOF`、`cat <<EOF | bash` 这两种最常见的写法都不满足，正文被当作数据删掉。
- 影响：README §5 声称「heredoc 喂给 shell 都会被读到」，实际 `bash -s <<'EOF'\ngit push origin main\nEOF` 放行。
- 修复：heredoc 所在行任一词（按空白、`|`、引号切分，经 `programOf` 归一化路径和 `.exe`）是 shell，就保留正文。`git commit -F - <<EOF`、`cat <<EOF > x.sh` 仍按数据处理。
- 测试：拒绝 `bash -s <<…`、`cat <<… | bash` 两条；放行 `git commit -F - <<…`（正文含 `git push origin main`）。

---

## P2（第二轮已处理）

### register.tsx

**P2-1 对仍在运行的步骤 `resume` 会并行重跑一遍**
- 位置：`hooks/register.tsx:117-120`、`:353`
- 问题：`isStuck` 只看状态是 `deciding/verifying/reviewing`，无法区分「重载后真的卡住」和「步骤正在本环境里跑」。
- 影响：验收中 `resume` 会在同一 worktree 并行再跑一遍检查（端口、锁文件、构建目录冲突 → 假失败），Review 中 `resume` 会再调一次 Reviewer。seq 守卫会丢掉旧结果，不会写坏状态，但浪费且可能制造假失败。
- 建议：模块级 `let inFlight: number | undefined` 记录本环境正在执行步骤的 seq（重载自然清零，正好就是「卡住」的信号），`resume` 只在没有在途步骤时重跑。
- **状态：已修（`ee63d25`）**。模块级计数 `stepsInFlight`（`hooks/register.tsx:355-364`），`turn.complete` 里的步骤链、重载后的重跑、`resume` 触发的步骤都经 `inFlight()` 计数；`resume` 遇到 `deciding/verifying/reviewing` 且本环境有在途步骤时回复「这一步仍在运行，无需恢复」（`:125`）。测试「a resume while a step still runs here does not run it a second time」：决策 fork 被挂起时 resume → 只有 1 次 fork、1 次 `git diff --check`，最终完成。遗留：已暂停任务的旧步骤仍在收尾时（验收中暂停后立刻恢复），新步骤会立即开始，旧步骤的检查进程跑完后按 seq 丢弃结果——与修复前相同，未扩大处理范围。

**P2-2 暂停期间结束的 Worker 回合不计数，`lastAnswer` 过期**
- 位置：`hooks/register.tsx:149`（非 running/publishing 直接返回）、`hooks/logic.ts:100`、`hooks/logic.ts:174`
- 问题：回合在 `paused` 时结束（P1-1 修复覆盖的是「回合还没结束就恢复」，这里是「结束后才恢复」），`turns` 不加、`lastAnswer` 停在上一轮。
- 影响：决策提示里的「Worker's last reply」和 Reviewer 证据里的「Worker's final report」是上一轮的话；反复暂停可绕过 `maxTurns`。
- 建议：暂停时的主循环回合只记录 `lastAnswer`（不改状态、不 bump 语义）；是否计入轮次属于口径问题，需要定：用户自己接管的回合算不算 Worker 回合。
- **状态：已修（`0e64dd7`）**。`notePausedTurn`（`hooks/register.tsx:389-408`）：暂停期间结束的主循环回合 `turns + 1`，以 `answer` 结束时写入 `lastAnswer`，状态不变；不递增 `seq`（不是迁移），已在路上的 resume 照常生效；面板日志不写（面板只在任务进行中动），审计日志记 `turn_while_paused`。**口径决定**（合并时由主会话改定，独立 Review 提示需人确认）：只有暂停时在途的那一轮 Worker 回合计入 `turns`——进入暂停时记下在途回合的 id（`pausedOnTurn`），结束的回合 id 与之相同才计数；你接管期间自己发起的回合不计数（`maxTurns` 约束的是无人值守部分），但它们的回复同样写入 `lastAnswer`。README §4 的 `maxTurns` 说明随之更新。测试「a turn that ends while paused counts, and its reply is what the decision reads」。

**P2-3 验收中按 Esc 可能被当成检查失败、消耗修复轮**
- 位置：`hooks/register.tsx:426-432`
- 问题：`runChecks` 把 `$.process.run` 的任何 rejection 都记成 `exitCode -1` 的失败，随后 `repair()` 发出新的 Worker 回合。README §7 说「在验收 / Review 中按 Esc … 进入 paused」。类型文档只写了 `process.run`「无法启动或超时时 reject」，没说派发被放弃时的行为——**未实测，属推断**。
- 建议：把 `turn.complete` 的 `next.signal` 传到 `runChecks`，`signal.aborted` 时转 `paused` 而不是 repair；先在真实引擎里验证 Esc 时 `process.run` 的行为。
- **状态：已修（`0061a86`）**。`next.signal` 经 `onWorkerTurn → decide → verify` 传入；检查返回时若信号已中止，任务转 `paused`（「验收被中断；/supervise resume 重新验收」），本次检查结果不记录、不进修复轮（`hooks/register.tsx:461-471`）。不论 `process.run` 在真实引擎里被放弃时是 reject 还是照常跑完，都不会再排修复轮——后一种情况修复前同样会在检查失败时排一轮新 Worker 回合。测试「Esc during the checks pauses the task instead of sending a repair turn」：prepend 层的内联插件在检查挂起时抢先结束 `turn.complete` 派发（探针确认这会让下层 hook 的 `next.signal` 中止，被挂起的 `process.run` 仍正常返回）；修复前任务进入修复轮，修复后为已暂停且只提交过 1 条 prompt。合并后在真实引擎（2.1.289）`-p` 跑完整任务（创建文件并提交 → 决策 → 验收 → Review pass → completed），未误判为中断，即会话正常结束不会中止 `turn.complete` 的 `next.signal`；按 Esc 的路径仍未实测。

**P2-4 非 ASCII 文件名的未跟踪文件对 Reviewer 静默消失**
- 位置：`hooks/register.tsx:461`、`:474-479`，`hooks/logic.ts:179-184`
- 问题：`git status --porcelain` 默认 `core.quotePath=true`，`说明.md` 输出为 `?? "\350\257\264\346\230\216.md"`（已实测）。`untrackedPaths` 只去掉外层引号，`$.fs.read` 失败后 `continue`，该文件既不展示也不列名。
- 影响：中文文件名的新文件若未提交，Reviewer 完全不知道它存在。Worker 被要求提交，所以多数情况下文件会进 diff，影响面有限。
- 建议：`git -c core.quotePath=false status --porcelain -z`，按 NUL 切分；读取失败时也把路径列进「未展示」段。
- **状态：已修（`1eac0d7`）**。改用 `git status --porcelain -z --untracked-files=all`（`-z` 本身就不转义路径，不需要 `core.quotePath`），`untrackedPaths`（`hooks/logic.ts:197-212`）按 NUL 切分并跳过改名/复制条目的源路径字段（已用真实 git 核对：`R  b.txt\0a.txt\0?? 说明.md\0`）；读不到的文件列进「Untracked files that could not be read」段（`hooks/register.tsx:547`、`:560`）。测试「the reviewer is told of every untracked file, whatever its name, even one it cannot read」。

**P2-5 硬边界只覆盖 Bash/PowerShell 工具**
- 位置：`hooks/register.tsx:176`
- 问题：匹配器只有 `/^(Bash|PowerShell)$/`。会话若接了 GitHub 类 MCP 服务（本机就有 GitHub 连接器），其 merge / release 工具完全在边界之外。
- 影响：设计边界而非实现错误；README §5 只说「Bash 和 PowerShell 两个工具」，但「监督任务期间禁止合并与发版」的总述会让人以为是全局的。
- 建议：对 `mcp__*` 工具按名字拒绝 `merge|release|publish|tag` 类操作，或在 README §5 明确写出 MCP 不在边界内。
- **状态：不修**——各 MCP 服务的工具名和参数没有统一约定，按名字猜既会误拦只读工具（`list_releases`、`get_tag`），又拦不住按参数写受保护分支的工具（`push_files` 的 `branch: main`），只会制造虚假的覆盖感；真正的保证在系统边界（分支保护、发布凭据不进 Worker 环境）。改为在 README §5 明确写出「MCP 工具不在边界内」。

**P2-10 Worker 回合进行中 stop 后立即 start：新任务接到旧任务的回合**
- 位置：`hooks/register.tsx:603-608`（`start` 只拒绝 active 的旧任务）
- 问题：`/supervise stop` 明说「正在运行的这一轮不会被打断」，任务变 `stopped` 后 `start` 立即放行。旧回合结束时新任务处于 `running`，`turn.complete` 把它算作新任务的第 1 轮：`lastAnswer` 是旧任务的回复，决策若为 `continue` 会在已排队的启动 prompt 后面再排一条——与 P1-1 同形的双驱动，入口不同。
- 建议：`start` 读 `auto-coding.workerTurn`，非空时回复「等这一轮结束再启动」。这会改变 `start` 的契约，本次只记录。
- **状态：已修（`08f2e40`，与 P2-11 同一提交）**。按建议改了 `start` 的契约：有回合在途时拒绝，回复「会话里还有一轮在进行（正在跑的回合不会被打断）。等这一轮结束后再 /supervise start。」（`hooks/register.tsx:682-685`）。这个拒绝依赖标记不会残留，所以与 P2-11 一起修。`-p` 与 `scripts/auto.ps1` 把 `/supervise start` 作为会话第一条输入，不受影响——已在真实引擎（2.1.289）用记录事件顺序的探针插件实测：`claude -p "/probe hello"` 只触发 `session.start → command.run`，没有 `prompt.submit` 和 `turn.start`；对照组普通提示词触发 `prompt.submit → turn.start → turn.complete`。测试「a start waits for the stopped task's turn instead of taking it as its own」：stop 后立即 start 被拒、没有提交新 prompt；旧回合结束后 start 成功，新任务 `轮次 0/40`。

**P2-11 `workerTurn` 残留：恢复时等一个永远不来的 `turn.complete`**（独立 Review 补充）
- 位置：`hooks/register.tsx:139-149`（基线 `5fd5296`：`turn.start` 写入、主循环 `turn.complete` 在 `await next(e)` 之后才清除、从不比对 turn id）
- 问题：标记只有一个清除点，且排在 `next(e)` 之后。某轮的结束没有走到那一行（底层 `turn.complete` 失败、会话在回合中途结束而状态留存、重载）时，标记一直留着。
- 影响：从 `paused` 恢复时 `resumeStep` 看到标记，只把任务改回 `running` 等这一轮结束，而这一轮已经不存在——任务挂在「Worker 工作中」，直到有人再发一条消息。P2-10 的修复让 `start` 读这个标记后，残留还会让新任务永远启动不了。
- 修复：三个清除点（`hooks/register.tsx:85`、`:154`、`:232`）——`turn.complete` 在 `next(e)` **之前**清除（回合已结束，下层失败不影响）；`session.start` 在注册命令之前清除（它在第一条输入之前，或在回合结束时的重载里触发，此时不可能有回合在途）；`session.end` 清除（回合不会活过它的会话，`/clear` 之后也不会有 `session.start`）。没有采用「任务离开活动状态时清除」：`stop` 时旧回合仍在跑，清掉会让 P2-10 失效。没有在 `turn.complete` 比对 turn id：主循环串行，任一主循环回合结束时都不会有别的主循环回合在途，无条件清除同时清掉更早的残留。
- 未覆盖：插件 worker 在回合中途重生（respawn）时 `session.start` 会清掉一个仍有效的标记，这一轮剩下的时间里 resume 会退回 P1-1 修复前的行为；概率低，且比残留导致的永久挂起代价小。
- 测试：「a fresh session start drops a turn marker whose end never came」「a turn.complete that fails beneath the mod still ends the turn」「a session that ends mid-turn leaves no turn in flight for the next task」——三条在修复前 resume 都会等回合结束（返回「这一轮结束」），修复后直接决策并完成。
- **状态：已修（`08f2e40`）**。

### policy.ts（词法边界的覆盖缺口，均已用探针实证）

**P2-6 PowerShell here-string 喂给 `Invoke-Expression` 时被整体删除**
- 位置：`hooks/policy.ts:73`
- 问题：所有 `@'…'@` / `@"…"@` 一律当数据删除。`@'\ngit push origin main\n'@ | Invoke-Expression` 放行。Windows 上 PowerShell 是唯一 shell 工具，这条比 bash heredoc 更相关。
- 建议：here-string 同一行在 `'@` 之后管道给 `iex|Invoke-Expression|pwsh|powershell`，或作为它们的参数时保留正文。
- **状态：已修（`ed18c8f`）**。`stripData`（`hooks/policy.ts:76-82`）看 here-string 开头那一行 `@'` 之前和结尾那一行 `'@` 之后的文字，有 shell 或 `iex`/`Invoke-Expression` 就保留正文；`SHELLS` 加入这两个名字。测试拒绝 `@'…'@ | Invoke-Expression`、`Invoke-Expression @"…"@`、`@'…'@ | iex`；放行 `git commit -m @'…'@`、`@'…'@ | Set-Content notes.md`。变量中转（`$s = @'…'@; iex $s`）仍在词法视野之外。

**P2-7 `gh api graphql` 的正文来自 heredoc 或文件时不可见**
- 位置：`hooks/policy.ts:79-81`、`:217`
- 问题：`gh api graphql -F query=@- <<EOF … EOF` 的正文不是喂给 shell，按数据删除；`--input file.json` 读不到。
- 建议：heredoc 行含 `gh api graphql` 时保留正文参与 mutation 匹配；`--input` 视为不可判定，可选择保守拒绝。
- **状态：部分修复（`ed18c8f`）**。heredoc：所在行是 `gh … graphql` 时保留正文（`hooks/policy.ts:91`），`checkGh` 对整条命令的 mutation 名匹配就能看到它；测试拒绝 `gh api graphql -F query=@- <<'EOF'` + `mergePullRequest` 正文，放行同样写法的只读 `query { … mergeable }`。`--input <文件>` **不修**：文件内容与脚本文件同属词法边界之外（README §5 已写明），保守拒绝会误拦只读查询。

**P2-8 `yarn version --patch|--minor|--major` 放行**
- 位置：`hooks/policy.ts:102-104`、`:22-24`
- 问题：`isVersionBump` 只数非 `-` 开头的词；yarn v1 的版本号是以旗标给出的，默认还会打 git tag。
- 建议：`--patch/--minor/--major/--prerelease/--new-version` 也算版本提升。
- **状态：已修（`c057e36`）**。发布判定函数同时拿到原始参数，yarn 在 `version` 子命令带 `--major|minor|patch|premajor|preminor|prepatch|prerelease|new-version` 时视为版本提升（`hooks/policy.ts:22`、`:29`）。测试拒绝 `yarn version --patch`、`yarn version --new-version=2.0.0`，放行 `npm version --json`。

**P2-9 `git rebase --onto <newbase> <upstream> <branch>` 改写受保护分支放行**
- 位置：`hooks/policy.ts:143-146`
- 问题：`--onto` 的取值被当成位置参数，`words[1]` 实际是 upstream 而不是被改写的分支；`git rebase --onto feat/login x main` 放行。
- 建议：跳过 `--onto` 的取值后再取被改写分支。
- **状态：已修（`41380cc`）**。跳过 `--onto`、`-s/--strategy`、`-X/--strategy-option`、`-x/--exec` 的取值后，剩下的才是 `<upstream> [<branch>]`（`hooks/policy.ts:18`、`:166-169`）。同一个解析错误还让 `git rebase -X theirs main feat/login` 被误判为改写 main，一并消除。测试拒绝 `git rebase --onto feat/login x main`、`git rebase -s ort feat/base master`；放行 `git rebase --onto main feat/base feat/login`、`git rebase -X theirs main feat/login`。

---

## P3（未修复）

### register.tsx

- **P3-1** `hooks/register.tsx:369`、`:443`：`decide` 和 `review` 在 seq 校验之前就写面板日志（`record`）；期间被暂停/停止时，面板上会出现一条随后被丢弃的决策或 Review 结论。建议把 `record` 挪到对应 `patch` 成功之后。
- **P3-2** `hooks/register.tsx:281-288`：`tick` 读到非 working 后、取消定时器前，若恢复触发了 `patch → animate`，`animate` 看到 `ticker` 仍在就直接返回，随后被 `tick` 取消——任务在跑但面板不再动，直到下一次状态迁移。建议 `tick` 取消后再读一次状态，或 `animate` 记录代数。
- **P3-3** `hooks/register.tsx:341`：API 错误退避期间状态是 `deciding`，面板显示「决策中」+ spinner 30–90 秒；重载后 `session.start`（`:91-92`）1 秒就重跑，绕过退避。
- **P3-4** `hooks/register.tsx:157-161`：步骤里未预期的异常只记日志，任务停在 working 状态（spinner 一直转，`-p` 会话退出时任务非终态）。现有代码各处已兜底，触发概率低。建议 catch 里转 `paused` 并写明原因。
- **P3-5** `hooks/register.tsx:330`：发布回合以 aborted/refusal/error 结束也走 `finishPublish` → `completed`（「发布未核实」）。按 Esc 打断发布会直接终结任务。
- **P3-6** `hooks/register.tsx:624`：任务 id 精确到秒；同一秒内 start → stop → clear → start 会复用 id，两次任务的审计日志写进同一个文件。
- **P3-7** `hooks/register.tsx:62`：`count()` 对 `0 < value < 1` 取整得 0，`maxTurns=0` 时第一轮结束即最终验收。建议 `Math.max(1, Math.floor(value))`。
- **P3-8** `hooks/register.tsx:309-325`：审计日志每写一行都读出整个文件再写回（O(n²)）；热重载后新旧模块各有一条 `logQueue`，并发追加可能丢行。

### policy.ts

- **P3-9** `hooks/policy.ts:19`、`:197`：`TAG_LIKE` 把 `2.0.x` 这类维护分支名当成版本 tag，在该分支上 `git push origin HEAD` 被拒（探针实证）。
- **P3-10** `hooks/policy.ts:228-236`：`switchedTo` 把 `git checkout main -- README.md`（检出文件）当成切到 main，同一命令后续的 `git merge` 被误拒（探针实证）。
- **P3-11** `hooks/policy.ts:55-57`：注释说 needsBranch 覆盖 checkout，正则并不含 checkout；行为上没问题（checkout 由 `switchedTo` 跟踪），注释不准。
- **P3-12** `hooks/policy.ts:79`：heredoc 正则会命中算术 `$((1<<2))` 和 here-string `<<<`，把后续行当正文吞掉（`echo $((1<<2))\ngit push origin main` 放行，探针实证）。
- **P3-13** `hooks/policy.ts:32-33`：`docker image push`、`docker buildx build --push`、`podman image push` 不在覆盖内。
- **P3-14** `hooks/policy.ts:154-163`：受保护分支的本地改写只认 `git branch -f/-D/-M` 和 `update-ref`；`git checkout -B main`、`git switch -C main`、在 main 上 `git reset --hard` 不拦。推送 main 仍被拒，影响限于本地。在 main 上 `git pull origin feat` 也是本地合并，按 README §5 口径放行，与「在 main 上 `git merge feat` 拒绝」不一致，记录不改。

### panel.tsx

- **P3-15** `hooks/panel.tsx:174-179`：`railOf` 对整条拦截记录（含命令原文）做匹配，且先判 `tag` 后判 `release`：`gh api 发版或写 tag` 点亮的是 tag；在 main 上 `git merge release-notes` 因命令里有 `release` 点亮「发版」而不是「合并」。建议只匹配 ` — ` 之后的原因部分。
- **P3-16** `hooks/panel.tsx:231`：宽布局在 72 列时每个阶段框内宽只有 7 格，`◐ 第 12 轮`（9 格）被截断；`padCells`（`:125-129`）把 U+2E80–U+FFEF 全按 2 格（半角片假名实为 1 格），`▶ ◆ ◇ ●` 等歧义宽度字符按 1 格，只影响对齐。
- **P3-17** `hooks/panel.tsx:406`、`:465`、`:496`、`:500`：目标和说明原样绘制，含换行时（粘贴的多行任务、模型给出的多行理由）状态条会超出 AbovePrompt 的 `maxRows`、面板行数变化；`Log` 的 key（`:377`）按下标生成，事件满 40 条后不再标识同一事件，`Runs`（`:189`）的子元素没有 key。均为显示问题。

---

### 第二轮独立 Review 补充（未修，留给 P3 处理）

- **P3-18** `hooks/register.tsx`（`turn.complete` 处理）：处理器在 `next(e)` 之前清除回合标记；这段窗口里对已暂停任务的 resume 会跳过等待、开始决策并把状态改离 `paused`，随后该回合走到 `notePausedTurn` 时状态已不匹配，这一轮的回复不会写入 `lastAnswer`。可选：记录这个竞态，或让 resume 路径取到刚结束那一轮的回复。
- **P3-19** `hooks/register.tsx`（`session.start` 重跑被打断的步骤）：热重载后 1 秒才重跑并计入 `stepsInFlight`；这 1 秒内的 `/supervise resume` 看到在途数为 0，会再起一份同样的步骤。seq 守卫会丢弃其中一份结果，但检查或 Reviewer 会多跑一次。可选：在排定定时器时就计入 `stepsInFlight`。

## 验证

| 命令 | 结果 |
| --- | --- |
| `claude plugin test .`（修复前） | 67 pass |
| 新增状态机用例在修复前运行 | 失败：`已完成 · 轮次 0/40`（复现 P1-1） |
| 临时探针（已删除） | P1-2…P1-5 及 P2-6…P2-9、P3-9/10/12 的放行/误拒结果如上所述 |
| `gh -R cli/cli pr merge --help`（gh 2.96.0） | 解析到 `pr merge`（P1-3 前提成立） |
| `git status --porcelain`（含 `说明.md`） | `?? "\350\257\264\346\230\216.md"`（P2-4 前提成立） |
| `claude plugin test .`（修复后） | 78 pass, 0 fail |
| `claude plugin validate .` | 通过；state 读写含 `auto-coding.workerTurn` |
| `npx -p typescript tsc -p .` | 通过 |
| `git diff --check` | 无输出 |
| **第二轮（P2）** | |
| `claude plugin test .`（基线 `5fd5296`） | 81 pass |
| 每条新增回归用例在对应修复前运行 | 均失败（P2-1：resume 回复「决策步骤先读一遍…」；P2-2：`轮次 0/40`；P2-3：进入修复轮；P2-4：Reviewer 提示里没有 `说明.md`；P2-6/7/8/9：放行；P2-10：start 成功；P2-11：三条 resume 都在等回合结束） |
| 测试工具探针（已删除） | prepend 层插件抢先结束 `turn.complete` → 下层 hook 的 `next.signal.aborted === true`，挂起的 `process.run` 仍正常返回；测试引擎里 `$.command.register` 无实现会 reject（故 `session.start` 先清标记再注册） |
| `git status --porcelain -z --untracked-files=all`（含改名与 `说明.md`） | `R  b.txt\0a.txt\0?? 说明.md\0`（P2-4 解析前提成立） |
| `claude plugin test .`（修复后） | 103 pass, 0 fail（policy 79 条，loop 24 条） |
| `claude plugin validate .` | 通过 |
| `npx -p typescript tsc -p .` | 通过 |
| `git diff --check` | 无输出 |
| 真实引擎探针（2.1.289，`claude -p --plugin-dir <探针>`，探针已删除） | `"/probe hello"`：`session.start → command.run`，无 `prompt.submit`/`turn.start`（P2-10 的拒绝不会挡住 `-p`/`--bg` 的首条 `/supervise start`）；普通提示词：`session.start → prompt.submit → turn.start → turn.complete` |
| 真实引擎跑修复后的完整任务 | 未实测（本会话的监督器加载的是 `%TEMP%` 快照，不随工作区改动热重载） |
