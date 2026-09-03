$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$expected = Get-Content -LiteralPath (Join-Path $repoRoot 'tool-versions.json') -Raw -Encoding utf8 | ConvertFrom-Json

function Get-CommandSummary {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        return [pscustomobject]@{ Tool = $Name; Status = 'missing'; Path = '' }
    }

    return [pscustomobject]@{ Tool = $Name; Status = 'found'; Path = $command.Source }
}

function Get-PnpmSummary {
    $pnpm = Get-CommandSummary -Name 'pnpm'
    if ($pnpm.Status -eq 'found') {
        return $pnpm
    }

    # On Windows, PowerShell can resolve the extensionless shim before the
    # executable .cmd shim. Use the latter so invocation is reliable.
    $corepack = Get-Command corepack.cmd -ErrorAction SilentlyContinue
    if ($null -eq $corepack) {
        $node = Get-Command node -ErrorAction SilentlyContinue
        if ($null -ne $node) {
            $candidate = Join-Path (Split-Path -Parent $node.Source) 'corepack.cmd'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $corepack = [pscustomobject]@{ Source = $candidate }
            }
        }
    }
    if ($null -eq $corepack) {
        return $pnpm
    }

    try {
        $version = (& $corepack.Source pnpm --version 2>$null | Select-Object -First 1).Trim()
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($version)) {
            return [pscustomobject]@{
                Tool = 'pnpm'
                Status = 'found'
                Path = "$($corepack.Source) pnpm ($version via Corepack)"
            }
        }
    }
    catch {
        # Keep the normal missing result when Corepack cannot activate pnpm.
    }

    return $pnpm
}

function Get-AdbSummary {
    $adb = Get-CommandSummary -Name 'adb'
    if ($adb.Status -eq 'found') {
        return $adb
    }

    $sdkRoots = @(
        $env:ANDROID_HOME
        $env:ANDROID_SDK_ROOT
        (Join-Path $env:LOCALAPPDATA 'Android\Sdk')
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    foreach ($sdkRoot in $sdkRoots | Select-Object -Unique) {
        $candidate = Join-Path $sdkRoot 'platform-tools\adb.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [pscustomobject]@{ Tool = 'adb'; Status = 'found'; Path = $candidate }
        }
    }

    return $adb
}

$tools = @(
    Get-CommandSummary -Name 'node'
    Get-PnpmSummary
    Get-CommandSummary -Name 'git'
    Get-CommandSummary -Name 'java'
    Get-CommandSummary -Name 'flutter'
    Get-CommandSummary -Name 'dart'
    Get-AdbSummary
    Get-CommandSummary -Name 'rustc'
    Get-CommandSummary -Name 'cargo'
)

$tools | Format-Table -AutoSize

Write-Host ''
Write-Host 'Pinned toolchain:'
$expected | Format-List

$missingRequired = $tools | Where-Object {
    $_.Tool -in @('node', 'pnpm', 'git', 'java', 'flutter', 'dart', 'rustc', 'cargo') -and
    $_.Status -eq 'missing'
}

if ($missingRequired) {
    Write-Error "Required M0 tools are missing: $($missingRequired.Tool -join ', ')"
}
