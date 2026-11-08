// "資料" (document) card: shown after the voice model creates a PDF. Open / download / save to Google Drive (Drive goes through the approval card).
// In the Android app the page is a WebView, which cannot download blobs: it hands the file to the app (window.ElvarAndroid.saveFile).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CSS = `
.vd{position:fixed;left:50%;bottom:max(14px,env(safe-area-inset-bottom));transform:translateX(-50%);z-index:44;width:min(520px,calc(100% - 24px));display:none;
  background:linear-gradient(180deg,rgba(3,26,52,.98),rgba(1,14,30,.99));color:#d9eef9;border:1.5px solid rgba(30,166,216,.9);border-radius:6px;padding:12px 14px;
  box-shadow:0 0 14px rgba(25,190,255,.45);font:14.5px/1.5 'Barlow Semi Condensed','Noto Sans JP','Yu Gothic UI','Meiryo',sans-serif}
.vd.on{display:block;animation:vs-in .16s ease-out}
.vd-t{display:flex;align-items:center;gap:8px;margin-bottom:4px}.vd-t b{color:#8fe3ff;letter-spacing:2px;font-size:12.5px;font-weight:600}
.vd-name{font-weight:700;color:#fff;word-break:break-all}.vd-sub{color:#7fb6d6;font-size:12.5px;margin-bottom:8px}.vd-msg{color:#1ee8c0;font-size:13px;min-height:1.2em;word-break:break-all}.vd-msg.warn{color:#ffb347}
.vd-b{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.vd-b button,.vd-b a{background:transparent;color:#8fe3ff;border:1px solid rgba(25,211,255,.7);border-radius:3px;padding:5px 14px;cursor:pointer;font:inherit;text-decoration:none}
.vd-b button:hover,.vd-b a:hover{background:rgba(25,211,255,.2);color:#fff}.vd-b button:disabled{opacity:.4;cursor:default}.vd-b .pri{background:rgba(25,211,255,.22)}.vd-x{margin-left:auto}
`;
export const toBase64 = (bytes) => { let s = ''; const CH = 0x8000; for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH)); return btoa(s); };

export function createDocCard() {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const el = document.createElement('div'); el.className = 'vd'; el.setAttribute('role', 'status'); document.body.appendChild(el);
  let url = '';
  const native = () => !!(window.ElvarAndroid && window.ElvarAndroid.saveFile);
  function close() { el.classList.remove('on'); if (url) { URL.revokeObjectURL(url); url = ''; } }

  /** @param {{name:string, bytes:Uint8Array, pages:number, onDrive?:()=>Promise<{ok:boolean, message:string, link?:string}>, onSave?:()=>Promise<{ok:boolean, message:string}>}} d */
  function show(d) {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(new Blob([d.bytes], { type: 'application/pdf' }));
    el.innerHTML = `<div class="vd-t"><b>DOCUMENT</b></div><div class="vd-name">📄 ${esc(d.name)}</div>
      <div class="vd-sub">${d.pages} ページ・${Math.max(1, Math.round(d.bytes.length / 1024))} KB</div><div class="vd-msg"></div>
      <div class="vd-b">${native() ? '' : '<button class="pri" data-open type="button">開く</button>'}<button ${native() ? 'class="pri"' : ''} data-save type="button">${native() ? '端末に保存' : 'ダウンロード'}</button>
      ${d.onSave ? '<button data-lib type="button">ファイルに保存</button>' : ''}${d.onDrive ? '<button data-drive type="button">Googleドライブに保存</button>' : ''}<button class="vd-x" data-x type="button">閉じる</button></div>`;
    const msg = el.querySelector('.vd-msg'), say = (t, warn) => { msg.textContent = t; msg.className = 'vd-msg' + (warn ? ' warn' : ''); };
    el.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.x !== undefined) close();
      else if (b.dataset.open !== undefined) window.open(url, '_blank', 'noopener');
      else if (b.dataset.save !== undefined) {
        if (native()) { try { say(window.ElvarAndroid.saveFile(d.name, 'application/pdf', toBase64(d.bytes)) ? 'ダウンロードフォルダに保存しました' : '保存できませんでした', false); } catch { say('保存できませんでした', true); } }
        else { const a = document.createElement('a'); a.href = url; a.download = d.name; document.body.appendChild(a); a.click(); a.remove(); say('ダウンロードしました'); }
      } else if (b.dataset.lib !== undefined) {   // the on-device file library (nothing leaves the device)
        b.disabled = true;
        try { const r = await d.onSave(); say(r.message, !r.ok); if (!r.ok) b.disabled = false; } catch (err) { say(String(err?.message || err), true); b.disabled = false; }
      } else if (b.dataset.drive !== undefined) {
        b.disabled = true; say('承認を待っています…');
        try { const r = await d.onDrive(); say(r.message, !r.ok); if (r.link) msg.insertAdjacentHTML('beforeend', ` <a href="${esc(r.link)}" target="_blank" rel="noopener noreferrer" style="color:#19d3ff">Driveで開く</a>`); if (!r.ok) b.disabled = false; }
        catch (err) { say(String(err?.message || err), true); b.disabled = false; }
      }
    };
    el.classList.add('on');
  }
  return { show, close };
}
