const API = 'http://127.0.0.1:3000';
const tabs = document.querySelectorAll('[data-tab]');
const controls = document.querySelectorAll('[data-setting]');
const edited = new Set();
const feedback = document.querySelector('#settings-feedback');
const health = document.querySelector('#health');

async function request(route, options) {
  const response = await fetch(API + route, {
    signal: AbortSignal.timeout(8000),
    ...options,
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

function post(body) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function showFeedback(message, error = false) {
  feedback.textContent = message;
  feedback.classList.toggle('error', error);
  feedback.hidden = !message;
}

function applyAnimationPreference(enabled) {
  document.body.classList.toggle('animations-disabled', enabled === false);
}

async function loadSettings() {
  try {
    const saved = await request('/api/settings');
    for (const control of controls) {
      const key = control.dataset.setting;
      if (edited.has(key)) continue;
      const value = saved[key];
      if (key === 'animations') applyAnimationPreference(value !== false);
      if (control.type === 'checkbox') {
        if (typeof value === 'boolean') control.checked = value;
      } else if (typeof value === (control.type === 'range' ? 'number' : 'string')) {
        control.value = value;
      }
    }
  } catch {
    if (!edited.size) showFeedback('Could not load saved settings. Showing defaults.', true);
  }
}

async function loadHealth() {
  health.textContent = 'Checking agent…';
  health.classList.remove('offline');
  try {
    const status = await request('/api/agent-health');
    health.classList.toggle('offline', !status.online);
    health.textContent = status.online
      ? `Agent online · ${status.tool_count ?? 0} tools registered`
      : 'Desktop engine offline';
  } catch {
    health.classList.add('offline');
    health.textContent = 'Could not reach the desktop agent.';
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    const selected = tab.dataset.tab;
    for (const button of tabs) {
      const active = button === tab;
      button.setAttribute('aria-pressed', String(active));
      document.getElementById(button.dataset.tab).hidden = !active;
    }
    document.querySelector('#content').scrollTop = 0;
    if (selected === 'system') void loadHealth();
  });
}

for (const control of controls) {
  const key = control.dataset.setting;
  control.addEventListener('input', () => edited.add(key));
  control.addEventListener('change', async () => {
    edited.add(key);
    let value = control.value;
    if (control.type === 'checkbox') value = control.checked;
    if (control.type === 'range') value = control.valueAsNumber;

    control.disabled = true;
    try {
      await request('/api/settings', post({ [key]: value }));
      if (key === 'animations') applyAnimationPreference(value);
      showFeedback('Preference saved.');
    } catch {
      showFeedback('Could not save this preference.', true);
    } finally {
      control.disabled = false;
    }
  });
}

document.querySelector('#api-key-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = document.querySelector('#key');
  const saveButton = form.querySelector('button');
  const apiKey = input.value.trim();
  if (!apiKey) return;

  input.disabled = saveButton.disabled = true;
  try {
    await request('/api/config/apikey', post({ apiKey }));
    input.value = '';
    showFeedback('Gemini API key saved.');
  } catch {
    showFeedback('Could not save the Gemini API key.', true);
  } finally {
    input.disabled = saveButton.disabled = false;
  }
});

document.querySelector('#close').addEventListener('click', () => window.close());
void loadSettings();
