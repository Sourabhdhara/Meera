const { contextBridge, ipcRenderer } = require('electron');

const page = location.pathname.split('/').pop();
contextBridge.exposeInMainWorld('wizard', {
  navigate: (target) => ipcRenderer.send('meera:wizard-page', target),
});

if (page === 'recall.html') {
  contextBridge.exposeInMainWorld('recall', {
    list: () => ipcRenderer.invoke('meera:recall-list'),
    add: (category, text) => ipcRenderer.invoke('meera:recall-add', category, text),
    remove: (id) => ipcRenderer.invoke('meera:recall-remove', id),
  });
}

if (page === 'share.html') {
  contextBridge.exposeInMainWorld('screenPreview', {
    list: () => ipcRenderer.invoke('meera:share-sources'),
    select: (id) => ipcRenderer.invoke('meera:select-screen', id),
    sendFrame: (base64) => ipcRenderer.send('meera:send-video-frame', base64),
    startVision: (sourceId) => ipcRenderer.send('meera:start-vision', sourceId),
    pauseVision: (paused) => ipcRenderer.send('meera:pause-vision', paused),
    setAiBlind: (blind) => ipcRenderer.send('meera:set-ai-blind', blind),
    stopVision: () => ipcRenderer.send('meera:stop-vision'),
    getVisionState: () => ipcRenderer.invoke('meera:get-vision-state'),
    onPreviewFrame: (callback) => ipcRenderer.on('meera:screen-preview-frame', (_event, frame) => callback(frame)),
  });
}

if (page === 'mcp.html') {
  contextBridge.exposeInMainWorld('desktopAgent', {
    health: () => ipcRenderer.invoke('meera:mcp-health'),
    mcpList: () => ipcRenderer.invoke('meera:mcp-list'),
    mcpStart: (id) => ipcRenderer.invoke('meera:mcp-start', id),
    mcpStop: (id) => ipcRenderer.invoke('meera:mcp-stop', id),
    mcpRestart: (id) => ipcRenderer.invoke('meera:mcp-restart', id),
    whatsappLinkStatus: () => ipcRenderer.invoke('meera:whatsapp-link-status'),
    whatsappDelink: () => ipcRenderer.invoke('meera:whatsapp-delink'),
    whatsappStart: () => ipcRenderer.invoke('meera:whatsapp-start'),
    whatsappStop: () => ipcRenderer.invoke('meera:whatsapp-stop'),
    whatsappRestart: () => ipcRenderer.invoke('meera:whatsapp-restart'),
    whatsappStatus: () => ipcRenderer.invoke('meera:whatsapp-mcp-status'),
  });
}
