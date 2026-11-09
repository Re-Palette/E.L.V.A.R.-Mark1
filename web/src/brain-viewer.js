// In-app viewer for the user's own second brain and conversation history (gold HUD style). Everything comes from the server for the signed-in user only
// (/api/elvar/notes, /api/elvar/conversations): notes can be read, edited (the old text stays as a version), trashed, restored and deleted for good, and
// conversations can be read and deleted message by message (principle 7). Opens from the HUD's folder icon, the settings panel, Ctrl+B or ?brain=1.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Small, safe Markdown renderer: everything is HTML-escaped first; only a fixed set of tags is produced. */
export function renderMarkdown(src) {
  let text = String(src ?? '').replace(/\r/g, '');
  text = text.replace(/^---\n[\s\S]*?\n---\n?/, '');                       // front matter
  const inline = (t) => {
    t = esc(t);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
    t = t.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (m, n, a) => `<a href="#" data-note="${n.trim()}">${a || n.trim()}</a>`);
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return t;
  };
  const out = []; let list = null, code = false, para = [];
  const flushP = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushL = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) { flushP(); flushL(); out.push(code ? '</pre>' : '<pre>'); code = !code; continue; }
    if (code) { out.push(esc(line) + '\n'); continue; }
    let m;
    if (!line.trim()) { flushP(); flushL(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushP(); flushL(); out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`); continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { flushP(); flushL(); out.push('<hr>'); continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { flushP(); if (list !== 'ul') { flushL(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushP(); if (list !== 'ol') { flushL(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flushP(); flushL(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    flushL(); para.push(line);
  }
  flushP(); flushL(); if (code) out.push('</pre>');
  return out.join('\n');
}

const CSS = `
.vb-back{position:fixed;inset:0;z-index:45;display:none;background:rgba(4,3,2,.9);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.vb-back.on{display:flex;animation:vs-in .16s ease-out}
.vb{display:flex;flex-direction:column;width:min(1200px,100%);height:100%;margin:0 auto;color:#f6efe2;font:15px/1.65 'Barlow Semi Condensed','Noto Sans JP','Yu Gothic UI','Meiryo',sans-serif;
  background:linear-gradient(180deg,rgba(21,16,10,.98),rgba(8,6,4,.99));outline:1.5px solid rgba(232,185,106,.9);outline-offset:-1px}
.vb-top{display:flex;align-items:center;gap:10px;padding:max(12px,env(safe-area-inset-top)) 14px 10px;border-bottom:1px solid rgba(232,185,106,.32)}
.vb-top h2{margin:0;font:400 18px/1.2 'Cinzel','Times New Roman',serif;letter-spacing:5px;color:#FFD99A;font-weight:600;white-space:nowrap}
.vb-top i{width:7px;height:7px;border-radius:50%;background:#E8B96A;box-shadow:0 0 6px #E8B96A}
.vb-btn{white-space:nowrap;background:transparent;color:#FFD99A;border:1px solid rgba(232,185,106,.6);border-radius:3px;padding:3px 12px;cursor:pointer;font:inherit;font-size:14px}
.vb-btn:hover,.vb-btn.on{background:rgba(232,185,106,.2);color:#fff}
.vb-x{margin-left:auto}
.vb-q{flex:1;min-width:0;background:#0d0a06;color:#f6efe2;border:1px solid rgba(232,185,106,.45);border-radius:3px;padding:5px 10px;font:inherit}
.vb-body{flex:1;min-height:0;display:flex;position:relative}
.vb-list{flex:0 0 300px;overflow:auto;border-right:1px solid rgba(232,185,106,.32);padding:8px 0}
.vb-doc{flex:1;min-width:0;overflow:auto;padding:16px 22px 40px}
.vb-gwrap{flex:1;min-width:0;display:none;position:relative}
.vb-gwrap canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:grab}
.vb-gnote{position:absolute;left:10px;bottom:8px;font-size:12px;color:#b99b6a;pointer-events:none}
.vb.graph .vb-doc{display:none}.vb.graph .vb-gwrap{display:block}
.vb-pjh{padding:10px 10px 4px;color:#FFD99A;font-size:12.5px;letter-spacing:2px;border-bottom:1px solid rgba(232,185,106,.25)}
.vb-pj{display:block;width:calc(100% - 12px);margin:6px;padding:8px 10px;text-align:left;background:rgba(232,185,106,.06);border:1px solid rgba(232,185,106,.4);border-radius:3px;color:#f6efe2;cursor:pointer;font:inherit}
.vb-pj:hover,.vb-pj.on{background:rgba(232,185,106,.16);border-color:rgba(232,185,106,.8)}
.vb-pj b{display:block;font-size:14.5px;font-weight:600}.vb-pj span{display:block;margin-top:3px;color:#b99b6a;font-size:12.5px;line-height:1.5}
.vb-pj i{display:inline-block;margin-right:6px;padding:0 7px;border:1px solid currentColor;border-radius:9px;font-style:normal;font-size:11.5px}
.vb-pj i.run{color:#9fe3a8}.vb-pj i.stale{color:#ffb347}.vb-pj i.new{color:#FFD99A}.vb-pj i.done{color:#7f9bb0}
.vb-fo{display:flex;align-items:center;gap:6px;width:100%;text-align:left;background:none;border:0;color:#E8B96A;padding:6px 10px;cursor:pointer;font:inherit;font-size:13px;letter-spacing:1.5px}
.vb-fo:hover{background:rgba(232,185,106,.1)}.vb-fo b{display:inline-block;width:1em;font-weight:400;color:#b99b6a}.vb-fo em{margin-left:auto;font-style:normal;color:#8a7350;font-size:12px}
.vb-n{display:block;width:100%;text-align:left;background:none;border:0;color:#e9dcc4;padding:6px 14px;cursor:pointer;font:inherit;font-size:14.5px;word-break:break-all}
.vb-n:hover{background:rgba(232,185,106,.12)}.vb-n.on{background:rgba(232,185,106,.22);color:#fff}
.vb-n small{display:block;color:#b99b6a;font-size:12px;line-height:1.4}
.vb-msg{padding:16px;color:#b99b6a;font-size:14px}.vb-msg.warn{color:#ffb347}
.vb-doc h2,.vb-doc h3,.vb-doc h4,.vb-doc h5{color:#FFD99A;margin:1.2em 0 .4em;font-weight:600}
.vb-doc h2{font-size:21px;margin-top:0}.vb-doc h3{font-size:18px}.vb-doc h4,.vb-doc h5{font-size:16px}
.vb-doc a{color:#E8B96A}.vb-doc code,.vb-doc pre{background:rgba(232,185,106,.1);border-radius:3px}.vb-doc code{padding:1px 5px}
.vb-doc pre{padding:10px 12px;overflow:auto;white-space:pre-wrap}.vb-doc blockquote{margin:.6em 0;padding:2px 12px;border-left:3px solid #E8B96A;color:#cdb88e}
.vb-doc hr{border:0;border-top:1px solid rgba(232,185,106,.4)}.vb-path{color:#b99b6a;font-size:12.5px;margin-bottom:6px;word-break:break-all}
.vb-links{margin-top:28px;padding-top:12px;border-top:1px solid rgba(232,185,106,.32)}
.vb-links h4{margin:0 0 6px;font-size:12.5px;letter-spacing:2px;color:#E8B96A;font-weight:600}
.vb-links button{display:block;background:none;border:0;color:#E8B96A;cursor:pointer;font:inherit;font-size:14.5px;padding:3px 0;text-align:left;word-break:break-all}
.vb-links button:hover{text-decoration:underline}.vb-links p{margin:0 0 12px;color:#b99b6a;font-size:13px}
.vb-back-btn{display:none}
@media (max-width:700px){
  .vb-top{flex-wrap:wrap;row-gap:8px}.vb-top h2{font-size:14px;letter-spacing:2px}.vb-q{order:9;flex:1 0 100%}
  .vb-list{flex:1;border-right:0}.vb-doc{display:none}
  .vb.show-doc .vb-list{display:none}.vb.show-doc .vb-doc{display:block;flex:1}
  .vb.show-doc .vb-back-btn,.vb.graph .vb-back-btn{display:inline-block}
  .vb.graph .vb-list{display:none}
}
.vb-seg{display:flex;gap:0}.vb-seg .vb-btn{border-radius:0;margin-left:-1px}.vb-seg .vb-btn:first-child{margin-left:0}
.vb-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 10px}.vb-bar .vb-path{flex:1 1 12em;margin:0}
.vb-btn.danger{border-color:rgba(255,122,74,.6);color:#ff9a6a}.vb-btn.danger:hover{background:rgba(255,122,74,.16);color:#fff}
.vb-btn.pri{background:linear-gradient(180deg,#FFD99A,#E8B96A 45%,#b07a32);color:#1a1006;border-color:#FFD99A}
.vb-edit{width:100%;min-height:52vh;background:#0d0a06;color:#f6efe2;border:1px solid rgba(232,185,106,.45);padding:10px 12px;font:14px/1.7 'Noto Sans JP',monospace;resize:vertical;outline:none}
.vb-edit:focus{border-color:#FFD99A}
.vb-ver{display:block;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid rgba(232,185,106,.18);color:#e9dcc4;padding:6px 4px;cursor:pointer;font:inherit;font-size:14px}.vb-ver:hover{background:rgba(232,185,106,.1)}.vb-ver.on{background:rgba(232,185,106,.2);color:#fff}
.vb-ver small{color:#b99b6a;margin-left:8px}
.vb-cv{display:block;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid rgba(232,185,106,.16);color:#e9dcc4;padding:8px 12px;cursor:pointer;font:inherit}.vb-cv:hover{background:rgba(232,185,106,.1)}.vb-cv.on{background:rgba(232,185,106,.2)}
.vb-cv b{display:block;font-size:14px;font-weight:600;color:#FFD99A}.vb-cv span{display:block;color:#b99b6a;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vb-m{margin:10px 0;padding:8px 12px;border-left:3px solid #E8B96A;background:rgba(232,185,106,.06)}.vb-m.assistant{border-left-color:#8a7350;background:rgba(255,255,255,.03)}
.vb-m small{display:flex;gap:10px;align-items:center;color:#b99b6a;font-size:12px}.vb-m small button{margin-left:auto;background:none;border:1px solid rgba(255,122,74,.5);color:#ff9a6a;cursor:pointer;font:inherit;font-size:12px;padding:0 8px}
.vb-m div{white-space:pre-wrap;word-break:break-word;color:#f6efe2}
`;

// ---------------------------------------------------------------- graph layout (force-directed, small N)
const hueOf = (folder) => { let h = 0; for (const c of folder) h = (h * 31 + c.charCodeAt(0)) % 360; return 28 + (h % 24); };   // gold .. amber family, folder-dependent
export function layoutGraph(nodes, edges, iterations = 260) {
  const N = nodes.length, idx = new Map(nodes.map((n, i) => [n.id, i]));
  const px = new Float32Array(N), py = new Float32Array(N), vx = new Float32Array(N), vy = new Float32Array(N);
  for (let i = 0; i < N; i++) { const a = (i / Math.max(1, N)) * Math.PI * 2, r = 60 + 8 * Math.sqrt(N) * ((i * 7919) % 100) / 100; px[i] = Math.cos(a) * r; py[i] = Math.sin(a) * r; }
  const E = edges.map(([a, b]) => [idx.get(a), idx.get(b)]).filter(([a, b]) => a !== undefined && b !== undefined);
  const k = 46;   // ideal edge length
  for (let it = 0; it < iterations; it++) {
    const cool = 1 - it / iterations;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        let dx = px[i] - px[j], dy = py[i] - py[j], d2 = dx * dx + dy * dy + 0.01;
        if (d2 > 90000) continue;                       // ignore far pairs
        const f = (k * k * 1.6) / d2;
        dx *= f; dy *= f; vx[i] += dx; vy[i] += dy; vx[j] -= dx; vy[j] -= dy;
      }
      vx[i] -= px[i] * 0.012; vy[i] -= py[i] * 0.012;     // gravity keeps islands together
    }
    for (const [a, b] of E) {
      const dx = px[b] - px[a], dy = py[b] - py[a], d = Math.sqrt(dx * dx + dy * dy) + 0.01, f = (d - k) * 0.08 / d;
      vx[a] += dx * f; vy[a] += dy * f; vx[b] -= dx * f; vy[b] -= dy * f;
    }
    for (let i = 0; i < N; i++) { const m = 6 * cool + 0.5, sp = Math.hypot(vx[i], vy[i]) || 1, s = Math.min(m, sp) / sp; px[i] += vx[i] * s; py[i] += vy[i] * s; vx[i] *= 0.5; vy[i] *= 0.5; }
  }
  return { x: px, y: py, edges: E };
}

export function initBrainViewer({ authHeaders, fetchImpl = (...a) => fetch(...a) }) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const back = document.createElement('div'); back.className = 'vb-back';
  back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true'); back.setAttribute('aria-label', '第二の脳');
  back.innerHTML = `<div class="vb">
    <div class="vb-top"><i></i><h2>SECOND BRAIN</h2>
      <button class="vb-btn vb-back-btn" type="button" data-back>◀ 一覧</button>
      <div class="vb-seg" role="tablist"><button class="vb-btn on" type="button" data-mode="notes">ノート</button><button class="vb-btn" type="button" data-mode="trash">ゴミ箱</button><button class="vb-btn" type="button" data-mode="conv">会話</button></div>
      <input class="vb-q" type="search" placeholder="検索" aria-label="検索">
      <button class="vb-btn" type="button" data-new title="新しいノート">＋ 新規</button>
      <button class="vb-btn" type="button" data-graph title="ノートのつながりの図">グラフ</button>
      <button class="vb-btn" type="button" data-reload title="再読み込み">↻</button>
      <button class="vb-btn vb-x" type="button" data-x>閉じる</button></div>
    <div class="vb-body"><div class="vb-list"></div><div class="vb-doc"><div class="vb-msg">左の一覧から選んでください。</div></div>
      <div class="vb-gwrap"><canvas></canvas><div class="vb-gnote"></div></div></div></div>`;
  document.body.appendChild(back);
  const $ = (s) => back.querySelector(s);
  const vb = $('.vb'), listEl = $('.vb-list'), docEl = $('.vb-doc'), q = $('.vb-q'), gBtn = $('[data-graph]'), cv = $('.vb-gwrap canvas'), gNote = $('.vb-gnote');
  let notes = [], current = '', currentNote = null, graph = null, searching = false, projInfo = null, mode = 'notes', convs = [], currentConv = null;
  const closed = new Set(); let openedDefault = false;
  const byPath = () => new Map(notes.map((n) => [n.path, n]));

  /** One call to the server as the signed-in user. Throws a Japanese message the viewer shows. */
  async function call(path, { method = 'GET', body } = {}) {
    if (window.__elvarDeviceLocked) throw new Error('スマホのロックを解除してから開いてください。');
    const r = await fetchImpl(path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...authHeaders() }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error('ログインし直してください。');
    if (!r.ok) throw Object.assign(new Error(j.message || ({ not_found: '見つかりません（すでに消えているかもしれません）', changed: '別の場所で変更されました。開き直してください', exists: 'すでに同じ名前のノートがあります', storage_quota_exceeded: '保存容量がいっぱいです', rate_limited: '少し待ってください' })[j.error] || `サーバーエラー (${r.status})`), { code: j.error, status: r.status });
    return j;
  }
  const fmt = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

  // ---------------- folder tree
  function tree(items) {
    const root = { dirs: new Map(), files: [] };
    for (const it of items) { const parts = it.path.split('/'); let n = root; for (const d of parts.slice(0, -1)) { if (!n.dirs.has(d)) n.dirs.set(d, { dirs: new Map(), files: [] }); n = n.dirs.get(d); } n.files.push(it); }
    return root;
  }
  const count = (n) => n.files.length + [...n.dirs.values()].reduce((a, c) => a + count(c), 0);
  function renderTree(n, prefix, depth, snippets, out) {
    for (const [name, sub] of [...n.dirs].sort((a, b) => a[0].localeCompare(b[0], 'ja'))) {
      const p = prefix + name + '/', isClosed = closed.has(p);
      out.push(`<button class="vb-fo" type="button" data-folder="${esc(p)}" style="padding-left:${10 + depth * 14}px"><b>${isClosed ? '▸' : '▾'}</b>${esc(name)}<em>${count(sub)}</em></button>`);
      if (!isClosed) renderTree(sub, p, depth + 1, snippets, out);
    }
    for (const it of n.files.sort((a, b) => a.path.localeCompare(b.path, 'ja'))) {
      out.push(`<button class="vb-n${it.path === current ? ' on' : ''}" type="button" data-path="${esc(it.path)}" style="padding-left:${22 + depth * 14}px">${esc(it.path.split('/').pop().replace(/\.md$/i, ''))}${snippets && it.snippet ? `<small>${esc(it.snippet)}</small>` : ''}</button>`);
    }
  }
  function renderList(items, snippets = false) {
    if (!items.length) { listEl.innerHTML = `<div class="vb-msg">${mode === 'trash' ? 'ゴミ箱は空です。' : 'ノートがありません。「覚えておいて」と話しかけると、ここに増えていきます。'}</div>`; return; }
    if (!snippets && !openedDefault) { openedDefault = true; if (items.length > 40) collectDirs(tree(items), '').forEach((d) => closed.add(d)); }
    const out = []; renderTree(snippets ? { dirs: new Map(), files: items } : tree(items), '', 0, snippets, out);
    listEl.innerHTML = (snippets || mode === 'trash' ? '' : projectCards(items)) + out.join('');
  }
  const collectDirs = (n, prefix) => [...n.dirs].flatMap(([k, v]) => [prefix + k + '/', ...collectDirs(v, prefix + k + '/')]);

  // ---------------- projects (プロジェクト/<名前>/ folders) pinned above the tree
  function projectStatus(p) {
    if (!p) return null;
    if (p.openTasks === 0 && p.doneTasks > 0) return ['done', '完了間近'];
    if (p.notes <= 1) return ['new', '新規'];
    if (p.daysSinceUpdate != null && p.daysSinceUpdate > 14 && p.openTasks > 0) return ['stale', '停滞'];
    return ['run', '進行中'];
  }
  function projectCards(items) {
    const by = new Map();
    for (const it of items) { const m = it.path.match(/^プロジェクト\/([^/]+)\/.+/); if (m) by.set(m[1], (by.get(m[1]) || 0) + 1); }
    if (!by.size) return '';
    const cards = [...by].sort((a, b) => a[0].localeCompare(b[0], 'ja')).map(([name, n]) => {
      const info = projInfo?.find((x) => x.name === name), st = projectStatus(info);
      const sub = info ? [info.openTasks ? `未完了 ${info.openTasks}` : '', info.nextActions?.[0] ? `次：${info.nextActions[0]}` : '', info.lastUpdated ? `更新 ${info.lastUpdated}` : ''].filter(Boolean).join(' ／ ') : `${n} ノート`;
      return `<button class="vb-pj${current.startsWith('プロジェクト/' + name + '/') ? ' on' : ''}" type="button" data-project="${esc(name)}"><b>${st ? `<i class="${st[0]}">${st[1]}</i>` : ''}${esc(name)}</b><span>${esc(sub || `${n} ノート`)}</span></button>`;
    }).join('');
    return `<div class="vb-pjh">プロジェクト（${by.size}）</div>${cards}`;
  }
  async function loadProjects() {
    try { const r = await call('/api/elvar/notes/projects'); projInfo = r.projects || []; if (!searching && mode === 'notes') renderList(notes); } catch { projInfo = null; }
  }

  async function loadList() {
    listEl.innerHTML = '<div class="vb-msg">読み込み中…</div>';
    try {
      const r = await call(mode === 'trash' ? '/api/elvar/notes?trash=1' : '/api/elvar/notes'); notes = (r.notes || []).map((n) => ({ path: n.path, id: n.id, rev: n.rev, updatedAt: n.updatedAt })); renderList(notes);
      if (mode === 'notes') { loadGraph(); loadProjects(); }
    } catch (e) { listEl.innerHTML = `<div class="vb-msg warn">${esc(e.message)}</div>`; }
  }
  async function loadGraph() {
    try { graph = await call('/api/elvar/notes/graph'); if (vb.classList.contains('graph')) drawGraphSoon(true); if (current && mode === 'notes') renderLinks(); } catch { graph = null; }
  }

  // ---------------- note: read, edit, versions, trash
  function renderLinks() {
    const old = docEl.querySelector('.vb-links'); if (old) old.remove();
    if (!graph || !current || editing) return;
    const back = graph.edges.filter(([, b]) => b === current).map(([a]) => a), out = graph.edges.filter(([a]) => a === current).map(([, b]) => b);
    const btns = (arr) => arr.length ? arr.map((p) => `<button type="button" data-path="${esc(p)}">${esc(p.replace(/\.md$/i, ''))}</button>`).join('') : '<p>なし</p>';
    docEl.insertAdjacentHTML('beforeend', `<div class="vb-links"><h4>このノートへのリンク（バックリンク） ${back.length}</h4>${btns(back)}<h4 style="margin-top:14px">このノートからのリンク ${out.length}</h4>${btns(out)}</div>`);
  }
  let editing = false, revs = [];
  const bar = (n) => `<div class="vb-bar"><div class="vb-path">${esc(n.path)}　<small>版 ${esc(n.rev)}・${esc(fmt(n.updatedAt))}</small></div>${mode === 'trash'
    ? '<button class="vb-btn" type="button" data-restore>元に戻す</button><button class="vb-btn danger" type="button" data-purge>完全に削除</button>'
    : '<button class="vb-btn" type="button" data-edit>編集</button><button class="vb-btn" type="button" data-versions>以前の版</button><button class="vb-btn danger" type="button" data-trash>ゴミ箱へ</button>'}</div>`;
  async function openNote(path) {
    current = path; editing = false; vb.classList.add('show-doc'); vb.classList.remove('graph'); gBtn.classList.remove('on');
    docEl.innerHTML = '<div class="vb-msg">読み込み中…</div>';
    listEl.querySelectorAll('.vb-n').forEach((b) => b.classList.toggle('on', b.dataset.path === path));
    try {
      let meta = byPath().get(path);
      if (!meta) { await loadList(); meta = byPath().get(path); }
      if (!meta) throw new Error('このノートはありません');
      const r = await call(`/api/elvar/notes/${meta.id}`); currentNote = r.note; revs = r.revisions || [];
      docEl.innerHTML = bar(r.note) + renderMarkdown(r.note.content);
      docEl.scrollTop = 0; if (mode === 'notes') renderLinks();
    } catch (e) { currentNote = null; docEl.innerHTML = `<div class="vb-msg warn">${esc(e.message)}</div>`; }
  }
  function startEdit() {
    if (!currentNote) return; editing = true;
    docEl.innerHTML = `<div class="vb-bar"><div class="vb-path">${esc(currentNote.path)}　<small>編集中（直す前の版は残ります）</small></div><button class="vb-btn pri" type="button" data-save>保存</button><button class="vb-btn" type="button" data-cancel>キャンセル</button></div>
      <textarea class="vb-edit" aria-label="ノートの本文" spellcheck="false"></textarea><div class="vb-msg" data-emsg></div>`;
    const ta = docEl.querySelector('.vb-edit'); ta.value = currentNote.content; ta.focus();
  }
  async function saveEdit() {
    const ta = docEl.querySelector('.vb-edit'), msg = docEl.querySelector('[data-emsg]');
    if (!ta.value.trim()) { msg.textContent = '内容が空です。消したいときは、「ゴミ箱へ」を使ってください。'; msg.className = 'vb-msg warn'; return; }
    try { const r = await call(`/api/elvar/notes/${currentNote.id}`, { method: 'PUT', body: { content: ta.value, baseRev: currentNote.rev } }); currentNote = r.note; editing = false; await loadList(); await openNote(currentNote.path); }
    catch (e) { msg.textContent = e.message; msg.className = 'vb-msg warn'; }
  }
  async function showVersions() {
    if (!currentNote) return;
    const r = await call(`/api/elvar/notes/${currentNote.id}`).catch(() => null); revs = r?.revisions || revs;
    docEl.innerHTML = `<div class="vb-bar"><div class="vb-path">${esc(currentNote.path)}　<small>以前の版（新しい30版まで）</small></div><button class="vb-btn" type="button" data-cancel>◀ 戻る</button></div>
      ${revs.length ? revs.map((v) => `<button class="vb-ver" type="button" data-rev="${esc(v.rev)}">版 ${esc(v.rev)}<small>${esc(fmt(v.at))}・${esc(v.bytes)} バイト</small></button>`).join('') : '<div class="vb-msg">以前の版は、まだありません（直すたびに、直す前の版が残ります）。</div>'}<div data-rv></div>`;
  }
  async function showRevision(rev) {
    const box = docEl.querySelector('[data-rv]'); docEl.querySelectorAll('.vb-ver').forEach((b) => b.classList.toggle('on', b.dataset.rev === String(rev)));
    try { const r = await call(`/api/elvar/notes/${currentNote.id}/revisions/${rev}`); box.innerHTML = `<div class="vb-bar" style="margin-top:14px"><div class="vb-path">版 ${esc(rev)} の内容</div><button class="vb-btn pri" type="button" data-rev-restore="${esc(rev)}">この版に戻す</button></div>${renderMarkdown(r.revision.content)}`; }
    catch (e) { box.innerHTML = `<div class="vb-msg warn">${esc(e.message)}</div>`; }
  }
  const doAct = async (fn, after) => { try { await fn(); await after(); } catch (e) { docEl.insertAdjacentHTML('afterbegin', `<div class="vb-msg warn">${esc(e.message)}</div>`); } };
  const resolve = (name) => {
    const n = name.toLowerCase().replace(/\.md$/, ''), k = (x) => x.path.toLowerCase().replace(/\.md$/, '');
    return (notes.find((x) => k(x) === n) || notes.find((x) => k(x).split('/').pop() === n.split('/').pop()))?.path;
  };

  // ---------------- conversations
  async function loadConvs() {
    listEl.innerHTML = '<div class="vb-msg">読み込み中…</div>';
    try {
      const r = await call('/api/elvar/conversations?limit=100'); convs = r.conversations || [];
      listEl.innerHTML = convs.length ? convs.map((c) => `<button class="vb-cv${currentConv?.id === c.id ? ' on' : ''}" type="button" data-conv="${esc(c.id)}"><b>${esc(fmt(c.startedAt))}</b><span>${esc(c.preview || '（返事だけ）')}・${esc(c.count)} 件</span></button>`).join('') : '<div class="vb-msg">会話の記録は、まだありません。話すと、ここに残ります（設定の「記憶」で、残す期間を選べます）。</div>';
    } catch (e) { listEl.innerHTML = `<div class="vb-msg warn">${esc(e.message)}</div>`; }
  }
  const msgHtml = (m) => `<div class="vb-m ${esc(m.role)}" data-mid="${esc(m.id)}"><small>${m.role === 'user' ? 'あなた' : 'E.L.V.A.R.'}・${esc(fmt(m.at))}<button type="button" data-delmsg>この発言を消す</button></small><div>${esc(m.text)}</div></div>`;
  async function openConv(id) {
    vb.classList.add('show-doc'); docEl.innerHTML = '<div class="vb-msg">読み込み中…</div>';
    try {
      const r = await call(`/api/elvar/conversations/${id}`); currentConv = r.conversation;
      docEl.innerHTML = `<div class="vb-bar"><div class="vb-path">${esc(fmt(currentConv.startedAt))}　<small>${esc(currentConv.messages.length)} 件</small></div><button class="vb-btn danger" type="button" data-delconv>この会話を消す</button></div>${currentConv.messages.map(msgHtml).join('')}`;
      listEl.querySelectorAll('.vb-cv').forEach((b) => b.classList.toggle('on', b.dataset.conv === id));
    } catch (e) { docEl.innerHTML = `<div class="vb-msg warn">${esc(e.message)}</div>`; }
  }
  async function searchConvs(v) {
    listEl.innerHTML = '<div class="vb-msg">検索中…</div>';
    try {
      const r = await call(`/api/elvar/messages?q=${encodeURIComponent(v)}&limit=50`);
      listEl.innerHTML = (r.messages || []).length ? r.messages.map((m) => `<button class="vb-cv" type="button" data-conv="${esc(m.conversationId)}"><b>${esc(fmt(m.at))}・${m.role === 'user' ? 'あなた' : 'E.L.V.A.R.'}</b><span>${esc(m.text)}</span></button>`).join('') : '<div class="vb-msg">見つかりませんでした。</div>';
    } catch (e) { listEl.innerHTML = `<div class="vb-msg warn">${esc(e.message)}</div>`; }
  }

  function setMode(m) {
    mode = m; current = ''; currentNote = null; currentConv = null; searching = false; q.value = ''; vb.classList.remove('graph', 'show-doc'); gBtn.classList.remove('on');
    back.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    $('[data-new]').style.display = m === 'notes' ? '' : 'none'; gBtn.style.display = m === 'notes' ? '' : 'none'; q.placeholder = m === 'conv' ? '会話を検索' : 'ノートを検索';
    docEl.innerHTML = `<div class="vb-msg">${m === 'conv' ? '左の一覧から、会話を選んでください。' : '左の一覧からノートを選んでください。'}</div>`;
    if (m === 'conv') loadConvs(); else loadList();
  }

  // ---------------- graph view
  let view = { x: 0, y: 0, s: 1 }, lay = null, hover = -1, raf = 0;
  function setupGraph() {
    if (!graph || !graph.nodes.length) { lay = null; gNote.textContent = graph ? 'ノートがありません' : 'つながりを読み込めませんでした'; return; }
    lay = layoutGraph(graph.nodes, graph.edges);
    const idx = new Map(graph.nodes.map((n, i) => [n.id, i]));
    lay.deg = new Uint16Array(graph.nodes.length); for (const [a, b] of lay.edges) { lay.deg[a]++; lay.deg[b]++; }
    lay.idx = idx;
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    for (let i = 0; i < graph.nodes.length; i++) { minx = Math.min(minx, lay.x[i]); maxx = Math.max(maxx, lay.x[i]); miny = Math.min(miny, lay.y[i]); maxy = Math.max(maxy, lay.y[i]); }
    const w = cv.clientWidth || 600, h = cv.clientHeight || 400, pad = 50;
    const s = Math.min((w - pad * 2) / Math.max(1, maxx - minx), (h - pad * 2) / Math.max(1, maxy - miny), 2.2);
    view = { s, x: w / 2 - ((minx + maxx) / 2) * s, y: h / 2 - ((miny + maxy) / 2) * s };
    gNote.textContent = `ノート ${graph.nodes.length} 件・リンク ${graph.edges.length} 本` + (graph.truncated ? '（先頭300件のみ）' : '') + '　ドラッグで移動、ピンチ/ホイールで拡大、点を押すと開きます';
  }
  function drawGraphSoon(rebuild) { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (rebuild || !lay) setupGraph(); drawGraph(); }); }
  function drawGraph() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    if (!lay) return;
    const cur = lay.idx.get(current), nb = new Set();
    if (cur !== undefined) for (const [a, b] of lay.edges) { if (a === cur) nb.add(b); if (b === cur) nb.add(a); }
    const X = (i) => lay.x[i] * view.s + view.x, Y = (i) => lay.y[i] * view.s + view.y;
    c.lineWidth = 1;
    for (const [a, b] of lay.edges) { const hot = a === cur || b === cur; c.strokeStyle = hot ? 'rgba(255,217,154,.9)' : 'rgba(232,185,106,.3)'; c.beginPath(); c.moveTo(X(a), Y(a)); c.lineTo(X(b), Y(b)); c.stroke(); }
    c.font = '12px "Noto Sans JP","Yu Gothic UI",sans-serif'; c.textAlign = 'center';
    for (let i = 0; i < graph.nodes.length; i++) {
      const id = graph.nodes[i].id, folder = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '', r = (3.2 + Math.min(7, lay.deg[i] * 1.1)) * Math.min(1.6, Math.max(0.7, view.s));
      const isCur = i === cur, isNb = nb.has(i), isHover = i === hover, h0 = hueOf(folder);
      c.beginPath(); c.arc(X(i), Y(i), r, 0, Math.PI * 2);
      c.fillStyle = isCur ? '#ffffff' : `hsl(${h0},90%,${isNb || isHover ? 72 : 58}%)`; c.shadowColor = isCur ? '#FFD99A' : 'transparent'; c.shadowBlur = isCur ? 14 : 0; c.fill(); c.shadowBlur = 0;
      if (isCur || isNb || isHover || view.s > 1.15 || lay.deg[i] >= 3) { c.fillStyle = isCur || isHover ? '#fff' : 'rgba(233,220,196,.88)'; c.fillText(id.split('/').pop().replace(/\.md$/i, ''), X(i), Y(i) - r - 5); }
    }
  }
  const pick = (mx, my) => {
    if (!lay) return -1; let best = -1, bd = 1e9;
    for (let i = 0; i < graph.nodes.length; i++) { const dx = lay.x[i] * view.s + view.x - mx, dy = lay.y[i] * view.s + view.y - my, d = dx * dx + dy * dy, r = Math.max(14, 6 + lay.deg[i] * 1.5); if (d < r * r && d < bd) { bd = d; best = i; } }
    return best;
  };
  const ptrs = new Map(); let moved = 0, pinch0 = 0, down = null;
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.offsetX, e.offsetY]); moved = 0; down = [e.offsetX, e.offsetY]; if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); } });
  cv.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) { const h = pick(e.offsetX, e.offsetY); if (h !== hover) { hover = h; cv.style.cursor = h >= 0 ? 'pointer' : 'grab'; drawGraphSoon(); } return; }
    if (ptrs.size === 2) {
      ptrs.set(e.pointerId, [e.offsetX, e.offsetY]); const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
      if (pinch0 > 0) { const f = Math.max(0.3, Math.min(4, view.s * d / pinch0)) / view.s; view.x = cx - (cx - view.x) * f; view.y = cy - (cy - view.y) * f; view.s *= f; } pinch0 = d; moved = 99; drawGraphSoon(); return;
    }
    view.x += e.offsetX - p[0]; view.y += e.offsetY - p[1]; moved += Math.abs(e.offsetX - p[0]) + Math.abs(e.offsetY - p[1]); ptrs.set(e.pointerId, [e.offsetX, e.offsetY]); drawGraphSoon();
  });
  const up = (e) => {
    ptrs.delete(e.pointerId); pinch0 = 0;
    if (moved < 8 && down) { const i = pick(down[0], down[1]); if (i >= 0) openNote(graph.nodes[i].id); }
    down = null;
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', (e) => { ptrs.delete(e.pointerId); pinch0 = 0; });
  cv.addEventListener('wheel', (e) => { e.preventDefault(); const f = Math.max(0.3, Math.min(4, view.s * (e.deltaY < 0 ? 1.12 : 1 / 1.12))) / view.s; view.x = e.offsetX - (e.offsetX - view.x) * f; view.y = e.offsetY - (e.offsetY - view.y) * f; view.s *= f; drawGraphSoon(); }, { passive: false });
  addEventListener('resize', () => { if (vb.classList.contains('graph')) drawGraphSoon(true); });


  // ---------------- wiring
  let timer = 0;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const v = q.value.trim();
      vb.classList.remove('graph'); gBtn.classList.remove('on');
      if (mode === 'conv') { if (v) searchConvs(v); else loadConvs(); return; }
      if (!v) { searching = false; renderList(notes); return; }
      searching = true; listEl.innerHTML = '<div class="vb-msg">検索中…</div>'; vb.classList.remove('show-doc');
      try { const r = await call(`/api/elvar/notes?q=${encodeURIComponent(v)}`); if (!(r.results || []).length) listEl.innerHTML = '<div class="vb-msg">見つかりませんでした。</div>'; else renderList(r.results, true); }
      catch (e) { listEl.innerHTML = `<div class="vb-msg warn">${esc(e.message)}</div>`; }
    }, 350);
  });
  listEl.addEventListener('click', (e) => {
    const cvb = e.target.closest('[data-conv]'); if (cvb) { openConv(cvb.dataset.conv); return; }
    const f = e.target.closest('[data-folder]');
    if (f) { const p = f.dataset.folder; closed.has(p) ? closed.delete(p) : closed.add(p); renderList(notes); return; }
    const pj = e.target.closest('[data-project]');
    if (pj) { const name = pj.dataset.project; closed.delete('プロジェクト/'); closed.delete(`プロジェクト/${name}/`); openNote(`プロジェクト/${name}/00_概要.md`); renderList(notes); return; }
    const b = e.target.closest('[data-path]'); if (b) openNote(b.dataset.path);
  });
  docEl.addEventListener('click', (e) => {
    const t = e.target, af = (m) => async () => { await loadList(); if (m) await openNote(currentNote?.path || current); };
    if (t.closest('[data-edit]')) return startEdit();
    if (t.closest('[data-save]')) return saveEdit();
    if (t.closest('[data-cancel]')) return openNote(current);
    if (t.closest('[data-versions]')) return showVersions();
    const rv = t.closest('[data-rev]'); if (rv) return showRevision(Number(rv.dataset.rev));
    const rr = t.closest('[data-rev-restore]'); if (rr) { if (confirm('この版に戻します（いまの内容も、版として残ります）。')) doAct(() => call(`/api/elvar/notes/${currentNote.id}/revisions/${rr.dataset.revRestore}/restore`, { method: 'POST', body: {} }), af(true)); return; }
    if (t.closest('[data-trash]')) { if (confirm(`「${currentNote.path}」をゴミ箱に入れます（30日は元に戻せます）。`)) doAct(() => call(`/api/elvar/notes/${currentNote.id}`, { method: 'DELETE' }), async () => { current = ''; currentNote = null; vb.classList.remove('show-doc'); docEl.innerHTML = '<div class="vb-msg">ゴミ箱に入れました。</div>'; await loadList(); }); return; }
    if (t.closest('[data-restore]')) { doAct(() => call(`/api/elvar/notes/${currentNote.id}/restore`, { method: 'POST', body: {} }), async () => { current = ''; vb.classList.remove('show-doc'); docEl.innerHTML = '<div class="vb-msg">元に戻しました。</div>'; await loadList(); }); return; }
    if (t.closest('[data-purge]')) { if (confirm(`「${currentNote.path}」を完全に削除します。以前の版も消え、元に戻せません。`)) doAct(() => call(`/api/elvar/notes/${currentNote.id}?permanent=1`, { method: 'DELETE' }), async () => { current = ''; vb.classList.remove('show-doc'); docEl.innerHTML = '<div class="vb-msg">完全に削除しました。</div>'; await loadList(); }); return; }
    const dm = t.closest('[data-delmsg]'); if (dm) { const el = dm.closest('[data-mid]'); if (confirm('この発言を消します。')) doAct(() => call(`/api/elvar/messages/${el.dataset.mid}`, { method: 'DELETE' }), async () => { el.remove(); }); return; }
    if (t.closest('[data-delconv]')) { if (confirm('この会話を、すべて消します。')) doAct(() => call(`/api/elvar/conversations/${currentConv.id}`, { method: 'DELETE' }), async () => { currentConv = null; vb.classList.remove('show-doc'); docEl.innerHTML = '<div class="vb-msg">消しました。</div>'; await loadConvs(); }); return; }
    const l = t.closest('.vb-links [data-path]'); if (l) { openNote(l.dataset.path); return; }
    const a = t.closest('a[data-note]'); if (!a) return;
    e.preventDefault(); const p = resolve(a.dataset.note);
    if (p) openNote(p); else { a.style.opacity = '.5'; a.title = 'このノートはまだありません'; }
  });
  back.addEventListener('click', async (e) => {
    const m = e.target.closest('[data-mode]');
    if (e.target === back || e.target.closest('[data-x]')) close();
    else if (m) setMode(m.dataset.mode);
    else if (e.target.closest('[data-back]')) { vb.classList.remove('show-doc', 'graph'); gBtn.classList.remove('on'); }
    else if (e.target.closest('[data-graph]')) toggleGraph();
    else if (e.target.closest('[data-new]')) {
      const p = prompt('新しいノートの名前（フォルダは / で区切れます。例：好み/コーヒー）'); if (!p || !p.trim()) return;
      const title = p.trim().split('/').pop().replace(/\.md$/i, '');
      try { const r = await call('/api/elvar/notes', { method: 'POST', body: { path: p.trim(), content: `# ${title}\n\n` } }); await loadList(); await openNote(r.note.path); startEdit(); }
      catch (err) { docEl.innerHTML = `<div class="vb-msg warn">${esc(err.message)}</div>`; vb.classList.add('show-doc'); }
    } else if (e.target.closest('[data-reload]')) { graph = null; if (mode === 'conv') loadConvs(); else { loadList(); if (current && !vb.classList.contains('graph')) openNote(current); } }
  });
  function toggleGraph() {
    const on = !vb.classList.contains('graph');
    vb.classList.toggle('graph', on); gBtn.classList.toggle('on', on);
    if (on) { vb.classList.remove('show-doc'); if (!graph) { gNote.textContent = '読み込み中…'; loadGraph(); } else drawGraphSoon(true); }
    else if (current) vb.classList.add('show-doc');
  }

  const isOpen = () => back.classList.contains('on');
  function open(opts = {}) {
    back.classList.add('on'); vb.classList.remove('show-doc', 'graph'); gBtn.classList.remove('on');
    setMode(opts?.mode === 'conv' ? 'conv' : 'notes');
    if (opts && typeof opts.path === 'string' && opts.path) openNote(opts.path);
  }
  function close() { back.classList.remove('on'); }
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) { e.stopImmediatePropagation(); e.preventDefault(); if (editing) { openNote(current); return; } close(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); isOpen() ? close() : open(); }
  }, true);
  document.addEventListener('click', (e) => { if (e.target.closest?.('.vm-nav-folder, [data-vh-nav="folder"]')) { e.preventDefault(); open(); } }, true);
  if (new URLSearchParams(location.search).get('brain') === '1') setTimeout(open, 600);
  return { open, close, openConversations: () => open({ mode: 'conv' }) };
}
