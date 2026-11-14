// Audio conversions between Web Audio PCM and Gemini Live WebSocket
function floatTo16BitPCM(input) {
  const output = new ArrayBuffer(input.length * 2);
  const view = new DataView(output);
  let offset = 0;
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return output;
}

function pcm16Base64ToFloat32(base64) {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const numSamples = Math.floor(len / 2);
  const float32 = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const low = binaryString.charCodeAt(i * 2);
    const high = binaryString.charCodeAt(i * 2 + 1);
    let sample = (high << 8) | low;
    if (sample >= 0x8000) sample -= 0x10000;
    float32[i] = sample / 32768.0;
  }
  return float32;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

class MeeraLiveClient {
  constructor(options = {}) {
    this.ws = null;
    this.inputAudioCtx = null;
    this.outputAudioCtx = null;
    this.micStream = null;
    this.micSourceNode = null;
    this.micProcessorNode = null;
    this.outputGainNode = null;
    this.nextStartTime = 0;
    this.activeSources = [];
    this.currentState = 'disconnected'; // 'disconnected' | 'connecting' | 'listening' | 'speaking'
    this.isActivated = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this._toggling = false;

    this.onStateChange = options.onStateChange || (() => {});
    this.onTranscription = options.onTranscription || (() => {});
    this.onError = options.onError || (() => {});
  }

  getState() {
    return this.currentState;
  }

  isAwake() {
    return this.currentState !== 'disconnected';
  }

  setState(state) {
    this.currentState = state;
    this.onStateChange(state);
  }

  sendVideoFrame(base64Jpeg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.currentState !== 'disconnected') {
      this.ws.send(JSON.stringify({ type: 'video', video: base64Jpeg }));
    }
  }

  async connect() {
    if (this.isActivated && this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.isActivated = true;
    this.setState('connecting');

    try {
      this.ws = new WebSocket('ws://127.0.0.1:3000/live');
      this.ws.binaryType = 'blob';

      this.ws.onopen = async () => {
        console.log('[Meera Live] Connected to backend WebSocket');
        try {
          if (!this.isActivated) return;

          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          if (!AudioContextClass) throw new Error('Web Audio API not supported');

          this.inputAudioCtx = new AudioContextClass({ sampleRate: 16000 });
          this.outputAudioCtx = new AudioContextClass({ sampleRate: 24000 });

          if (this.inputAudioCtx.state === 'suspended') await this.inputAudioCtx.resume().catch(() => {});
          if (this.outputAudioCtx.state === 'suspended') await this.outputAudioCtx.resume().catch(() => {});

          this.outputGainNode = this.outputAudioCtx.createGain();
          this.outputGainNode.connect(this.outputAudioCtx.destination);

          // Get microphone stream
          let stream;
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
          } catch (e) {
            console.warn('[Meera Live] Mic not accessible, using silent link:', e);
            stream = this.inputAudioCtx.createMediaStreamDestination().stream;
          }

          if (!this.isActivated || !this.inputAudioCtx || !this.outputAudioCtx) {
            stream.getTracks().forEach((track) => { try { track.stop(); } catch {} });
            return;
          }

          this.micStream = stream;
          this.micSourceNode = this.inputAudioCtx.createMediaStreamSource(this.micStream);
          // Smaller frames reduce the time before Gemini receives the end of a
          // spoken phrase. 1024 samples at 16 kHz is ~64 ms vs ~128 ms.
          this.micProcessorNode = this.inputAudioCtx.createScriptProcessor(1024, 1, 1);

          this.micSourceNode.connect(this.micProcessorNode);
          // Route through a zero-gain node to keep processor active without echoing mic to speakers
          const micMuteNode = this.inputAudioCtx.createGain();
          micMuteNode.gain.value = 0;
          this.micProcessorNode.connect(micMuteNode);
          micMuteNode.connect(this.inputAudioCtx.destination);

          this.micProcessorNode.onaudioprocess = (e) => {
            // Ensure speaker output buffer for mic processor is completely silent
            const outBuffer = e.outputBuffer.getChannelData(0);
            outBuffer.fill(0);

            if (this.currentState === 'disconnected' || this.currentState === 'connecting') return;

            const inputData = e.inputBuffer.getChannelData(0);

            // Calculate real-time input energy (RMS)
            let sumSquares = 0;
            for (let i = 0; i < inputData.length; i++) {
              sumSquares += inputData[i] * inputData[i];
            }
            const rms = Math.sqrt(sumSquares / inputData.length);

            // Real-Time Interruption (Barge-In):
            // When Meera is speaking, direct user speech (>= 0.028) streams through
            // to Gemini Live, triggering instant interruption so Meera stops and listens to you!
            if (this.currentState === 'speaking' && rms < 0.028) {
              return;
            }

            // While listening, keep sending quiet frames too. Gemini's server-side
            // VAD needs the silence after the last word to commit end-of-turn;
            // dropping all low-energy frames makes that detection feel delayed.

            const pcmBuffer = floatTo16BitPCM(inputData);
            const base64Audio = arrayBufferToBase64(pcmBuffer);
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ audio: base64Audio }));
            }
          };

          this.setState('listening');
        } catch (audioErr) {
          console.error('[Meera Live] Audio initialization failed:', audioErr);
          this.onError(`Audio error: ${audioErr.message}`);
          this.disconnect();
        }
      };

      this.ws.onmessage = async (event) => {
        try {
          const rawText = typeof event.data === 'string' ? event.data : await event.data.text();
          const msg = JSON.parse(rawText);
          console.log('[Meera Packet]:', msg.type);

          if (msg.type === 'error') {
            console.error('[Meera Live] Server error:', msg.error);
            this.onError(msg.error);
            this.disconnect();
            return;
          }
          if (msg.type === 'status') {
            console.log('[Meera WS Status]:', msg.status);
            if (msg.status === 'connected') {
              this.setState('listening');
            } else if (msg.status === 'reconnecting') {
              this.setState('connecting');
            } else if (msg.status === 'offline') {
              this.setState('offline');
            } else if (msg.status === 'session_closed') {
              this.disconnect();
            }
            return;
          }
          if (msg.type === 'audio' && msg.audio) {
            console.log('[Meera Audio] Received chunk, bytes:', msg.audio.length);
            this.playAudioPCMChunk(msg.audio);
          }
          if (msg.type === 'interrupted') {
            console.log('[Meera] Interrupted');
            this.handleInterruption();
          }
          if (msg.type === 'turnComplete') {
            console.log('[Meera] Turn complete');
            setTimeout(() => {
              if (this.activeSources.length === 0 && this.currentState === 'speaking') {
                this.setState('listening');
              }
            }, 100);
          }
          if (msg.type === 'transcription') {
            console.log(`[Meera Transcription] ${msg.role}: ${msg.text}`);
            this.onTranscription(msg.role, msg.text);
          }
          if (msg.type === 'notification') {
            console.log('[Meera Notification Packet]:', msg);
            if (window.meera && window.meera.showNotification) {
              window.meera.showNotification(msg.title, msg.message, msg.duration);
            }
          }
          if (msg.type === 'character_theme_changed' && msg.theme) {
            document.body.dataset.theme = msg.theme;
            localStorage.setItem('meera.characterTheme', msg.theme);
          }
          if (msg.type === 'toolCall') {
            this.handleToolCall(msg);
          }
        } catch (parseErr) {
          console.error('[Meera Live] Packet parse error:', parseErr);
        }
      };

      this.ws.onerror = (err) => {
        console.error('[Meera Live] WebSocket transport error:', err);
        // Let onclose perform the reconnect. Calling disconnect here clears
        // isActivated and prevents the retry path from ever running.
        this.setState('disconnected');
      };

      this.ws.onclose = () => {
        console.log('[Meera Live] WebSocket closed');
        this.ws = null;
        if (this.isActivated) {
          this.reconnectAttempts++;
          const delay = Math.min(6000, 1500 * Math.pow(1.5, this.reconnectAttempts - 1));
          console.log(`[Meera Live] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})...`);
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            if (this.isActivated && (this.currentState === 'disconnected' || !this.ws)) {
              this.connect();
            }
          }, delay);
        } else {
          this.disconnect();
        }
      };
    } catch (err) {
      console.error('[Meera Live] Connection error:', err);
      this.disconnect();
    }
  }

  handleToolCall(msg) {
    const { callId, name, args } = msg;
    console.log(`[Meera Live] Tool call triggered: ${name}`, args);

    if (name === 'browserOpen' || name === 'openWebsite') {
      let url = args?.url || 'https://youtube.com';
      if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
      try { window.open(url, '_blank'); } catch {}
      this.sendToolResponse(callId, name, { result: `Opened ${url} in your browser.` });
    } else if (name === 'browserSearch') {
      const q = args?.query || '';
      let url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
      if (q.toLowerCase().includes('youtube') || q.toLowerCase().includes('video')) {
        url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q.replace(/youtube|search|find|play/gi, '').trim() || q)}`;
      }
      try { window.open(url, '_blank'); } catch {}
      this.sendToolResponse(callId, name, { result: `Searching for "${q}" in your browser.` });
    } else {
      this.sendToolResponse(callId, name, { error: `Tool ${name} is handled locally.` });
    }
  }

  sendToolResponse(callId, name, output) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'toolResponse', id: callId, name, output }));
    }
  }

  handleInterruption() {
    this.activeSources.forEach((src) => {
      try { src.stop(); } catch {}
    });
    this.activeSources = [];
    this.nextStartTime = 0;
    this.setState('listening');
  }

  playAudioPCMChunk(base64Audio) {
    if (!this.outputAudioCtx || !this.outputGainNode) return;
    try {
      if (this.outputAudioCtx.state === 'suspended') {
        this.outputAudioCtx.resume().catch(() => {});
      }
      this.setState('speaking');
      const float32 = pcm16Base64ToFloat32(base64Audio);
      if (!float32 || float32.length === 0) return;

      const buffer = this.outputAudioCtx.createBuffer(1, float32.length, 24000);
      buffer.getChannelData(0).set(float32);

      const source = this.outputAudioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.outputGainNode);

      const currentTime = this.outputAudioCtx.currentTime;
      // Keep a small safety margin for network jitter without making the first
      // syllable noticeably late.
      if (this.nextStartTime < currentTime) {
        this.nextStartTime = currentTime + 0.06;
      }
      source.start(this.nextStartTime);
      this.nextStartTime += buffer.duration;

      source.onended = () => {
        const index = this.activeSources.indexOf(source);
        if (index > -1) this.activeSources.splice(index, 1);
        if (this.activeSources.length === 0 && this.currentState === 'speaking') {
          // Add a short grace period before returning to 'listening'
          // in case the next audio chunk from network is in-flight.
          setTimeout(() => {
            if (this.activeSources.length === 0 && this.currentState === 'speaking') {
              this.setState('listening');
              this.nextStartTime = 0;
            }
          }, 100);
        }
      };

      this.activeSources.push(source);
    } catch (e) {
      console.error('[Meera Live] PCM chunk playback error:', e);
    }
  }

  disconnect() {
    this.isActivated = false;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setState('disconnected');

    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => { try { track.stop(); } catch {} });
      this.micStream = null;
    }
    if (this.micProcessorNode) {
      try { this.micProcessorNode.disconnect(); } catch {}
      this.micProcessorNode = null;
    }
    if (this.micSourceNode) {
      try { this.micSourceNode.disconnect(); } catch {}
      this.micSourceNode = null;
    }
    if (this.inputAudioCtx) {
      try { this.inputAudioCtx.close(); } catch {}
      this.inputAudioCtx = null;
    }
    if (this.outputAudioCtx) {
      try { this.outputAudioCtx.close(); } catch {}
      this.outputAudioCtx = null;
    }

    this.activeSources.forEach((src) => {
      try { src.stop(); } catch {}
    });
    this.activeSources = [];
    this.nextStartTime = 0;
  }

  toggleAwaken() {
    if (this._toggling) return;
    this._toggling = true;
    setTimeout(() => { this._toggling = false; }, 350);

    if (this.isAwake()) {
      console.log('[Meera] Switching to Sleep mode...');
      this.disconnect();
    } else {
      console.log('[Meera] Awakening Meera...');
      this.connect();
    }
  }
}

window.MeeraLiveClient = MeeraLiveClient;

