// Exposes a tiny, fixed API to the page (context isolation stays on).
const { contextBridge, ipcRenderer } = require('electron');
const tokenArg = process.argv.find((a) => a.startsWith('--elvar-token='));
contextBridge.exposeInMainWorld('elvarDesktop', {
  isDesktop: true,
  accessToken: tokenArg ? tokenArg.slice('--elvar-token='.length) : '',
  /** Ask the OS to put the HUD window in front of everything, right now. */
  bringToFront: () => ipcRenderer.send('elvar:bring-to-front'),
});
