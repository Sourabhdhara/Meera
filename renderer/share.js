const preview = document.querySelector('#preview');
const placeholder = document.querySelector('#preview-placeholder');
const status = document.querySelector('#share-status');
const stop = document.querySelector('#stop');
const pause = document.querySelector('#pause');
const switchScreen = document.querySelector('#switch');
const pausedBanner = document.querySelector('#paused-banner');
const visionTitle = document.querySelector('#vision-title');
const indicator = document.querySelector('#vision-indicator');
const visionToggle = document.querySelector('#vision-toggle');
const visionDesc = document.querySelector('#vision-desc');

let stream = null;
let sources = [];
let selectedIndex = 0;
let isContinuousActive = false;
let isPaused = false;     // Both blind (Pause button)
let isAiBlind = false;    // AI only blind (Toggle switch)

function showStatus(message, state = '') {
  status.textContent = message;
  status.className = state;
}

function updateUIState(active, paused, aiBlind = isAiBlind) {
  isContinuousActive = active;
  isPaused = paused;
  isAiBlind = aiBlind;

  if (active) {
    stop.disabled = false;
    pause.disabled = false;
    pause.textContent = paused ? 'Resume' : 'Pause';
    pause.setAttribute('aria-pressed', String(paused));
    pausedBanner.hidden = !paused;

    if (paused) {
      indicator.className = 'paused';
      visionTitle.textContent = 'Screen vision paused (Both blind)';
      showStatus('Screen vision paused completely.', 'paused');
    } else if (isAiBlind) {
      indicator.className = 'ai-blind';
      visionTitle.textContent = 'Preview live · AI Blind';
      showStatus('AI vision off (Private mode). Preview active.', 'warning');
    } else {
      indicator.className = 'active';
      visionTitle.textContent = 'Screen vision active';
      showStatus('Screen vision active in background.', 'live');
    }

    if (visionToggle) visionToggle.checked = !isAiBlind;
  } else {
    stop.disabled = true;
    pause.disabled = true;
    pause.textContent = 'Pause';
    pause.setAttribute('aria-pressed', 'false');
    pausedBanner.hidden = true;
    indicator.className = '';
    visionTitle.textContent = 'Screen vision ready';
    showStatus('Screen vision ready.');
  }
}

async function startLocalPreview(index) {
  switchScreen.disabled = pause.disabled = stop.disabled = true;
  showStatus('Starting preview…');
  try {
    const sourceId = sources[index]?.id;
    if (sourceId) {
      await window.screenPreview.select(sourceId);
    }

    if (stream) {
      try {
        stream.getTracks().forEach((track) => track.stop());
      } catch (_) {}
      stream = null;
    }

    const nextStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    stream = nextStream;

    preview.srcObject = stream;
    await preview.play();
    preview.hidden = false;
    placeholder.hidden = true;
    selectedIndex = index;

    // Start background streaming in Main Process (continues even when Wizard closes!)
    window.screenPreview.startVision(sourceId);
    updateUIState(true, false);
  } catch (err) {
    console.error('[Screen Share] Start preview error:', err);
    placeholder.textContent = 'Could not start screen preview.';
    placeholder.hidden = false;
    preview.hidden = true;
    showStatus('Screen preview could not start.', 'error');
    updateUIState(false, false);
  } finally {
    switchScreen.disabled = sources.length < 2;
  }
}

async function checkInitialVisionState() {
  try {
    sources = await window.screenPreview.list();
    const state = await window.screenPreview.getVisionState();

    if (state && state.active) {
      updateUIState(true, state.paused, state.aiBlind);
      placeholder.textContent = 'Screen vision active in background.';
      // Start local preview for current session
      await startLocalPreview(0);
    } else {
      updateUIState(false, false, false);
      // Auto-start preview on first page visit if displays available
      if (sources.length) {
        await startLocalPreview(0);
      } else {
        placeholder.textContent = 'No displays found.';
        showStatus('No displays found.', 'error');
      }
    }
  } catch (e) {
    console.warn('[Screen Share] Init error:', e);
  }
}

// When main process streams frames, display can also be mirrored if needed
window.screenPreview.onPreviewFrame((base64) => {
  // Active frame heartbeat
  if (!isPaused && isContinuousActive) {
    indicator.className = 'active';
  }
});

// Controls
switchScreen.addEventListener('click', (event) => {
  if (sources.length > 1) {
    const nextIdx = (selectedIndex + 1) % sources.length;
    void startLocalPreview(nextIdx);
  }
});

pause.addEventListener('click', () => {
  isPaused = !isPaused;
  if (preview) {
    if (isPaused) preview.pause();
    else preview.play().catch(() => {});
  }
  // PAUSE BUTTON: Both blind (freeze preview + pause background capture)
  window.screenPreview.pauseVision(isPaused);
  updateUIState(isContinuousActive, isPaused, isAiBlind);
});

// Explicit STOP button: Only this completely shuts down screen vision!
stop.addEventListener('click', () => {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  preview.srcObject = null;
  preview.hidden = true;
  placeholder.hidden = false;
  placeholder.textContent = 'Screen vision stopped.';

  window.screenPreview.stopVision();
  updateUIState(false, false, false);
  window.wizard.navigate('menu');
});

if (visionToggle) {
  visionToggle.addEventListener('change', () => {
    // TOGGLE SWITCH: AI Only Blind (Preview stays LIVE, Meera blind)
    isAiBlind = !visionToggle.checked;
    window.screenPreview.setAiBlind(isAiBlind);
    updateUIState(isContinuousActive, isPaused, isAiBlind);
  });
}

document.querySelector('#close').addEventListener('click', () => window.close());

// NOTE: Unlike before, pagehide and beforeunload DO NOT kill the vision stream!
// Meera continues to see your screen in the background until you hit "Stop"!
window.addEventListener('pagehide', () => {
  // Only stop local camera rendering track inside this closed window; background Main Process continues!
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
});

void checkInitialVisionState();
