#Requires -RunAsAdministrator
<#
.SYNOPSIS
  开发用：给 Veyl 的二进制做 Authenticode 签名并信任开发证书；也负责把证书清干净。

.DESCRIPTION
  W1/W2 的对端认证要求客户端有可验证的 Authenticode 签名（未签名一律断开）。
  没有代码签名证书时，用本脚本生成一张自签名代码签名证书：
    1. 证书放在 CurrentUser\My（带私钥）；
    2. 公钥导入 LocalMachine\Root —— 服务以 LocalSystem 运行，
       WinVerifyTrust 只看机器级根存储，用户级根存储它看不见；
    3. 用 Set-AuthenticodeSignature 签名（不需要 Windows SDK / signtool）。

  默认签名目标：
    - src-tauri\target\debug\veyl-service.exe（特权服务，W1/W2）
    - src-tauri\target\debug\veyl.exe        （per-user 界面进程，W3）
  没构建的目标会跳过并提示；显式传 -Path 时，目标不存在直接报错。

  重建二进制后签名会失效，重新运行本脚本即可。

  **测试机用完即删**：
    powershell -ExecutionPolicy Bypass -File dev-sign.ps1 -Remove
  会把 CurrentUser\My / LocalMachine\My / LocalMachine\Root 里同 Subject 的证书
  一并移除。先卸载服务再删证书，否则服务会拒绝已签名的客户端。

  注意：这是开发证书，不是发布证书。发布构建必须用真实证书，并在构建时设置
  VEYL_WIN_CERT_THUMBPRINTS（以及可选的 VEYL_WIN_PUBLISHER）。
#>
param(
  [string[]]$Path = @(
    (Join-Path $PSScriptRoot "..\..\src-tauri\target\debug\veyl-service.exe"),
    (Join-Path $PSScriptRoot "..\..\src-tauri\target\debug\veyl.exe")
  ),
  [string]$Subject = "CN=Veyl Dev Signing",
  [switch]$NewCertificate,
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

$stores = @(
  "Cert:\CurrentUser\My",
  "Cert:\LocalMachine\My",
  "Cert:\LocalMachine\Root"
)

if ($Remove) {
  if ($NewCertificate) {
    throw "-Remove 与 -NewCertificate 不能同时使用"
  }
  $thumbprints = @()
  foreach ($store in $stores) {
    $thumbprints += Get-ChildItem $store -ErrorAction SilentlyContinue |
      Where-Object { $_.Subject -eq $Subject } |
      Select-Object -ExpandProperty Thumbprint
  }
  $thumbprints = $thumbprints | Sort-Object -Unique

  if (-not $thumbprints) {
    Write-Host "没有找到 Subject 为 '$Subject' 的证书，无需清理。"
    exit 0
  }

  foreach ($thumbprint in $thumbprints) {
    foreach ($store in $stores) {
      $candidate = Join-Path $store $thumbprint
      if (Test-Path -LiteralPath $candidate) {
        Remove-Item -LiteralPath $candidate -Force
        Write-Host "已移除 $candidate"
      }
    }
  }
  Write-Host ""
  Write-Host "清理完成。复核（应无输出）："
  Write-Host "  Get-ChildItem Cert:\LocalMachine\Root | Where-Object Subject -eq '$Subject'"
  exit 0
}

$cert = $null
if (-not $NewCertificate) {
  # 不依赖 -CodeSigningCert 动态参数（不同 PowerShell 版本支持不一致），直接按 EKU 过滤。
  $cert = Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Subject -eq $Subject -and
      $_.HasPrivateKey -and
      ($_.EnhancedKeyUsageList.ObjectId -contains "1.3.6.1.5.5.7.3.3")
    } |
    Select-Object -First 1
}

if (-not $cert) {
  Write-Host "创建自签名代码签名证书：$Subject"
  $cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $Subject `
    -KeyUsage DigitalSignature `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -CertStoreLocation Cert:\CurrentUser\My `
    -NotAfter (Get-Date).AddYears(2)
}

$cer = Join-Path $env:TEMP "veyl-dev-signer-$PID.cer"
Export-Certificate -Cert $cert -FilePath $cer -Force | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Remove-Item -LiteralPath $cer -Force

$explicitTargets = $PSBoundParameters.ContainsKey("Path")
$signed = 0
foreach ($file in $Path) {
  if (-not (Test-Path -LiteralPath $file)) {
    if ($explicitTargets) {
      throw "找不到 $file"
    }
    Write-Warning "跳过不存在的目标：$file（先构建对应 bin）"
    continue
  }
  $signature = Set-AuthenticodeSignature `
    -FilePath $file `
    -Certificate $cert `
    -HashAlgorithm SHA256
  if ($signature.Status -ne "Valid") {
    throw "签名失败：$($signature.Status) $($signature.StatusMessage)"
  }
  Write-Host "已签名：$file"
  $signed += 1
}

if ($signed -eq 0) {
  throw "没有任何可签名的目标。先在 src-tauri 下执行: cargo build --bin veyl-service（W3 还需 --bin veyl）"
}

Write-Host ""
Write-Host "证书指纹(SHA1)：$($cert.Thumbprint)"
Write-Host "本机已信任该证书（LocalMachine\Root），服务端 WinVerifyTrust 可通过。"
Write-Host "测试结束请清理：powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Remove"
Write-Host ""
Write-Host "发布构建固定签名者（示例）："
Write-Host "  `$env:VEYL_WIN_CERT_THUMBPRINTS='$($cert.Thumbprint)'"
Write-Host "  cargo build --release --bin veyl-service"
