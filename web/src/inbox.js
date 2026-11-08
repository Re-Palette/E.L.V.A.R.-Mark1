// 通知欄 (notification center): reports and notifications ELVAR itself produces — finished sub-agent jobs, finished work (documents, builds / Pull Requests),
// predictive alerts — collect here, newest first. A new item opens the panel by itself for a while and a small bell (bottom-left) shows the unread count.
// Kept on this device only (localStorage). Texts are the short summaries that were already shown / spoken; nothing secret is added.
const KEY = 'elvar_inbox', MAX = 40;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const KINDS = { report: ['報告', '#19d3ff'], deliverable: ['完成品', '#5ee08a'], build: ['製作', '#a78bfa'], alert: ['注意', '#ffb347'], notice: ['お知らせ', '#7fb6d6'] };
const CSS = `
.vi-panel{position:fixed;right:14px;top:84px;z-index:56;width:min(380px,calc(100vw - 28px));max-height:min(70vh,520px);display:none;flex-direction:column;background:linear-gradient(180deg,rgba(3,26,52,.98),rgba(1,14,30,.99));color:#d9eef9;border:1.5px solid rgba(30,166,216,.9);border-radius:6px;box-shadow:0 0 18px rgba(25,190,255,.4);font:13.5px/1.5 'Barlow Semi Condensed','Noto Sans JP',sans-serif}
.vi-panel.on{display:flex;animation:va-in .14s ease-out}.vi-top{display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid rgba(40,150,200,.4)}.vi-top h2{margin:0;font-size:13px;letter-spacing:2px;color:#8fe3ff;font-weight:600}.vi-top .sp{margin-left:auto}
.vi-btn{background:transparent;color:#8fe3ff;border:1px solid rgba(25,211,255,.55);border-radius:3px;padding:2px 9px;cursor:pointer;font:inherit;font-size:12px}.vi-btn:hover{background:rgba(25,211,255,.2);color:#fff}
.vi-list{overflow:auto;padding:6px 8px;min-height:0}.vi-item{border:1px solid rgba(40,150,200,.3);border-left:3px solid var(--c,#19d3ff);border-radius:3px;padding:5px 9px;margin:5px 0;background:rgba(25,211,255,.04)}.vi-item.read{opacity:.6}
.vi-h{display:flex;gap:6px;align-items:baseline}.vi-tag{font-size:11px;color:var(--c,#19d3ff);border:1px solid currentColor;border-radius:8px;padding:0 6px}.vi-time{margin-left:auto;font-size:11px;color:#7fb6d6}.vi-t{font-weight:600;color:#fff;margin:2px 0}
.vi-b{color:#cfe6f3;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;word-break:break-word}.vi-act{margin-top:4px;display:flex;gap:6px}.vi-empty{color:#7fb6d6;padding:14px 8px;text-align:center}
`;
const read = () => { try { const j = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(j) ? j : []; } catch { return []; } };
const write = (l) => { try { localStorage.setItem(KEY, JSON.stringify(l.slice(0, MAX))); } catch {} };
export const ago = (at, now = Date.now()) => { const m = Math.floor((now - at) / 60000); return m < 1 ? 'いま' : m < 60 ? `${m}分前` : m < 1440 ? `${Math.round(m / 60)}時間前` : `${Math.round(m / 1440)}日前`; };
/** Pure (tested): add one item to a list — newest first, the same key replaces the old one (an updated build is one item, not many), capped. */
export function pushItem(list, item, now = Date.now()) {
  const it = { id: `${now}-${Math.random().toString(36).slice(2, 6)}`, at: now, kind: KINDS[item.kind] ? item.kind : 'notice', title: String(item.title || '').slice(0, 80), body: String(item.body || '').slice(0, 600), url: item.url || '', notePath: item.notePath || '', key: item.key || '', read: false };
  if (!it.title) return list;
  return [it, ...list.filter((x) => !(it.key && x.key === it.key))].slice(0, MAX);
}

export function initInbox({ openNote = () => {}, autoOpenMs = 20000 } = {}) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const panel = document.createElement('div'); panel.className = 'vi-panel'; panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', '通知欄');
  panel.innerHTML = '<div class="vi-top"><h2>通知欄</h2><span class="sp"></span><button class="vi-btn" data-allread type="button">すべて既読</button><button class="vi-btn" data-clear type="button">消す</button><button class="vi-btn" data-x type="button">閉じる</button></div><div class="vi-list"></div>';
  document.body.append(panel);
  const listEl = panel.querySelector('.vi-list');
  const bellBtn = () => document.querySelector('[data-vh-nav="bell"]');
  function badgeEl() { const b = bellBtn(); if (!b) return null; let e = b.querySelector('.vi-badge'); if (!e) { e = document.createElement('i'); e.className = 'vi-badge'; e.hidden = true; b.appendChild(e); } return e; }
  let items = read(), timer = 0, touched = false;
  function render() {
    const unread = items.filter((i) => !i.read).length;
    const badge = badgeEl(); if (badge) { badge.hidden = !unread; badge.textContent = unread > 9 ? '9+' : String(unread); }
    listEl.innerHTML = items.length ? items.map((i) => { const [lab, col] = KINDS[i.kind]; return `<div class="vi-item ${i.read ? 'read' : ''}" style="--c:${col}" data-id="${esc(i.id)}"><div class="vi-h"><span class="vi-tag">${lab}</span><span class="vi-time">${ago(i.at)}</span></div><div class="vi-t">${esc(i.title)}</div>${i.body ? `<div class="vi-b">${esc(i.body)}</div>` : ''}<div class="vi-act">${i.notePath ? '<button class="vi-btn" data-note type="button">ノートを開く</button>' : ''}${i.url ? '<button class="vi-btn" data-url type="button">開く</button>' : ''}${i.read ? '' : '<button class="vi-btn" data-read type="button">既読</button>'}</div></div>`; }).join('') : '<div class="vi-empty">新しい通知・報告はありません</div>';
  }
  const save = () => { write(items); render(); };
  function open({ auto = false } = {}) {
    panel.classList.add('on'); touched = !auto; render(); clearTimeout(timer);
    if (auto && autoOpenMs > 0) timer = setTimeout(() => { if (!touched) panel.classList.remove('on'); }, autoOpenMs);
  }
  const close = () => { panel.classList.remove('on'); clearTimeout(timer); };
  panel.addEventListener('pointerdown', () => { touched = true; }, true); panel.addEventListener('mouseenter', () => { touched = true; });
  document.addEventListener('click', (e) => { if (e.target.closest?.('[data-vh-nav="bell"]')) { e.preventDefault(); panel.classList.contains('on') ? close() : open(); } }, true);
  panel.addEventListener('click', (e) => {
    const t = e.target, row = t.closest('.vi-item'), it = row && items.find((x) => x.id === row.dataset.id);
    if (t.closest('[data-x]')) close();
    else if (t.closest('[data-allread]')) { items.forEach((i) => { i.read = true; }); save(); }
    else if (t.closest('[data-clear]')) { items = []; save(); }
    else if (it && t.closest('[data-read]')) { it.read = true; save(); }
    else if (it && t.closest('[data-note]')) { it.read = true; save(); try { openNote(it.notePath); } catch {} }
    else if (it && t.closest('[data-url]')) { it.read = true; save(); try { window.open(it.url, '_blank', 'noopener'); } catch {} }
  });
  setInterval(() => { if (panel.classList.contains('on')) render(); }, 60_000);
  render();
  return {
    /** a new report / notification: stored, and the panel shows it (opened by itself, then tucked away unless touched) */
    add(item) { const before = items; items = pushItem(items, item); if (items === before) return; write(items); if (item.quiet) render(); else open({ auto: true }); },
    open, close, get items() { return items; }, get unread() { return items.filter((i) => !i.read).length; }, el: panel,
  };
}
