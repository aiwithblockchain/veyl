# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\dev\tun-dev.ps1
#       构建 debug App 与 veyl-service → 签名 → 同步服务/规则 → 前台启动
#   powershell -ExecutionPolicy Bypass -File scripts\dev\tun-dev.ps1 -Detach
#       装完即返回（App 在后台跑）
#   powershell -ExecutionPolicy Bypass -File scripts\dev\tun-dev.ps1 -NoOpen
#       只构建、签名、同步服务，不启动
#   powershell -ExecutionPolicy Bypass -File scripts\dev\tun-dev.ps1 -KillExisting
#       构建前结束正在运行的 dev 实例（src-tauri\target\debug\veyl.exe）
#   powershell -ExecutionPolicy Bypass -File scripts\dev\tun-dev.ps1 -SkipService
#       只做代理模式：不签名、不装服务、不投放规则，不弹 UAC
#   powershell -ExecutionPolicy Bypass -File scripts\dev\tun-dev.ps1 -ReinstallService
#       强制重装服务并重新投放规则
#
# 为什么需要它：Windows 的 TUN 走「LocalSystem 服务 + 命名管道」，服务端只接受
# 带**可验证 Authenticode 签名**的客户端（tun/windows/peer.rs）。`tauri dev`
# 每次重建都会让 veyl.exe 的签名失效，服务也随之拒绝连接；所以和 macOS 的
# tun-dev.sh 一样，走「构建 → 签名 → 装服务 → 启动」这条与发布包同形的路径，
# 只是构建配置换成 debug、不产出安装包。
#
# 权限模型：本脚本用**普通窗口**运行。只有签名、装服务、投放规则这三步会弹一次
# UAC（通过 dev-sign.ps1 / dev-install-service.ps1）。App 始终以当前用户运行——
# 不要用管理员窗口跑本脚本，否则 WebView 也会拿到管理员令牌。
#
# 与 macOS 脚本的差异：
#   - App 不装进 Program Files（开发态直接跑 target\debug\veyl.exe）；
#     Program Files 下只有由服务自己读取的 veyl-service.exe 与 runtime\。
#   - 规则集由服务从 %ProgramData%\Veyl\rules\*.srs 读（W5 安装器尚未实现，
#     这里代替它投放，否则带分流的 TUN 配置会返回 rule_set_missing）。
#   - 服务或运行时变化时会重装服务；如果 TUN 正在连接，重装会断开它。
#
# 前置：Windows 10/11 x64、node/npm、cargo（MSVC）、管理员凭据（弹 UAC 时提供）、
#       src-tauri\resources\runtime\sing-box.exe / wintun.dll / wintun-LICENSE.txt。
#       规则归档可选；缺了 TUN 只能「全部走节点」，不能按规则分流。
#
# 日志：
#   logs\app-<日期>.log                 应用日志（debug 构建写仓库根的 logs\）
#   build\logs\tun-dev-*.log            本次前台/后台运行的标准输出
#   %ProgramData%\Veyl\logs\service.log 服务日志
#   %ProgramData%\Veyl\logs\sing-box.log 运行时日志
#
# 卸载：scripts\windows\dev-uninstall-service.ps1 -RemoveData
#       scripts\windows\dev-sign.ps1 -Remove

[CmdletBinding()]
param(
    [switch]$Detach,
    [switch]$NoOpen,
    [switch]$KillExisting,
    [switch]$SkipService,
    [switch]$ReinstallService,
    [switch]$Help,
    # 内部：父进程提权后调用，只执行签名 / 服务 / 规则这一步。
    [switch]$Elevated
)

$ErrorActionPreference = "Stop"

# App 的日志是 UTF-8。不设这个，Windows PowerShell 5.1 会按控制台代码页解码
# 子进程输出，中文日志全变乱码。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$appExe = Join-Path $root "src-tauri\target\debug\veyl.exe"
$serviceExe = Join-Path $root "src-tauri\target\debug\veyl-service.exe"
$runtimeDir = Join-Path $root "src-tauri\resources\runtime"
$rulesSourceDir = Join-Path $root "src-tauri\resources\rules"
$installDir = Join-Path $env:ProgramFiles "Veyl"
$installedService = Join-Path $installDir "veyl-service.exe"
$dataDir = Join-Path $env:ProgramData "Veyl"
$logsDir = Join-Path $root "build\logs"
$stateFile = Join-Path $root "build\state\dev-sync.json"
$serviceName = "VeylService"
$devSubject = "CN=Veyl Dev Signing"

function Fail([string]$message) {
    throw $message
}

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-Sha256([string]$path) {
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
}

function Get-RulesArchive {
    if (-not (Test-Path -LiteralPath $rulesSourceDir)) {
        return $null
    }
    $archive = Get-ChildItem -LiteralPath $rulesSourceDir -Filter "veyl-rules-*.tar.zst" -ErrorAction SilentlyContinue |
        Sort-Object Name |
        Select-Object -Last 1
    if ($archive) { return $archive.FullName }
    return $null
}

function Test-OurSignature([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    $signature = Get-AuthenticodeSignature -FilePath $path
    if ($signature.Status -ne "Valid") { return $false }
    if (-not $signature.SignerCertificate) { return $false }
    return $signature.SignerCertificate.Subject -eq $devSubject
}

function Read-DevState {
    if (-not (Test-Path -LiteralPath $stateFile)) { return $null }
    try {
        return Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    }
    catch {
        # 状态文件损坏只会让下一步多做一次特权检查，不是错误。
        return $null
    }
}

function Write-DevState {
    $archive = Get-RulesArchive
    $rulesHash = if ($archive) { Get-Sha256 $archive } else { "" }
    $state = @{
        rulesArchiveSha256 = $rulesHash
        serviceExeSha256   = Get-Sha256 $serviceExe
        updatedAt          = (Get-Date).ToString("o")
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stateFile) | Out-Null
    $state | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
}

# 只返回本脚本构建出来的实例；别的路径（例如安装版）不碰。
# Path 读不到时单独归类：既不能确认是 dev 实例，也不能当成不存在。
function Get-DevAppProcesses {
    $dev = @()
    $unknown = @()
    foreach ($process in (Get-Process -Name "veyl" -ErrorAction SilentlyContinue)) {
        $path = $null
        try { $path = $process.Path } catch { }
        if ($path -eq $appExe) {
            $dev += $process
        }
        elseif (-not $path) {
            $unknown += $process
        }
    }
    return @{ Dev = $dev; Unknown = $unknown }
}

function Stop-DevApp {
    $found = Get-DevAppProcesses
    $ids = @($found.Dev | ForEach-Object { $_.Id })
    if ($ids.Count -eq 0) { return }
    Write-Host "结束正在运行的 dev 实例（PID：$($ids -join ' ')）"
    foreach ($id in $ids) {
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
    # Windows 在进程退出前会一直占用 exe，构建前必须等文件锁释放。
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        $left = @((Get-DevAppProcesses).Dev | ForEach-Object { $_.Id })
        if ($left.Count -eq 0) { return }
        Start-Sleep -Milliseconds 200
    }
    Fail "结束旧实例失败（PID：$($left -join ' ')）"
}

# ---- 特权步骤：签名、服务、规则。普通用户窗口会把自己用 RunAs 再拉一次。 ----

function Invoke-PrivilegedSteps {
    foreach ($path in @($appExe, $serviceExe)) {
        if (-not (Test-Path -LiteralPath $path)) {
            Fail "找不到 $path（先在普通窗口跑一次构建）"
        }
    }
    foreach ($name in @("sing-box.exe", "wintun.dll", "wintun-LICENSE.txt")) {
        if (-not (Test-Path -LiteralPath (Join-Path $runtimeDir $name))) {
            Fail "缺少 $runtimeDir\$name。先执行：node scripts\runtime\fetch-runtime.mjs --platform=windows"
        }
    }

    Write-Host "[3/4] 签名（开发证书）"
    & (Join-Path $root "scripts\windows\dev-sign.ps1") -Path @($appExe, $serviceExe)
    if (-not (Test-OurSignature $appExe) -or -not (Test-OurSignature $serviceExe)) {
        Fail "签名后校验失败，服务会拒绝未签名的客户端"
    }

    Write-Host "[4/4] 同步服务与规则"
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    $needInstall = $ReinstallService.IsPresent -or (-not $service) -or (-not (Test-Path -LiteralPath $installedService))
    if (-not $needInstall) {
        if ((Get-Sha256 $installedService) -ne (Get-Sha256 $serviceExe)) {
            $needInstall = $true
        }
        else {
            foreach ($name in @("sing-box.exe", "wintun.dll", "wintun-LICENSE.txt")) {
                $source = Join-Path $runtimeDir $name
                $installed = Join-Path $installDir "runtime\$name"
                if (-not (Test-Path -LiteralPath $installed) -or (Get-Sha256 $installed) -ne (Get-Sha256 $source)) {
                    $needInstall = $true
                    break
                }
            }
        }
    }

    if ($needInstall) {
        Write-Host "  重装 $serviceName（如果 TUN 正在连接，会断开）"
        & (Join-Path $root "scripts\windows\dev-install-service.ps1") -Binary $serviceExe
    }
    elseif ($service.Status -ne "Running") {
        Write-Host "  启动 $serviceName"
        Start-Service -Name $serviceName
    }
    else {
        Write-Host "  服务已是最新，保持运行"
    }

    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if (-not $service -or $service.Status -ne "Running") {
        Fail "$serviceName 没有运行，TUN 会返回 helper_missing"
    }

    Stage-Rules
    Write-DevState
}

# 服务只认 tag，文件从 %ProgramData%\Veyl\rules\ 取（bin/veyl-service/server.rs）。
# 归档里的布局是 geosite/cn.srs + manifest，服务的映射是「文件名去扩展名 = tag」，
# 所以按 manifest 的 id 平铺成 <id>.srs。
function Stage-Rules {
    $archive = Get-RulesArchive
    if (-not $archive) {
        Write-Host "  没有规则归档：跳过投放。带分流的配置会返回 rule_set_missing"
        return
    }
    $archiveHash = Get-Sha256 $archive
    $state = Read-DevState
    if ($state -and $state.rulesArchiveSha256 -eq $archiveHash) {
        Write-Host "  规则未变化，跳过投放"
        return
    }

    $tar = Join-Path $env:SystemRoot "System32\tar.exe"
    if (-not (Test-Path -LiteralPath $tar)) {
        Write-Warning "没有 $tar，无法解压规则归档；TUN 分流会返回 rule_set_missing"
        return
    }

    $staging = Join-Path $env:TEMP ("veyl-rules-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    try {
        & $tar -xf $archive -C $staging
        if ($LASTEXITCODE -ne 0) { Fail "解压规则归档失败：$archive" }
        $manifestPath = Join-Path $staging "manifest.json"
        if (-not (Test-Path -LiteralPath $manifestPath)) {
            Fail "规则归档里没有 manifest.json：$archive"
        }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $target = Join-Path $dataDir "rules"
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        Get-ChildItem -LiteralPath $target -Filter "*.srs" -ErrorAction SilentlyContinue |
            Remove-Item -Force -ErrorAction SilentlyContinue
        $count = 0
        foreach ($item in $manifest.items) {
            $from = Join-Path $staging ($item.file -replace '/', '\')
            if (-not (Test-Path -LiteralPath $from)) {
                Fail "规则归档缺少 $($item.file)"
            }
            Copy-Item -LiteralPath $from -Destination (Join-Path $target ($item.id + ".srs")) -Force
            $count += 1
        }
        Write-Host "  规则已投放：$count 个 .srs 到 $target"
    }
    finally {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# 服务、运行时、签名、规则是否有一项需要管理员动。全部最新时不弹 UAC。
function Test-PrivilegedNeeded {
    if ($ReinstallService.IsPresent) { return $true }
    if (-not (Test-OurSignature $appExe) -or -not (Test-OurSignature $serviceExe)) { return $true }

    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if (-not $service -or $service.Status -ne "Running") { return $true }
    if (-not (Test-Path -LiteralPath $installedService)) { return $true }
    if ((Get-Sha256 $installedService) -ne (Get-Sha256 $serviceExe)) { return $true }

    foreach ($name in @("sing-box.exe", "wintun.dll", "wintun-LICENSE.txt")) {
        $source = Join-Path $runtimeDir $name
        $installed = Join-Path $installDir "runtime\$name"
        if (-not (Test-Path -LiteralPath $installed) -or (Get-Sha256 $installed) -ne (Get-Sha256 $source)) {
            return $true
        }
    }

    $archive = Get-RulesArchive
    if ($archive) {
        $state = Read-DevState
        if (-not $state -or $state.rulesArchiveSha256 -ne (Get-Sha256 $archive)) { return $true }
    }
    return $false
}

function Invoke-PrivilegedOrElevate {
    if (Test-Admin) {
        Invoke-PrivilegedSteps
        return
    }

    # 一次 UAC 覆盖全部特权步骤；取消只影响 TUN，代理模式照常可用。
    $argumentLine = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Elevated' -f $PSCommandPath
    if ($ReinstallService.IsPresent) {
        $argumentLine += " -ReinstallService"
    }
    $shellPath = (Get-Process -Id $PID).Path
    try {
        $child = Start-Process -FilePath $shellPath -Verb RunAs -Wait -PassThru -ArgumentList $argumentLine
        if ($child.ExitCode -ne 0) {
            Write-Warning "特权步骤失败（退出码 $($child.ExitCode)）。TUN 不可用，代理模式不受影响；日志见 $logsDir\tun-dev-privileged-*.log"
        }
    }
    catch {
        Write-Warning "已取消管理员授权：跳过签名与服务，TUN 不可用，代理模式不受影响"
    }
}

function Show-Help {
    Write-Host @'
用法：powershell -ExecutionPolicy Bypass -File scripts\dev\tun-dev.ps1 [选项]

  （无参数）        构建 debug App 与 veyl-service → 签名 → 同步服务/规则 → 前台启动
  -Detach           装完即返回（App 在后台跑）
  -NoOpen           只构建、签名、同步服务，不启动
  -KillExisting     构建前结束正在运行的 dev 实例
  -SkipService      只做代理模式：不签名、不装服务、不投放规则
  -ReinstallService 强制重装服务并重新投放规则
  -Help             打印本说明

普通窗口运行；签名/装服务/投放规则会弹一次 UAC。
App 始终以当前用户运行，不要用管理员窗口跑本脚本。
'@
}

# ---- 提权后的入口：只做特权步骤，然后返回给父进程 ----
if ($Elevated) {
    if (-not (Test-Admin)) {
        Write-Host "错误：-Elevated 需要管理员权限" -ForegroundColor Red
        exit 1
    }
    New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
    $transcript = Join-Path $logsDir ("tun-dev-privileged-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
    Start-Transcript -Path $transcript -Force | Out-Null
    try {
        Invoke-PrivilegedSteps
        Write-Host "特权步骤完成。日志：$transcript"
        exit 0
    }
    catch {
        Write-Host "错误：$($_.Exception.Message)" -ForegroundColor Red
        Write-Host "日志：$transcript"
        exit 1
    }
    finally {
        try { Stop-Transcript | Out-Null } catch { }
    }
}

if ($Help) {
    Show-Help
    exit 0
}

try {
    if ($Detach -and $NoOpen) { Fail "-Detach 与 -NoOpen 不能同时使用" }
    if ($env:OS -ne "Windows_NT") { Fail "tun-dev.ps1 只能在 Windows 上运行" }

    Write-Host "== Veyl Windows 开发启动 =="
    Write-Host "仓库：$root"
    if (Test-Admin) {
        Write-Warning "当前窗口是管理员权限：App 也会以管理员身份运行。建议用普通 PowerShell 重跑"
    }

    foreach ($tool in @("node", "npm", "cargo")) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Fail "缺少命令：$tool" }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $root "node_modules"))) {
        Fail "缺少 node_modules。先在 $root 执行：npm install"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $root "src-tauri\claurst\src-rust\crates\api\Cargo.toml"))) {
        Fail "claurst 子模块没有检出。先在 $root 执行：git submodule update --init --recursive"
    }

    if (-not (Test-Path -LiteralPath (Join-Path $runtimeDir "sing-box.exe"))) {
        Fail "缺少运行时：$runtimeDir\sing-box.exe`n  先执行：node scripts\runtime\fetch-runtime.mjs --platform=windows"
    }
    if (-not $SkipService) {
        foreach ($name in @("wintun.dll", "wintun-LICENSE.txt")) {
            if (-not (Test-Path -LiteralPath (Join-Path $runtimeDir $name))) {
                Fail "缺少运行时：$runtimeDir\$name`n  先执行：node scripts\runtime\fetch-runtime.mjs --platform=windows"
            }
        }
    }
    if (-not (Get-RulesArchive)) {
        Write-Warning "没有规则归档（src-tauri\resources\rules\veyl-rules-*.tar.zst）：TUN 只能「全部走节点」，按规则分流会返回 rule_set_missing"
        Write-Warning "需要分流时先执行：npm run rules:fetch"
    }

    $running = Get-DevAppProcesses
    if ($running.Unknown.Count -gt 0) {
        Fail "有 veyl.exe 正在运行但读不到路径（PID：$(@($running.Unknown | ForEach-Object { $_.Id }) -join ' ')）。先手动退出，或换管理员窗口确认"
    }
    if ($running.Dev.Count -gt 0) {
        if ($KillExisting) {
            Stop-DevApp
        }
        else {
            $ids = @($running.Dev | ForEach-Object { $_.Id }) -join ' '
            Fail "dev 实例正在运行（PID：$ids）。先退出 App，或加 -KillExisting 让脚本结束它"
        }
    }

    Write-Host "[1/4] 构建 veyl-service（debug）"
    & cargo build --manifest-path (Join-Path $root "src-tauri\Cargo.toml") --bin veyl-service
    if ($LASTEXITCODE -ne 0) { Fail "veyl-service 构建失败" }

    Write-Host "[2/4] 构建 App（debug，不打包）"
    Push-Location $root
    try {
        & npm run tauri -- build --debug --no-bundle
        if ($LASTEXITCODE -ne 0) { Fail "App 构建失败" }
    }
    finally {
        Pop-Location
    }
    foreach ($path in @($appExe, $serviceExe)) {
        if (-not (Test-Path -LiteralPath $path)) { Fail "找不到构建产物：$path" }
    }

    if ($SkipService) {
        Write-Host "`n-SkipService：跳过签名、服务与规则（代理模式）"
    }
    elseif (Test-PrivilegedNeeded) {
        Invoke-PrivilegedOrElevate
    }
    else {
        Write-Host "`n签名、服务与规则都已是最新，跳过特权步骤"
    }

    # 特权步骤可能因为 UAC 被取消而没执行；日志被 App 的 debug 输出淹没时，
    # 这一行是唯一能分清「TUN 可用」和「只是代理能用」的地方。
    if ($SkipService) {
        Write-Host "TUN 服务：已按 -SkipService 跳过（只有代理模式）"
    }
    else {
        $tunService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
        if ($tunService -and $tunService.Status -eq "Running") {
            Write-Host "TUN 服务：$serviceName 已安装并在运行"
        }
        else {
            Write-Warning "TUN 服务未安装或未运行：接管全部流量会返回 helper_missing。重跑脚本并在 UAC 弹窗里选「是」"
        }
    }

    if ($NoOpen) {
        Write-Host "`n-NoOpen：不启动 App"
        exit 0
    }

    $rustLog = $env:RUST_LOG
    if (-not $rustLog) {
        $rustLog = "debug"
        $env:RUST_LOG = $rustLog
    }
    New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"

    if ($Detach) {
        $outLog = Join-Path $logsDir ("tun-dev-{0}.out.log" -f $stamp)
        $errLog = Join-Path $logsDir ("tun-dev-{0}.err.log" -f $stamp)
        $process = Start-Process -FilePath $appExe -WorkingDirectory $root `
            -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
        Start-Sleep -Seconds 2
        if ($process.HasExited) {
            Write-Warning "App 已退出（退出码 $($process.ExitCode)）。日志：$errLog"
            exit 1
        }
        Write-Host "`n已在后台启动（PID $($process.Id)）"
        Write-Host "标准输出：$outLog"
        Write-Host "标准错误：$errLog"
    }
    else {
        $logFile = Join-Path $logsDir ("tun-dev-{0}.log" -f $stamp)
        Write-Host "`n前台启动：$appExe"
        Write-Host "日志：$logFile"
        Write-Host "应用日志：$root\logs\；按 Ctrl-C 结束（结束脚本会一并结束 App）"
        Write-Host ""
        $started = Get-Date
        $code = 0
        # PowerShell 5.1 把原生命令的 stderr 包成 ErrorRecord；在 Stop 下第一行日志
        # 就会被当成终止错误。App 的日志正常走 stderr，这里必须放宽为 Continue。
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            & $appExe 2>&1 | Tee-Object -FilePath $logFile
            $code = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previousPreference
            # Ctrl-C 打断管线时 App 可能还在；正常退出则没有进程可收。
            foreach ($process in (Get-DevAppProcesses).Dev) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            }
        }
        if (((Get-Date) - $started).TotalSeconds -le 2) {
            $others = Get-Process -Name "veyl" -ErrorAction SilentlyContinue
            if ($others) {
                Write-Warning "App 启动后立刻退出，但仍有 veyl.exe 在运行（单实例保护）。先退出旧实例，或用 -KillExisting 重跑"
                $code = 1
            }
        }
        if ($code -ne 0) {
            Write-Host "App 退出码：$code"
        }
    }

    Write-Host @"

下一步：
  1. 代理模式：新建或选择一套配置，点「连接」即可，不需要额外授权。
  2. TUN：服务已安装并在运行；连接时由服务拉起 sing-box（首次 start 要复制运行时，慢是正常的）。
  3. 失败时看：
       $dataDir\logs\service.log      服务
       $dataDir\logs\sing-box.log     运行时
       $root\logs\app-<日期>.log      应用
     rule_set_missing → 规则没投放（本脚本会投放；用 -ReinstallService 重试）
     helper_missing   → 服务没装/没跑，或用 -SkipService 启动过
  4. TUN 是独立进程：关闭 App 不会断开，断开请在 App 内操作。
"@
}
catch {
    Write-Host "错误：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
