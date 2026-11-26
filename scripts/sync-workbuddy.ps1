<#
.SYNOPSIS
    把 fork-repo 的运行时文件同步到 WorkBuddy 发布目录，并做校验。

.DESCRIPTION
    WorkBuddy 发布的是它自己的 localDir 副本，不会自动跟随 git 仓库。
    这个脚本负责：
      1. 备份发布目录里将被覆盖的运行时文件（不备份 .env）
      2. 复制 server.js / lib / public / data/samples.json 等运行时文件
      3. 校验源文件与目标文件 SHA256 一致，且 .env 未被改动
      4. 对 JS 文件跑 node --check
      5. 用示例模式启动一次，检查 /api/health

.PARAMETER SourceDir
    仓库根目录，默认是脚本所在目录的上一级。

.PARAMETER DeployDir
    WorkBuddy 应用的发布目录；也可以用环境变量 FORK_DEPLOY_DIR 指定。

.PARAMETER SkipSmoke
    跳过启动冒烟测试，只做同步与哈希校验。

.EXAMPLE
    $env:FORK_DEPLOY_DIR = 'C:\path\to\WorkBuddy\fork'
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/sync-workbuddy.ps1

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/sync-workbuddy.ps1 -DeployDir 'C:\path\to\WorkBuddy\fork' -SkipSmoke
#>
[CmdletBinding()]
param(
    [string]$SourceDir,
    [string]$DeployDir = $env:FORK_DEPLOY_DIR,
    [switch]$SkipSmoke
)

$ErrorActionPreference = 'Stop'

if (-not $DeployDir) {
    Write-Host '错误：请用 -DeployDir 或环境变量 FORK_DEPLOY_DIR 指定 WorkBuddy 发布目录。' -ForegroundColor Red
    exit 1
}
if (-not $SourceDir) {
    $SourceDir = Split-Path -Parent $PSScriptRoot
}

function Write-Step([string]$Text) {
    Write-Host "==> $Text" -ForegroundColor Cyan
}

$SourceDir = (Resolve-Path -LiteralPath $SourceDir).Path
if (-not (Test-Path -LiteralPath $DeployDir)) {
    throw "发布目录不存在：$DeployDir"
}
$DeployDir = (Resolve-Path -LiteralPath $DeployDir).Path
if ($DeployDir -eq $SourceDir) {
    throw '发布目录不能等于仓库目录。'
}

if (-not (Test-Path -LiteralPath (Join-Path $SourceDir 'server.js'))) {
    throw "源目录里找不到 server.js：$SourceDir"
}

$fileList = @('server.js', 'doctor.js', 'check-quotes.js')
$dirList = @('lib', 'public')
$dataFile = 'data/samples.json'

$envPath = Join-Path $DeployDir '.env'
$envHashBefore = $null
if (Test-Path -LiteralPath $envPath) {
    $envHashBefore = (Get-FileHash -LiteralPath $envPath -Algorithm SHA256).Hash
} else {
    Write-Warning '发布目录没有 .env，发布后很可能走示例模式。'
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path (Split-Path -Parent $DeployDir) ("fork-backup-$stamp")
Write-Step "备份到 $backupDir"
New-Item -ItemType Directory -Path $backupDir | Out-Null

foreach ($rel in ($fileList + $dataFile)) {
    $old = Join-Path $DeployDir $rel
    if (Test-Path -LiteralPath $old) {
        $backup = Join-Path $backupDir $rel
        New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
        Copy-Item -LiteralPath $old -Destination $backup -Force
    }
}
foreach ($dir in $dirList) {
    $old = Join-Path $DeployDir $dir
    if (Test-Path -LiteralPath $old) {
        Copy-Item -LiteralPath $old -Destination (Join-Path $backupDir $dir) -Recurse -Force
    }
}

Write-Step "同步运行时文件到 $DeployDir"
foreach ($rel in $fileList) {
    Copy-Item -LiteralPath (Join-Path $SourceDir $rel) -Destination (Join-Path $DeployDir $rel) -Force
}
foreach ($dir in $dirList) {
    $targetDir = Join-Path $DeployDir $dir
    if (-not (Test-Path -LiteralPath $targetDir)) {
        New-Item -ItemType Directory -Path $targetDir | Out-Null
    }
    Copy-Item -Path (Join-Path $SourceDir "$dir\*") -Destination $targetDir -Recurse -Force
}

$dataDir = Join-Path $DeployDir 'data'
if (-not (Test-Path -LiteralPath $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir | Out-Null
}
Copy-Item -LiteralPath (Join-Path $SourceDir $dataFile) -Destination $dataDir -Force

$relativeFiles = New-Object System.Collections.Generic.List[string]
foreach ($rel in ($fileList + $dataFile)) {
    $relativeFiles.Add($rel)
}
foreach ($dir in $dirList) {
    Get-ChildItem -LiteralPath (Join-Path $SourceDir $dir) -Recurse -File | ForEach-Object {
        $relativeFiles.Add($_.FullName.Substring($SourceDir.Length + 1))
    }
}

Write-Step '校验 SHA256'
$mismatch = @()
foreach ($rel in ($relativeFiles | Sort-Object -Unique)) {
    $src = Join-Path $SourceDir $rel
    $dst = Join-Path $DeployDir $rel
    if (-not (Test-Path -LiteralPath $dst)) {
        $mismatch += "$rel（目标缺失）"
        continue
    }
    $srcHash = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash
    $dstHash = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
    if ($srcHash -ne $dstHash) {
        $mismatch += $rel
    }
}
if ($mismatch.Count -gt 0) {
    throw "以下文件哈希不一致：`n$($mismatch -join "`n")"
}

$envHashAfter = $null
if (Test-Path -LiteralPath $envPath) {
    $envHashAfter = (Get-FileHash -LiteralPath $envPath -Algorithm SHA256).Hash
}
if ($envHashBefore -ne $envHashAfter) {
    throw '.env 在同步过程中被改动了，请立即检查。'
}

$node = (Get-Command node -ErrorAction Stop).Source
Write-Step 'node --check'
$jsFiles = @('server.js', 'doctor.js', 'check-quotes.js', 'public/app.js')
$jsFiles += Get-ChildItem -LiteralPath (Join-Path $SourceDir 'lib') -Recurse -File -Filter '*.js' |
    ForEach-Object { $_.FullName.Substring($SourceDir.Length + 1) }

foreach ($rel in ($jsFiles | Sort-Object -Unique)) {
    & $node --check (Join-Path $DeployDir $rel)
    if ($LASTEXITCODE -ne 0) {
        throw "node --check 失败：$rel"
    }
}

if (-not $SkipSmoke) {
    Write-Step '启动冒烟测试（示例模式，PORT=0）'
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $psi.Arguments = 'server.js'
    $psi.WorkingDirectory = $DeployDir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables['PORT'] = '0'
    $psi.EnvironmentVariables['FORK_DATA_SOURCE'] = 'sample'

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    $null = $proc.Start()
    try {
        $lineTask = $proc.StandardOutput.ReadLineAsync()
        if (-not $lineTask.Wait(15000)) {
            throw '启动超时（15 秒内没有读到启动日志）'
        }
        $line = $lineTask.Result
        if ($line -notmatch 'localhost:(\d+)') {
            throw "启动日志里没有端口：$line"
        }
        $port = [int]$matches[1]
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 10
        if (-not $health.ok) {
            throw 'health.ok 不是 true'
        }
        if (-not $health.sampleMode) {
            throw 'health.sampleMode 不是 true，说明示例模式没有生效'
        }
        Write-Host "    健康检查通过：http://127.0.0.1:$port（provider=$($health.provider)）" -ForegroundColor Green
    } catch {
        $stderr = ''
        if (-not $proc.HasExited) {
            $proc.Kill()
            $proc.WaitForExit(3000) | Out-Null
        }
        try { $stderr = $proc.StandardError.ReadToEnd() } catch { }
        throw "$($_.Exception.Message)`n$stderr"
    } finally {
        if (-not $proc.HasExited) {
            $proc.Kill()
            $proc.WaitForExit(3000) | Out-Null
        }
        $proc.Dispose()
    }
}

Write-Host ''
Write-Host '同步完成。' -ForegroundColor Green
Write-Host "  源目录：$SourceDir"
Write-Host "  发布目录：$DeployDir"
Write-Host "  备份：$backupDir"
Write-Host "  校验：$($relativeFiles.Count) 个文件哈希一致；.env 未改动"
Write-Host ''
Write-Host '下一步（WorkBuddy 客户端）：' -ForegroundColor Yellow
Write-Host '  1. 打开 WorkBuddy → 点击头像 → 设置 → 数据管理 → 应用'
Write-Host '  2. 找到「Fork分歧地图」→ 右侧三个点 → 下线应用'
Write-Host '  3. 再点发布应用，等发布完成'
Write-Host '  4. 复制新的完整分享链接（?sharecode=...）'
Write-Host '  5. 如果域名或分享码变了，同步更新 public/index.html 里的 og:url / og:image / twitter:image'
