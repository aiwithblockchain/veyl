# 用法：
#   pwsh scripts/packaging/lib/sign-windows.ps1 -Path build\packages\Veyl-0.1.0.msi
#   由 build-msi.ps1 -Sign 调用，一般不需要手工执行。
#
# 凭据二选一（都没有就直接报错，不会静默出未签名产物）：
#   VEYL_WIN_SIGN_CMD          云 HSM 签名 CLI；脚本把文件路径作为最后一个参数追加
#   VEYL_WIN_CERT_THUMBPRINT   本地证书指纹，走 signtool /sha1
#
# P5 正式接入：Azure Trusted Signing / DigiCert KeyLocker / SSL.com eSigner 都走第一种。
# 时间戳必须带，否则证书到期后旧签名失效。

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"

function Find-SignTool {
    $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $roots = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
        "$env:ProgramFiles\Windows Kits\10\bin"
    ) | Where-Object { $_ -and (Test-Path $_) }

    foreach ($root in $roots) {
        $candidate = Get-ChildItem -Path $root -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }
    return $null
}

if (-not (Test-Path $Path)) {
    throw "找不到待签名文件：$Path"
}

$useCloud = [bool]$env:VEYL_WIN_SIGN_CMD
$useThumbprint = [bool]$env:VEYL_WIN_CERT_THUMBPRINT

Write-Host "签名目标：$Path"
Write-Host ("  VEYL_WIN_SIGN_CMD        {0}" -f $(if ($useCloud) { "已设置" } else { "未设置" }))
Write-Host ("  VEYL_WIN_CERT_THUMBPRINT {0}" -f $(if ($useThumbprint) { "已设置" } else { "未设置" }))

if (-not $useCloud -and -not $useThumbprint) {
    throw "未配置 Windows 签名凭据：请设置 VEYL_WIN_SIGN_CMD（云 HSM）或 VEYL_WIN_CERT_THUMBPRINT（本地证书）"
}

if ($useCloud) {
    # 命令模板后追加文件路径，例如：
    #   VEYL_WIN_SIGN_CMD="AzureSignTool sign -kvu https://... -kvc ... -tr http://timestamp.digicert.com -td sha256"
    $commandLine = "$env:VEYL_WIN_SIGN_CMD `"$Path`""
    Write-Host "使用云 HSM 签名"
    & cmd.exe /c $commandLine
    if ($LASTEXITCODE -ne 0) {
        throw "云 HSM 签名失败（exit $LASTEXITCODE）：$Path"
    }
}
else {
    $signTool = Find-SignTool
    if (-not $signTool) {
        throw "找不到 signtool.exe：请安装 Windows SDK 或改用 VEYL_WIN_SIGN_CMD"
    }
    Write-Host "使用本地证书签名（指纹见环境变量，不打印）"
    & $signTool sign /sha1 $env:VEYL_WIN_CERT_THUMBPRINT /fd SHA256 /tr $TimestampUrl /td SHA256 $Path
    if ($LASTEXITCODE -ne 0) {
        throw "signtool 签名失败（exit $LASTEXITCODE）：$Path"
    }
}

$verifier = Find-SignTool
if ($verifier) {
    & $verifier verify /pa /v $Path
    if ($LASTEXITCODE -ne 0) {
        throw "签名校验失败：$Path"
    }
}
else {
    $signature = Get-AuthenticodeSignature -FilePath $Path
    if ($signature.Status -ne 'Valid') {
        throw "签名校验失败：$($signature.StatusMessage)"
    }
}

Write-Host "签名完成：$Path"
