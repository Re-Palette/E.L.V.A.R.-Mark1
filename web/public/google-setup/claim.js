// Runs on the page Google returns to (/api/google/callback). If this is the same browser as the app, finish the connection right here;
// otherwise (the system browser / a Custom Tab) the app finishes it when you go back to it. No inline script: the page has a strict CSP.
(async () => {
  const $ = (id) => document.getElementById(id);
  let state = '';
  try { const u = new URL(location.href); state = u.searchParams.get('state') || ''; history.replaceState(null, '', u.pathname); } catch { /* ignore */ }   // the code / state do not stay in the address bar
  let token = ''; try { token = localStorage.getItem('elvar_device_token') || ''; } catch { /* ignore */ }
  if (!state || !token) return;
  try {
    const r = await fetch('/api/elvar/connect/google/claim', { method: 'POST', headers: { 'content-type': 'application/json', 'x-elvar-token': token }, body: JSON.stringify({ state }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok && (j.claimed || j.state === 'connected')) { $('st').textContent = '連携が完了しました。'; $('more').textContent = 'このタブは閉じて、アプリに戻ってください。'; }
    else if (r.ok && j.ok === false) { $('st').className = 'warn'; $('st').textContent = j.message || '連携を完了できませんでした。'; }
  } catch { /* the app will claim it */ }
})();
