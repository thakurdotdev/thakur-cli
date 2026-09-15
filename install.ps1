# thakurcode Windows PowerShell installer
# Usage:
#   powershell -c "irm https://raw.githubusercontent.com/thakurdotdev/takur-cli/main/install.ps1 | iex"

$ErrorActionPreference = "Stop"

$repo = if ($env:GITHUB_REPO) { $env:GITHUB_REPO } else { "thakurdotdev/takur-cli" }
$version = if ($env:THAKURCODE_VERSION) { $env:THAKURCODE_VERSION } else { "latest" }
$installDir = if ($env:THAKURCODE_INSTALL_DIR) { $env:THAKURCODE_INSTALL_DIR } else { "$env:USERPROFILE\.thakurcode\bin" }

Write-Host "
  _   _           _                               _      
 | |_| |__   __ _| | ___   _ _ __ ___ ___   __| | ___ 
 | __| '_ \ / _` | |/ / | | | '__/ __/ _ \ / _` |/ _ \
 | |_| | | | (_| |   <| |_| | | | (_| (_) | (_| |  __/
  \__|_| |_|\__,_|_|\_\\__,_|_|  \___\___/ \__,_|\___|

  AI coding harness — multi-model terminal coding agent
" -ForegroundColor Cyan

$arch = if ([System.Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
if ($arch -ne "x64") {
    Write-Error "thakurcode currently only supports 64-bit Windows (x64)."
    exit 1
}

$artifact = "thakurcode-windows-x64.exe"
$downloadUrl = if ($env:THAKURCODE_DOWNLOAD_URL) {
    $env:THAKURCODE_DOWNLOAD_URL
} elseif ($version -eq "latest") {
    "https://github.com/$repo/releases/latest/download/$artifact"
} else {
    "https://github.com/$repo/releases/download/$version/$artifact"
}

if (!(Test-Path $installDir)) {
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
}

$targetPath = Join-Path $installDir "thakurcode.exe"
$legacyPath = Join-Path $installDir "harness.exe"
$tempPath = [System.IO.Path]::GetTempFileName()

Write-Host "→ Downloading $artifact..." -ForegroundColor Cyan

$downloaded = $false
try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $tempPath -UseBasicParsing
    $downloaded = $true
} catch {
    Write-Warning "Could not download from GitHub release ($downloadUrl)."
    if (Test-Path "dist\$artifact") {
        Write-Host "→ Using local binary from dist\$artifact" -ForegroundColor Cyan
        Copy-Item "dist\$artifact" $tempPath -Force
        $downloaded = $true
    } elseif (Test-Path "dist\thakurcode.exe") {
        Write-Host "→ Using local binary from dist\thakurcode.exe" -ForegroundColor Cyan
        Copy-Item "dist\thakurcode.exe" $tempPath -Force
        $downloaded = $true
    }
}

if (-not $downloaded) {
    Write-Error "Installation failed: Unable to fetch binary. Ensure GitHub release is published or set THAKURCODE_DOWNLOAD_URL."
    exit 1
}

Move-Item -Path $tempPath -Destination $targetPath -Force
Copy-Item -Path $targetPath -Destination $legacyPath -Force

Write-Host "✓ Installed binary to $targetPath" -ForegroundColor Green

# Update User PATH if needed
$userPath = [System.Environment]::GetEnvironmentVariable("Path", [System.EnvironmentVariableTarget]::User)
$pathEntries = $userPath -split ';' | Where-Object { $_ -ne "" }

if ($pathEntries -notcontains $installDir) {
    $newUserPath = ($pathEntries + $installDir) -join ';'
    [System.Environment]::SetEnvironmentVariable("Path", $newUserPath, [System.EnvironmentVariableTarget]::User)
    Write-Host "✓ Added $installDir to User PATH" -ForegroundColor Green
    $env:Path = "$installDir;$env:Path"
}

Write-Host "
Installation Complete!
To get started:
  1. If running in an existing PowerShell session, reload PATH or restart terminal.
  2. Run:
     thakurcode                   # Start chat REPL
     thakurcode auth <provider>   # Configure API key
     thakurcode --help            # Show all options
" -ForegroundColor Green
