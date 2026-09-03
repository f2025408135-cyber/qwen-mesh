# handoff.ps1 - ONE COMMAND to hand a coding task to the cloud before shutting down.
# Usage:
#   .\handoff.ps1 -Task "Fix the failing test in services/foo and run the suite"
#   .\handoff.ps1 -Task "..." -Engine swarm      # 1 codex + 5 opencode workers
#   .\handoff.ps1 -Task "..." -Wait              # tail the run before shutting down
#
# The task runs on the HF ZeroGPU space (own datacenter internet, 16 vCPU / 97GB),
# driven by GitHub Actions - your PC can be OFF the whole time.
# Result lands in the PRIVATE repo: qwen-research/handoffs/ + the Actions log.

param(
  [Parameter(Mandatory = $true)][string]$Task,
  [ValidateSet("opencode", "swarm", "pi", "codex")][string]$Engine = "opencode",
  [switch]$Wait
)

$Repo = "f2025408135-cyber/qwen-mesh"

Write-Host "[handoff] engine=$Engine" -ForegroundColor Cyan
Write-Host "[handoff] dispatching task to cloud..." -ForegroundColor Cyan

gh workflow run handoff-task.yml -R $Repo -f task="$Task" -f engine="$Engine"
if ($LASTEXITCODE -ne 0) { Write-Host "[handoff] dispatch FAILED" -ForegroundColor Red; exit 1 }

Start-Sleep -Seconds 8
$run = gh run list -R $Repo --workflow=handoff-task.yml --limit 1 --json databaseId,url,createdAt |
  ConvertFrom-Json | Select-Object -First 1
Write-Host "[handoff] run started: $($run.url)" -ForegroundColor Green

Write-Host ""
Write-Host "  You can shut down the PC NOW - the task runs on the HF space" -ForegroundColor Yellow
Write-Host "  (own internet, no dependency on this device)." -ForegroundColor Yellow
Write-Host "  Result will appear in: qwen-research/handoffs/" -ForegroundColor Yellow
Write-Host "  Check later: gh run view $($run.databaseId) -R $Repo --log" -ForegroundColor Yellow

if ($Wait) {
  Write-Host ""
  Write-Host "[handoff] waiting for run to finish..." -ForegroundColor Cyan
  gh run watch $run.databaseId -R $Repo --exit-status
  if ($LASTEXITCODE -eq 0) {
    Write-Host "[handoff] DONE. Result:" -ForegroundColor Green
    gh run view $run.databaseId -R $Repo --log | Select-String "=== result ===" -Context 0,40
  } else {
    Write-Host "[handoff] run FAILED - check the log" -ForegroundColor Red
  }
}