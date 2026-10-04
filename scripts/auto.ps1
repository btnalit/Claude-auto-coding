<#
.SYNOPSIS
  在一个新 worktree 里，以 Claude Code 后台会话启动一个 auto-coding 无人值守任务。

.DESCRIPTION
  一条命令，不经过任何对话框：
  - worktree 由 `claude -w` 建在仓库内的 .claude/worktrees/<Name>，沿用仓库已有的信任。
    仓库本身还没被信任时直接报错退出，而不是停在一个没人看得见的信任对话框上。
  - worktree 从本地 HEAD 建，没推送的提交也在里面。
  - 后台会话没有窗口；`claude attach <id>` 随时接进去看实时面板，`claude logs <id>` 看最近输出。
  - 任务就在插件自己的仓库上跑时，加载的是 HEAD 的快照，Worker 改代码不会重载监督器。

.PARAMETER Task
  交给 /supervise start 的任务描述。
.PARAMETER Repo
  任务所在的 git 仓库，默认当前目录。
.PARAMETER Name
  worktree 名（分支为 worktree-<Name>），默认 auto-<月日-时分秒>。
.PARAMETER Plugin
  auto-coding 插件目录，默认本脚本所在的仓库。
.PARAMETER Attach
  启动后在当前终端接入会话，直接看面板。
.PARAMETER DryRun
  只打印将要执行的 claude 命令。

.EXAMPLE
  .\scripts\auto.ps1 "给 parser 加上空输入处理，并补测试"
.EXAMPLE
  .\scripts\auto.ps1 -Repo D:\proj -Name fix-42 -Attach "修复 #42：空输入时崩溃"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)] [string] $Task,
  [string] $Repo = (Get-Location).Path,
  [string] $Name = ('auto-' + (Get-Date -Format 'MMdd-HHmmss')),
  [string] $Plugin = '',
  [switch] $Attach,
  [switch] $DryRun
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 has no $PSScriptRoot yet while it evaluates parameter defaults.
if (-not $Plugin) { $Plugin = Split-Path -Parent $PSScriptRoot }

function Fail([string] $Message) {
  Write-Host "auto-coding: $Message" -ForegroundColor Red
  exit 1
}

function Same-Path([string] $A, [string] $B) {
  return (($A -replace '\\', '/').TrimEnd('/')) -ieq (($B -replace '\\', '/').TrimEnd('/'))
}

# The variables that mark a process as a child of another Claude Code session. Run from inside one,
# the new session would take them as its own; the person's configuration (CLAUDE_CONFIG_DIR and the rest) stays.
$SessionMarkers = @(
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_AGENT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_JOB_DIR'
)

# 1. The repository.
$top = & git -C $Repo rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or -not $top) { Fail "不是 git 仓库：$Repo" }
$top = ($top | Select-Object -First 1).Trim()
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Fail '找不到 claude 命令' }

# 2. Trust. A worktree `claude -w` makes inside the repo shares the repo's trust, and trust is
#    recorded per path; an untrusted repo would wait on the dialog, so stop here and say why.
$configDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { $HOME }
$configFile = Join-Path $configDir '.claude.json'
$isTrusted = $false
if (Test-Path $configFile) {
  $projects = (Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json).projects
  if ($projects) {
    foreach ($entry in $projects.PSObject.Properties) {
      if ((Same-Path $entry.Name $top) -and $entry.Value.hasTrustDialogAccepted -eq $true) { $isTrusted = $true }
    }
  }
}
if (-not $isTrusted) {
  Fail "Claude Code 还没有信任 $top 。在该目录运行一次 claude，选择 'Yes, I trust this folder'（只需一次），再重试。"
}

# 3. The plugin the session loads.
if (-not (Test-Path (Join-Path $Plugin '.claude-plugin\plugin.json'))) { Fail "找不到 auto-coding 插件：$Plugin" }
$pluginDir = (Resolve-Path $Plugin).Path
$pluginTop = & git -C $pluginDir rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -eq 0 -and $pluginTop -and (Same-Path ($pluginTop | Select-Object -First 1).Trim() $top)) {
  # The Worker will edit this very plugin: load a snapshot of HEAD, so its edits never reload the supervisor.
  $sha = (& git -C $top rev-parse --short HEAD).Trim()
  $snapshot = Join-Path $env:TEMP "auto-coding-plugin-$sha"
  # A dry run only names the snapshot the real run would load; it makes and prunes nothing.
  if (-not $DryRun -and -not (Test-Path (Join-Path $snapshot '.claude-plugin\plugin.json'))) {
    New-Item -ItemType Directory -Force -Path $snapshot | Out-Null
    $archive = "auto-coding-plugin-$sha.tar"
    # Windows' own tar first: a GNU tar earlier on PATH (Git's) reads "C:" as a remote host,
    # so the archive is also named relative to the folder it is unpacked in.
    $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path $tarExe)) { $tarExe = 'tar' }
    Push-Location $snapshot
    try {
      & git -C $top archive -o (Join-Path $snapshot $archive) HEAD
      if ($LASTEXITCODE -ne 0) { Fail '无法生成插件快照（git archive 失败）' }
      & $tarExe -xf $archive
      if ($LASTEXITCODE -ne 0) { Fail '无法生成插件快照（tar 失败）' }
    } finally {
      Remove-Item $archive -ErrorAction SilentlyContinue
      Pop-Location
    }
  }
  $pluginDir = $snapshot
  # Snapshots pile up one per commit. One a day old serves no running task (a task's deadline is hours),
  # so those go, with any archive a failed unpack left; the one this task loads stays.
  $cutoff = (Get-Date).AddDays(-1)
  Get-ChildItem -Path $env:TEMP -Filter 'auto-coding-plugin-*' -ErrorAction SilentlyContinue |
    Where-Object { -not $DryRun -and $_.FullName -ne $snapshot -and $_.LastWriteTime -lt $cutoff } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}

# 4. Settings for this session alone: the worktree starts from the local HEAD. A file, because
#    PowerShell 5.1 drops the quotes of a JSON string passed to a native command.
$settings = Join-Path $env:TEMP 'auto-coding-worktree-head.json'
Set-Content -Path $settings -Value '{"worktree":{"baseRef":"head"}}' -Encoding ASCII

$claudeArgs = @('--bg', '-w', $Name, '--settings', $settings, '--plugin-dir', $pluginDir, "/supervise start $Task")
if ($DryRun) {
  Write-Host "cd $top"
  Write-Host ('claude ' + (($claudeArgs | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join ' '))
  exit 0
}

# Runs claude and returns what it printed as plain text. claude writes UTF-8; the console's own code
# page (GBK on a Chinese Windows) would garble it, so UTF-8 is set for the call alone and put back.
function Invoke-Claude([string[]] $ArgList) {
  $previous = [Console]::OutputEncoding
  $ErrorActionPreference = 'Continue'
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  try {
    $text = & claude @ArgList 2>&1 | Out-String
  } finally {
    [Console]::OutputEncoding = $previous
  }
  return $text -replace "$([char]27)\[[0-9;?]*[A-Za-z]", ''
}

# 5. Start it, as a session of its own.
foreach ($marker in $SessionMarkers) { Remove-Item "Env:$marker" -ErrorAction SilentlyContinue }
Push-Location $top
try {
  $out = Invoke-Claude $claudeArgs
} finally {
  Pop-Location
}
$match = [regex]::Match($out, 'backgrounded[^\r\n]*?\b([0-9a-f]{8})\b')
if (-not $match.Success) {
  Write-Host $out
  Fail '后台会话没有启动（见上面的输出）'
}
$id = $match.Groups[1].Value

# 6. Wait until the mod has taken the task, so a session that did not load it never passes for a running task.
$state = 'waiting'
for ($i = 0; $i -lt 30 -and $state -eq 'waiting'; $i++) {
  Start-Sleep -Seconds 2
  $screen = Invoke-Claude @('logs', $id)
  if ($screen -match '已启动监督任务') { $state = 'started' }
  elseif ($screen -match 'Unknown command: /supervise') { $state = 'no-plugin' }
}
if ($state -eq 'no-plugin') {
  Invoke-Claude @('stop', $id) | Out-Null
  Fail "会话里没有加载 auto-coding（Unknown command: /supervise），已停止会话 $id。插件目录：$pluginDir"
}

$worktree = Join-Path $top ".claude\worktrees\$Name"
if ($state -eq 'started') {
  Write-Host "auto-coding 任务已在后台启动" -ForegroundColor Green
} else {
  Write-Host "auto-coding 会话已启动，60 秒内还没看到任务开始，用 claude logs $id 确认" -ForegroundColor Yellow
}
Write-Host "  会话      $id"
Write-Host "  worktree  $worktree（分支 worktree-$Name）"
Write-Host "  看面板    claude attach $id"
Write-Host "  看输出    claude logs $id"
Write-Host "  结束      claude stop $id"
# `claude rm` refuses while the stopped session's process is still exiting (its lock names a live pid).
Write-Host "  清理      等 stop 后的进程退出（几秒），再 claude rm $id ：删会话和 worktree"

if ($Attach) {
  Push-Location $top
  try { & claude attach $id } finally { Pop-Location }
}
