// Runs only on the E.L.V.A.R. site(s) you allowed. Relays ONE message type from the page to the extension.
document.documentElement.dataset.elvarExtension = '1';
window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin) return;               // only this very page
  const d = e.data;
  if (d && d.source === 'elvar-hud' && d.type === 'bring-to-front') {
    try { chrome.runtime.sendMessage({ type: 'bring-to-front' }); } catch { /* extension reloaded */ }
  }
});
