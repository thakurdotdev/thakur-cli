# thakurcode Windows PowerShell installer
# Usage:
#   powershell -c "irm https://raw.githubusercontent.com/thakurdotdev/thakur-cli/main/install.ps1 | iex"

$ErrorActionPreference = "Stop"

$repo = if ($env:GITHUB_REPO) { $env:GITHUB_REPO } else { "thakurdotdev/thakur-cli" }
$version = if ($env:THAKURCODE_VERSION) { $env:THAKURCODE_VERSION } else { "latest" }
$installDir = if ($env:THAKURCODE_INSTALL_DIR) { $env:THAKURCODE_INSTALL_DIR } else { "$env:USERPROFILE\.thakurcode\bin" }

Write-Host "
   __  __          __                             __   
  / /_/ /_  ____ _/ /____  _______    _________  ____/ /__ 
 / __/ __ \/ __ `/ //_/ / / / ___/   / ___/ __ \/ __  / _ \
/ /_/ / / / /_/ / ,< / /_/ / /      / /__/ /_/ / /_/ /  __/
\__/_/ /_/\__,_/_/|_|\__,_/_/       \___/\____/\__,_/\___/ 

  thakurcode • multi-model AI coding agent for terminal
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

$force = if ($env:THAKURCODE_FORCE -eq "1" -or $args -contains "--force" -or $args -contains "-f") { $true } else { $false }

# Check installed version to avoid redundant downloads
if ((Test-Path $targetPath) -and (-not $force)) {
    $installedVersion = (& $targetPath --version 2>$null) -replace '^[vV\s]+', '' -replace '\s+$', ''
    $targetTag = $version
    if ($version -eq "latest") {
        try {
            $req = [System.Net.WebRequest]::Create("https://github.com/$repo/releases/latest")
            $req.AllowAutoRedirect = $false
            $resp = $req.GetResponse()
            $location = $resp.GetResponseHeader("Location")
            if ($location -match '/tag/(.+)') {
                $targetTag = $Matches[1]
            }
            $resp.Close()
        } catch {}
    }
    $cleanTarget = $targetTag -replace '^[vV\s]+', '' -replace '\s+$', ''

    if ($installedVersion -and $cleanTarget -and ($cleanTarget -ne "latest") -and ($installedVersion -eq $cleanTarget)) {
        Write-Host ""
        Write-Host "┌─────────────────────────────────────────────────────────────┐" -ForegroundColor Green
        Write-Host "│  ✓ thakurcode v$installedVersion is already installed and up to date!      │" -ForegroundColor Green
        Write-Host "└─────────────────────────────────────────────────────────────┘" -ForegroundColor Green
        Write-Host "  Location: $targetPath" -ForegroundColor DarkGray
        Write-Host "`n  Run thakurcode to start.`n  To force re-installation, set `$env:THAKURCODE_FORCE = '1' or pass --force`n"
        exit 0
    }
}

$tempPath = [System.IO.Path]::GetTempFileName()

Write-Host "→ Downloading $artifact (~86 MB, standalone binary)..." -ForegroundColor Cyan

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
┌─────────────────────────────────────────────────────────────┐
│  ✓ thakurcode installed successfully!                       │
└─────────────────────────────────────────────────────────────┘
  Location: $targetPath

Quick start:
  thakurcode                   # Start chat REPL
  thakurcode auth <provider>   # Configure API key
  thakurcode --help            # Show all options
" -ForegroundColor Green
