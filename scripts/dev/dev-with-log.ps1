# 日常开发启动（Windows）：跑 `tauri dev`，同时把输出落到 build\logs\dev-<时间戳>.log。
#
#   powershell -ExecutionPolicy Bypass -File scripts\dev\dev-with-log.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\dev\dev-with-log.ps1 -Clean
#   powershell -ExecutionPolicy Bypass -File scripts\dev\dev-with-log.ps1 -NoOpen
#
# 与 dev-with-log.sh 行为对齐：缺 node_modules 直接退出、-Clean 清缓存、
# RUST_LOG 默认 veyl=debug,tauri=info（外部已设置则不覆盖）、退出时打印日志路径。

param(
    [switch]$Clean,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
Set-Location $root

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
    Write-Error "缺少 node_modules。先在 $root 执行：npm install"
    exit 1
}

if ($Clean) {
    Write-Host "清理缓存：dist\  node_modules\.vite\  src-tauri\target\debug"
    foreach ($path in @('dist', 'node_modules\.vite', 'src-tauri\target\debug')) {
        Remove-Item -Recurse -Force (Join-Path $root $path) -ErrorAction SilentlyContinue
    }
}

if (-not $env:RUST_LOG) {
    $rustLogSource = '使用默认值'
    $env:RUST_LOG = 'veyl=debug,tauri=info'
}
else {
    $rustLogSource = '已由外部设置'
}
# 目前 Host 还没读这个变量（自动开 DevTools 需要 src-tauri 侧支持），先留作约定。
$env:VEYL_OPEN_DEVTOOLS = if ($NoOpen) { '0' } else { '1' }

$logDir = Join-Path $root 'build\logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$logFile = Join-Path $logDir ("dev-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

Write-Host "启动 Veyl（RUST_LOG：$rustLogSource）"
Write-Host "日志：$logFile"
Write-Host ""

$exitCode = 0
try {
    npm run app:dev 2>&1 | Tee-Object -FilePath $logFile
    $exitCode = $LASTEXITCODE
}
finally {
    Write-Host ""
    Write-Host "日志：$logFile"
}

exit $exitCode
