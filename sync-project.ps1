# sync-project.ps1 - upload a project snapshot to the PRIVATE repo so the HF
# space can code with FULL context (files + deps installed on the space).
#
# Usage:
#   .\sync-project.ps1 -Dir "F:\some\project" -Name myproj
#
# The snapshot lands at qwen-research:projects/<name>/ (git, node_modules, venv,
# caches and .env* secrets are EXCLUDED). Then hand off:
#   .\handoff.ps1 -Task "..." -Project myproj

param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [Parameter(Mandatory = $true)][string]$Name
)

$ErrorActionPreference = "Stop"
$Repo = "f2025408135-cyber/qwen-research"
$Work = "$env:TEMP\qwen-research-sync"

if (-not (Test-Path $Dir)) { Write-Host "[sync] dir not found: $Dir" -ForegroundColor Red; exit 1 }
$Dir = (Resolve-Path $Dir).Path

Write-Host "[sync] cloning $Repo ..." -ForegroundColor Cyan
if (Test-Path $Work) { Remove-Item $Work -Recurse -Force }
gh repo clone $Repo $Work -- --depth 1
if ($LASTEXITCODE -ne 0) { Write-Host "[sync] clone failed" -ForegroundColor Red; exit 1 }

$dst = Join-Path $Work "projects\$Name"
New-Item -ItemType Directory -Force $dst | Out-Null

Write-Host "[sync] copying $Dir -> projects\$Name (excluding secrets/caches)..." -ForegroundColor Cyan
robocopy $Dir $dst /E `
  /XD .git node_modules venv .venv __pycache__ dist .next .swarm swarm-output .opencode .codex .pi hf-worker `
  /XF ".env" ".env.local" ".env.*" "*.key" "*.pem" ".DS_Store" `
  /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host "[sync] robocopy failed (code $LASTEXITCODE)" -ForegroundColor Red; exit 1 }

Push-Location $Work
try {
  git add -A
  $stat = git diff --cached --stat | Select-Object -Last 1
  git -c user.name="sync-bot" -c user.email="sync@users.noreply.github.com" commit -m "sync project '$Name' ($($stat))" | Out-Null
  git push --quiet
  Write-Host "[sync] pushed: $Repo -> projects/$Name ($stat)" -ForegroundColor Green
  Write-Host "[sync] now hand off: .\handoff.ps1 -Task '...' -Project $Name" -ForegroundColor Yellow
} finally {
  Pop-Location
}