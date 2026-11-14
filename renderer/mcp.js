const content = document.querySelector('#content');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let isUpdating = false;
let isActing = false;
let lastRenderKey = '';

async function load() {
  if (isUpdating || isActing) return;
  isUpdating = true;
  try {
    const servers = await window.desktopAgent?.mcpList().catch(() => null);
    if (!Array.isArray(servers)) {
      if (!lastRenderKey) {
        content.innerHTML = `<div class="mcp-intro"><span class="eyebrow">INTEGRATIONS</span><h2>MCP Server Hub</h2><p class="status offline">Connecting to desktop agent…</p></div>`;
      }
      return;
    }
    const whatsapp = await window.desktopAgent?.whatsappLinkStatus().catch(() => ({ state: 'offline' }));

    // Create state fingerprint to avoid re-rendering DOM when data is unchanged
    const renderKey = JSON.stringify({
      servers: servers.map((s) => ({ id: s.id, running: Boolean(s.status?.running), transport: s.transport, url: s.url })),
      whatsappState: whatsapp?.state,
      whatsappQr: whatsapp?.qr
    });

    if (renderKey === lastRenderKey) {
      return;
    }
    lastRenderKey = renderKey;

    content.innerHTML = `<div class="mcp-intro"><span class="eyebrow">INTEGRATIONS</span><h2>MCP Server Hub</h2><p>Connect tools to MEERA through local or remote MCP servers.</p></div>` + servers.map((s) => {
      const isWhatsApp = s.id === 'whatsapp';
      const state = isWhatsApp ? (whatsapp?.state || 'stopped') : (s.status?.running ? 'running' : 'stopped');
      const linked = isWhatsApp && state === 'ready';
      return `<section class="mcp-card" data-id="${esc(s.id)}"><div class="mcp-card-head"><div><h2>${esc(s.name)}</h2><p class="mcp-subtitle">${esc(s.transport.toUpperCase())} <span>•</span> ${esc(isWhatsApp ? 'WhatsApp Web' : (s.url || `${s.command || ''} ${(s.args || []).join(' ')}`))}</p></div><span class="mcp-pill ${linked || (!isWhatsApp && s.status?.running) ? 'online' : 'offline'}"><i></i>${esc(state.toUpperCase())}</span></div><div class="mcp-actions"><button class="action primary" data-action="start">Start</button><button class="action" data-action="stop">Stop</button><button class="action" data-action="restart">Restart</button>${isWhatsApp ? '<button class="action danger" data-action="delink">Delink</button>' : ''}</div>${isWhatsApp && state === 'qr_required' ? `<p class="mcp-hint">Scan this QR code with WhatsApp:</p><pre class="mcp-qr">${esc(whatsapp.qr || 'Waiting for QR…')}</pre>` : ''}</section>`;
    }).join('');
  } catch (err) {
    console.warn('[MCP Hub] Load notice:', err);
  } finally {
    isUpdating = false;
  }
}

content.addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  const card = button.closest('[data-id]');
  if (!card) return;
  const id = card.dataset.id;
  if (!id) return;

  const action = button.dataset.action;
  isActing = true;
  button.disabled = true;
  button.textContent = action === 'delink' ? 'Delinking…' : (action === 'start' ? 'Starting…' : (action === 'stop' ? 'Stopping…' : 'Restarting…'));

  // Disable sibling buttons on this card to prevent conflicting duplicate commands
  const cardButtons = card.querySelectorAll('.mcp-actions button');
  cardButtons.forEach((btn) => { btn.disabled = true; });

  try {
    if (action === 'delink') {
      if (confirm('Delink WhatsApp and remove the saved session?')) {
        await window.desktopAgent.whatsappDelink();
      }
    } else if (id === 'whatsapp') {
      const fnName = `whatsapp${action[0].toUpperCase()}${action.slice(1)}`;
      if (typeof window.desktopAgent[fnName] === 'function') {
        await window.desktopAgent[fnName]();
      }
    } else {
      const fnName = `mcp${action[0].toUpperCase()}${action.slice(1)}`;
      if (typeof window.desktopAgent[fnName] === 'function') {
        await window.desktopAgent[fnName](id);
      }
    }
  } catch (err) {
    console.error('[MCP Action Error]:', err);
  } finally {
    isActing = false;
    lastRenderKey = ''; // Force refresh
    await load();
  }
});

document.querySelector('#close').addEventListener('click', () => window.close());
void load();
const pollTimer = setInterval(() => { void load(); }, 1500);
window.addEventListener('beforeunload', () => clearInterval(pollTimer));
