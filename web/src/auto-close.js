// Screens that ELVAR opens by itself (家計, プロジェクト管理, システムチェック, API接続状況) close again ~5 s after the explanation has finished,
// unless the owner operated the screen (click / tap, key). Scrolling and hovering are only reading and do not cancel it — then it stays until the owner closes it. Screens the owner opened himself are never armed.
const DEFAULTS = { delayMs: 5000, maxWaitMs: 25000 };

/** The decision logic, with an injectable clock (tested). `live` needs: modelSpeaking, stretchActive, state, pendingTools, userSpoke, lastModelAudioAt (performance.now() time base). */
export function createAutoCloseController({ live, now = () => performance.now(), delayMs = DEFAULTS.delayMs, maxWaitMs = DEFAULTS.maxWaitMs }) {
  let item = null;   // { close, armedAt, quietSince, engaged }
  const delay = () => (typeof delayMs === 'function' ? delayMs() : delayMs);
  const busy = () => !!(live.modelSpeaking || live.stretchActive || live.state === 'thinking' || live.pendingTools > 0);
  return {
    arm(close) { disarm(); item = { close, armedAt: now(), quietSince: null, engaged: false }; return item; },
    /** The owner touched the screen: it stays. */
    engage() { if (item) item.engaged = true; },
    disarm,
    /** Call a few times a second. @returns {'idle'|'wait'|number|'closed'} number = seconds left on the countdown */
    tick() {
      if (!item) return 'idle';
      if (item.engaged) { item = null; return 'idle'; }
      const t = now();
      if (live.userSpoke) { item.armedAt = t; item.quietSince = null; return 'wait'; }          // the owner is talking (a follow-up question): wait for the next explanation
      const spokeSince = (live.lastModelAudioAt || 0) > item.armedAt;                              // the explanation has started (and, below, finished)
      if (busy() || (!spokeSince && t - item.armedAt < maxWaitMs) || (spokeSince && t - (live.lastModelAudioAt || 0) < 1200)) { item.quietSince = null; return 'wait'; }
      item.quietSince ??= t;
      const left = delay() - (t - item.quietSince);
      if (left > 0) return Math.ceil(left / 1000);
      const c = item.close; item = null; try { c(); } catch (e) { console.warn('[auto-close]', e?.message ?? e); } return 'closed';
    },
    get armed() { return !!item; },
  };
  function disarm() { item = null; }
}

/** Wires the controller to the page: interaction listeners on the screen, a ticking loop, and a small "closing in N s" chip. */
export function createAutoClose({ live, store, delayMs }) {
  const on = () => { try { return store?.get?.('elvar_autoclose') !== '0'; } catch { return true; } };
  const secs = () => { const n = Number(store?.get?.('elvar_autoclose_s')); return n >= 2 && n <= 60 ? n * 1000 : (delayMs || DEFAULTS.delayMs); };
  const ctl = createAutoCloseController({ live, delayMs: secs });
  let chip = null, listenersOn = null;
  const ensureChip = () => { if (chip) return chip; chip = document.createElement('div'); chip.setAttribute('role', 'status');
    chip.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:70;padding:5px 14px;border:1px solid rgba(25,211,255,.7);border-radius:14px;background:rgba(1,14,30,.95);color:#8fe3ff;font:13px "Noto Sans JP","Yu Gothic UI",sans-serif;display:none;box-shadow:0 0 10px rgba(25,190,255,.35)'; document.body.appendChild(chip); return chip; };
  const hideChip = () => { if (chip) chip.style.display = 'none'; };
  function detach() { if (listenersOn) { for (const ev of ['click', 'keydown', 'focusin']) listenersOn.el.removeEventListener(ev, listenersOn.fn, true); listenersOn = null; } }
  const timer = setInterval(() => {
    const r = ctl.tick();
    if (typeof r === 'number') { const c = ensureChip(); c.textContent = `あと ${r} 秒で閉じます（画面を操作すると、残ります）`; c.style.display = 'block'; }
    else { hideChip(); if (r === 'closed' || r === 'idle') detach(); }
  }, 250);
  return {
    /** @param {{close:()=>void, el?:HTMLElement}} screen  Call when ELVAR (a tool), not the owner, has opened the screen. */
    arm({ close, el }) {
      if (!on()) return;
      detach(); hideChip();
      const it = ctl.arm(() => { hideChip(); detach(); close(); });
      if (el) { const fn = () => { ctl.engage(); hideChip(); }; for (const ev of ['click', 'keydown', 'focusin']) el.addEventListener(ev, fn, true); listenersOn = { el, fn }; }   // only a click / key counts as operating: scrolling and hovering are reading
      return it;
    },
    disarm() { ctl.disarm(); hideChip(); detach(); },
    stop() { clearInterval(timer); },
  };
}
