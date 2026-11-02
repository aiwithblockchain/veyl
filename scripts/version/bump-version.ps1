# 用法：
#   pwsh scripts/version/bump-version.ps1 0.2.0
#   pwsh scripts/version/bump-version.ps1 -Build
#   pwsh scripts/version/bump-version.ps1 -Minor
#   pwsh scripts/version/bump-version.ps1 -Major
#   pwsh scripts/version/bump-version.ps1 -Build -DryRun
#
# 同步三处版本号并回读校验：
#   package.json              .version
#   src-tauri/Cargo.toml      [package] version
#   src-tauri/tauri.conf.json .version
#
# 前置：PowerShell 5.1+。不修改 Cargo.lock。
# -Build/-Minor/-Major 会丢弃预发布后缀。

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Version,

    [switch]$Build,
    [switch]$Minor,
    [switch]$Major,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$pkgJson = Join-Path $root "package.json"
$cargoToml = Join-Path $root "src-tauri/Cargo.toml"
$tauriConf = Join-Path $root "src-tauri/tauri.conf.json"

function Fail([string]$message) {
    Write-Error $message
    exit 1
}

function Show-Usage {
    Write-Host @"
用法：
  bump-version.ps1 <x.y.z>        设定指定版本
  bump-version.ps1 -Build         修订号 +1
  bump-version.ps1 -Minor         次版本 +1，修订号归零
  bump-version.ps1 -Major         主版本 +1，其余归零
  bump-version.ps1 <flag> -DryRun 只打印，不落盘
"@
}

$modes = @($Build, $Minor, $Major) | Where-Object { $_ }
if ($modes.Count -gt 1) { Fail "-Build/-Minor/-Major 只能选一个" }
if ($Version -and $modes.Count -eq 1) { Fail "版本号不能和 -Build/-Minor/-Major 同时使用" }
if (-not $Version -and $modes.Count -eq 0) { Show-Usage; Fail "缺少目标版本" }

foreach ($file in @($pkgJson, $cargoToml, $tauriConf)) {
    if (-not (Test-Path $file)) { Fail "找不到文件：$file" }
}

function Test-Semver([string]$value) {
    return $value -match '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
}

function Read-PkgVersion {
    return (Get-Content $pkgJson -Raw | ConvertFrom-Json).version
}

function Read-TauriVersion {
    return (Get-Content $tauriConf -Raw | ConvertFrom-Json).version
}

function Read-CargoVersion {
    $section = $null
    foreach ($line in Get-Content $cargoToml) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^\[.+\]$') { $section = $trimmed; continue }
        if ($section -eq '[package]' -and $trimmed -match '^version\s*=\s*"([^"]+)"') {
            return $Matches[1]
        }
    }
    return $null
}

function Write-TextWithoutBom([string]$path, [string]$text) {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $utf8)
}

function Set-JsonVersion([string]$path, [string]$version) {
    $text = [System.IO.File]::ReadAllText($path)
    $regex = [regex]'("version"\s*:\s*")[^"]*(")'
    if (-not $regex.IsMatch($text)) { Fail "$path 里找不到 version 字段" }
    $updated = $regex.Replace($text, { param($m) $m.Groups[1].Value + $version + $m.Groups[2].Value }, 1)
    Write-TextWithoutBom $path $updated
}

function Set-CargoVersion([string]$path, [string]$version) {
    $lines = [System.IO.File]::ReadAllLines($path)
    $section = $null
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $trimmed = $lines[$i].Trim()
        if ($trimmed -match '^\[.+\]$') { $section = $trimmed; continue }
        if ($section -eq '[package]' -and $trimmed -match '^version\s*=') {
            $lines[$i] = [regex]::Replace($lines[$i], '(version\s*=\s*)"[^"]*"', ('$1"' + $version + '"'), 1)
            Write-TextWithoutBom $path ($lines -join "`n")
            return
        }
    }
    Fail "$path 的 [package] 段里找不到 version"
}

$current = Read-PkgVersion
if (-not (Test-Semver $current)) { Fail "package.json 里的版本 '$current' 不是 semver" }

if ($Version) {
    if (-not (Test-Semver $Version)) { Fail "版本 '$Version' 不是 semver（要求 x.y.z，可带 -pre/+build）" }
    $new = $Version
}
else {
    $parts = $current -split '\.'
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    $patch = [int]($parts[2] -replace '[-+].*$', '')
    if ($Build) { $patch++ }
    if ($Minor) { $minor++; $patch = 0 }
    if ($Major) { $major++; $minor = 0; $patch = 0 }
    $new = "$major.$minor.$patch"
}

$cargoCurrent = Read-CargoVersion
$tauriCurrent = Read-TauriVersion

Write-Host "当前版本"
Write-Host ("  package.json              {0}" -f $current)
Write-Host ("  src-tauri/Cargo.toml      {0}" -f $cargoCurrent)
Write-Host ("  src-tauri/tauri.conf.json {0}" -f $tauriCurrent)
if ($current -ne $cargoCurrent -or $current -ne $tauriCurrent) {
    Write-Warning "三处当前版本不一致，本次会一起覆盖为 $new"
}

Write-Host ""
Write-Host "将写入 $new："
Write-Host ("  package.json              {0} -> {1}" -f $current, $new)
Write-Host ("  src-tauri/Cargo.toml      {0} -> {1}" -f $cargoCurrent, $new)
Write-Host ("  src-tauri/tauri.conf.json {0} -> {1}" -f $tauriCurrent, $new)

if ($DryRun) {
    Write-Host ""
    Write-Host "-DryRun：未写入任何文件"
    exit 0
}

Set-JsonVersion $pkgJson $new
Set-CargoVersion $cargoToml $new
Set-JsonVersion $tauriConf $new

$failed = $false
$results = @(
    @{ Name = "package.json"; Value = (Read-PkgVersion) },
    @{ Name = "src-tauri/Cargo.toml"; Value = (Read-CargoVersion) },
    @{ Name = "src-tauri/tauri.conf.json"; Value = (Read-TauriVersion) }
)

foreach ($item in $results) {
    if ($item.Value -eq $new) {
        Write-Host ("  OK {0,-28} {1}" -f $item.Name, $item.Value)
    }
    else {
        Write-Error ("  FAIL {0,-28} 期望 {1}，实际 {2}" -f $item.Name, $new, $item.Value)
        $failed = $true
    }
}

if ($failed) { Fail "回读校验失败，三处版本不一致" }

Write-Host ""
Write-Host "版本已更新为 $new"
Write-Host "提醒：Cargo.lock 未改动，下次 cargo 构建会自动更新。"
