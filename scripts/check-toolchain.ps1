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

$tools = @(
    Get-CommandSummary -Name 'node'
    Get-CommandSummary -Name 'pnpm'
    Get-CommandSummary -Name 'git'
    Get-CommandSummary -Name 'java'
    Get-CommandSummary -Name 'flutter'
    Get-CommandSummary -Name 'dart'
    Get-CommandSummary -Name 'adb'
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

