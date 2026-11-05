#Requires -RunAsAdministrator
<#
.SYNOPSIS
  开发用：停止并删除 VeylService，清理安装目录。

.DESCRIPTION
  正式卸载器在 W5。这里只清开发机上的服务、Program Files\Veyl 与 ProgramData\Veyl。
  默认保留 ProgramData 下的日志，方便回看失败原因；-RemoveData 一并删除。
#>
param(
  [string]$ServiceName = "VeylService",
  [switch]$RemoveData
)

$ErrorActionPreference = "Stop"

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
  Write-Host "停止 $ServiceName"
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Service -Name $ServiceName -ErrorAction SilentlyContinue).Status -ne "Stopped" -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
  Write-Host "删除 $ServiceName"
  & sc.exe delete $ServiceName | Out-Null
} else {
  Write-Host "没有 $ServiceName 服务"
}

$dataDir = Join-Path $env:ProgramData "Veyl"

# 服务被强杀时 sing-box 可能还活着，而且没人知道它存在。按记录里的
# pid + 镜像路径核对后再杀；只按 pid 会在 pid 复用时误杀别的进程。
$record = Join-Path $dataDir "tun\sing-box.pid"
if (Test-Path $record) {
  $lines = @(Get-Content -LiteralPath $record)
  if ($lines.Count -ge 3) {
    $singBoxPid = 0
    if ([int]::TryParse($lines[0].Trim(), [ref]$singBoxPid)) {
      try {
        $process = Get-Process -Id $singBoxPid -ErrorAction SilentlyContinue
        if ($process -and $process.Path -eq $lines[2].Trim()) {
          Write-Host "结束遗留的 sing-box pid=$singBoxPid"
          Stop-Process -Id $singBoxPid -Force -ErrorAction SilentlyContinue
        }
      } catch {
        Write-Host "无法核对遗留 pid=$singBoxPid，跳过（请手工检查）"
      }
    }
  }
}
# 配置里有节点凭据：即使保留日志也要删掉。
$tunDir = Join-Path $dataDir "tun"
if (Test-Path $tunDir) {
  Write-Host "删除 $tunDir（活动配置与 pid 记录）"
  Remove-Item -LiteralPath $tunDir -Recurse -Force
}

$installDir = Join-Path $env:ProgramFiles "Veyl"
if (Test-Path $installDir) {
  Write-Host "删除 $installDir"
  Remove-Item -LiteralPath $installDir -Recurse -Force
}

if ($RemoveData) {
  if (Test-Path $dataDir) {
    Write-Host "删除 $dataDir"
    Remove-Item -LiteralPath $dataDir -Recurse -Force
  }
} else {
  Write-Host "保留 $dataDir\logs（加 -RemoveData 连日志一起删）"
}
