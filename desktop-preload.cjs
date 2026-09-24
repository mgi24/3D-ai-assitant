const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aichatDesktop', Object.freeze({
  getSessionToken: () => ipcRenderer.invoke('desktop:get-session-token'),
  close: () => ipcRenderer.send('desktop:close'),
  openPoseBrowser: () => ipcRenderer.send('desktop:open-pose-browser'),
  closePoseBrowser: () => ipcRenderer.send('desktop:close-pose-browser')
}));
