// Exposes a tiny, fixed API to the page (context isolation stays on).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('elvarDesktop', {
  isDesktop: true,
  // A device token (elv1....) or, in env mode, the shared access token, from the main process (environment, our origin only).
  // Used as the x-elvar-token header by web/src/elvar/auth.js when this device has not signed in itself.
  accessToken: (() => { try { return ipcRenderer.sendSync('elvar:token') || ''; } catch { return ''; } })(),
  /** Ask the OS to put the HUD window in front of everything, right now. */
  bringToFront: () => ipcRenderer.send('elvar:bring-to-front'),
  /** Open Google's consent screen in the system browser (the main process refuses any other URL). */
  openExternal: (url) => ipcRenderer.send('elvar:open-external', String(url)),
});
