# auto-coding · 设计系统

面向终端的监控面板（Pane + AbovePrompt 状态条），视觉取自 [live-panel-skill](https://github.com/ythx-101/live-panel-skill) 的 `terminal-dark` 主题；其动效语法源自 [@thedelost](https://x.com/thedelost/status/2105398038026195279) 的 Codex agent-tree 动图。这里只借风格与语法，布局与内容是本项目自己的。代码中的唯一来源：`hooks/panel.tsx` 的 `TOKENS`。

## Tokens

| token | 值 | 用途 |
| --- | --- | --- |
| `bg` | `#14171c` | 面板底色（深色带蓝调，不用纯黑） |
| `surface` | `#262a32` | 次级面 |
| `hl` | `#302d45` | 点亮行背景（边界触发点） |
| `line` / `line2` | `#4a5367` / `#3a4154` | 已走过 / 未走到的连线与边框 |
| `dots` | `#566078` | 进度条剩余部分 |
| `dim` / `mute` | `#6f788c` / `#aab1c0` | 次要文字 / 标签 |
| `fg` / `wh` | `#e4e8f0` / `#ffffff` | 正文 / 仅用于最新一行与标题强调 |
| `cy` | `#86e1e6` | 角色：worker |
| `bl` | `#8fb4f6` | 角色：decide |
| `gr` | `#7fdba8` | 角色：verify；成功 |
| `pu` | `#b9a2f2` | 角色：review |
| `ye` | `#e3c07a` | 角色：boundary；警告、暂停、挂起 |
| `rd` | `#f08c8c` | 失败（live-panel 没有，本项目补充） |

## 规则（live-panel 动效语法的本地化）

1. **版面不动**：无任务时也画完整面板（全部阶段为待命态），状态只改变颜色、文字与光点。
2. **动的是真实状态**：
   - 快：当前阶段的 spinner、通往当前阶段那一段连线上的光点、命令行光标——**只在任务 working 时**，200ms 一帧；暂停与终态完全静止。
   - 中：session log 由每一步自己写入，最新一行高亮加粗，其余变灰。
   - 慢：阶段推进、修复轮计数、边界触发点（◇→◆）点亮。
3. **一个事实处处一致**：面板、状态条、`/supervise status`、审计日志都读同一份 `$.state`。
4. **阈值翻色**：预算条到 75% 变 `ye`，耗尽变 `rd`。
5. **边框**：阶段框与分区用 `dashed`（对应 live-panel 的分段框），日志用 `single`；边框由引擎绘制，不手画（CJK 双宽字符会撑歪手画框）。
6. **宽度**：≥72 列横排流水线，否则竖排；文字超长一律 `truncate-end`。
