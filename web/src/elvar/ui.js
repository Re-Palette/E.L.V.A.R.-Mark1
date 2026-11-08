// Shared look of the ELVAR overlays (setup wizard, sign-in, settings): the gold HUD palette (web/src/hud/hud.css) on near-black,
// bevelled panels with a metal edge, Cinzel for titles and Barlow / Noto Sans JP for text.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const UI_CSS = `
.ev-back{--g:#E8B96A;--gh:#FFD99A;--gd:#8A5A20;--txt:#f6efe2;--sub:#b99b6a;--warn:#ff7a4a;--ok:#9fe3a8;
  position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;
  background:radial-gradient(ellipse 60% 50% at 50% 40%,rgba(150,96,36,.22),transparent 70%),rgba(4,3,2,.94);
  -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);color:var(--txt);
  font:15px/1.65 'Barlow Semi Condensed','Noto Sans JP','Hiragino Sans','Yu Gothic UI','Meiryo',sans-serif;animation:ev-in .18s ease-out}
.ev-back *{box-sizing:border-box}
.ev-back[hidden]{display:none}
@keyframes ev-in{from{opacity:0}to{opacity:1}}
.ev-frame{--c:20px;width:min(640px,100%);max-height:94vh;display:flex;padding:1.5px;
  clip-path:polygon(var(--c) 0,calc(100% - var(--c)) 0,100% var(--c),100% calc(100% - var(--c)),calc(100% - var(--c)) 100%,var(--c) 100%,0 calc(100% - var(--c)),0 var(--c));
  background:linear-gradient(135deg,var(--gh),var(--gd) 28%,var(--g) 52%,#5a3a14 74%,var(--gh));
  filter:drop-shadow(0 0 14px rgba(232,185,106,.28))}
.ev-frame.wide{width:min(780px,100%)}
.ev-panel{--c:19px;flex:1;min-width:0;overflow:auto;padding:24px 28px 26px;
  clip-path:polygon(var(--c) 0,calc(100% - var(--c)) 0,100% var(--c),100% calc(100% - var(--c)),calc(100% - var(--c)) 100%,var(--c) 100%,0 calc(100% - var(--c)),0 var(--c));
  background:radial-gradient(ellipse 80% 40% at 50% 0,rgba(232,185,106,.08),transparent 70%),linear-gradient(180deg,#15100a,#080604 60%,#0b0806)}
.ev-head{display:flex;align-items:center;gap:12px;margin-bottom:4px}
.ev-head i{width:8px;height:8px;transform:rotate(45deg);background:var(--g);box-shadow:0 0 6px rgba(244,168,58,.8)}
.ev-title{margin:0;font:400 21px/1.2 'Cinzel','Times New Roman',serif;letter-spacing:6px;color:var(--gh);text-shadow:0 0 8px rgba(255,200,120,.35)}
.ev-sub{margin:2px 0 0;color:var(--sub);font-size:13px;letter-spacing:1.5px}
.ev-x{margin-left:auto;background:none;border:1px solid rgba(232,185,106,.5);color:var(--g);padding:3px 13px;cursor:pointer;font:inherit;font-size:13px;
  clip-path:polygon(6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%,0 6px)}
.ev-x:hover{background:rgba(232,185,106,.14);color:var(--gh)}
.ev-steps{display:flex;gap:6px;margin:14px 0 4px}
.ev-steps span{flex:1;height:3px;background:rgba(232,185,106,.18)}
.ev-steps span.on{background:linear-gradient(90deg,var(--gd),var(--gh));box-shadow:0 0 6px rgba(244,168,58,.5)}
.ev-steps span.done{background:var(--gd)}
.ev-sec{margin-top:18px;padding-top:12px;border-top:1px solid rgba(232,185,106,.18)}
.ev-sec:first-of-type{border-top:0;padding-top:4px}
.ev-sec>h3,.ev-h3{margin:0 0 10px;font:600 12.5px/1.4 'Barlow Semi Condensed','Noto Sans JP',sans-serif;letter-spacing:2.6px;color:var(--g)}
.ev-p{margin:6px 0;color:#e9dcc4}
.ev-note{margin:6px 0 0;font-size:12.5px;color:var(--sub)}
.ev-field{display:flex;flex-direction:column;gap:4px;margin:10px 0}
.ev-field>span{font-size:13px;color:#e9dcc4;letter-spacing:.5px}
.ev-row{display:flex;align-items:center;gap:12px;margin:8px 0;flex-wrap:wrap}
.ev-row>span.l{flex:0 0 10.5em;color:#e9dcc4;font-size:14px}
.ev-input,.ev-select,.ev-area{width:100%;background:#0d0a06;color:var(--txt);border:1px solid rgba(232,185,106,.38);padding:9px 11px;font:inherit;outline:none;border-radius:0;
  clip-path:polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px)}
.ev-area{min-height:5.5em;resize:vertical}
.ev-input:focus,.ev-select:focus,.ev-area:focus{border-color:var(--gh);box-shadow:inset 0 0 0 1px rgba(255,217,154,.35);background:#120e08}
.ev-input::placeholder{color:#6f5a3c}
.ev-check{display:flex;gap:10px;align-items:flex-start;margin:8px 0;cursor:pointer}
.ev-check input{width:18px;height:18px;margin-top:3px;accent-color:#E8B96A;flex:none}
.ev-btns{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px;align-items:center}
.ev-btn{background:transparent;color:var(--g);border:1px solid rgba(232,185,106,.7);padding:8px 20px;cursor:pointer;font:600 14px/1.2 'Barlow Semi Condensed','Noto Sans JP',sans-serif;letter-spacing:1.5px;
  clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px)}
.ev-btn:hover:not(:disabled){background:rgba(232,185,106,.14);color:var(--gh)}
.ev-btn.pri{background:linear-gradient(180deg,var(--gh),var(--g) 45%,#b07a32);color:#1a1006;border-color:var(--gh)}
.ev-btn.pri:hover:not(:disabled){filter:brightness(1.08);color:#120a02}
.ev-btn.sm{padding:4px 12px;font-size:13px}
.ev-btn.danger{color:#ffb08a;border-color:rgba(255,122,74,.6)}
.ev-btn:disabled{opacity:.4;cursor:default}
.ev-spacer{flex:1}
.ev-msg{min-height:1.4em;font-size:13.5px;color:var(--sub);margin-top:10px}
.ev-msg.warn{color:var(--warn)}.ev-msg.ok{color:var(--ok)}
.ev-chip{display:inline-block;padding:1px 9px;font-size:12px;letter-spacing:1px;border:1px solid rgba(232,185,106,.45);color:var(--g)}
.ev-chip.ok{border-color:rgba(159,227,168,.55);color:var(--ok)}.ev-chip.off{color:var(--sub);border-color:rgba(185,155,106,.35)}
.ev-code{font:600 22px/1.2 'Barlow Semi Condensed',monospace;letter-spacing:6px;text-transform:uppercase;text-align:center}
.ev-kv{display:grid;grid-template-columns:1fr auto;gap:6px 14px;align-items:center}
.ev-key{padding:10px 0;border-bottom:1px solid rgba(232,185,106,.12)}
.ev-key:last-child{border-bottom:0}
.ev-key .nm{color:var(--txt);font-size:14.5px}.ev-key .st{font-size:12.5px;color:var(--sub)}
.ev-tabs{display:flex;gap:2px;flex-wrap:wrap;margin:14px 0 2px;border-bottom:1px solid rgba(232,185,106,.25)}
.ev-tab{background:none;border:0;color:var(--sub);padding:7px 14px;cursor:pointer;font:600 13.5px/1.2 'Barlow Semi Condensed','Noto Sans JP',sans-serif;letter-spacing:1.6px;border-bottom:2px solid transparent;margin-bottom:-1px}
.ev-tab:hover{color:var(--gh)}
.ev-tab.on{color:var(--gh);border-bottom-color:var(--g);text-shadow:0 0 6px rgba(255,200,120,.35)}
.ev-pane[hidden]{display:none}
.ev-grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}
.ev-device{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(232,185,106,.12)}
.ev-device .nm{flex:1}.ev-device small{color:var(--sub)}
@media (max-width:560px){.ev-panel{padding:18px 16px 20px}.ev-row>span.l{flex:1 0 100%}.ev-grid2{grid-template-columns:1fr}.ev-title{font-size:18px;letter-spacing:4px}}
`;

let injected = false;
export function ensureUiCss() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style'); s.id = 'elvar-ui-css'; s.textContent = UI_CSS; document.head.appendChild(s);
}

/** A full-screen gold overlay. Returns { back, panel, close() }. */
export function overlay({ title, sub = '', wide = false, closable = false, label = title, onClose } = {}) {
  ensureUiCss();
  const back = document.createElement('div');
  back.className = 'ev-back'; back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true'); back.setAttribute('aria-label', label);
  back.innerHTML = `<div class="ev-frame${wide ? ' wide' : ''}"><div class="ev-panel">
    <div class="ev-head"><i></i><div><h2 class="ev-title">${esc(title)}</h2>${sub ? `<p class="ev-sub">${esc(sub)}</p>` : ''}</div>${closable ? '<button class="ev-x" type="button" data-x>閉じる</button>' : ''}</div>
    <div data-body></div></div></div>`;
  document.body.appendChild(back);
  const close = () => { back.remove(); onClose?.(); };
  if (closable) back.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) close(); });
  return { back, panel: back.querySelector('[data-body]'), close };
}
