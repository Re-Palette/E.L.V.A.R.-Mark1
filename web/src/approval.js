// Approval card for Google write actions. Nothing is executed unless the owner presses 承認.
// - the default focus is 却下, so Enter can never approve by accident; Esc rejects; no click-outside action
// - high-danger actions (send / delete / share) get an amber frame and say so
// - unanswered for 2 minutes -> rejected automatically (the server ticket expires at the same time)
const TIMEOUT_MS = 120_000;
/** What the owner said, as an answer to a confirmation: 'yes' | 'no' | 'edit' | null. Strict on purpose: only short, plain answers count. Pure (tested). */
export function classifyReply(text) {
  const t = String(text || '').replace(/[\s。、．，,.!！?？「」『』〜~-]+/g, '').toLowerCase();
  if (!t || t.length > 18) return null;
  if (/^(いいえ|やめて|やめる|やめます|やめとく|キャンセル|だめ|ダメ|中止|違う|ちがう|依頼しない|送らない)/.test(t)) return 'no';
  if (/(直して|修正|変更|ちょっと待って|待って|違うんだけど|やり直し)/.test(t)) return 'edit';
  if (/^(はい|ええ|うん|おねがい|お願い|依頼(して|します)|送って|送信(して|します)|了解|了承|承認|ok|オーケー|いいよ|いいです|それで(お願い|いい|おk)|大丈夫(です)?|問題ありません)((して)?(ください|下さい)|します|いたします|です)?$/.test(t) || /^はい(お願い|依頼|送って|それで)/.test(t)) return 'yes';
  return null;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
.va-back{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;padding:16px;background:rgba(0,8,20,.78);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.va-back.on{display:flex;animation:va-in .14s ease-out}@keyframes va-in{from{opacity:0}to{opacity:1}}
.va-wrap{--ac:#19d3ff;filter:drop-shadow(0 0 10px rgba(25,190,255,.55));width:min(560px,100%);max-height:90vh}
.va-wrap.high{--ac:#ffb347;filter:drop-shadow(0 0 10px rgba(255,170,70,.55))}
.va-panel{--c:16px;background:linear-gradient(180deg,rgba(3,26,52,.98),rgba(1,14,30,.99));color:#d9eef9;max-height:90vh;overflow:auto;padding:20px 24px 22px;
  clip-path:polygon(var(--c) 0,calc(100% - var(--c)) 0,100% var(--c),100% calc(100% - var(--c)),calc(100% - var(--c)) 100%,var(--c) 100%,0 calc(100% - var(--c)),0 var(--c));
  outline:1.5px solid var(--ac);outline-offset:-1px;font:15px/1.65 'Barlow Semi Condensed','Noto Sans JP','Yu Gothic UI','Meiryo',sans-serif}
.va-top{display:flex;align-items:center;gap:10px;margin-bottom:10px}.va-top i{width:8px;height:8px;border-radius:50%;background:var(--ac);box-shadow:0 0 7px var(--ac)}
.va-top h2{margin:0;font-size:15px;letter-spacing:2.5px;color:var(--ac);font-weight:600}.va-top span{margin-left:auto;font-size:12px;color:#7fb6d6}
.va-lines{border-top:1px solid rgba(40,150,200,.35);border-bottom:1px solid rgba(40,150,200,.35);padding:10px 0;margin:6px 0 14px}
.va-lines div{white-space:pre-wrap;word-break:break-word}.va-lines div:first-child{font-weight:700;color:#fff;margin-bottom:4px}
.va-lines .warn{color:#ffb347}
.va-btns{display:flex;gap:12px;justify-content:flex-end}
.va-btn{min-width:120px;padding:9px 18px;border-radius:3px;cursor:pointer;font:inherit;font-weight:600;border:1px solid var(--ac);background:transparent;color:var(--ac)}
.va-btn:hover,.va-btn:focus-visible{background:rgba(25,211,255,.18);color:#fff;outline:none}.va-wrap.high .va-btn:hover,.va-wrap.high .va-btn:focus-visible{background:rgba(255,170,70,.2)}
.va-btn.go{background:var(--ac);color:#001428}.va-btn.go:hover{background:#fff;color:#001428}
.va-note{margin:10px 0 0;font-size:12px;color:#7fb6d6}
/* placement:'bottom' keeps the screen behind the card readable (e.g. the file preview while a print is being approved) */
.va-back.bottom{align-items:flex-end;background:transparent;-webkit-backdrop-filter:none;backdrop-filter:none;pointer-events:none;padding-bottom:max(12px,env(safe-area-inset-bottom))}
.va-back.bottom .va-wrap{pointer-events:auto}.va-back.bottom .va-panel{max-height:62vh;padding:14px 20px 16px}.va-back.bottom .va-note{display:none}.va-back.bottom .va-lines{margin:4px 0 10px;padding:6px 0;font-size:14px;line-height:1.5}
`;

export function createApproval() {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const back = document.createElement('div'); back.className = 'va-back';
  back.setAttribute('role', 'alertdialog'); back.setAttribute('aria-modal', 'true'); back.setAttribute('aria-label', '承認が必要です');
  back.innerHTML = `<div class="va-wrap"><div class="va-panel">
    <div class="va-top"><i></i><h2>承認が必要です</h2><span id="va-count"></span></div>
    <div class="va-lines" id="va-lines"></div>
    <div class="va-btns"><button class="va-btn" id="va-no" type="button">却下</button><button class="va-btn" id="va-edit" type="button" hidden>直す</button><button class="va-btn go" id="va-yes" type="button">承認して実行</button></div>
    <p class="va-note" id="va-note">「承認して実行」を押したときだけ、この内容のとおりに実行されます。</p>
  </div></div>`;
  document.body.appendChild(back);
  const $ = (id) => back.querySelector('#' + id);

  const queue = []; let current = null, timer = 0, tick = 0;
  function finish(ok) {
    if (!current) return;
    clearTimeout(timer); clearInterval(tick);
    const c = current; current = null; back.classList.remove('on');
    c.resolve(ok);
    setTimeout(next, 120);
  }
  function next() {
    if (current || !queue.length) return;
    current = queue.shift();
    const { summary, danger, voice, yes, no, edit, title, placement } = current;
    back.classList.toggle('bottom', placement === 'bottom');
    $('va-yes').textContent = yes || '承認して実行'; $('va-no').textContent = no || '却下'; $('va-edit').hidden = !edit; $('va-edit').textContent = edit || '直す';
    back.querySelector('h2').textContent = title || '承認が必要です';
    $('va-note').textContent = voice ? '「はい」と声で答えても、ボタンを押しても、この内容のとおりに実行されます（短く「はい」と言ったときだけ承認になります）。' : '「承認して実行」を押したときだけ、この内容のとおりに実行されます。';
    back.querySelector('.va-wrap').classList.toggle('high', danger === 'high');
    $('va-lines').innerHTML = (summary || []).map((l) => `<div class="${/^※/.test(l) ? 'warn' : ''}">${esc(l)}</div>`).join('');
    back.classList.add('on');
    let left = TIMEOUT_MS / 1000;
    const draw = () => { $('va-count').textContent = `${left}秒で自動的に却下`; };
    draw(); tick = setInterval(() => { left--; draw(); }, 1000);
    timer = setTimeout(() => finish(false), TIMEOUT_MS);
    $('va-no').focus();                     // default focus = reject
  }
  $('va-yes').onclick = () => finish(true);
  $('va-no').onclick = () => finish(false);
  $('va-edit').onclick = () => finish('edit');
  addEventListener('keydown', (e) => { if (current && e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); finish(false); } }, true);

  return {
    /** @returns {Promise<boolean|'edit'>} true only if the owner pressed 承認 (or, on a voice-enabled card, said a plain 「はい」) */
    ask({ id, tool, summary, danger, voice = false, yes, no, edit, title, placement }) { return new Promise((resolve) => { queue.push({ id, tool, summary, danger, voice, yes, no, edit, title, placement, resolve }); next(); }); },
    /** The owner's speech (transcript so far). Answers a voice-enabled card; ignored while the assistant is talking (its own echo must never approve). */
    hear(text, { modelBusy = false } = {}) {
      if (!current || !current.voice || modelBusy) return false;
      const r = classifyReply(text);
      if (r === 'yes') { finish(true); return true; } if (r === 'no') { finish(false); return true; } if (r === 'edit' && current.edit) { finish('edit'); return true; }
      return false;
    },
    /** The model withdrew a request: drop it (rejecting) without asking. */
    cancel(ids) {
      for (let i = queue.length - 1; i >= 0; i--) if (ids.includes(queue[i].id)) { queue[i].resolve(false); queue.splice(i, 1); }
      if (current && ids.includes(current.id)) finish(false);
    },
    get open() { return !!current; },
  };
}
