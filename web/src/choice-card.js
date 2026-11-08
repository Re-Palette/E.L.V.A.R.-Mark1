import { ownerAddress } from './brand.js';
// "Question card": when ELVAR asks the owner something by voice (create a project? send the build request? make a draft?), the same question is shown
// on screen with buttons. A button press is sent to the assistant as the owner's typed answer, so it works exactly like answering aloud.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CSS = `
.vq{position:fixed;left:50%;bottom:max(160px,calc(env(safe-area-inset-bottom) + 150px));transform:translateX(-50%);z-index:46;width:min(520px,calc(100% - 24px));display:none;
  background:linear-gradient(180deg,rgba(3,26,52,.98),rgba(1,14,30,.99));color:#d9eef9;border:1.5px solid rgba(30,166,216,.9);border-radius:6px;padding:12px 14px;
  box-shadow:0 0 14px rgba(25,190,255,.45);font:15px/1.55 'Barlow Semi Condensed','Noto Sans JP','Yu Gothic UI','Meiryo',sans-serif}
.vq.on{display:block;animation:vs-in .16s ease-out}
.vq-t{display:flex;align-items:center;gap:8px;margin-bottom:4px}.vq-t b{color:#8fe3ff;letter-spacing:2px;font-size:12.5px;font-weight:600}.vq-t span{margin-left:auto;color:#7fb6d6;font-size:12px}
.vq-q{font-weight:700;color:#fff;white-space:pre-wrap;word-break:break-word}.vq-sub{color:#7fb6d6;font-size:12.5px;margin-top:2px}
.vq-b{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.vq-b button{background:transparent;color:#8fe3ff;border:1px solid rgba(25,211,255,.7);border-radius:3px;padding:7px 18px;cursor:pointer;font:inherit;font-weight:600}
.vq-b button:hover,.vq-b button:focus-visible{background:rgba(25,211,255,.2);color:#fff;outline:none}.vq-b button.pri{background:rgba(25,211,255,.24)}.vq-b .view{border-style:dashed;color:#1ee8c0;border-color:rgba(30,232,192,.7)}.vq-b .x{margin-left:auto;font-weight:400;color:#7fb6d6;border-color:rgba(127,182,214,.5)}
`;
const AUTO_HIDE_MS = 180_000;

/** @param {{onPick:(label:string)=>void, onView?:(path:string)=>void}} o */
export function createChoiceCard({ onPick, onView = () => {} }) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const el = document.createElement('div'); el.className = 'vq'; el.setAttribute('role', 'group'); el.setAttribute('aria-label', ownerAddress() + 'への質問'); document.body.appendChild(el);
  let timer = 0, shownAt = 0;
  const hide = () => { clearTimeout(timer); el.classList.remove('on'); };
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]')) { hide(); return; }
    const v = e.target.closest('[data-view]'); if (v) { try { onView(v.dataset.view); } catch (err) { console.error('[choice] view', err); } return; }   // look at the note; the question stays
    const b = e.target.closest('[data-opt]'); if (!b) return;
    const label = b.dataset.opt; hide();
    try { onPick(label); } catch (err) { console.error('[choice]', err); }
  });
  return {
    /** @param {{question:string, options:string[], viewPath?:string, viewLabel?:string}} d */
    show(d) {
      const opts = (Array.isArray(d.options) && d.options.length ? d.options : ['はい', 'いいえ']).map((x) => String(x).slice(0, 24)).slice(0, 4);
      el.innerHTML = `<div class="vq-t"><b>QUESTION</b><span>声で答えても、押しても構いません</span></div><div class="vq-q">${esc(String(d.question || '').slice(0, 300))}</div>
        <div class="vq-b">${d.viewPath ? `<button class="view" type="button" data-view="${esc(String(d.viewPath).slice(0, 200))}">📄 ${esc(String(d.viewLabel || '企画書を見る').slice(0, 20))}</button>` : ''}${opts.map((o, i) => `<button type="button" data-opt="${esc(o)}"${i === 0 ? ' class="pri"' : ''}>${esc(o)}</button>`).join('')}<button class="x" type="button" data-x>閉じる</button></div>`;
      el.classList.add('on'); shownAt = Date.now(); clearTimeout(timer); timer = setTimeout(hide, AUTO_HIDE_MS);
    },
    hide,
    /** The owner answered aloud: the card is no longer needed (called when new speech is heard after the card appeared). */
    answeredByVoice() { if (el.classList.contains('on') && Date.now() - shownAt > 2500) hide(); },
    get open() { return el.classList.contains('on'); },
  };
}
