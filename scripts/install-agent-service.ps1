<#
.SYNOPSIS
  Run the DevPilot Agent headlessly so a registered project can be edited from
  the phone without anyone sitting at the PC.

.DESCRIPTION
  Builds the Agent, writes a launcher that carries its environment, and
  registers a Scheduled Task that starts it at logon and restarts it if it
  exits. The PC stays on (or wakes on LAN); nothing else is required at the
  keyboard once pairing is done once from DevPilot Desktop.

.PARAMETER DesktopToken
  Desktop control-API bearer token, >= 32 characters. Reused on every start so
  an existing pairing keeps working. Generated and printed if omitted.

.PARAMETER ExtraHosts
  Extra reachable IPv4 addresses to advertise in the pairing QR, e.g. this PC's
  Tailscale address ("100.x.y.z"). Lets the phone pair from outside the LAN.
  Comma-separated. Optional.

.PARAMETER AdbConnectTargets
  Wireless-ADB "host:port" targets the Agent runs `adb connect` against before
  it looks for a device, e.g. the phone's Tailscale address on port 5555.
  Comma-separated. Optional.

.PARAMETER DataDir
  Agent data directory. Defaults to <workspace>\.devpilot-data.

.PARAMETER Uninstall
  Remove the Scheduled Task and launcher.

.EXAMPLE
  pwsh -File scripts/install-agent-service.ps1 -DesktopToken $token -ExtraHosts 100.101.102.103
#>
[CmdletBinding()]
param(
  [string]$DesktopToken,
  [string]$ExtraHosts,
  [string]$AdbConnectTargets,
  [string]$DataDir,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$taskName = 'DevPilot Agent'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
if (-not $DataDir) { $DataDir = Join-Path $workspaceRoot '.devpilot-data' }
$launcherPath = Join-Path $DataDir 'agent-service.cmd'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  if (Test-Path $launcherPath) { Remove-Item $launcherPath -Force }
  Write-Host "Removed scheduled task '$taskName'." -ForegroundColor Green
  return
}

if (-not $DesktopToken) {
  $bytes = [byte[]]::new(32)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $DesktopToken = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  Write-Host "Generated DEVPILOT_DESKTOP_TOKEN (save this for DevPilot Desktop browser mode):" -ForegroundColor Yellow
  Write-Host "  $DesktopToken" -ForegroundColor Yellow
}
if ($DesktopToken.Length -lt 32) { throw 'DesktopToken must be at least 32 characters.' }

$node = (Get-Command node -ErrorAction Stop).Source
$entry = Join-Path $workspaceRoot 'apps\agent\dist\index.js'

Write-Host 'Building the Agent...' -ForegroundColor Cyan
& corepack pnpm --filter "@devpilot/contracts" build
if ($LASTEXITCODE -ne 0) { throw 'contracts build failed.' }
& corepack pnpm --filter "@devpilot/agent" build
if ($LASTEXITCODE -ne 0) { throw 'agent build failed.' }
if (-not (Test-Path $entry)) { throw "Agent entry not found at $entry" }

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# The launcher keeps the token out of the machine-wide environment. Task
# Scheduler runs this .cmd; `node` stays in the foreground so the task's
# restart-on-exit applies to the Agent itself.
$lines = @(
  '@echo off',
  'setlocal',
  "set ""DEVPILOT_DESKTOP_TOKEN=$DesktopToken""",
  "set ""DEVPILOT_DATA_DIR=$DataDir""",
  'set "DEVPILOT_RUN_MODE=service"'
)
if ($ExtraHosts) { $lines += "set ""DEVPILOT_PAIRING_EXTRA_HOSTS=$ExtraHosts""" }
if ($AdbConnectTargets) { $lines += "set ""DEVPILOT_ADB_CONNECT_TARGETS=$AdbConnectTargets""" }
$lines += "cd /d ""$workspaceRoot"""
$lines += """$node"" ""$entry"""
Set-Content -Path $launcherPath -Value $lines -Encoding ascii
Write-Host "Wrote launcher: $launcherPath" -ForegroundColor Green

$action = New-ScheduledTaskAction -Execute $launcherPath
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Registered scheduled task '$taskName' (starts at logon)." -ForegroundColor Green
Write-Host 'Start it now with:  Start-ScheduledTask -TaskName "DevPilot Agent"' -ForegroundColor Cyan
Write-Host 'Tip: set Windows to auto-login and disable sleep so the box is always reachable.' -ForegroundColor Cyan
