#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Builds one or more SocialPoster WebAssembly plugins into dist/<folder-name>.wasm.
.DESCRIPTION
    When folder names or relative paths are provided as positional arguments,
    only those plugin directories are built. When no arguments are provided,
    all top-level directories containing a recognised plugin manifest
    (Cargo.toml, go.mod, package.json, build.zig, CMakeLists.txt, or Makefile)
    are discovered and built automatically.
#>
$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DistDir = Join-Path $RootDir 'dist'
$MaxWasmBytes = 1048576

function Get-PluginTargets {
    param([string[]]$InputArgs)

    $targets = [System.Collections.Generic.List[string]]::new()

    if ($InputArgs.Count -gt 0) {
        foreach ($arg in $InputArgs) {
            $candidate = if ([System.IO.Path]::IsPathRooted($arg)) {
                $arg
            } else {
                Join-Path $RootDir $arg
            }
            if (-not (Test-Path -Path $candidate -PathType Container)) {
                Write-Error "Plugin directory not found: $arg"
                exit 1
            }
            $resolved = (Resolve-Path $candidate).Path
            $targets.Add($resolved)
        }
        return $targets
    }

    $excluded = @('.git', 'dist', 'target', 'node_modules', 'output', 'cli')
    $manifests = @('Cargo.toml', 'go.mod', 'package.json', 'build.zig', 'CMakeLists.txt', 'Makefile')

    foreach ($dir in (Get-ChildItem -Path $RootDir -Directory)) {
        if ($dir.Name.StartsWith('.') -or ($excluded -contains $dir.Name)) {
            continue
        }
        $hasManifest = $false
        foreach ($m in $manifests) {
            if (Test-Path (Join-Path $dir.FullName $m)) {
                $hasManifest = $true
                break
            }
        }
        if ($hasManifest) {
            $targets.Add($dir.FullName)
        }
    }

    return $targets
}

function Invoke-BuildTarget {
    param([string]$TargetDir)

    $folderName = Split-Path -Leaf $TargetDir
    $destWasm = Join-Path $DistDir "$folderName.wasm"

    Write-Host "==> Building plugin '$folderName'..." -ForegroundColor Cyan

    Push-Location $TargetDir
    try {
        if (Test-Path 'Cargo.toml') {
            cargo build --release --target wasm32-unknown-unknown
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

            $releaseDir = Join-Path $TargetDir 'target/wasm32-unknown-unknown/release'
            $wasmFile = Get-ChildItem -Path $releaseDir -Filter '*.wasm' -File | Select-Object -First 1
            if (-not $wasmFile) {
                throw "No compiled .wasm artefact found in $releaseDir"
            }
            Copy-Item -Path $wasmFile.FullName -Destination $destWasm -Force
        }
        elseif (Test-Path 'go.mod') {
            go mod tidy
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

            $env:GOFLAGS = '-buildvcs=false'
            tinygo build -o $destWasm -target=wasi -no-debug .
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
        elseif (Test-Path 'package.json') {
            if (-not (Test-Path 'node_modules')) {
                if (Test-Path 'package-lock.json') {
                    npm ci --no-audit --no-fund
                } else {
                    npm install --no-audit --no-fund
                }
                if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            }

            $beforeTime = Get-Date
            npm run build
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

            $wasmFile = @(
                Get-ChildItem -Path $TargetDir -Recurse -Filter '*.wasm' -File -ErrorAction SilentlyContinue |
                    Where-Object { $_.FullName -notmatch 'node_modules' }
                Get-ChildItem -Path (Join-Path $RootDir 'output') -Filter '*.wasm' -File -ErrorAction SilentlyContinue |
                    Where-Object { $_.LastWriteTime -ge $beforeTime.AddSeconds(-2) -or $_.Name -match [regex]::Escape($folderName) }
            ) | Sort-Object LastWriteTime -Descending | Select-Object -First 1

            if (-not $wasmFile) {
                throw "No compiled .wasm artefact found after running npm run build in $TargetDir"
            }
            Copy-Item -Path $wasmFile.FullName -Destination $destWasm -Force
        }
        elseif (Test-Path 'build.zig') {
            $beforeTime = Get-Date
            zig build -Doptimize=ReleaseSmall
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

            $wasmFile = @(
                Get-ChildItem -Path (Join-Path $TargetDir 'zig-out') -Recurse -Filter '*.wasm' -File -ErrorAction SilentlyContinue
                Get-ChildItem -Path (Join-Path $RootDir 'output') -Filter '*.wasm' -File -ErrorAction SilentlyContinue |
                    Where-Object { $_.LastWriteTime -ge $beforeTime.AddSeconds(-2) -or $_.Name -match [regex]::Escape($folderName) }
            ) | Sort-Object LastWriteTime -Descending | Select-Object -First 1

            if (-not $wasmFile) {
                throw "No compiled .wasm artefact found after running zig build in $TargetDir"
            }
            Copy-Item -Path $wasmFile.FullName -Destination $destWasm -Force
        }
        elseif (Test-Path 'CMakeLists.txt') {
            $buildSubdir = Join-Path $TargetDir 'build'
            cmake -B $buildSubdir -S $TargetDir
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            cmake --build $buildSubdir --config Release
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

            $wasmFile = Get-ChildItem -Path $buildSubdir -Recurse -Filter '*.wasm' -File | Select-Object -First 1
            if (-not $wasmFile) {
                throw "No compiled .wasm artefact found in $buildSubdir"
            }
            Copy-Item -Path $wasmFile.FullName -Destination $destWasm -Force
        }
        elseif (Test-Path 'Makefile') {
            make OUT=$destWasm
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
        else {
            throw "No recognised plugin manifest found in $TargetDir"
        }
    }
    finally {
        Pop-Location
    }

    if (-not (Test-Path $destWasm)) {
        throw "Expected output artefact was not created: $destWasm"
    }

    $sizeBytes = (Get-Item $destWasm).Length
    $sizeKb = [Math]::Round($sizeBytes / 1024, 2)
    Write-Host "    Artefact : dist/$folderName.wasm" -ForegroundColor Green
    Write-Host "    Size     : $sizeKb KB ($sizeBytes bytes)"

    if ($sizeBytes -gt $MaxWasmBytes) {
        Write-Warning "Artefact 'dist/$folderName.wasm' ($sizeBytes bytes) exceeds the 1 MB ($MaxWasmBytes bytes) SocialPoster Hub limit!"
    }
}

$targets = Get-PluginTargets -InputArgs $args
if ($targets.Count -eq 0) {
    Write-Error 'No plugin directories with a recognised manifest were found.'
    exit 1
}

New-Item -ItemType Directory -Path $DistDir -Force | Out-Null

foreach ($t in $targets) {
    Invoke-BuildTarget -TargetDir $t
}

Write-Host "`nFinished building $($targets.Count) plugin(s) into dist/." -ForegroundColor Green
