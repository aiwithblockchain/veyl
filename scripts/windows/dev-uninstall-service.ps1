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

$installDir = Join-Path $env:ProgramFiles "Veyl"
if (Test-Path $installDir) {
  Write-Host "删除 $installDir"
  Remove-Item -LiteralPath $installDir -Recurse -Force
}

if ($RemoveData) {
  $dataDir = Join-Path $env:ProgramData "Veyl"
  if (Test-Path $dataDir) {
    Write-Host "删除 $dataDir"
    Remove-Item -LiteralPath $dataDir -Recurse -Force
  }
} else {
  Write-Host "保留 $(Join-Path $env:ProgramData 'Veyl')（加 -RemoveData 删除）"
}
