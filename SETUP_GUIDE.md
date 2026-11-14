# MEERA Setup Guide

## Requirements

- Windows 10 or later
- Node.js installed and available in the terminal
- Google Chrome installed, or a Puppeteer-managed Chrome browser

Check the installed versions:

```cmd
node -v
npm -v
```

## Installation

Open Command Prompt or PowerShell in the MEERA project folder:

```cmd
cd C:\Users\<username>\Music\MEERA
```

Install the project dependencies:

```cmd
npm install
```

If installation fails while Puppeteer is downloading its browser, run:

```cmd
set PUPPETEER_SKIP_DOWNLOAD=true
npm install
npx puppeteer browsers install chrome
npm install
```

The final command should report either `up to date` or `added ... packages`.

## Start MEERA

Start the desktop application with:

```cmd
npm run app
```

## Troubleshooting Windows file-lock errors

If npm reports `EBUSY` for Electron, esbuild, or Puppeteer files:

1. Close MEERA, Electron, VS Code terminals, and File Explorer windows opened inside the project.
2. Stop leftover processes:

```cmd
taskkill /F /IM electron.exe /T
taskkill /F /IM node.exe /T
```

3. Restart Windows if the files remain locked.
4. Run `npm install` again.

The `deprecated` package messages do not prevent installation. The installation is successful when npm reports `added ... packages` or `up to date`.

## Security audit

Inspect reported vulnerabilities with:

```cmd
npm audit
```

Do not run `npm audit fix --force` without testing afterward, because it can install breaking dependency upgrades.
