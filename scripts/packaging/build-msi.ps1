# 用法：
#   pwsh scripts/packaging/build-msi.ps1           只构建未签名 MSI
#   pwsh scripts/packaging/build-msi.ps1 -Sign     构建并签名（没有凭据直接失败）
#
# 前置：Windows、node/npm、cargo、Rust MSVC toolchain、WiX（Tauri 会自动下载）
# 产物：build\packages\<Product>-<version>.msi
# 日志：build\logs\build-msi-<timestamp>.log
#
# 签名顺序固定：签 exe → 打包 MSI → 签 MSI。
# 签名失败必须让整个脚本失败——不存在「忽略退出码继续出包」的分支。

[CmdletBinding()]
param(
    [switch]$Sign,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
    Get-Content $PSCommandPath | Select-Object -First 8 | ForEach-Object { $_ -replace '^#\s?', '' }
    exit 0
}

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$buildDir = Join-Path $root "build"
$packagesDir = Join-Path $buildDir "packages"
$logsDir = Join-Path $buildDir "logs"

New-Item -ItemType Directory -Force -Path $packagesDir | Out-Null
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

$logPath = Join-Path $logsDir ("build-msi-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
Start-Transcript -Path $logPath -Force | Out-Null

function Fail([string]$message) {
    throw $message
}

try {
    if ($env:OS -ne "Windows_NT") {
        Fail "build-msi.ps1 只能在 Windows 上运行"
    }

    Write-Host "== Veyl Windows 打包 =="
    Write-Host "仓库：$root"
    Write-Host "日志：$logPath"

    foreach ($tool in @("node", "npm", "cargo")) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            Fail "缺少命令：$tool"
        }
    }

    $version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
    $config = Get-Content (Join-Path $root "src-tauri/tauri.conf.json") -Raw | ConvertFrom-Json
    $productName = $config.productName
    if (-not $version) { Fail "读取版本号失败" }
    if (-not $productName) { Fail "读取 productName 失败" }

    $packageName = $null
    $section = $null
    foreach ($line in Get-Content (Join-Path $root "src-tauri/Cargo.toml")) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^\[.+\]$') { $section = $trimmed; continue }
        if ($section -eq '[package]' -and $trimmed -match '^name\s*=\s*"([^"]+)"') {
            $packageName = $Matches[1]
            break
        }
    }
    if (-not $packageName) { Fail "读取 Cargo 包名失败" }

    Write-Host "版本：$version"
    Write-Host "产品名：$productName"

    Write-Host "`n[0/5] 图标新鲜度"
    $iconSource = Join-Path $root "veyl.png"
    $iconIco = Join-Path $root "src-tauri/icons/icon.ico"
    if (-not (Test-Path $iconIco)) {
        Write-Warning "找不到 src-tauri/icons/icon.ico，先跑 npm run icons"
    }
    elseif ((Test-Path $iconSource) -and ((Get-Item $iconSource).LastWriteTime -gt (Get-Item $iconIco).LastWriteTime)) {
        Write-Warning "icon.ico 比 veyl.png 旧，建议先跑 npm run icons（本次仍用现有图标打包）"
    }
    else {
        Write-Host "  图标不早于源图"
    }

    # 凭据检查必须在构建之前：不允许「先构建，最后发现签不了」。
    if ($Sign) {
        $hasCloud = [bool]$env:VEYL_WIN_SIGN_CMD
        $hasThumbprint = [bool]$env:VEYL_WIN_CERT_THUMBPRINT
        Write-Host ("  VEYL_WIN_SIGN_CMD        {0}" -f $(if ($hasCloud) { "已设置" } else { "未设置" }))
        Write-Host ("  VEYL_WIN_CERT_THUMBPRINT {0}" -f $(if ($hasThumbprint) { "已设置" } else { "未设置" }))
        if (-not $hasCloud -and -not $hasThumbprint) {
            Fail "指定了 -Sign 但未配置签名凭据；请设置 VEYL_WIN_SIGN_CMD 或 VEYL_WIN_CERT_THUMBPRINT，或去掉 -Sign 只出一份未签名 MSI"
        }
        Write-Host "-Sign：先签 exe，再打 MSI，最后签 MSI"
    }
    else {
        Write-Host "未指定 -Sign：产出未签名 MSI（仅限内测）"
    }

    $signTool = Join-Path $PSScriptRoot "lib/sign-windows.ps1"
    $pwshExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell" }

    Push-Location $root
    try {
        Write-Host "`n[1/5] 构建前端"
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build 失败" }

        if ($Sign) {
            Write-Host "`n[2/5] 构建可执行文件（不打包）"
            & npm run tauri -- build --no-bundle
            if ($LASTEXITCODE -ne 0) { throw "tauri build --no-bundle 失败" }

            $exePath = Join-Path $root "src-tauri/target/release/$packageName.exe"
            if (-not (Test-Path $exePath)) { throw "找不到可执行文件：$exePath" }

            Write-Host "`n[3/5] 签名可执行文件"
            & $pwshExe -NoProfile -ExecutionPolicy Bypass -File $signTool -Path $exePath
            if ($LASTEXITCODE -ne 0) { throw "签名 exe 失败，终止构建" }

            Write-Host "`n[4/5] 打包 MSI"
            & npm run tauri -- bundle --bundles msi
            if ($LASTEXITCODE -ne 0) { throw "tauri bundle 失败" }
        }
        else {
            Write-Host "`n[2/5] 构建并打包 MSI"
            & npm run tauri -- build --bundles msi
            if ($LASTEXITCODE -ne 0) { throw "tauri build 失败" }
            Write-Host "`n[3/5] 跳过签名"
            Write-Host "`n[4/5] 已完成打包"
        }
    }
    finally {
        Pop-Location
    }

    Write-Host "`n[5/5] 收集产物"
    $msiDir = Join-Path $root "src-tauri/target/release/bundle/msi"
    if (-not (Test-Path $msiDir)) { Fail "找不到 MSI 目录：$msiDir" }

    $msi = Get-ChildItem -Path $msiDir -Filter *.msi |
        Sort-Object LastWriteTime |
        Select-Object -Last 1
    if (-not $msi) { Fail "MSI 目录里没有 .msi 文件：$msiDir" }

    $target = Join-Path $packagesDir ("{0}-{1}.msi" -f $productName, $version)
    Copy-Item -Path $msi.FullName -Destination $target -Force
    Write-Host "  $target"

    if ($Sign) {
        Write-Host "`n签名 MSI"
        & $pwshExe -NoProfile -ExecutionPolicy Bypass -File $signTool -Path $target
        if ($LASTEXITCODE -ne 0) {
            Remove-Item -Path $target -Force -ErrorAction SilentlyContinue
            throw "签名 MSI 失败，已删除未签名产物"
        }
    }

    $hash = Get-FileHash -Path $target -Algorithm SHA256
    $size = (Get-Item $target).Length
    Write-Host "`n完成"
    Write-Host "  产物：$target"
    Write-Host ("  大小：{0:N1} MB" -f ($size / 1MB))
    Write-Host "  摘要：$($hash.Hash.ToLower())"
    if (-not $Sign) {
        Write-Host "  提示：这是未签名包，对外分发前请用 -Sign 重新构建"
    }
    Write-Host "  提示：装到干净机器上确认快捷方式与开始菜单用的是新图标"

    Start-Sleep -Milliseconds 100
    Stop-Transcript | Out-Null
    exit 0
}
catch {
    Write-Host "错误：$_" -ForegroundColor Red
    try { Stop-Transcript | Out-Null } catch { }
    exit 1
}
