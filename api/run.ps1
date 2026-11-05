# Start the Seventh House API on http://127.0.0.1:8000
# Usage (from api/):  powershell -File .\run.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    Write-Host "Creating .venv and installing requirements-dev.txt..."
    python -m venv .venv
    & $python -m pip install -r (Join-Path $PSScriptRoot "requirements-dev.txt")
}

if (-not (Test-Path (Join-Path $PSScriptRoot ".env"))) {
    throw "api/.env is missing. Add DATABASE_URL and the other keys from README.md."
}

Write-Host "Applying migrations..."
& $python -m alembic upgrade head

Write-Host "Starting API at http://127.0.0.1:8000  (Ctrl+C to stop)"
& $python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
