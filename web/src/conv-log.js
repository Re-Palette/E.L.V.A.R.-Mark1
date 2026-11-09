// Records every conversation turn (the user's words and the assistant's replies, as transcribed) in the user's own conversation log on the server
// (POST /api/elvar/messages: short-term memory, kept for the retention the user chose in Settings > 記憶).
// Turns are queued on this device and sent in batches (every 4 minutes, when a conversation ends, when the page is hidden); a failed send is retried later.
// The server masks secrets (keys, passwords, card numbers) before anything is stored. Off with the setting 「この端末の会話を記録する」.
const QKEY = 'elvar_conv_queue', ON = 'elvar_conv_log';
const read = () => { try { const j = JSON.parse(localStorage.getItem(QKEY) || '[]'); return Array.isArray(j) ? j : []; } catch { return []; } };
const write = (q) => { try { localStorage.setItem(QKEY, JSON.stringify(q.slice(-200))); } catch {} };
export const convLogOn = (get = (k) => { try { return localStorage.getItem(k); } catch { return null; } }) => get(ON) !== '0';

/** Drops what must not be logged: system notes, empty turns. Pure (tested). */
export function loggable(turn) {
  const user = String(turn?.user || '').trim(), model = String(turn?.model || '').trim();
  if (!user && !model) return null;
  if (/^\[システム\]/.test(user)) return null;
  return { user, model, at: Number(turn.at) || Date.now() };
}

export function initConvLog({ live, authHeaders = () => live.authHeaders?.() || {}, hudLive, intervalMs = 240_000, isOn = convLogOn, fetchImpl = (...a) => fetch(...a) }) {
  let busy = false, failures = 0;
  async function flush({ force = false } = {}) {
    if (busy) return false;
    const q = read(); if (!q.length) return true;
    if (!isOn() || window.__elvarDeviceLocked && !force) return false;
    busy = true;
    try {
      const batch = q.slice(0, 40);
      const res = await fetchImpl('/api/elvar/messages', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify({ turns: batch, channel: 'voice' }) });
      const r = res.ok ? await res.json().catch(() => null) : null;
      if (!r || !r.written) { failures++; if (failures === 3) try { hudLive?.logActivity({ icon: 'gear', title: '会話を記録できません', sub: 'ログインし直してください' }); } catch {} return false; }
      failures = 0; write(read().slice(batch.length)); return true;
    } catch (e) { failures++; return false; }
    finally { busy = false; }
  }
  live.onTurn = (t) => { if (!isOn()) return; const l = loggable(t); if (!l) return; write([...read(), l]); if (read().length >= 12) flush(); };
  const prevIdle = live.onIdle; live.onIdle = () => { try { prevIdle?.(); } catch {} flush(); };
  setInterval(() => flush(), intervalMs);
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  setTimeout(() => flush(), 20_000);   // anything left from the last session
  return { flush, pending: () => read().length };
}
