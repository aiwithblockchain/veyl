# 用法：
#   powershell -ExecutionPolicy Bypass -File client\pc\scripts\dev.ps1
#       构建 debug 版 → 前台启动
#   powershell -ExecutionPolicy Bypass -File client\pc\scripts\dev.ps1 -Detach
#       构建后后台启动
#   powershell -ExecutionPolicy Bypass -File client\pc\scripts\dev.ps1 -NoOpen
#       只构建，不启动
#   powershell -ExecutionPolicy Bypass -File client\pc\scripts\dev.ps1 -KillExisting
#       启动前结束正在运行的 veyl-cli 实例
#   powershell -ExecutionPolicy Bypass -File client\pc\scripts\dev.ps1 -Help
#
# 当前是骨架：没有特权服务、没有 TUN、没有运行时与规则。
# 接入隧道层（M0 之后）时，在标了 TODO(TUN) 的位置补回签名、装服务与投放资源。
#
# 前置：Windows 10/11 x64、node/npm、cargo（MSVC）；
#       先在本目录执行过 npm install。

[CmdletBinding()]
param(
    [switch]$Detach,
    [switch]$NoOpen,
    [switch]$KillExisting,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Fail([string]$message) {
    throw $message
}

if ($Help) {
    Get-Content $PSCommandPath | Select-Object -First 16 | ForEach-Object {
        $_ -replace '^# ?', ''
    }
    exit 0
}

if ($NoOpen -and $Detach) {
    Fail "-NoOpen 与 -Detach 不能同时使用"
}

$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root "src-tauri\tauri.conf.json"
$cargoPath = Join-Path $root "src-tauri\Cargo.toml"

if (-not (Test-Path $configPath)) { Fail "找不到 $configPath" }
if (-not (Test-Path $cargoPath)) { Fail "找不到 $cargoPath" }
if (-not (Test-Path (Join-Path $root "node_modules"))) {
    Fail "缺少 node_modules。先执行：cd `"$root`"; npm install"
}

$config = Get-Content $configPath -Raw | ConvertFrom-Json
$product = $config.productName
if ([string]::IsNullOrWhiteSpace($product)) { Fail "读取 productName 失败" }

$cargoText = Get-Content $cargoPath -Raw
if ($cargoText -notmatch '(?m)^name\s*=\s*"([^"]+)"') {
    Fail "读取 Cargo 包名失败"
}
$cargoName = $Matches[1]

$exe = Join-Path $root "src-tauri\target\debug\$cargoName.exe"
$logsDir = Join-Path $root "build\logs"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$log = Join-Path $logsDir "dev-$stamp.log"

foreach ($tool in @("node", "npm", "cargo")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Fail "缺少命令：$tool"
    }
}

Write-Host "== veyl-cli 开发包（Windows）=="
Write-Host "目录：$root"
Write-Host "产物：$exe`n"

Write-Host "[1/3] 构建 debug 版"
Push-Location $root
try {
    & npm run tauri -- build --debug --no-bundle
    if ($LASTEXITCODE -ne 0) { Fail "构建失败（退出码 $LASTEXITCODE）" }
} finally {
    Pop-Location
}

if (-not (Test-Path $exe)) { Fail "找不到构建产物：$exe" }

# TODO(TUN)：接入隧道层后，在这里构建并签名 veyl-cli-service.exe、
# 投放 sing-box 运行时与规则、安装 LocalSystem 服务——照 scripts/dev/tun-dev.ps1。

Write-Host "`n[2/3] 结束旧实例"
if ($KillExisting) {
    $running = Get-Process -Name $cargoName -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $exe }
    if ($running) {
        Write-Host "  结束：$($running.Id -join ' ')"
        $running | Stop-Process -Force
        Start-Sleep -Milliseconds 300
    } else {
        Write-Host "  没有正在运行的实例"
    }
} else {
    $running = Get-Process -Name $cargoName -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $exe }
    if ($running) {
        Fail "veyl-cli 正在运行（PID：$($running.Id -join ' ')）。先退出，或加 -KillExisting"
    }
    Write-Host "  没有正在运行的实例"
}

Write-Host "`n[3/3] 启动"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

if ($NoOpen) {
    Write-Host "  已跳过启动（-NoOpen）"
} elseif ($Detach) {
    $process = Start-Process -FilePath $exe -WorkingDirectory $root `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru
    Write-Host "  已在后台启动（PID $($process.Id)）"
    Write-Host "  日志：$log"
} else {
    Write-Host "  前台运行，Ctrl-C 结束"
    Write-Host "  日志：$log`n"
    & $exe 2>&1 | Tee-Object -FilePath $log
    exit $LASTEXITCODE
}
