#Requires -RunAsAdministrator
<#
.SYNOPSIS
  开发用：把一个本地构建的 veyl-service.exe 装成 LocalSystem 服务。

.DESCRIPTION
  这不是正式安装器（W5 才做）。它只做验证服务骨架与管道所需的最小动作：
  复制到 C:\Program Files\Veyl\、建立 %ProgramData%\Veyl\ 并收紧 ACL、
  用 sc.exe 注册服务。

  对端认证默认要求客户端有可验证的 Authenticode 签名，**与客户端路径无关**。
  本机没有签名环境时，可以用编译期开关 VEYL_WIN_ALLOW_UNSIGNED_DEV=1 构建
  debug 版（默认关闭、仅 debug、每次放行写 warn）；该构建不能用于 W2 验收。
#>
param(
  [string]$Binary = (Join-Path $PSScriptRoot "..\..\src-tauri\target\debug\veyl-service.exe"),
  [string]$ServiceName = "VeylService",
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Binary)) {
  throw "找不到 $Binary。先在 src-tauri 下执行: cargo build --bin veyl-service"
}

$installDir = Join-Path $env:ProgramFiles "Veyl"
$dataDir = Join-Path $env:ProgramData "Veyl"
$logsDir = Join-Path $dataDir "logs"

Write-Host "[1/5] 创建 $installDir"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

function Set-VeylAcl {
  param(
    [string]$Path,
    [bool]$UsersRead
  )
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  # 切断继承，只留显式规则；父目录的 Users ACE 不会漏进来。
  $acl.SetAccessRuleProtection($true, $false)
  $entries = @(
    @{ Sid = "S-1-5-18"; Rights = "FullControl" },      # SYSTEM
    @{ Sid = "S-1-5-32-544"; Rights = "FullControl" }   # Administrators
  )
  if ($UsersRead) {
    $entries += @{ Sid = "S-1-5-32-545"; Rights = "ReadAndExecute" }  # Users
  }
  # 用 SID 而不是本地化组名：中文 Windows 的显示名不一样。
  foreach ($entry in $entries) {
    $identity = New-Object System.Security.Principal.SecurityIdentifier($entry.Sid)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $identity,
      $entry.Rights,
      [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit",
      [System.Security.AccessControl.PropagationFlags]"None",
      [System.Security.AccessControl.AccessControlType]"Allow")
    $acl.AddAccessRule($rule)
  }
  # 所有者必须是管理员或 SYSTEM：所有者隐含 WRITE_DAC，普通用户一旦成为所有者
  # 就能给自己加写权限。服务启动时会校验这一点并拒绝启动。
  $adminSid = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")
  $acl.SetOwner($adminSid)
  Set-Acl -Path $Path -AclObject $acl
}

Write-Host "[2/5] 收紧 $dataDir（只允许 SYSTEM/Administrators）；$logsDir 额外给 Users 只读"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
# ProgramData 根目录将来会放配置与 pid，不能人人可读；只有日志子目录需要用户可读。
Set-VeylAcl -Path $dataDir -UsersRead $false
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
Set-VeylAcl -Path $logsDir -UsersRead $true

$target = Join-Path $installDir "veyl-service.exe"
Write-Host "[3/5] 复制服务二进制到 $target"
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Write-Host "      已有同名服务，先停止并删除"
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Service -Name $ServiceName -ErrorAction SilentlyContinue).Status -ne "Stopped" -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
  & sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 1
}
Copy-Item -LiteralPath $Binary -Destination $target -Force

# 运行时：服务只从安装目录复制到 %ProgramData% 后执行，不会读 per-user 目录。
# 缺了它 TUN 会明确返回 runtime_missing，不影响协议/对端认证的验证。
$runtimeSource = Join-Path $PSScriptRoot "..\..\src-tauri\resources\runtime"
$runtimeTarget = Join-Path $installDir "runtime"
if (Test-Path (Join-Path $runtimeSource "sing-box.exe")) {
  Write-Host "      复制运行时到 $runtimeTarget"
  New-Item -ItemType Directory -Force -Path $runtimeTarget | Out-Null
  foreach ($name in @("sing-box.exe", "wintun.dll", "wintun-LICENSE.txt")) {
    $from = Join-Path $runtimeSource $name
    if (-not (Test-Path $from)) {
      throw "缺少 $from。先跑: node scripts\runtime\fetch-runtime.mjs --platform=windows"
    }
    Copy-Item -LiteralPath $from -Destination (Join-Path $runtimeTarget $name) -Force
  }
} else {
  Write-Warning "没有 $runtimeSource\sing-box.exe：TUN 启动会返回 runtime_missing"
  Write-Warning "先跑 node scripts\runtime\fetch-runtime.mjs --platform=windows 再重跑本脚本"
}

Write-Host "[4/5] 注册服务 $ServiceName（LocalSystem / Automatic）"
# New-Service 会正确引用带空格的路径；sc.exe create 在 PowerShell 里容易被引号坑到。
$quoted = '"{0}"' -f $target
New-Service -Name $ServiceName -BinaryPathName $quoted `
  -DisplayName "Veyl Privileged Service" -StartupType Automatic | Out-Null
& sc.exe description $ServiceName "Veyl 的 TUN 特权服务（开发安装脚本）" | Out-Null
& sc.exe failure $ServiceName reset= 86400 actions= restart/60000/restart/60000 | Out-Null

if ($NoStart) {
  Write-Host "[5/5] 已注册但未启动（-NoStart）"
  exit 0
}

Write-Host "[5/5] 启动服务"
Start-Service -Name $ServiceName
Start-Sleep -Seconds 1
Get-Service -Name $ServiceName | Format-List Name, Status, StartType

Write-Host ""
Write-Host "下一步（普通用户 PowerShell，不要用管理员）："
Write-Host "  & '$target' --client status"
Write-Host "  & '$target' --client ping      # 仅 debug 构建；release 用 status"
Write-Host "预期：status 五个字段齐全；ping 返回 ok=true"
Write-Host "对端认证要求签名：先跑 dev-sign.ps1，或用 VEYL_WIN_ALLOW_UNSIGNED_DEV=1 的 debug 构建"
Write-Host ""
Write-Host "服务日志：$logsDir\service.log"
Write-Host "失败时先看：sc.exe query $ServiceName / 事件查看器 → Windows 日志 → 系统"
Write-Host "卸载：scripts\windows\dev-uninstall-service.ps1"
