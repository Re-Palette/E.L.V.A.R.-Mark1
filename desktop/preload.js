// Exposes a tiny, fixed API to the page (context isolation stays on).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('elvarDesktop', {
  isDesktop: true,
  /** Ask the OS to put the HUD window in front of everything, right now. */
  bringToFront: () => ipcRenderer.send('elvar:bring-to-front'),
  /** Sign in with Google through Supabase Auth in the system browser; the result returns through elvar://auth-callback (the main process checks the URL). */
  openAuth: (url) => ipcRenderer.send('elvar:open-auth', String(url)),
  /** Open Google's consent screen in the system browser (the main process refuses any other URL). */
  openExternal: (url) => ipcRenderer.send('elvar:open-external', String(url)),
});
