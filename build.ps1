#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Launches the interactive SocialPoster WebAssembly plugin builder.
#>
$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CliDir = Join-Path $RootDir 'cli'
$NodeModules = Join-Path $CliDir 'node_modules'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js is required to run the SocialPoster plugin builder. Please install Node.js 20+ and try again.'
    exit 1
}

if (-not (Test-Path $NodeModules)) {
    Write-Host 'Installing CLI dependencies on first run...' -ForegroundColor Cyan
    Push-Location $CliDir
    try {
        npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    }
    finally {
        Pop-Location
    }
}

node (Join-Path $CliDir 'index.mjs') @args
exit $LASTEXITCODE
