const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('meera', {
  close: () => ipcRenderer.send('meera:close'),
  toggleMenu: () => ipcRenderer.send('meera:toggle-menu'),
  resize: (direction) => ipcRenderer.send('meera:resize', direction),
  dragStart: (x, y) => ipcRenderer.send('meera:drag-start', { x, y }),
  dragMove: (x, y) => ipcRenderer.send('meera:drag-move', { x, y }),
  dragEnd: () => ipcRenderer.send('meera:drag-end'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('meera:set-ignore-mouse', ignore),
  onMenuState: (callback) => ipcRenderer.on('meera:menu-state', (_event, value) => callback(value)),
  onVideoFrame: (callback) => ipcRenderer.on('meera:video-frame', (_event, value) => callback(value)),
  showNotification: (title, message, duration) => ipcRenderer.send('meera:show-notification', { title, message, duration }),
  readyToShow: () => ipcRenderer.send('meera:ready-to-show'),
});
