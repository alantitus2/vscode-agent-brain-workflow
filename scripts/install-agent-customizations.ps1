[CmdletBinding()]
param()

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$requiredPaths = @(
    'AGENTS.md',
    '.github\instructions\default-executor-sol-collaboration.instructions.md',
    '.github\agents\sol-brain.agent.md',
    '.github\hooks\agent-continuation.json',
    'bin\agent-handoff',
    'scripts\agent-handoff-guard.mjs',
    'scripts\agent-stop-guard.mjs'
)

foreach ($relativePath in $requiredPaths) {
    $path = Join-Path $repoRoot $relativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing workspace workflow file: $path"
    }
}

Write-Output "Workspace-native Agent workflow is present in $repoRoot"
Write-Output 'No user-level ~/.copilot files were installed.'
