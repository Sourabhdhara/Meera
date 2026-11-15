/* ===========================================================================
 * MEERA V2 — Linux-Style Atomic Background Auto-Updater
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

class AutoUpdater {
  constructor(appRoot, currentVersion = '1.0.0') {
    this.appRoot = appRoot;
    this.currentVersion = currentVersion;
    this.repo = 'Sourabhdhara/Meera';
    this.checkIntervalMs = 60 * 60 * 1000; // 1 hour
  }

  startPeriodicCheck() {
    // Initial check after 15 seconds of clean boot
    setTimeout(() => {
      this.checkForUpdates().catch(() => {});
    }, 15000);

    // Periodic check
    setInterval(() => {
      this.checkForUpdates().catch(() => {});
    }, this.checkIntervalMs);
  }

  async checkForUpdates() {
    console.log('[AutoUpdater] Checking for remote updates on GitHub...');
    return new Promise((resolve, reject) => {
      const url = `https://api.github.com/repos/${this.repo}/releases/latest`;
      const options = {
        headers: { 'User-Agent': 'MEERA-Desktop-Updater' }
      };

      https.get(url, options, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(false);
        }

        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const remoteTag = (data.tag_name || '').replace(/^v/, '');
            if (remoteTag && this.isNewer(remoteTag, this.currentVersion)) {
              console.log(`[AutoUpdater] New version detected: ${remoteTag} (current: ${this.currentVersion})`);
              const asset = data.assets?.find(a => a.name === 'meera-core.zip');
              if (asset && asset.browser_download_url) {
                this.stageAtomicUpdate(asset.browser_download_url, remoteTag);
              }
            } else {
              console.log('[AutoUpdater] App is up to date.');
            }
            resolve(true);
          } catch (e) {
            resolve(false);
          }
        });
      }).on('error', () => resolve(false));
    });
  }

  isNewer(remote, current) {
    const rParts = remote.split('.').map(Number);
    const cParts = current.split('.').map(Number);
    for (let i = 0; i < Math.max(rParts.length, cParts.length); i++) {
      const r = rParts[i] || 0;
      const c = cParts[i] || 0;
      if (r > c) return true;
      if (r < c) return false;
    }
    return false;
  }

  stageAtomicUpdate(downloadUrl, version) {
    const updatesDir = path.join(this.appRoot, '..', 'updates');
    if (!fs.existsSync(updatesDir)) {
      try { fs.mkdirSync(updatesDir, { recursive: true }); } catch (_) { return; }
    }

    const zipTarget = path.join(updatesDir, 'update-pending.zip');
    const tempCore = path.join(updatesDir, 'core-staging');

    console.log(`[AutoUpdater] Silently downloading update ${version} in background...`);
    
    // Download zip stream
    const file = fs.createWriteStream(zipTarget);
    const download = (url) => {
      https.get(url, { headers: { 'User-Agent': 'MEERA-Desktop-Updater' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return download(res.headers.location);
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            console.log('[AutoUpdater] Download complete. Extracting staging payload...');
            this.extractAndArm(zipTarget, tempCore, version);
          });
        });
      }).on('error', () => {
        try { fs.unlinkSync(zipTarget); } catch (_) {}
      });
    };

    download(downloadUrl);
  }

  extractAndArm(zipPath, targetDir, version) {
    if (fs.existsSync(targetDir)) {
      try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (_) {}
    }
    fs.mkdirSync(targetDir, { recursive: true });

    const ps = `Expand-Archive -Path '${zipPath}' -DestinationPath '${targetDir}' -Force`;
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true });
    child.on('close', (code) => {
      try { fs.unlinkSync(zipPath); } catch (_) {}
      if (code === 0) {
        console.log(`[AutoUpdater] Linux-style Atomic update ${version} is ARMED and ready for next restart!`);
        fs.writeFileSync(path.join(path.dirname(targetDir), 'update_ready.flag'), version, 'utf8');
      }
    });
  }

  static applyPendingUpdateOnStartup(installRoot) {
    // If running from C:\ProgramData\MEERA\core
    const updatesDir = path.join(installRoot, '..', 'updates');
    const flagFile = path.join(updatesDir, 'update_ready.flag');
    const stagingDir = path.join(updatesDir, 'core-staging');

    if (fs.existsSync(flagFile) && fs.existsSync(stagingDir)) {
      console.log('[AutoUpdater] Found armed update! Applying atomic directory swap...');
      const backupDir = path.join(installRoot, '..', 'core-backup');
      try {
        if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
        
        // 1. Move active core -> core-backup
        fs.renameSync(installRoot, backupDir);
        
        // 2. Move staging -> core
        fs.renameSync(stagingDir, installRoot);
        
        // 3. Clear flag
        fs.unlinkSync(flagFile);
        console.log('[AutoUpdater] Atomic swap complete! App successfully upgraded.');
      } catch (e) {
        console.error('[AutoUpdater] Atomic swap failed, falling back to existing core:', e);
        if (!fs.existsSync(installRoot) && fs.existsSync(backupDir)) {
          fs.renameSync(backupDir, installRoot);
        }
      }
    }
  }
}

module.exports = AutoUpdater;
