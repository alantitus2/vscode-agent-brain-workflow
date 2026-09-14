[CmdletBinding()]
param(
    [switch]$Force
)

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$targetRoot = if ($env:COPILOT_HOME) {
    $env:COPILOT_HOME
} else {
    Join-Path $env:USERPROFILE '.copilot'
}

$items = @(
    'agents\luna-worker.agent.md',
    'agents\sol-brain.agent.md',
    'instructions\default-executor-sol-collaboration.instructions.md'
)

foreach ($relativePath in $items) {
    $sourcePath = Join-Path $repoRoot $relativePath
    $targetPath = Join-Path $targetRoot $relativePath
    $targetDirectory = Split-Path -Parent $targetPath

    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Missing customization file: $sourcePath"
    }

    New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
    if ($Force -or -not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
        Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
        Write-Output "Installed: $targetPath"
    } else {
        Write-Output "Preserved existing file: $targetPath"
    }
}

Write-Output "Installed VS Code Agent Host customizations from $repoRoot"
