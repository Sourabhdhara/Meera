<#
.SYNOPSIS
    MEERA AI Companion — Ultra-Light Web Bootstrapper & Installer
    Installs MEERA securely into C:\ProgramData\MEERA\ and configures Desktop Shortcut.
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 1. Target Directories
$VaultRoot = "C:\ProgramData\MEERA"
$CoreDir = Join-Path $VaultRoot "core"
$UpdatesDir = Join-Path $VaultRoot "updates"
$UserAppData = Join-Path $env:APPDATA "MEERA"

Write-Host "[-] Preparing Secure Installation Vault..." -ForegroundColor Gray

# Create ProgramData vault
if (-not (Test-Path $VaultRoot)) {
    New-Item -Path $VaultRoot -ItemType Directory -Force | Out-Null
    try {
        $dirInfo = Get-Item $VaultRoot -Force
        $dirInfo.Attributes = [System.IO.FileAttributes]::Hidden
    } catch {}
}

if (-not (Test-Path $CoreDir)) { New-Item -Path $CoreDir -ItemType Directory -Force | Out-Null }
if (-not (Test-Path $UpdatesDir)) { New-Item -Path $UpdatesDir -ItemType Directory -Force | Out-Null }
if (-not (Test-Path $UserAppData)) { New-Item -Path $UserAppData -ItemType Directory -Force | Out-Null }

Write-Host "[✓] Vault initialized at $VaultRoot" -ForegroundColor Green

# 2. Check Node Runtime Prerequisite
Write-Host "[-] Checking Runtime Environment..." -ForegroundColor Gray
$HasNode = $null
try {
    $ver = & node -v 2>$null
    if ($ver) { $HasNode = $true }
} catch {}

if (-not $HasNode) {
    Write-Host "[!] Installing Node.js LTS Runtime environment..." -ForegroundColor Yellow
    $NodeMsiUrl = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi"
    $TempMsi = Join-Path $env:TEMP "nodejs-lts.msi"
    Invoke-WebRequest -Uri $NodeMsiUrl -OutFile $TempMsi -UseBasicParsing
    Start-Process msiexec.exe -ArgumentList "/i `"$TempMsi`" /quiet /norestart" -Wait
    Remove-Item $TempMsi -Force -ErrorAction SilentlyContinue
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", [System.EnvironmentVariableTarget]::Machine)
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", [System.EnvironmentVariableTarget]::User)
    $env:Path = "$machinePath;$userPath"
}

# 3. Stream Protected Core Payload
Write-Host "[-] Fetching Latest Encrypted Neural Core..." -ForegroundColor Gray
$ReleaseApi = "https://api.github.com/repos/Sourabhdhara/Meera/releases/latest"
$TempZip = Join-Path $VaultRoot "meera-core-stream.zip"

$downloaded = $false
try {
    $ReleaseInfo = Invoke-RestMethod -Uri $ReleaseApi -Headers @{"User-Agent"="MEERA-Installer"} -TimeoutSec 10
    $CoreAsset = $ReleaseInfo.assets | Where-Object { $_.name -eq "meera-core.zip" } | Select-Object -First 1
    if ($CoreAsset) {
        Invoke-WebRequest -Uri $CoreAsset.browser_download_url -OutFile $TempZip -UseBasicParsing
        $downloaded = $true
    }
} catch {}

if (-not $downloaded) {
    Write-Host "[!] Deploying from local payload staging..." -ForegroundColor Yellow
    $searchPaths = @(
        (Join-Path $PSScriptRoot "..\release-dist\meera-core.zip"),
        (Join-Path $PSScriptRoot "meera-core.zip"),
        "release-dist\meera-core.zip"
    )
    $found = $null
    foreach ($p in $searchPaths) {
        if (Test-Path $p) {
            $found = $p
            break
        }
    }

    if ($found) {
        Copy-Item -Path $found -Destination $TempZip -Force
    } else {
        Write-Error "No payload found to install!"
        exit 1
    }
}

Write-Host "[-] Extracting Protected Bytecode Core into Vault..." -ForegroundColor Gray
Expand-Archive -Path $TempZip -DestinationPath $CoreDir -Force
Remove-Item $TempZip -Force -ErrorAction SilentlyContinue

# Copy assets folder into core if present
$localAssets = Join-Path $PSScriptRoot "..\assets"
if (Test-Path $localAssets) {
    Copy-Item -Path $localAssets -Destination (Join-Path $CoreDir "assets") -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "[✓] Core neural engine installed successfully!" -ForegroundColor Green

# 4. Link minimal dependencies
Set-Location $CoreDir
if (-not (Test-Path "$CoreDir\node_modules\bytenode")) {
    Write-Host "[-] Linking production dependencies..." -ForegroundColor Gray
    Start-Process "npm.cmd" -ArgumentList "install --omit=dev --no-audit --no-fund" -WorkingDirectory $CoreDir -NoNewWindow -Wait
}

# 5. Create Desktop & Start Menu Shortcuts
Write-Host "[-] Creating Desktop & Start Menu Shortcuts..." -ForegroundColor Gray
$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop)
$ShortcutPath = Join-Path $DesktopPath "MEERA.lnk"

# Find best available electron executable
$LocalElectron = Join-Path $PSScriptRoot "..\node_modules\electron\dist\electron.exe"
if (-not (Test-Path $LocalElectron)) { $LocalElectron = "node_modules\electron\dist\electron.exe" }
$GlobalElectron = (Get-Command electron.cmd -ErrorAction SilentlyContinue).Source

$TargetExe = "npx.cmd"
$TargetArgs = "electron electron\main.cjs"

if (Test-Path $LocalElectron) {
    # Copy pre-installed electron runtime into vault so it never redownloads
    $VaultElectron = Join-Path $CoreDir "electron\electron.exe"
    if (-not (Test-Path (Split-Path $VaultElectron))) {
        New-Item -Path (Split-Path $VaultElectron) -ItemType Directory -Force | Out-Null
        Copy-Item -Path (Split-Path $LocalElectron)\* -Destination (Split-Path $VaultElectron) -Recurse -Force
    }
    $TargetExe = $VaultElectron
    $TargetArgs = "electron\main.cjs"
} elseif ($GlobalElectron) {
    $TargetExe = $GlobalElectron
    $TargetArgs = "electron\main.cjs"
}

$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $TargetExe
$Shortcut.Arguments = $TargetArgs
$Shortcut.WorkingDirectory = $CoreDir
$Shortcut.Description = "MEERA AI Desktop Companion"
$Shortcut.IconLocation = "$CoreDir\assets\icon.ico"
$Shortcut.WindowStyle = 1
$Shortcut.Save()

# Also copy shortcut to Start Menu Programs
$StartMenuPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Programs)
$StartShortcutPath = Join-Path $StartMenuPath "MEERA.lnk"
Copy-Item $ShortcutPath $StartShortcutPath -Force -ErrorAction SilentlyContinue

Write-Host "[✓] Shortcuts created!" -ForegroundColor Green
Write-Host "Launching MEERA now..." -ForegroundColor Cyan

# 6. Launch MEERA
Start-Process $TargetExe -ArgumentList $TargetArgs -WorkingDirectory $CoreDir
exit 0
