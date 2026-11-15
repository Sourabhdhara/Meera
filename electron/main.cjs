/* ===========================================================================
 * MEERA V2 — Unified Electron Main Process
 * ========================================================================= */

'use strict';

const { app, BrowserWindow, desktopCapturer, ipcMain, screen, session, dialog, shell } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

// Performance and Audio switches
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.setName('MEERA');

// --- Constants & Paths ------------------------------------------------------
const SERVER_PORT = 3000;
const SERVER_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;
const APP_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..');
const SERVER_ENTRY = path.join(APP_ROOT, 'dist', 'server.cjs');

let win = null;
let menuWin = null;
let dragOrigin = null;
let avatarScale = 1;
let serverProcess = null;
let isQuitting = false;

// Companion Window Size
const COMPANION_WIDTH = 280;
const COMPANION_HEIGHT = 360;

// Taskbar & Position reference
const REFERENCE_FILE = path.join(app.getPath('userData'), 'meera_position.json');
let REFERENCE = { x: 1000, y: 500, width: COMPANION_WIDTH, height: COMPANION_HEIGHT };
try {
  if (fs.existsSync(REFERENCE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(REFERENCE_FILE, 'utf8'));
    if (typeof saved.x === 'number') REFERENCE.x = saved.x;
    if (typeof saved.y === 'number') REFERENCE.y = saved.y;
  }
} catch (_) {}

function getStartupPosition(width = COMPANION_WIDTH, height = COMPANION_HEIGHT) {
  return {
    x: REFERENCE.x,
    y: REFERENCE.y,
  };
}

function positionOnTaskbar() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setBounds({ x: REFERENCE.x, y: REFERENCE.y, width: COMPANION_WIDTH, height: COMPANION_HEIGHT });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.showInactive();
}

// --- Backend Process Management --------------------------------------------
function isBackendRunning() {
  return new Promise((resolve) => {
    const req = http.get(SERVER_ORIGIN + '/api/agent-health', (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startBackend() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    console.warn(`[Electron] dist/server.cjs not found; skipping internal backend boot.`);
    return;
  }

  const dataDir = app.getPath('userData');
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    ELECTRON_RUN_AS_NODE: '1',
    MEERA_LAUNCHED_BY: 'electron',
    MEERA_DATA_DIR: dataDir,
    MEERA_APP_ROOT: APP_ROOT,
    MYRAA_LAUNCHED_BY: 'electron',
    MYRAA_DATA_DIR: dataDir,
    MYRAA_APP_ROOT: APP_ROOT,
  };

  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  serverProcess.stdout?.on('data', (d) => process.stdout.write(`[Server] ${d}`));
  serverProcess.stderr?.on('data', (d) => process.stderr.write(`[Server Error] ${d}`));
  serverProcess.on('exit', (code, signal) => {
    if (!isQuitting) {
      console.warn(`[Server] Exited with code ${code}, signal ${signal}`);
    }
  });
}

async function replaceExistingBackend() {
  try {
    const response = await fetch(`${SERVER_ORIGIN}/api/agent-health`, { signal: AbortSignal.timeout(1200) });
    const health = await response.json();
    if (health.pid && Number(health.pid) !== process.pid) {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(health.pid), '/T', '/F'], { windowsHide: true });
        killer.once('close', resolve);
        setTimeout(resolve, 5000);
      });
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  } catch (_) {
    // Port is unused; startBackend will create the backend below.
  }
}

function stopBackend() {
  if (serverProcess && !serverProcess.killed) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F']);
      } else {
        serverProcess.kill('SIGTERM');
      }
    } catch (_) {}
    serverProcess = null;
  }
}

// --- Companion Window ------------------------------------------------------
function createWindow() {
  const startupPosition = getStartupPosition(COMPANION_WIDTH, COMPANION_HEIGHT);

  win = new BrowserWindow({
    width: COMPANION_WIDTH,
    height: COMPANION_HEIGHT,
    x: startupPosition.x,
    y: startupPosition.y,
    frame: false,
    transparent: true,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[Renderer] ${message} (${sourceId}:${line})`);
  });

  win.loadFile(path.join(APP_ROOT, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    positionOnTaskbar();
    setTimeout(() => positionOnTaskbar(), 120);
  });
}

// --- Wizard Window & Management --------------------------------------------
const wizardPages = new Set(['menu', 'settings', 'recall', 'share', 'mcp']);
const WIZARD_SIZE = { width: 440, height: 420 };

function wizardFile(page) {
  return path.join(APP_ROOT, 'renderer', `${page}.html`);
}

async function requestMeera(route, options) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await fetch(`${SERVER_ORIGIN}${route}`, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`MEERA request failed (${response.status}).`);
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

function getShareSources() {
  return desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
}

function configureWizard(window) {
  const contents = window.webContents;
  const sessionInstance = contents.session;
  let page = 'menu';
  let navigating = false;
  let selection;

  function isPage(frame, expected) {
    return frame && !contents.isDestroyed() && frame === contents.mainFrame
      && page === expected && frame.url === pathToFileURL(wizardFile(expected)).href;
  }

  async function navigate(target) {
    if (navigating) return;
    navigating = true;
    selection = undefined;
    page = target;
    try {
      await window.loadFile(wizardFile(target));
    } finally {
      navigating = false;
    }
    if (target === 'share' && !contents.isDestroyed() && page === 'share') {
      void contents.executeJavaScript('window.startScreenPreview()', true).catch(() => {});
    }
  }

  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  contents.ipc.on('meera:wizard-page', (event, target) => {
    const frame = event.senderFrame;
    if (!isPage(frame, page) || typeof target !== 'string'
      || !wizardPages.has(target) || target === page) return;
    if (page !== 'menu' && target !== 'menu') return;
    void navigate(target).catch((error) => {
      if (!window.isDestroyed()) console.error('Could not open Wizard page:', error.message);
    });
  });

  function handle(channel, owner, handler) {
    contents.ipc.handle(channel, (event, ...args) => {
      if (!isPage(event.senderFrame, owner)) throw new Error('Wizard page changed.');
      return handler(...args);
    });
  }

  handle('meera:recall-list', 'recall', () => requestMeera('/api/memories'));
  handle('meera:recall-add', 'recall', (category, text) => {
    if (!['identity', 'preference', 'goal', 'project', 'relationship', 'emotional', 'behavior', 'practice'].includes(category)
      || typeof text !== 'string' || !text.trim()) throw new Error('Invalid recollection.');
    return requestMeera('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, text: text.trim() }),
    });
  });
  handle('meera:recall-remove', 'recall', (id) => {
    if (typeof id !== 'string' || !/^[a-z0-9_-]+$/i.test(id)) throw new Error('Invalid recollection ID.');
    return requestMeera(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
  });

  handle('meera:mcp-health', 'mcp', () => requestMeera('/api/agent-health'));
  handle('meera:mcp-list', 'mcp', () => requestMeera('/api/mcp/list'));
  handle('meera:mcp-start', 'mcp', (id) => requestMeera(`/api/mcp/${encodeURIComponent(id)}/start`, { method: 'POST' }));
  handle('meera:mcp-stop', 'mcp', (id) => requestMeera(`/api/mcp/${encodeURIComponent(id)}/stop`, { method: 'POST' }));
  handle('meera:mcp-restart', 'mcp', (id) => requestMeera(`/api/mcp/${encodeURIComponent(id)}/restart`, { method: 'POST' }));
  handle('meera:whatsapp-link-status', 'mcp', () => requestMeera('/api/mcp/whatsapp/status'));
  handle('meera:whatsapp-delink', 'mcp', () => requestMeera('/api/mcp/whatsapp/delink', { method: 'POST' }));
  handle('meera:whatsapp-start', 'mcp', () => requestMeera('/api/mcp/whatsapp/start', { method: 'POST' }));
  handle('meera:whatsapp-stop', 'mcp', () => requestMeera('/api/mcp/whatsapp/stop', { method: 'POST' }));
  handle('meera:whatsapp-restart', 'mcp', () => requestMeera('/api/mcp/whatsapp/restart', { method: 'POST' }));
  // WhatsApp is owned exclusively by the backend MCP manager. Electron only proxies UI actions to it.
  handle('meera:whatsapp-mcp-status', 'mcp', () => requestMeera('/api/mcp/whatsapp/status'));
  handle('meera:whatsapp-mcp-start', 'mcp', () => requestMeera('/api/mcp/whatsapp/start', { method: 'POST' }));
  handle('meera:whatsapp-mcp-stop', 'mcp', () => requestMeera('/api/mcp/whatsapp/stop', { method: 'POST' }));
  handle('meera:whatsapp-mcp-restart', 'mcp', () => requestMeera('/api/mcp/whatsapp/restart', { method: 'POST' }));

  handle('meera:share-sources', 'share', async () => {
    return (await getShareSources()).map(({ id, name }) => ({ id, name }));
  });
  handle('meera:select-screen', 'share', (id) => {
    if (typeof id !== 'string') return false;
    selection = { id, expires: Date.now() + 5000 };
    return true;
  });

  sessionInstance.setDisplayMediaRequestHandler(async (request, respond) => {
    let chosen = selection;
    selection = undefined;
    if (!chosen || chosen.expires < Date.now() || !isPage(request.frame, 'share')
      || !request.videoRequested || request.audioRequested) {
      // Fallback: if user clicked Switch or userGesture was lost during async IPC, grab first valid screen
      const sources = await getShareSources();
      if (sources.length > 0) {
        const video = (chosen && sources.find((s) => s.id === chosen.id)) || sources[0];
        respond(video && isPage(request.frame, 'share') ? { video } : {});
        return;
      }
      respond({});
      return;
    }
    try {
      const sources = await getShareSources();
      const video = sources.find((source) => source.id === chosen.id) || sources[0];
      respond(video && isPage(request.frame, 'share') ? { video } : {});
    } catch {
      respond({});
    }
  });

  window.on('closed', () => sessionInstance.setDisplayMediaRequestHandler(null));
  return navigate('menu');
}

// --- Continuous Background Screen Vision Engine ----------------------------
let screenVisionInterval = null;
let isScreenVisionActive = false;
let isScreenVisionPaused = false;   // Both blind (Pause button)
let isAiBlindOnly = false;           // AI only blind (Toggle switch)
let selectedScreenSourceId = null;

async function captureScreenAndStream() {
  if (!isScreenVisionActive || isScreenVisionPaused) return;
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 960, height: 540 },
    });
    if (!sources || sources.length === 0) return;
    let chosen = sources[0];
    if (selectedScreenSourceId) {
      const match = sources.find((s) => s.id === selectedScreenSourceId);
      if (match) chosen = match;
    }
    const base64Jpeg = chosen.thumbnail.toJPEG(55).toString('base64');
    // Only forward frame to Meera AI brain if AI is NOT blind
    if (!isAiBlindOnly && win && !win.isDestroyed()) {
      win.webContents.send('meera:video-frame', base64Jpeg);
    }
    // Mirror to Wizard preview if open
    if (menuWin && !menuWin.isDestroyed()) {
      menuWin.webContents.send('meera:screen-preview-frame', base64Jpeg);
    }
  } catch (err) {
    console.warn('[Screen Vision] Capture error:', err);
  }
}

function startScreenVision(sourceId) {
  selectedScreenSourceId = sourceId || null;
  isScreenVisionActive = true;
  isScreenVisionPaused = false;
  isAiBlindOnly = false;
  if (screenVisionInterval) clearInterval(screenVisionInterval);
  screenVisionInterval = setInterval(captureScreenAndStream, 2000);
  setTimeout(captureScreenAndStream, 150);
  console.log('[Screen Vision] Continuous Vision Mode ACTIVATED');
}

function pauseScreenVision(paused) {
  isScreenVisionPaused = Boolean(paused);
  console.log('[Screen Vision] Pause state (Both blind):', isScreenVisionPaused);
}

function setAiBlind(blind) {
  isAiBlindOnly = Boolean(blind);
  console.log('[Screen Vision] AI Blind state (Meera only blind):', isAiBlindOnly);
}

function stopScreenVision() {
  isScreenVisionActive = false;
  isScreenVisionPaused = false;
  isAiBlindOnly = false;
  if (screenVisionInterval) {
    clearInterval(screenVisionInterval);
    screenVisionInterval = null;
  }
  console.log('[Screen Vision] Continuous Vision Mode STOPPED');
}

// --- IPC Messaging ---------------------------------------------------------
ipcMain.on('meera:close', () => {
  isQuitting = true;
  stopScreenVision();
  app.quit();
});

ipcMain.on('meera:start-vision', (_event, sourceId) => {
  startScreenVision(sourceId);
});

ipcMain.on('meera:pause-vision', (_event, paused) => {
  pauseScreenVision(paused);
});

ipcMain.on('meera:set-ai-blind', (_event, blind) => {
  setAiBlind(blind);
});

ipcMain.on('meera:stop-vision', () => {
  stopScreenVision();
});

ipcMain.handle('meera:get-vision-state', () => {
  return { active: isScreenVisionActive, paused: isScreenVisionPaused, aiBlind: isAiBlindOnly };
});

ipcMain.on('meera:ready-to-show', () => {
  if (win && !win.isDestroyed()) win.setOpacity(1);
});

ipcMain.on('meera:send-video-frame', (_event, base64) => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('meera:video-frame', base64);
  }
});

ipcMain.on('meera:toggle-menu', () => {
  if (menuWin && !menuWin.isDestroyed()) {
    menuWin.close();
    return;
  }
  if (!win || win.isDestroyed()) return;

  const bounds = win.getBounds();
  const { width: wizardWidth, height: wizardHeight } = WIZARD_SIZE;
  const { workArea } = screen.getDisplayMatching(bounds);

  // Place Wizard comfortably to the left of Meera (or screen right side)
  let wizardX = Math.round(bounds.x - wizardWidth - 15);
  if (wizardX < workArea.x + 20) {
    wizardX = Math.round(bounds.x + bounds.width + 15);
  }
  wizardX = Math.max(workArea.x + 20, Math.min(wizardX, workArea.x + workArea.width - wizardWidth - 20));

  let wizardY = Math.round(workArea.y + workArea.height - wizardHeight - 20);

  const wizard = new BrowserWindow({
    x: wizardX,
    y: wizardY,
    width: wizardWidth,
    height: wizardHeight,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      partition: 'meera-wizard',
      preload: path.join(__dirname, 'wizard-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  menuWin = wizard;
  wizard.setAlwaysOnTop(true, 'screen-saver');

  wizard.on('closed', () => {
    if (menuWin === wizard) {
      menuWin = null;
    }
  });

  void configureWizard(wizard).catch((error) => {
    if (!wizard.isDestroyed()) console.error('Could not open Wizard:', error.message);
  });
});

// --- Purple Desktop Notification Popup Window (Native HTML/Electron) -------
let activeNotificationWin = null;

function showNotificationPopup(title, message, duration = 6) {
  try {
    if (activeNotificationWin && !activeNotificationWin.isDestroyed()) {
      activeNotificationWin.close();
      activeNotificationWin = null;
    }

    const primaryDisplay = screen.getPrimaryDisplay();
    const workArea = primaryDisplay.workArea; // 1440x860
    const cardWidth = 360;
    const cardHeight = 130;

    const notifX = Math.round(workArea.x + workArea.width - cardWidth - 20);
    const notifY = Math.round(workArea.y + workArea.height - cardHeight - 20);

    const notifWin = new BrowserWindow({
      x: notifX,
      y: notifY,
      width: cardWidth,
      height: cardHeight,
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    activeNotificationWin = notifWin;
    notifWin.setAlwaysOnTop(true, 'screen-saver');

    const url = new URL(pathToFileURL(path.join(APP_ROOT, 'renderer', 'notification.html')).href);
    url.searchParams.set('title', title || 'MEERA Alert');
    url.searchParams.set('message', message || '');
    url.searchParams.set('duration', String(duration || 6));

    notifWin.loadURL(url.href);
    notifWin.showInactive();

    notifWin.on('closed', () => {
      if (activeNotificationWin === notifWin) {
        activeNotificationWin = null;
      }
    });
  } catch (err) {
    console.error('[Electron Notification] Error displaying card:', err);
  }
}

ipcMain.on('meera:show-notification', (_event, { title, message, duration }) => {
  showNotificationPopup(title, message, duration);
});

ipcMain.on('meera:drag-start', (_event, point) => {
  if (win) {
    const bounds = win.getBounds();
    dragOrigin = { x: point.x, y: point.y, windowX: bounds.x, windowY: bounds.y };
  }
});

ipcMain.on('meera:drag-move', (_event, point) => {
  if (win && dragOrigin) {
    const newX = Math.round(dragOrigin.windowX + point.x - dragOrigin.x);
    const newY = Math.round(dragOrigin.windowY + point.y - dragOrigin.y);
    win.setPosition(newX, newY);
  }
});

ipcMain.on('meera:drag-end', () => {
  dragOrigin = null;
  if (win && !win.isDestroyed()) {
    const b = win.getBounds();
    REFERENCE.x = b.x;
    REFERENCE.y = b.y;
    try {
      fs.writeFileSync(REFERENCE_FILE, JSON.stringify({ x: b.x, y: b.y }, null, 2), 'utf8');
      console.log(`[Electron] Saved Meera position: X=${b.x}, Y=${b.y}`);
    } catch (_) {}
  }
});

ipcMain.on('meera:set-ignore-mouse', (event, ignore) => {
  if (win && !win.isDestroyed() && event.sender === win.webContents) {
    if (process.platform === 'win32') {
      win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
    } else {
      // On Linux/X11, passing forward: true often breaks mouse input entirely.
      // Simply toggling ignore state allows direct native clicks and drags.
      win.setIgnoreMouseEvents(Boolean(ignore));
    }
  }
});

ipcMain.on('meera:resize', () => {
  // Legacy resize handler: companion window preserves user's last saved drag position
});

// --- App Bootstrap ---------------------------------------------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      // Reload UI so hot updates apply immediately if user runs npm start again
      win.webContents.reloadIgnoringCache();
    }
  });

  app.whenReady().then(async () => {
    // Disable HTTP cache in development so CSS/JS changes reflect immediately
    session.defaultSession.clearCache().catch(() => {});
    session.defaultSession.setPermissionCheckHandler(() => true);
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(true));

    // Always replace an existing backend so an old/orphan build cannot serve stale MCP logic.
    await replaceExistingBackend();
    console.log('[Electron] Starting current background MEERA server...');
    startBackend();

    createWindow();
  });
}

app.on('window-all-closed', (event) => event.preventDefault());

app.on('before-quit', () => {
  isQuitting = true;
  stopBackend();
});
