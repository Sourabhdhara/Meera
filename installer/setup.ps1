<#
.SYNOPSIS
    MEERA AI Companion — Ultra-Light 2MB Web Bootstrapper & Installer
    Installs MEERA securely into C:\ProgramData\MEERA\ and configures Desktop Shortcut.
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# UI Branding Helper
function Write-Branding {
    Clear-Host
    Write-Host "==========================================================" -ForegroundColor Magenta
    Write-Host "                🌸 MEERA AI COMPANION 🌸                " -ForegroundColor White -BackgroundColor DarkMagenta
    Write-Host "          Next-Gen Autonomous AI Desktop OS Companion     " -ForegroundColor Cyan
    Write-Host "==========================================================" -ForegroundColor Magenta
    Write-Host ""
}

Write-Branding

# 1. Target Directories
$VaultRoot = "C:\ProgramData\MEERA"
$CoreDir = Join-Path $VaultRoot "core"
$UpdatesDir = Join-Path $VaultRoot "updates"
$UserAppData = Join-Path $env:APPDATA "MEERA"

Write-Host "[-] Preparing Secure Installation Vault..." -ForegroundColor Gray

# Create ProgramData vault (hidden system style)
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

# 2. Check Node/Electron Runtime Prerequisite
Write-Host "[-] Checking Runtime Environment..." -ForegroundColor Gray
$HasNode = $null
try {
    $ver = & node -v 2>$null
    if ($ver) { $HasNode = $true }
} catch {}

if (-not $HasNode) {
    Write-Host "[!] Installing ultra-fast Node.js LTS Runtime environment..." -ForegroundColor Yellow
    $NodeMsiUrl = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi"
    $TempMsi = Join-Path $env:TEMP "nodejs-lts.msi"
    Invoke-WebRequest -Uri $NodeMsiUrl -OutFile $TempMsi -UseBasicParsing
    Start-Process msiexec.exe -ArgumentList "/i `"$TempMsi`" /quiet /norestart" -Wait
    Remove-Item $TempMsi -Force -ErrorAction SilentlyContinue
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

# 3. Stream Protected Core Payload
Write-Host "[-] Fetching Latest Encrypted Neural Core from Release..." -ForegroundColor Gray
$ReleaseApi = "https://api.github.com/repos/Sourabhdhara/Meera/releases/latest"
$TempZip = Join-Path $VaultRoot "meera-core-stream.zip"

try {
    $ReleaseInfo = Invoke-RestMethod -Uri $ReleaseApi -Headers @{"User-Agent"="MEERA-Installer"} -TimeoutSec 15
    $CoreAsset = $ReleaseInfo.assets | Where-Object { $_.name -eq "meera-core.zip" } | Select-Object -First 1
    if ($CoreAsset) {
        Write-Host "[-] Streaming payload version $($ReleaseInfo.tag_name) ($([math]::Round($CoreAsset.size / 1MB, 2)) MB)..." -ForegroundColor Cyan
        Invoke-WebRequest -Uri $CoreAsset.browser_download_url -OutFile $TempZip -UseBasicParsing
    } else {
        throw "Core asset not found in release"
    }
} catch {
    Write-Host "[!] Note: Remote release asset not yet published; deploying from local workspace staging..." -ForegroundColor Yellow
    $LocalZip = "release-dist\meera-core.zip"
    if (Test-Path $LocalZip) {
        Copy-Item -Path $LocalZip -Destination $TempZip -Force
    } else {
        Write-Error "No local or remote payload found to install!"
        exit 1
    }
}

Write-Host "[-] Extracting Protected Bytecode Core into Vault..." -ForegroundColor Gray
Expand-Archive -Path $TempZip -DestinationPath $CoreDir -Force
Remove-Item $TempZip -Force -ErrorAction SilentlyContinue

Write-Host "[✓] Core neural engine installed successfully!" -ForegroundColor Green

# 4. Install Minimal Dependencies if needed
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

$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "npx.cmd"
$Shortcut.Arguments = "electron electron\main.cjs"
$Shortcut.WorkingDirectory = $CoreDir
$Shortcut.Description = "MEERA AI Desktop Companion"
$Shortcut.WindowStyle = 1
$Shortcut.Save()

# Also copy shortcut to Start Menu Programs
$StartMenuPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Programs)
$StartShortcutPath = Join-Path $StartMenuPath "MEERA.lnk"
Copy-Item $ShortcutPath $StartShortcutPath -Force -ErrorAction SilentlyContinue

Write-Host "[✓] Shortcuts created!" -ForegroundColor Green
Write-Host ""
Write-Host "==========================================================" -ForegroundColor Magenta
Write-Host "   🌸 MEERA HAS BEEN SUCCESSFULLY INSTALLED & CONFIGURED!  " -ForegroundColor White -BackgroundColor DarkGreen
Write-Host "==========================================================" -ForegroundColor Magenta
Write-Host ""
Write-Host "Launching MEERA now..." -ForegroundColor Cyan

# Launch MEERA
Start-Process "npx.cmd" -ArgumentList "electron electron\main.cjs" -WorkingDirectory $CoreDir
