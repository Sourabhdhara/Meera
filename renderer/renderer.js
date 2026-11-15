const companion = document.querySelector('#companion');

// Realistic 3D Ground & Contact Shadow Surface
const groundContainer = document.createElement('div');
groundContainer.id = 'meera-ground';
groundContainer.innerHTML = `
  <div class="ground-shadow-blur"></div>
  <div class="ground-shadow-medium"></div>
  <div class="ground-contact-left"></div>
  <div class="ground-contact-right"></div>
  <div class="ground-glass-rim"></div>
`;
companion.appendChild(groundContainer);

// Standing GIF element (Meera Companion)
const meeraGif = document.createElement('img');
meeraGif.id = 'meera-gif';
meeraGif.alt = 'Meera Standing';
meeraGif.draggable = false;
meeraGif.src = '../assets/animations/standing-listening.gif';
companion.appendChild(meeraGif);

let isTalking = false;

// Core appearance switcher (Speaking vs Listening GIF)
function updateAppearance() {
  const standingSource = isTalking
    ? '../assets/animations/standing-speaking.gif'
    : '../assets/animations/standing-listening.gif';

  if (!meeraGif.src.endsWith(standingSource)) {
    meeraGif.src = standingSource;
  }
}

// Initial setup
companion.dataset.state = 'disconnected';
updateAppearance();

async function applyAnimationPreference() {
  const cachedCharacterTheme = localStorage.getItem('meera.characterTheme');
  if (cachedCharacterTheme) document.body.dataset.theme = cachedCharacterTheme;
  try {
    const res = await fetch('http://127.0.0.1:3000/api/settings', { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const settings = await res.json();
      document.body.classList.toggle('animations-disabled', settings.animations === false);
      const characterTheme = settings.characterTheme || settings.theme;
      if (characterTheme) {
        document.body.dataset.theme = characterTheme;
        localStorage.setItem('meera.characterTheme', characterTheme);
        if (!settings.characterTheme && settings.theme) {
          fetch('http://127.0.0.1:3000/api/settings', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ characterTheme: settings.theme })
          }).catch(() => {});
        }
      }
    }
  } catch {}
}
applyAnimationPreference();

// Ignore mouse clicks on transparent parts (handles mouse enter/leave on avatar cleanly)
meeraGif.addEventListener('mouseenter', () => {
  window.meera?.setIgnoreMouse(false);
});
meeraGif.addEventListener('mouseleave', () => {
  if (!dragging) {
    window.meera?.setIgnoreMouse(true);
  }
});
document.addEventListener('mousemove', (event) => {
  if (dragging) return;
  const isOverAvatar = event.target === meeraGif;
  window.meera?.setIgnoreMouse(!isOverAvatar);
});

// Live WebSocket Audio & Brain Client
let liveClient = null;
if (typeof MeeraLiveClient !== 'undefined') {
  liveClient = new MeeraLiveClient({
    onStateChange: (state) => {
      console.log('[Meera State]:', state);
      window.meeraAnimation.setState(state);
    },
    onTranscription: (role, text) => {
      console.log(`[Meera Transcription] ${role}: ${text}`);
    },
    onError: (err) => {
      console.warn('[Meera Error]:', err);
    }
  });

  // Startup initially awakened
  const startInitial = () => {
    liveClient.connect();
  };
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', startInitial);
  } else {
    startInitial();
  }

  // Ensure AudioContext is fully resumed on any user touch/click gesture
  window.addEventListener('pointerdown', () => {
    if (liveClient?.outputAudioCtx?.state === 'suspended') {
      liveClient.outputAudioCtx.resume().catch(() => {});
    }
    if (liveClient?.inputAudioCtx?.state === 'suspended') {
      liveClient.inputAudioCtx.resume().catch(() => {});
    }
  }, { passive: true });

  window.meera?.onVideoFrame?.((base64) => {
    liveClient?.sendVideoFrame(base64);
  });
}
window.meeraLiveClient = liveClient;

// Double click, single click (awaken/sleep), right click and dragging handlers
let lastRightClick = 0;
let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
let hasDragged = false;
const DRAG_THRESHOLD = 6; // px

meeraGif.addEventListener('dblclick', (event) => {
  event.preventDefault();
  window.meera.toggleMenu();
});

meeraGif.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const now = Date.now();
  if (now - lastRightClick < 450) {
    // Double right-click -> close app
    lastRightClick = 0;
    window.meera.close();
    return;
  }
  lastRightClick = now;

  // Single right-click -> toggle awaken / sleep
  setTimeout(() => {
    if (lastRightClick === now && !hasDragged) {
      liveClient?.toggleAwaken();
    }
  }, 280);
});

let lastDragX = 0;

meeraGif.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return; // Only drag on primary (left) button
  dragging = true;
  hasDragged = false;
  dragStartX = event.screenX;
  dragStartY = event.screenY;
  lastDragX = event.screenX;
  meeraGif.setPointerCapture(event.pointerId);
  meeraGif.classList.add('is-dragging');
  window.meera.dragStart(event.screenX, event.screenY);
});

meeraGif.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  const dx = Math.abs(event.screenX - dragStartX);
  const dy = Math.abs(event.screenY - dragStartY);
  if (!hasDragged && (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD)) {
    hasDragged = true;
  }
  if (hasDragged) {
    const deltaX = event.screenX - lastDragX;
    if (deltaX > 2) {
      meeraGif.classList.add('tilt-right');
      meeraGif.classList.remove('tilt-left');
    } else if (deltaX < -2) {
      meeraGif.classList.add('tilt-left');
      meeraGif.classList.remove('tilt-right');
    }
    lastDragX = event.screenX;
    window.meera.dragMove(event.screenX, event.screenY);
  }
});

function endDrag() {
  dragging = false;
  hasDragged = false;
  meeraGif.classList.remove('is-dragging', 'tilt-left', 'tilt-right');
  window.meera.dragEnd();
}

meeraGif.addEventListener('pointerup', (event) => {
  meeraGif.releasePointerCapture(event.pointerId);
  endDrag();
});

meeraGif.addEventListener('pointercancel', () => {
  endDrag();
});

// Public animation control API
window.meeraAnimation = {
  setScale(scale) {
    const s = `${Math.max(150, Math.min(330, scale))}px`;
    meeraGif.style.width = s;
  },
  setState(state) {
    isTalking = (state === 'talking' || state === 'speaking');
    companion.dataset.state = state;
    updateAppearance();
  }
};
