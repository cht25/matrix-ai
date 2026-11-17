# =============================================================================
# QORVYNA AI — Android App Bundle (AAB) build (Tauri 2, Play Store bundle)
#
# Builds the EXISTING application (one shared frontend, bundled into the app)
# without the online Agent build:
#   1. validates the Android/Rust toolchain this repository actually needs;
#   2. installs dependencies exactly as the lockfile pins them (npm ci);
#   3. bundles the shared frontend into public/native;
#   4. initialises the Tauri Android project when it does not exist yet, then
#      re-applies the QORVYNA notification-listener manifest patch;
#   5. builds the AAB with the Tauri CLI from devDependencies;
#   6. verifies an .aab really exists on disk before reporting success.
#
# Every command is echoed with its exit code. Any failure stops the script with
# a non-zero exit code — no step is skipped and nothing is reported as built
# unless the file is on disk.
#
# Usage (from the repository root):
#   powershell -ExecutionPolicy Bypass -File .\build-android-aab.ps1
#   powershell -ExecutionPolicy Bypass -File .\build-android-aab.ps1 -Target aarch64
#   powershell -ExecutionPolicy Bypass -File .\build-android-aab.ps1 -SkipInstall
#
# An .aab is NOT installable on a device: it is the upload format Google Play
# requires. Use build-android-apk.ps1 for an installable APK.
# =============================================================================

[CmdletBinding()]
param(
    # Skip `npm ci` when node_modules is already in the state you want.
    [switch]$SkipInstall,
    # Build a debug bundle (Play does not accept it; useful for inspection only).
    [switch]$Debug,
    # Restrict the ABI split, e.g. -Target aarch64 (default: Tauri's own).
    [string]$Target = "",
    # Open the CLI in verbose mode.
    [switch]$Verbose
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

function Write-Info { param([string]$Message) Write-Host "  $Message" }
function Write-Ok { param([string]$Message) Write-Host "  OK   $Message" -ForegroundColor Green }
function Write-Fail {
    param([string]$Message)
    Write-Host "  FAIL $Message" -ForegroundColor Red
    $script:failures.Add($Message)
}

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
    param([Parameter(Mandatory = $true)][string]$Exe, [string[]]$Arguments = @())
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

Write-Host "QORVYNA AI — Android AAB build" -ForegroundColor White
Write-Host "repository: $repoRoot"
Write-Host "host OS   : $([System.Environment]::OSVersion.VersionString)"

# ---------------------------------------------------------------------------
Write-Step "Validate prerequisites"
# ---------------------------------------------------------------------------

foreach ($required in @(
    (Join-Path $repoRoot "package.json"),
    (Join-Path $repoRoot "package-lock.json"),
    (Join-Path $repoRoot "src-tauri\tauri.conf.json"),
    (Join-Path $repoRoot "src-tauri\Cargo.toml"),
    (Join-Path $repoRoot "scripts\native\build-native-frontend.mjs"),
    (Join-Path $repoRoot "scripts\native\patch-android-manifest.mjs")
)) {
    if (-not (Test-Path -LiteralPath $required)) {
        Write-Fail "Missing required file: $required (run this script from the repository root)."
        Complete-Script
    }
}
Write-Ok "Repository files present."

$node = Invoke-Capture -Exe "node" -Arguments @("-v")
if ($node.Code -ne 0) { Write-Fail "Node.js is not installed or not on PATH. Install Node.js 22 LTS (winget install OpenJS.NodeJS.LTS)." }
else {
    $nodeMajor = [int]($node.Output.TrimStart("v").Split(".")[0])
    Write-Ok "node $($node.Output.TrimStart('v'))"
    if ($nodeMajor -lt 20) { Write-Fail "Node.js $($node.Output) is too old; this project targets Node.js 20.x or 22.x LTS and Next.js 15." }
}

$npm = Invoke-Capture -Exe "npm" -Arguments @("-v")
if ($npm.Code -ne 0) { Write-Fail "npm is not available on PATH." } else { Write-Ok "npm $($npm.Output)" }

# JDK 17 — required by the Android Gradle Plugin that Tauri 2 generates.
$javaHome = $env:JAVA_HOME
if (-not $javaHome -or -not (Test-Path -LiteralPath (Join-Path $javaHome "bin\java.exe"))) {
    Write-Fail "JAVA_HOME is not set to a JDK directory containing bin\java.exe. Install OpenJDK 17 (winget install EclipseAdoptium.Temurin.17.JDK) and set JAVA_HOME, then reopen the terminal."
} else {
    $java = Invoke-Capture -Exe (Join-Path $javaHome "bin\java.exe") -Arguments @("-version")
    $javaText = $java.Output
    if ($java.Code -ne 0) { Write-Fail "JAVA_HOME points at $javaHome but 'java -version' failed: $javaText" }
    else {
        Write-Ok "JAVA_HOME=$javaHome"
        Write-Info ($javaText -split "`n" | Select-Object -First 1)
        if ($javaText -match 'version "(1\.)?(\d+)') {
            $javaMajor = [int]$Matches[2]
            if ($javaMajor -ne 17) {
                Write-Fail "JDK $javaMajor found; the Tauri 2 Android project targets JDK 17. Point JAVA_HOME at a JDK 17 installation."
            }
        }
    }
}

# Android SDK — Tauri finds it through ANDROID_HOME (or ANDROID_SDK_ROOT).
$sdkRoot = $env:ANDROID_HOME
if (-not $sdkRoot) { $sdkRoot = $env:ANDROID_SDK_ROOT }
if (-not $sdkRoot -or -not (Test-Path -LiteralPath $sdkRoot)) {
    Write-Fail "ANDROID_HOME (or ANDROID_SDK_ROOT) is not set to an existing Android SDK directory. Install Android Studio, then set ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk."
} else {
    Write-Ok "ANDROID_HOME=$sdkRoot"
    $platforms = Join-Path $sdkRoot "platforms"
    $buildTools = Join-Path $sdkRoot "build-tools"
    if (-not (Test-Path -LiteralPath $platforms)) { Write-Fail "No 'platforms' directory under $sdkRoot. Install 'Android SDK Platform 34' with the SDK Manager." }
    else {
        $installed = Get-ChildItem -LiteralPath $platforms -Directory | Select-Object -ExpandProperty Name
        if (-not ($installed | Where-Object { [int]($_ -replace "^android-", "") -ge 34 })) {
            Write-Fail "Android SDK platform 34 (or newer) is missing. Installed: $($installed -join ', '). Run: sdkmanager ""platforms;android-34"""
        } else { Write-Ok "SDK platforms: $($installed -join ', ')" }
    }
    if (-not (Test-Path -LiteralPath $buildTools)) { Write-Fail "No 'build-tools' directory under $sdkRoot. Install 'Android SDK Build-Tools 34'." }
    else {
        $tools = Get-ChildItem -LiteralPath $buildTools -Directory | Select-Object -ExpandProperty Name
        if (-not $tools) { Write-Fail "build-tools is empty. Install 'Android SDK Build-Tools 34'." } else { Write-Ok "Build-tools: $($tools -join ', ')" }
    }

    # Tauri 2 needs the NDK; it is resolved from $ANDROID_HOME\ndk\<version>.
    $ndkDir = Join-Path $sdkRoot "ndk"
    if ($env:NDK_HOME -and (Test-Path -LiteralPath $env:NDK_HOME)) {
        Write-Ok "NDK_HOME=$($env:NDK_HOME)"
    } elseif (Test-Path -LiteralPath $ndkDir) {
        $ndks = Get-ChildItem -LiteralPath $ndkDir -Directory | Select-Object -ExpandProperty Name
        if ($ndks.Count -gt 0) { Write-Ok "Android NDK: $($ndks -join ', ') (under $ndkDir)" }
        else { Write-Fail "No NDK installed under $ndkDir. Run: sdkmanager ""ndk;27.0.12077973""" }
    } else {
        Write-Fail "No Android NDK found. Install one (sdkmanager ""ndk;27.0.12077973"") or set NDK_HOME."
    }
}

$rustc = Invoke-Capture -Exe "rustc" -Arguments @("--version")
if ($rustc.Code -ne 0) { Write-Fail "rustc is not installed. Install Rust (winget install Rustlang.Rustup) and reopen the terminal." }
else { Write-Ok $rustc.Output }

$cargo = Invoke-Capture -Exe "cargo" -Arguments @("--version")
if ($cargo.Code -ne 0) { Write-Fail "cargo is not available on PATH." } else { Write-Ok $cargo.Output }

# Rust must be able to cross-compile to Android. `rustup target list --installed`
# prints the truth; a missing target would fail much later inside cargo.
$targets = Invoke-Capture -Exe "rustup" -Arguments @("target", "list", "--installed")
if ($targets.Code -ne 0) {
    Write-Fail "rustup is not available, so the Android Rust targets cannot be verified or installed."
} else {
    $installed = $targets.Output -split "`n" | ForEach-Object { $_.Trim() }
    Write-Ok ("Installed Rust targets: " + ($installed -join ", "))
    foreach ($needed in @("aarch64-linux-android", "armv7-linux-androideabi", "i686-linux-android", "x86_64-linux-android")) {
        if ($installed -notcontains $needed) {
            Write-Fail "Rust target $needed is missing. Run: rustup target add $needed"
        }
    }
}

if ($script:failures.Count -gt 0) { Complete-Script }

# ---------------------------------------------------------------------------
Write-Step "Install dependencies from the lockfile"
# ---------------------------------------------------------------------------

if ($SkipInstall) {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules"))) {
        Write-Fail "-SkipInstall was given but node_modules does not exist. Run without -SkipInstall."
        Complete-Script
    }
    Write-Info "Skipped by -SkipInstall."
} else {
    Invoke-Checked -Exe "npm" -Arguments @("ci", "--no-audit", "--no-fund") -Description "Installing exactly what package-lock.json pins."
}

$tauriVersion = Invoke-Capture -Exe "npx" -Arguments @("--no-install", "tauri", "--version")
if ($tauriVersion.Code -ne 0) { Write-Fail "The Tauri CLI is not installed from devDependencies (@tauri-apps/cli). Run: npm ci" }
else { Write-Ok "tauri CLI $($tauriVersion.Output)" }

# ---------------------------------------------------------------------------
Write-Step "Bundle the shared frontend into public/native"
# ---------------------------------------------------------------------------

Write-Info "The same src/ components the website renders are bundled into the app; it ships its own assets and never loads the website URL."
Invoke-Checked -Exe "node" -Arguments @("scripts/native/build-native-frontend.mjs") -Description "Bundling src/ components for the Android WebView."

$nativeIndex = Join-Path $repoRoot "public\native\index.html"
$nativeApp = Join-Path $repoRoot "public\native\app.js"
foreach ($artifact in @($nativeIndex, $nativeApp)) {
    if (Test-Path -LiteralPath $artifact) {
        Write-Ok ("{0} ({1} KB)" -f $artifact.Replace("$repoRoot\", ""), [math]::Round((Get-Item -LiteralPath $artifact).Length / 1KB, 1))
    } else { Write-Fail "The native frontend bundle is incomplete: $artifact is missing." }
}
if ($script:failures.Count -gt 0) { Complete-Script }

# ---------------------------------------------------------------------------
Write-Step "Android project (tauri android init + manifest patch)"
# ---------------------------------------------------------------------------

$androidProject = Join-Path $repoRoot "src-tauri\gen\android"
if (-not (Test-Path -LiteralPath $androidProject)) {
    Write-Info "src-tauri\gen\android does not exist yet — running 'tauri android init' once."
    Invoke-Checked -Exe "npx" -Arguments @("--no-install", "tauri", "android", "init") -Description "Generating the Gradle project Tauri builds."
} else {
    Write-Ok "Android project already initialised at src-tauri\gen\android."
}

$manifest = Join-Path $androidProject "app\src\main\AndroidManifest.xml"
if (-not (Test-Path -LiteralPath $manifest)) {
    Write-Fail "AndroidManifest.xml not found at $manifest — 'tauri android init' did not complete."
    Complete-Script
}
# The notification-listener service lives in a generated folder, so the patch is
# re-applied on every build. It is idempotent.
Invoke-Checked -Exe "node" -Arguments @("scripts/native/patch-android-manifest.mjs") -Description "Re-applying the QORVYNA notification-listener declaration."

# ---------------------------------------------------------------------------
Write-Step "Build the App Bundle"
# ---------------------------------------------------------------------------

$tauriArgs = @("--no-install", "tauri", "android", "build", "--aab")
if ($Debug) { $tauriArgs += "--debug" }
if ($Target -ne "") { $tauriArgs += @("--target", $Target) }
if ($Verbose) { $tauriArgs += "--verbose" }

Write-Info "This cross-compiles the Rust shell for Android and runs Gradle; the first run takes several minutes."
Invoke-Checked -Exe "npx" -Arguments $tauriArgs -Description "Building the QORVYNA AI App Bundle."

# ---------------------------------------------------------------------------
Write-Step "Verify the App Bundle exists"
# ---------------------------------------------------------------------------

$bundleRoot = Join-Path $androidProject "app\build\outputs\bundle"
$bundles = @()
if (Test-Path -LiteralPath $bundleRoot) {
    $bundles = @(Get-ChildItem -LiteralPath $bundleRoot -Recurse -File -Filter *.aab)
}
if ($bundles.Count -eq 0) {
    Write-Fail "No .aab was produced under src-tauri\gen\android\app\build\outputs\bundle. Gradle reported the failure above; nothing was built."
    Complete-Script
}

foreach ($bundle in $bundles) {
    $size = [math]::Round($bundle.Length / 1MB, 1)
    Write-Ok ("AAB: {0} ({1} MB)" -f $bundle.FullName.Replace("$repoRoot\", ""), $size)
}

# Google Play rejects unsigned uploads; report the real signing state instead of
# implying the bundle is ready to upload. `jarsigner -verify` is part of the JDK.
$primary = $bundles | Select-Object -First 1
$jarsigner = Join-Path $javaHome "bin\jarsigner.exe"
if (Test-Path -LiteralPath $jarsigner) {
    $verify = Invoke-Capture -Exe $jarsigner -Arguments @("-verify", "-verbose", "-certs", $primary.FullName)
    if ($verify.Output -match "jar verified") {
        Write-Ok "Signature verified with jarsigner ($($primary.Name))."
    } else {
        Write-Fail "jarsigner did not verify $($primary.Name). Google Play will reject an unsigned or invalidly signed bundle — configure release signing (see WINDOWS_BUILD_GUIDE.md §8)."
    }
} else {
    Write-Info "jarsigner was not found in JAVA_HOME, so the signature was not verified."
}

Write-Host ""
Write-Info "Output location: src-tauri\gen\android\app\build\outputs\bundle\<release|debug>\"
Write-Info "Upload format  : .aab (Google Play). For an installable file use build-android-apk.ps1."
Write-Info "Clean rebuild  : remove src-tauri\gen\android\app\build and public\native, then run this script again."

Complete-Script
