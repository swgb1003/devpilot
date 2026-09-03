param()

$ErrorActionPreference = 'Stop'

# `tauri dev` starts Vite on port 5173.  A previous Ctrl+C can leave its Node
# child running; only reclaim a Vite process whose command line is inside this
# DevPilot workspace, never an unrelated service using the same port.
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$workspacePattern = [regex]::Escape((Join-Path $workspaceRoot 'apps\desktop'))
$listeners = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    $commandLine = $process.CommandLine
    if ($process.Name -ne 'node.exe' -or $commandLine -notmatch 'vite' -or $commandLine -notmatch $workspacePattern) {
        throw "Port 5173 is already used by a process outside this DevPilot workspace (PID $($listener.OwningProcess)). Stop it manually, then retry."
    }
    Stop-Process -Id $listener.OwningProcess -Force
}

# Browser-mode development uses `tsx watch src/index.ts`.  It cannot share the
# Desktop sidecar's authenticated loopback port, so reclaim only that exact
# workspace-owned process tree.  Any other listener is left untouched.
$agentWorkspacePattern = [regex]::Escape((Join-Path $workspaceRoot 'apps\agent'))
$agentListeners = Get-NetTCPConnection -LocalPort 47831 -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $agentListeners) {
    $agent = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    $commandLine = $agent.CommandLine
    if ($agent.Name -eq 'node.exe' -and $commandLine -match $agentWorkspacePattern -and $commandLine -match 'tsx' -and $commandLine -match 'src[\\/]index\.ts') {
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($agent.ParentProcessId)"
        if ($parent.CommandLine -match $agentWorkspacePattern -and $parent.CommandLine -match 'tsx' -and $parent.CommandLine -match 'watch') {
            & taskkill /PID $parent.ProcessId /T /F | Out-Null
        } else {
            Stop-Process -Id $agent.ProcessId -Force
        }
        continue
    }
    throw "Port 47831 is already used by another process (PID $($listener.OwningProcess)). Close the existing DevPilot Desktop or that process, then retry."
}

& corepack pnpm --filter @devpilot/desktop dev
exit $LASTEXITCODE
