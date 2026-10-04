# auto-coding

Claude Code 的无人值守开发监督 mod（function-hooks 插件）。由 [pi-claude-supervisor](https://github.com/btnalit/pi-claude-supervisor) 精简而来：原项目是 **Pi 在外部监督一个 Claude Code 子进程**，这里改成 **在同一个 Claude Code 会话内部监督它自己的主循环**——主循环就是 Worker，mod 就是 Supervisor。tmux / JSONL transport、cgroup、cwd 租约、hook relay 这些进程边界代码全部不再需要，4 万多行收缩到约 1200 行（不含测试）。

## 1. 它做什么

```
/supervise start <任务>
        │
        ▼
 ┌─ Worker 回合（本会话主循环） ◄──────────────────────────┐
 │      │ turn.complete                                    │
 │      ▼                                                  │
 │  决策：$.model.fork 读整段对话 → continue / verify / park │
 │      │continue ──────────────────────────────────────────┤
 │      ▼verify                                            │
 │  验收：git diff --check + 项目 checks（$.process.run）    │
 │      │失败 → 修复轮（≤ maxRepairRounds）──────────────────┤
 │      ▼通过                                              │
 │  独立 Review：$.model.complete（diff + 证据，无工具）     │
 │      │revise → 修复轮 ───────────────────────────────────┘
 │      │human  → blocked（交给人）
 │      ▼pass
 │  （可选）publish=push|pr：Worker 推分支 / 开 PR → 核实远端
 ▼
 completed / blocked / failed / stopped
```

全程有一条硬边界：**监督任务期间禁止合并与发版**。推送功能分支、`gh pr create` 放行。

## 2. 与原项目的映射

| pi-claude-supervisor | auto-coding mod | 说明 |
| --- | --- | --- |
| Pi 进程 + Supervisor 状态机 | `hooks/register.tsx` 状态机 | 状态存在 `$.state`，热重载不丢 |
| Claude Code Worker（tmux / JSONL 子进程） | 本会话主循环 | 不再有 transport、cgroup、进程清理 |
| `turn_completed` | `turn.complete` hook（过滤子 agent 的 turn） | |
| Decision Worker（持久只读 Pi session） | `$.model.fork`：同一对话、同一模型、走 prompt cache、无工具 | 便宜；独立性由验收 + Reviewer 保证 |
| 验收检查 / `--spec` | `git diff --check` + `.claude/auto-coding.json` 的 `checks` | |
| 独立 Reviewer（全新只读 Pi session） | `$.model.complete`（独立调用，默认 opus） | 只看证据包，不能自己探索仓库 |
| 修复轮 / `maxRepairRounds` | 同 | |
| 硬边界（禁 push/merge/PR/.git/删除底线） | 只禁**合并与发版**；push、PR 放行 | 按需求收窄，见 §5 |
| 人工接管 `human_takeover` | 你在会话里输入或按 Esc → `paused` | `/supervise resume` 恢复 |
| `AskUserQuestion` 由 Decision Worker 回答 | 任务进行中直接拒绝，要求 Worker 自选假设继续 | Plan Mode 同理 |
| deadline / 轮次预算 | `deadlineMinutes` / `maxTurns` | 到点不再开新轮，做最终验收 |
| 事件日志 JSONL | `<git-dir>/auto-coding/<任务id>.jsonl` | 在 `.git` 里，不污染工作区和 diff |
| 候选通知（UI / webhook） | toast + 状态栏 + 提示框上方状态条 | webhook 未移植 |

## 3. 加载

需要 Claude Code 2.1.289+（function-hooks 是早期访问 API，以本机 types 为准）。

```powershell
# 单次会话
claude --plugin-dir D:\Claude-auto-coding

# 每个会话都加载（交互会话会监视目录，改代码自动热重载）
# 在 ~/.claude/settings.json 的 env 里加：
#   "CLAUDE_CODE_PLUGIN_DIRS": "D:\\Claude-auto-coding"
```

没有任务时所有 hook 直接放行，对平常使用无影响。

**回滚**：去掉 `--plugin-dir` 或删除上面那个 env 项即可；mod 不写任何全局配置。

## 4. 使用

```text
/supervise start 给 parser 加上空输入处理，并补测试     # 或直接 /supervise <任务>
/supervise status          # 状态、检查结果、Review 结论、日志路径
/supervise pause | resume  # 暂停/恢复自动推进（resume 也能恢复被打断的步骤）
/supervise stop            # 停止任务，硬边界随之解除
/supervise clear           # 清除已结束的任务
```

要求在 git 仓库里启动：启动时记录 baseline commit，Reviewer 看的是相对 baseline 的 diff（含已提交和未提交改动、未跟踪文件）。

### 一键无人值守（推荐）

在任务所在的仓库里：

```powershell
D:\Claude-auto-coding\scripts\auto.ps1 "给 parser 加上空输入处理，并补测试"
D:\Claude-auto-coding\scripts\auto.ps1 -Name fix-42 -Attach "修复 #42：空输入时崩溃"   # 启动后直接接入看面板
```

它做的事，以及为什么（都是真实跑出来的坑）：

| 步骤 | 为什么 |
| --- | --- |
| `claude --bg -w <Name>`：后台会话，worktree 建在仓库内 `.claude/worktrees/<Name>` | 无窗口、不占终端；`claude attach <id>` 随时接入看实时面板，`claude logs <id>` 看最近输出 |
| 启动前检查仓库已被 Claude Code 信任 | 信任按**精确路径**记录、不继承上级目录：仓库外新建的目录会停在信任对话框上。`-w` 的 worktree 沿用仓库的信任；仓库本身没被信任就直接报错并说明怎么做（在该目录运行一次 `claude` 选信任，只需一次），绝不挂在一个看不见的对话框上 |
| `--settings` 指定 `worktree.baseRef = head` | `-w` 默认从 `origin/<默认分支>` 建，本地未推送的提交会被漏掉 |
| 任务就在本插件仓库上跑时，加载 HEAD 的快照（`%TEMP%\auto-coding-plugin-<sha>`） | Worker 改的正是插件源码，交互会话会在回合结束时热重载，快照让监督器保持不变 |
| 只清掉标识"子会话"的环境变量（`CLAUDECODE`、`CLAUDE_JOB_DIR` 等） | 从另一个 Claude Code 会话里运行时，新会话不该把父会话的身份当成自己的；`CLAUDE_CONFIG_DIR` 等配置保留 |
| 启动后读会话画面，确认出现"已启动监督任务" | 插件没加载时会话只会显示 `Unknown command: /supervise`，脚本据此报错并停止会话，不会假装任务在跑 |

不用脚本时的等价命令（Linux / macOS 同样适用）：

```bash
cd <仓库> && claude --bg -w <名字> --settings '{"worktree":{"baseRef":"head"}}' \
  --plugin-dir <插件目录> "/supervise start <任务>"
```

**Headless**（无界面，已实测）：`claude -p --plugin-dir D:/Claude-auto-coding "/supervise start <任务>"`。`-p` 本身跳过信任对话框；Git Bash 下需先 `export MSYS_NO_PATHCONV=1`，否则 `/supervise` 会被改写成路径。监督步骤在 `turn.complete` 内执行完才放行，所以 `-p` 会话会一直跑到任务进入终态。

### 实时面板

`/supervise start` 会同时打开 auto-coding 面板（全屏布局下停靠在侧边，主屏布局下内联），之后随时可用 `/supervise panel` 或状态条上的 **面板** 按钮重新打开。视觉取自 [live-panel-skill](https://github.com/ythx-101/live-panel-skill) 的 terminal-dark 主题，规则见 `design-system/auto-coding/MASTER.md`：

```
          AUTO-CODING  ·  T261004140124  ·  ◐ Worker 工作中
══════════════════════════════════════════════════════════════════
     ■ worker   ■ decide   ■ verify   ■ review   ■ boundary
任务  给 parser 加上空输入处理，并补测试
─●·─▶┆ Worker ┆────▶┆  决策  ┆────▶┆  验收  ┆────▶┆ Review ┆────▶┆  完成  ┆
     ┆◐ 第 2 轮┆     ┆ verify ┆     ┆ 1/2 ✗  ┆     ┆   —    ┆     ┆   —    ┆
» 验收检查未通过：check-1
│ session log                                  │
│ 14:05:37  verify   check-1 失败（exit 1）      │
│ 14:05:38  worker   修复轮 1/3：验收检查未通过   │  ← 最新一行高亮
┆ 预算 · 验收            已运行 6m · 剩余 3h54m ┆
┆ 轮次  ━━╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌  2/40              ┆
┆ 检查  diff-check ✓  check-1 ✗ exit 1          ┆
┆ 边界 · on guard  ◇ 合并  ◆ tag  ◇ 发版  ◇ 发布  ┆
~/repo $ /supervise start 给 parser 加上空输入处理… █
turns [2/40]  repair [1/3]  checks [1/2]  review [—]  boundary [1]   [暂停] [停止]
```

- 流水线高亮当前阶段；修复轮里 Worker 重新变为当前阶段，而把它打回来的验收/Review 保持红/黄。
- 光点、spinner、光标**只在任务进行中**动（200ms 一帧）；暂停和终态完全静止——面板不会在什么都没发生时假装忙碌。
- session log 由每一步自己写入（worker 回合、决策、检查、Review、修复轮、边界拦截、终态），和审计日志同源。

### 项目验收命令

在仓库里放 `.claude/auto-coding.json`（示例见 `examples/auto-coding.json`）：

```json
{ "checks": ["npm test", "npm run lint"] }
```

每条命令经平台 shell 执行（Windows：`cmd.exe /d /s /c`，其他：`sh -c`），可用 `"shell": ["bash", "-lc"]` 覆盖；退出码 0 为通过，单条超时 10 分钟。`git diff --check` 始终会跑。

### 全局选项（`/config` 菜单，或 settings 的 `pluginConfigs["auto-coding"].options`）

| 选项 | 默认 | 含义 |
| --- | --- | --- |
| `reviewerModel` | `opus` | 独立 Review 用的模型（opus / sonnet / haiku） |
| `maxTurns` | 40 | 每个任务的回合上限：主循环在任务期间结束的每一轮都算，含修复轮，也含暂停期间结束的回合（暂停让它跑完的那一轮、你接管时自己发起的回合） |
| `maxRepairRounds` | 3 | 修复轮上限，超过即 `blocked` |
| `deadlineMinutes` | 240 | 墙钟预算 |
| `protectedBranches` | `main,master` | 逗号分隔，`release/*` 这类前缀通配可用 |
| `publish` | `none` | 通过后：`none` 保留本地候选；`push` 让 Worker 推分支；`pr` 再开 PR（从不合并） |

选项在任务启动时快照进任务，运行中修改不影响当前任务。

## 5. 硬边界

任务处于非终态（含 `paused`）时，Bash 和 PowerShell 两个工具的命令都会过 `hooks/policy.ts`：

**拒绝**

- 合并：`gh pr merge`；在受保护分支上 `git merge` / `git rebase`（会跟踪同一条命令里的 `checkout`/`switch`）；直推受保护分支（`git push origin main`、`HEAD:main`、当前分支是 main 时的裸 `git push`、删除受保护分支）；`git branch -f/-D/-M` 或 `git update-ref` 改写受保护分支；`gh api` 合并 PR / 改写受保护分支
- 发版：创建/删除 tag；推 tag（`--tags`、`--follow-tags`、`refs/tags/`、`tag <名>`、形如 `v1.2.3` 的 refspec）；`--all` / `--mirror`；`gh release create/upload/edit/delete`；`gh api` 发版；`npm/pnpm/yarn/bun publish`、`npm version <x>`、`yarn version --patch` 等、`cargo/poetry/uv publish`、`twine upload`、`gem push`、`dotnet nuget push`、`docker/podman push`、`vsce/ovsx publish`、`lerna publish`、`changeset publish`、`goreleaser release`、`semantic-release`、`release-it`

**放行**：推功能分支（含 `--force-with-lease`）、`gh pr create/view/checks`、在功能分支上 merge/rebase main、在 main 上 `git pull`，以及一切本地开发操作（编辑、测试、提交）。

**它是词法的、尽力而为的**：按命令文本判断，引号内的 `sh -c '…'`、管道、`&&`、heredoc 喂给 shell、PowerShell here-string 交给 `Invoke-Expression`/`iex`/`pwsh`、`gh api graphql` 的 heredoc 正文都会被读到；提交信息、`--body`、喂给 `cat` 的 heredoc 被当作数据，不会误伤。但脚本文件里的命令、别名、变量拼接、`gh api graphql --input <文件>` 的正文、`gh workflow run` 触发的发版流水线都在它视野之外。**MCP 工具不在边界内**：只有 Bash 和 PowerShell 两个工具过 policy，会话若接了 GitHub 类 MCP 服务，它的合并 PR、写分支、发版工具不经过这道检查。**真正的保证应放在系统边界上**：GitHub 分支保护（main 要求 PR + review）、发布凭据（npm token 等）不进 Worker 的环境。mod 的边界是第二道防线和审计点，每次拦截都记入日志并作为证据交给 Reviewer。

`.git` 写入、删除底线这些本地防护不由 mod 拦截，交给 Claude Code 自己的权限模式。

## 6. 状态与审计

- 状态：`$.state`（`auto-coding.task`、`auto-coding.denials`、`auto-coding.events`、`auto-coding.isBandHidden`、`auto-coding.workerTurn`），类型契约在 `types/index.d.ts`
- 每次状态迁移递增 `seq`；异步步骤写回前核对 `seq`，被暂停/停止/重载超越的结果直接丢弃
- `workerTurn` 记录主循环在途回合：Worker 这一轮还没结束就 resume 时，任务回到 `running`，等这一轮结束再决策，不会读半轮对话或排第二条指令；有回合在途时 `/supervise start` 会拒绝（`stop` 不打断正在跑的那一轮，等它结束再启动，免得新任务把旧回合当成自己的第 1 轮）。标记在 `turn.complete` 一开始就清除，`session.start`（首次加载或回合结束后的重载）和 `session.end` 也会清掉残留，不会让 resume 或 start 等一个永远不来的回合结束
- 热重载：`session.start` 发现 `deciding/verifying/reviewing` 会自动重跑该步骤；`/supervise resume` 对这三个状态只在本环境没有在途步骤（即确实被重载打断）时才重跑，步骤还在跑时不会再并行跑一遍
- 审计日志：`<git-dir>/auto-coding/<id>.jsonl`，记录 `task_started`、`status`、`decision`、`checks`、`review`、`worker_input`、`boundary_denied`、`turn_while_paused`（暂停期间结束的回合：计入轮次，其回复作为 resume 时决策读到的"最后回复"，状态不变）

## 7. 已知限制与取舍

- **Reviewer 不能探索仓库**：只看 diff（>120k 字符截断并明示）、未跟踪文件（单文件 20k / 总计 60k）、检查结果、拦截记录、Worker 自述。换来的是零副作用、重载安全。没用后台子 agent，是因为它完成时会以 task-notification 回灌主循环、凭空触发一轮 Worker 回合。
- **决策步骤不独立**：fork 与 Worker 同模型同上下文；完成与否最终由验收 + 独立 Review 把关。
- **权限弹窗会卡住无人值守**：交互会话里等人点、`-p` 里直接拒绝。建议在 auto 模式或有 allowlist 的配置下使用。
- **API 错误重试用定时器**：交互会话正常；`-p` 会话可能在等待期间退出（任务记为 stopped，日志保留）。
- **任务绑定会话**：`/clear` 或退出即 `stopped`；同一会话一次一个任务，并行请用不同会话 + 不同 worktree。
- **没有成本核算**：只有轮次和时间预算。
- **会话里任何输入都会暂停自动推进**（包括中途补一句指导），需要 `/supervise resume`；在验收 / Review 中按 Esc 或模型调用超时同样进入 `paused`（验收中按 Esc：`$.process.run` 没有中止信号，已在跑的检查会跑完，但结果不计、不进修复轮）。
- **任务进行中，"停下来问人"的规则被临时改写**：任务处于 working 时，系统提示末尾多一段 `auto-coding:unattended`——列出预先授权的动作（编辑、命令/测试/构建、装依赖、本地提交、推功能分支、开 PR），并把其他指令（包括你的 CLAUDE.md，如"有歧义就停下来问"）里的"停下来问人 / 先确认"改为"写明假设、继续"。暂停（你一输入）或任务结束时这段即消失，正常规则恢复。决策步骤是第二道防线：Worker 为权限内动作请示、出于谨慎跳过、或报告完成却没提交，都会被要求直接去做；这些永远不构成挂起理由。不保证 100%，但系统提示层和决策层两道叠加。
- **Worker 回合结束后 spinner 会继续转一会儿**：监督步骤（决策、验收、Review）在 `turn.complete` 里执行，直到下一轮排上队或任务进入终态——这是预期行为，不是卡住。
- **热重载**：交互会话（含后台会话）监视 `--plugin-dir`，改了插件源码会在回合结束时重载；进行中的步骤由 `session.start` 接着跑。审查插件自身时用 `scripts/auto.ps1`，它加载快照。

## 8. 开发与验证

```powershell
claude plugin validate D:\Claude-auto-coding   # manifest、hooks、state 契约
claude plugin test D:\Claude-auto-coding       # tests/*.test.ts
```

- `tests/policy.test.ts`：边界放行/拒绝两侧 79 条用例
- `tests/loop.test.ts`：测试 hook 扮演引擎（git、fork、reviewer、prompt 提交），覆盖完成、检查失败修复、revise 修复、continue、子 agent 过滤、暂停/恢复、Worker 回合进行中恢复会等该回合结束、残留的回合标记在 session.start / session.end / 底层 turn.complete 失败后被清掉、有回合在途时 start 等它结束、步骤仍在运行时 resume 不重跑、暂停期间结束的回合计数并更新最后回复、验收中按 Esc（prepend 层插件抢先结束派发）进入 paused 而非修复轮、非 ASCII 及读不到的未跟踪文件仍列给 Reviewer、Review 被打断进入 paused、状态条在 terminal/desktop 上渲染且按钮可用、面板在无任务/进行中/修复轮下的绘制（两个 surface × 宽窄两种宽度）、动画只在 working 时重绘、边界只在任务期间生效
- 类型检查：加载过一次后引擎会写好 `.claude-plugin/types/` 和根目录 `tsconfig.json`（都已 gitignore），之后 `npx -p typescript tsc -p .`。工具类型表是本机的（Windows 只有 PowerShell、Linux 有 Bash），所以 shell 边界按名字正则匹配

已在真实引擎（2.1.289，Windows）实测：

- `-p`：一次通过闭环、检查失败 → 修复轮 → 通过、`git tag` 经 PowerShell 被拦截且 Reviewer 据拦截记录给出 `human`。
- 后台会话 + 面板：用本 mod 无人值守地审查本仓库（任务 T261004145555，约 24 分钟），`claude attach` 全程看面板推进；Worker 产出 `REVIEW.md` 并修复 5 个 P1，三项验收通过，独立 Review `pass`，结果已合并。
- `scripts/auto.ps1`：真实启动（无对话框、mod 接到任务）、干跑、未信任仓库报错。

## 9. 目录

```
.claude-plugin/plugin.json   manifest + userConfig
hooks/hooks.json             { "modules": ["./register.tsx"] }
hooks/register.tsx           所有 hook 与用到 $ 的状态机步骤（$ 不能跨 import 传递）
hooks/panel.tsx              纯绘制：实时面板与状态条（拿到元素表和数据模型，不碰 $）
scripts/auto.ps1             一键无人值守：后台会话 + 仓库内 worktree + 启动确认
hooks/logic.ts               纯函数：标签、预算、提示词、JSON 解析
hooks/policy.ts              纯函数：合并/发版边界
types/index.d.ts             $.state 契约
tests/                       claude plugin test 用例
examples/auto-coding.json    项目验收配置示例
.claude/auto-coding.json     本仓库自己的验收命令（validate + test）
design-system/auto-coding/   面板的配色 token 与动效规则
```

## 10. 后续可做

- 交互会话里的权限请求由决策步骤代答（原项目的 `permissionAuthority`）
- 候选通知 webhook（企业微信 / 通用 JSON）
- 作为 marketplace 发布，`claude plugin install` 安装
