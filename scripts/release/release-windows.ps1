# 用法：
#   pwsh scripts/release/release-windows.ps1 -DryRun
#   pwsh scripts/release/release-windows.ps1
#   pwsh scripts/release/release-windows.ps1 -Upload -Confirm 0.1.0
#
# 前置：
#   build-msi.ps1 能跑通
#   -Upload 还需要 gh 已登录且有 contents: write
#
# 硬规则：
#   - 脚本绝不执行 git push（不推分支、不推 tag）。远程写入只发生在 -Upload 分支，且由 gh 完成。
#   - 一律草稿：macOS 侧通常已经建好草稿，这里只把 MSI 追加上去；没有就自己建草稿。
#   - 不自动发布；正式发布由 PM 在 GitHub 上手动点。

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Upload,
    [string]$Confirm,
    [switch]$AllowDirty
)

$ErrorActionPreference = "Stop"

function Fail([string]$message) {
    throw $message
}

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

if ($Upload -and -not $Confirm) {
    Fail "-Upload 必须同时给 -Confirm <版本号>"
}
if ($Confirm -and -not $Upload) {
    Fail "-Confirm 只能和 -Upload 一起使用"
}

$pkg = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$conf = Get-Content (Join-Path $root "src-tauri/tauri.conf.json") -Raw | ConvertFrom-Json

$cargoVersion = $null
$section = $null
foreach ($line in Get-Content (Join-Path $root "src-tauri/Cargo.toml")) {
    $trimmed = $line.Trim()
    if ($trimmed -match '^\[.+\]$') { $section = $trimmed; continue }
    if ($section -eq '[package]' -and $trimmed -match '^version\s*=\s*"([^"]+)"') {
        $cargoVersion = $Matches[1]
        break
    }
}

if ($pkg.version -ne $cargoVersion) { Fail "版本号不一致：package.json $($pkg.version)，Cargo.toml $cargoVersion" }
if ($pkg.version -ne $conf.version) { Fail "版本号不一致：package.json $($pkg.version)，tauri.conf.json $($conf.version)" }

$version = $pkg.version
$productName = $conf.productName
$tag = "v$version"
$msi = Join-Path $root ("build/packages/{0}-{1}.msi" -f $productName, $version)

Write-Host "== $productName 发布（Windows）=="
Write-Host "版本：$version"
Write-Host "标签：$tag"
Write-Host "产物：$msi"
Write-Host ""

if (-not $AllowDirty) {
    $status = & git -C $root status --porcelain
    if ($status) {
        $status | ForEach-Object { Write-Host $_ }
        Fail "工作区不干净；提交后再发布，或用 -AllowDirty 显式跳过"
    }
}
else {
    Write-Host "注意：-AllowDirty，跳过工作区检查"
}

& git -C $root rev-parse -q --verify "refs/tags/$tag" 2>$null | Out-Null
$localTagExists = ($LASTEXITCODE -eq 0)

$buildCmd = "pwsh -NoProfile -File `"$root/scripts/packaging/build-msi.ps1`""
$releaseExists = $false
if (Get-Command gh -ErrorAction SilentlyContinue) {
    & gh release view $tag 2>$null | Out-Null
    $releaseExists = ($LASTEXITCODE -eq 0)
}

$ghCmd = if ($releaseExists) {
    "gh release upload $tag `"$msi`" --clobber"
}
else {
    "gh release create $tag `"$msi`" --draft --title `"$productName $version`" --generate-notes"
}

if ($DryRun) {
    Write-Host "将要执行："
    Write-Host "  $buildCmd"
    if ($Upload) { Write-Host "  $ghCmd" }
    Write-Host ""
    Write-Host "-DryRun：未构建、未上传、未改动任何文件"
    exit 0
}

Write-Host "[1/2] 本地构建"
& pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts/packaging/build-msi.ps1")
if ($LASTEXITCODE -ne 0) { Fail "本地构建失败" }

if (-not $Upload) {
    Write-Host ""
    Write-Host "产物已就绪。要上传草稿 release，手动执行："
    Write-Host "  $ghCmd"
    Write-Host ""
    Write-Host "（脚本不会执行 git push；tag 由 gh 在远端创建，发布动作请在 GitHub 上点）"
    exit 0
}

if ($Confirm -ne $version) { Fail "确认版本号不匹配（输入 $Confirm，当前 $version），已取消" }

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Fail "缺少 gh CLI：https://cli.github.com"
}

if ($localTagExists) {
    Write-Warning "本地已存在 tag $tag；gh 会按远端状态处理"
}

if ($releaseExists) {
    $assets = & gh release view $tag --json assets --jq '.assets[].name'
    if ($assets -contains (Split-Path -Leaf $msi)) {
        Fail "release $tag 里已经有同名产物，版本号已用过"
    }
}

Write-Host ""
Write-Host "[2/2] 上传草稿 release"
Write-Host "  $ghCmd"

if ($releaseExists) {
    & gh release upload $tag $msi --clobber
}
else {
    & gh release create $tag $msi --draft --title "$productName $version" --generate-notes
}
if ($LASTEXITCODE -ne 0) { Fail "上传失败" }

$hash = (Get-FileHash -Path $msi -Algorithm SHA256).Hash.ToLower()
Write-Host ""
Write-Host "草稿已就绪：$tag"
Write-Host "产物 SHA256：$hash"
Write-Host "下一步：到 GitHub Releases 页面检查附件并点 Publish。"
