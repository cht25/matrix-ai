# =============================================================================
# QORVYNA AI — Windows desktop build (Tauri 2)
#
# Builds the EXISTING application manually, without the online Agent build:
#   1. validates the toolchain this repository actually needs;
#   2. installs dependencies exactly as the lockfile pins them (npm ci);
#   3. bundles the shared frontend into public/native (the WebView assets);
#   4. builds the Windows installers with the Tauri CLI from devDependencies;
#   5. verifies the artifacts really exist before reporting success.
#
# Every command is echoed with its exit code. Any failure stops the script with
# a non-zero exit code — no step is skipped and nothing is reported as built
# unless the file is on disk.
#
# Usage (from the repository root):
#   powershell -ExecutionPolicy Bypass -File .\build-windows.ps1
#   powershell -ExecutionPolicy Bypass -File .\build-windows.ps1 -SkipInstall
#   powershell -ExecutionPolicy Bypass -File .\build-windows.ps1 -Targets nsis
# =============================================================================

[CmdletBinding()]
param(
    # Skip `npm ci` when node_modules is already in the state you want.
    [switch]$SkipInstall,
    # Restrict bundle formats, e.g. -Targets nsis or -Targets "nsis,msi".
    [string]$Targets = "",
    # Build a debug/dev binary instead of the release bundles.
    [switch]$Debug
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location -LiteralPath $repoRoot

$script:stepNo = 0
$script:failures = New-Object System.Collections.Generic.List[string]

function Write-Step {
    param([string]$Title)
    $script:stepNo++
    Write-Host ""
    Write-Host ("=" * 78) -ForegroundColor DarkGray
    Write-Host ("STEP {0}  {1}" -f $script:stepNo, $Title) -ForegroundColor Cyan
    Write-Host ("=" * 78) -ForegroundColor DarkGray
}

function Write-Info {
    param([string]$Message)
    Write-Host "  $Message"
}

function Write-Ok {
    param([string]$Message)
    Write-Host "  OK   $Message" -ForegroundColor Green
}

function Write-Fail {
    param([string]$Message)
    Write-Host "  FAIL $Message" -ForegroundColor Red
    $script:failures.Add($Message)
}

# Run a native command, print it, print its exit code, and fail the script if
# it did not succeed. `&` failures do not throw on their own, so $LASTEXITCODE
# is checked explicitly and the global error preference is never relied on.
function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [string[]]$Arguments = @(),
        [string]$Description = ""
    )
    if ($Description) { Write-Info $Description }
    $pretty = "$Exe " + ($Arguments -join " ")
    Write-Host "  > $pretty" -ForegroundColor DarkYellow
    $global:LASTEXITCODE = 0
    & $Exe @Arguments
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        Write-Fail "'$pretty' exited with code $code."
        Complete-Script
    }
    Write-Ok "'$pretty' exited with code 0."
}

function Invoke-Capture {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [string[]]$Arguments = @()
    )
    try {
        $output = & $Exe @Arguments 2>&1
        return @{ Code = $LASTEXITCODE; Output = ($output -join "`n").Trim() }
    } catch {
        return @{ Code = 127; Output = $_.Exception.Message }
    }
}

function Complete-Script {
    Write-Host ""
    Write-Host ("=" * 78) -ForegroundColor DarkGray
    if ($script:failures.Count -gt 0) {
        Write-Host ("BUILD FAILED — {0} problem(s):" -f $script:failures.Count) -ForegroundColor Red
        foreach ($failure in $script:failures) { Write-Host "  - $failure" -ForegroundColor Red }
        Write-Host ("=" * 78) -ForegroundColor DarkGray
        exit 1
    }
    Write-Host "BUILD SUCCEEDED" -ForegroundColor Green
    Write-Host ("=" * 78) -ForegroundColor DarkGray
    exit 0
}

Write-Host "QORVYNA AI — Windows build" -ForegroundColor White
Write-Host "repository: $repoRoot"
Write-Host "host OS   : $([System.Environment]::OSVersion.VersionString)"

if ($env:OS -ne "Windows_NT") {
    Write-Fail "This script builds the Windows desktop app and must run on Windows."
    Complete-Script
}

# ---------------------------------------------------------------------------
Write-Step "Validate prerequisites"
# ---------------------------------------------------------------------------

$packageJson = Join-Path $repoRoot "package.json"
$tauriConf = Join-Path $repoRoot "src-tauri\tauri.conf.json"
$cargoToml = Join-Path $repoRoot "src-tauri\Cargo.toml"

foreach ($required in @($packageJson, $tauriConf, $cargoToml, (Join-Path $repoRoot "package-lock.json"), (Join-Path $repoRoot "scripts\native\build-native-frontend.mjs"))) {
    if (-not (Test-Path -LiteralPath $required)) {
        Write-Fail "Missing required file: $required (run this script from the repository root)."
        Complete-Script
    }
}
Write-Ok "Repository files present (package.json, package-lock.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml)."

$node = Invoke-Capture -Exe "node" -Arguments @("-v")
if ($node.Code -ne 0) {
    Write-Fail "Node.js is not installed or not on PATH. Install Node.js 22 LTS from https://nodejs.org/en/download (winget install OpenJS.NodeJS.LTS)."
    Complete-Script
}
$nodeVersion = $node.Output.TrimStart("v")
$nodeMajor = [int]($nodeVersion.Split(".")[0])
Write-Ok "node $nodeVersion"
if ($nodeMajor -lt 20) {
    Write-Fail "Node.js $nodeVersion is too old. This project targets Node.js 20.x or 22.x LTS (Next.js 15)."
}

$npm = Invoke-Capture -Exe "npm" -Arguments @("-v")
if ($npm.Code -ne 0) {
    Write-Fail "npm is not available on PATH."
} else {
    $npmMajor = [int]($npm.Output.Split(".")[0])
    Write-Ok "npm $($npm.Output)"
    if ($npmMajor -lt 10) { Write-Fail "npm $($npm.Output) is older than the 10.x used for package-lock.json. Run: npm install -g npm@latest" }
}

$rustc = Invoke-Capture -Exe "rustc" -Arguments @("--version")
if ($rustc.Code -ne 0) {
    Write-Fail "rustc is not installed. Install Rust from https://rustup.rs (winget install Rustlang.Rustup) and reopen the terminal."
} else {
    Write-Ok $rustc.Output
    if ($rustc.Output -match "rustc (\d+)\.(\d+)\.(\d+)") {
        $rustVersion = [version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $Matches[3])
        if ($rustVersion -lt [version]"1.77.2") {
            Write-Fail "rustc $rustVersion is older than the 1.77.2 required by src-tauri/Cargo.toml. Run: rustup update stable && rustup default stable-msvc"
        }
    }
}

$cargo = Invoke-Capture -Exe "cargo" -Arguments @("--version")
if ($cargo.Code -ne 0) { Write-Fail "cargo is not available. Install the Rust toolchain (rustup) and reopen the terminal." } else { Write-Ok $cargo.Output }

if ($rustc.Code -eq 0) {
    $host = Invoke-Capture -Exe "rustc" -Arguments @("-vV")
    if ($host.Output -match "host:\s*(\S+)") {
        $hostTriple = $Matches[1]
        Write-Info "rust host target: $hostTriple"
        if ($hostTriple -notmatch "windows-msvc$") {
            Write-Fail "The active Rust toolchain targets '$hostTriple'. Windows builds need an MSVC toolchain: rustup default stable-msvc"
        }
    }
}

# MSVC linker — required by the MSVC Rust toolchain and by Tauri's build script.
$linkOk = $false
foreach ($vswhere in @("${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe", "${env:ProgramFiles}\Microsoft Visual Studio\Installer\vswhere.exe")) {
    if (Test-Path -LiteralPath $vswhere) {
        $found = Invoke-Capture -Exe $vswhere -Arguments @("-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath")
        if ($found.Code -eq 0 -and $found.Output) { $linkOk = $true; Write-Ok "Visual Studio C++ build tools: $($found.Output)" }
    }
}
$cl = Invoke-Capture -Exe "cl" -Arguments @()
if ($cl.Code -eq 0 -or $cl.Output -match "Microsoft") { $linkOk = $true }
if (-not $linkOk) {
    Write-Fail "Microsoft C++ build tools were not found. Install 'Desktop development with C++' (Visual Studio Build Tools 2022, winget install Microsoft.VisualStudio.2022.BuildTools) or open a 'x64 Native Tools Command Prompt'."
}

# WebView2 runtime — the app has no UI without it.
$webviewKeys = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
)
$webview = $null
foreach ($key in $webviewKeys) {
    if (Test-Path $key) { $webview = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).pv; if ($webview) { break } }
}
if ($webview) { Write-Ok "WebView2 runtime $webview" }
else { Write-Fail "Microsoft Edge WebView2 Runtime is not installed. Install it: winget install Microsoft.EdgeWebView2Runtime" }

if ($script:failures.Count -gt 0) { Complete-Script }

# ---------------------------------------------------------------------------
Write-Step "Install dependencies from the lockfile"
# ---------------------------------------------------------------------------

if ($SkipInstall) {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules"))) {
        Write-Fail "-SkipInstall was given but node_modules does not exist. Run without -SkipInstall."
        Complete-Script
    }
    Write-Info "Skipped by -SkipInstall (node_modules already present)."
} else {
    Invoke-Checked -Exe "npm" -Arguments @("ci", "--no-audit", "--no-fund") -Description "Installing exactly what package-lock.json pins."
}

$tauriVersion = Invoke-Capture -Exe "npx" -Arguments @("--no-install", "tauri", "--version")
if ($tauriVersion.Code -ne 0) {
    Write-Fail "The Tauri CLI is not installed from devDependencies (@tauri-apps/cli). Run: npm ci"
} else {
    Write-Ok "tauri CLI $($tauriVersion.Output)"
}

# ---------------------------------------------------------------------------
Write-Step "Bundle the shared frontend into public/native"
# ---------------------------------------------------------------------------

Write-Info "tauri.conf.json frontendDist is ../public/native — the app ships its own assets and never loads the website URL."
Invoke-Checked -Exe "node" -Arguments @("scripts/native/build-native-frontend.mjs") -Description "Bundling src/ components for the Tauri WebView."

$nativeIndex = Join-Path $repoRoot "public\native\index.html"
$nativeApp = Join-Path $repoRoot "public\native\app.js"
foreach ($artifact in @($nativeIndex, $nativeApp)) {
    if (Test-Path -LiteralPath $artifact) {
        $size = [math]::Round((Get-Item -LiteralPath $artifact).Length / 1KB, 1)
        Write-Ok ("{0} ({1} KB)" -f $artifact.Replace("$repoRoot\", ""), $size)
    } else {
        Write-Fail "The native frontend bundle is incomplete: $artifact is missing."
    }
}
if ($script:failures.Count -gt 0) { Complete-Script }

# ---------------------------------------------------------------------------
Write-Step "Build the Windows app and installers"
# ---------------------------------------------------------------------------

$tauriArgs = @("--no-install", "tauri", "build")
if ($Debug) { $tauriArgs += "--debug" }
if ($Targets -ne "") {
    if ($Targets -notmatch "^(nsis|msi)(\s*,\s*(nsis|msi))*$") {
        Write-Fail "-Targets must be nsis, msi, or a comma-separated list of them (received '$Targets')."
        Complete-Script
    }
    $tauriArgs += @("--bundles", $Targets)
}

Write-Info "This compiles the Rust shell with cargo; the first run takes several minutes."
Invoke-Checked -Exe "npx" -Arguments $tauriArgs -Description "Building the QORVYNA AI Windows bundles."

# ---------------------------------------------------------------------------
Write-Step "Verify the artifacts exist"
# ---------------------------------------------------------------------------

$mode = if ($Debug) { "debug" } else { "release" }
$bundleRoot = Join-Path $repoRoot ("src-tauri\target\{0}\bundle" -f $mode)
$binRoot = Join-Path $repoRoot ("src-tauri\target\{0}" -f $mode)

# The executable name comes from the Cargo package (src-tauri/Cargo.toml →
# `name = "matrix-ai-desktop"`), never from an assumption in this script: the
# real file on disk is listed, and a missing one is a failure.
$executables = @()
if (Test-Path -LiteralPath $binRoot) {
    $executables = @(Get-ChildItem -LiteralPath $binRoot -File -Filter *.exe)
}
if ($executables.Count -gt 0) {
    foreach ($binary in $executables) {
        $size = [math]::Round($binary.Length / 1MB, 1)
        Write-Ok ("Executable: {0} ({1} MB)" -f $binary.FullName.Replace("$repoRoot\", ""), $size)
    }
} else {
    Write-Fail "No executable was produced in src-tauri\target\$mode. cargo reported the failure above."
}

if (Test-Path -LiteralPath $bundleRoot) {
    $installers = @(Get-ChildItem -LiteralPath $bundleRoot -Recurse -File | Where-Object { $_.Extension -eq ".exe" -or $_.Extension -eq ".msi" })
    if ($installers.Count -gt 0) {
        foreach ($installer in $installers) {
            $size = [math]::Round($installer.Length / 1MB, 1)
            Write-Ok ("Installer: {0} ({1} MB)" -f $installer.FullName.Replace("$repoRoot\", ""), $size)
        }
    } elseif (-not $Debug) {
        Write-Fail "No installer (.exe / .msi) was produced under $bundleRoot. Tauri reported a bundling failure above; nothing was published."
    }
} elseif (-not $Debug) {
    Write-Fail "The bundle directory $bundleRoot does not exist — no installer was produced."
}

Write-Host ""
Write-Info "Output locations:"
Write-Info "  executable : src-tauri\target\$mode\  (matrix-ai-desktop.exe — the Cargo package name)"
Write-Info "  installers : src-tauri\target\$mode\bundle\nsis\ and src-tauri\target\$mode\bundle\msi\"
Write-Info "Clean rebuild: remove src-tauri\target and public\native, then run this script again."

Complete-Script
