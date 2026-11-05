#Requires -RunAsAdministrator
<#
.SYNOPSIS
  开发用：先占住 \\.\pipe\veyl-helper，验证服务不会降级/换名字。

.DESCRIPTION
  在另一个 PowerShell 里运行本脚本后，再执行 Start-Service VeylService。
  服务必须启动失败（同名管道已存在，FILE_FLAG_FIRST_PIPE_INSTANCE 生效），
  日志里应出现「创建命名管道 ... 失败（Win32 5）」或「同名管道可能已被其他进程占用」。

  按 Ctrl+C 结束占位进程，然后再启动服务应当成功。

  注意：这不是攻击工具；它模拟的是「服务启动前别人先创建同名管道」这一情形。
#>
param(
  [string]$PipeName = "veyl-helper",
  [int]$Seconds = 60
)

$ErrorActionPreference = "Stop"

Write-Host "占住 \\.\pipe\$PipeName（$Seconds 秒；Ctrl+C 提前结束）"
$server = [System.IO.Pipes.NamedPipeServerStream]::new(
  $PipeName,
  [System.IO.Pipes.PipeDirection]::InOut,
  1,
  [System.IO.Pipes.PipeTransmissionMode]::Byte,
  [System.IO.Pipes.PipeOptions]::None
)

try {
  $server.WaitForConnectionAsync().Wait([TimeSpan]::FromSeconds($Seconds)) | Out-Null
  Write-Host "占位结束（没有客户端连上来）"
} finally {
  $server.Dispose()
}
