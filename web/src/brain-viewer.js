// In-app viewer for the second brain (read-only). Notes come through the same /api/google/execute tools the voice model uses
// (brain_list / brain_read / brain_search), so it needs no extra server code. Opens from the phone HUD's folder icon, the settings
// panel, Ctrl+B or ?brain=1.
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
.vb-back{position:fixed;inset:0;z-index:45;display:none;background:rgba(0,8,20,.82);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.vb-back.on{display:flex;animation:vs-in .16s ease-out}
.vb{display:flex;flex-direction:column;width:min(1200px,100%);height:100%;margin:0 auto;color:#d9eef9;font:15px/1.65 'Barlow Semi Condensed','Noto Sans JP','Yu Gothic UI','Meiryo',sans-serif;
  background:linear-gradient(180deg,rgba(3,26,52,.97),rgba(1,14,30,.98));outline:1.5px solid rgba(30,166,216,.9);outline-offset:-1px}
.vb-top{display:flex;align-items:center;gap:10px;padding:max(12px,env(safe-area-inset-top)) 14px 10px;border-bottom:1px solid rgba(40,150,200,.32)}
.vb-top h2{margin:0;font-size:16px;letter-spacing:3px;color:#8fe3ff;font-weight:600;white-space:nowrap}
.vb-top i{width:7px;height:7px;border-radius:50%;background:#19d3ff;box-shadow:0 0 6px #19d3ff}
.vb-btn{white-space:nowrap;background:transparent;color:#8fe3ff;border:1px solid rgba(25,211,255,.6);border-radius:3px;padding:3px 12px;cursor:pointer;font:inherit;font-size:14px}
.vb-btn:hover,.vb-btn.on{background:rgba(25,211,255,.2);color:#fff}
.vb-x{margin-left:auto}
.vb-q{flex:1;min-width:0;background:#021a30;color:#d9eef9;border:1px solid rgba(25,211,255,.45);border-radius:3px;padding:5px 10px;font:inherit}
.vb-body{flex:1;min-height:0;display:flex;position:relative}
.vb-list{flex:0 0 300px;overflow:auto;border-right:1px solid rgba(40,150,200,.32);padding:8px 0}
.vb-doc{flex:1;min-width:0;overflow:auto;padding:16px 22px 40px}
.vb-gwrap{flex:1;min-width:0;display:none;position:relative}
.vb-gwrap canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:grab}
.vb-gnote{position:absolute;left:10px;bottom:8px;font-size:12px;color:#7fb6d6;pointer-events:none}
.vb.graph .vb-doc{display:none}.vb.graph .vb-gwrap{display:block}
.vb-pjh{padding:10px 10px 4px;color:#8fe3ff;font-size:12.5px;letter-spacing:2px;border-bottom:1px solid rgba(40,150,200,.25)}
.vb-pj{display:block;width:calc(100% - 12px);margin:6px;padding:8px 10px;text-align:left;background:rgba(25,211,255,.06);border:1px solid rgba(40,150,200,.4);border-radius:3px;color:#e6f6ff;cursor:pointer;font:inherit}
.vb-pj:hover,.vb-pj.on{background:rgba(25,211,255,.16);border-color:rgba(25,211,255,.8)}
.vb-pj b{display:block;font-size:14.5px;font-weight:600}.vb-pj span{display:block;margin-top:3px;color:#8fb5cc;font-size:12.5px;line-height:1.5}
.vb-pj i{display:inline-block;margin-right:6px;padding:0 7px;border:1px solid currentColor;border-radius:9px;font-style:normal;font-size:11.5px}
.vb-pj i.run{color:#5ee08a}.vb-pj i.stale{color:#ffb347}.vb-pj i.new{color:#8fe3ff}.vb-pj i.done{color:#7f9bb0}
.vb-fo{display:flex;align-items:center;gap:6px;width:100%;text-align:left;background:none;border:0;color:#3ac9ef;padding:6px 10px;cursor:pointer;font:inherit;font-size:13px;letter-spacing:1.5px}
.vb-fo:hover{background:rgba(25,211,255,.1)}.vb-fo b{display:inline-block;width:1em;font-weight:400;color:#7fb6d6}.vb-fo em{margin-left:auto;font-style:normal;color:#5c93b3;font-size:12px}
.vb-n{display:block;width:100%;text-align:left;background:none;border:0;color:#cfe9f6;padding:6px 14px;cursor:pointer;font:inherit;font-size:14.5px;word-break:break-all}
.vb-n:hover{background:rgba(25,211,255,.12)}.vb-n.on{background:rgba(25,211,255,.22);color:#fff}
.vb-n small{display:block;color:#7fb6d6;font-size:12px;line-height:1.4}
.vb-msg{padding:16px;color:#7fb6d6;font-size:14px}.vb-msg.warn{color:#ffb347}
.vb-doc h2,.vb-doc h3,.vb-doc h4,.vb-doc h5{color:#8fe3ff;margin:1.2em 0 .4em;font-weight:600}
.vb-doc h2{font-size:21px;margin-top:0}.vb-doc h3{font-size:18px}.vb-doc h4,.vb-doc h5{font-size:16px}
.vb-doc a{color:#19d3ff}.vb-doc code,.vb-doc pre{background:rgba(25,211,255,.1);border-radius:3px}.vb-doc code{padding:1px 5px}
.vb-doc pre{padding:10px 12px;overflow:auto;white-space:pre-wrap}.vb-doc blockquote{margin:.6em 0;padding:2px 12px;border-left:3px solid #1ea6d8;color:#a9cfe3}
.vb-doc hr{border:0;border-top:1px solid rgba(40,150,200,.4)}.vb-path{color:#7fb6d6;font-size:12.5px;margin-bottom:6px;word-break:break-all}
.vb-links{margin-top:28px;padding-top:12px;border-top:1px solid rgba(40,150,200,.32)}
.vb-links h4{margin:0 0 6px;font-size:12.5px;letter-spacing:2px;color:#3ac9ef;font-weight:600}
.vb-links button{display:block;background:none;border:0;color:#19d3ff;cursor:pointer;font:inherit;font-size:14.5px;padding:3px 0;text-align:left;word-break:break-all}
.vb-links button:hover{text-decoration:underline}.vb-links p{margin:0 0 12px;color:#7fb6d6;font-size:13px}
.vb-back-btn{display:none}
@media (max-width:700px){
  .vb-top{flex-wrap:wrap;row-gap:8px}.vb-top h2{font-size:14px;letter-spacing:2px}.vb-q{order:9;flex:1 0 100%}
  .vb-list{flex:1;border-right:0}.vb-doc{display:none}
  .vb.show-doc .vb-list{display:none}.vb.show-doc .vb-doc{display:block;flex:1}
  .vb.show-doc .vb-back-btn,.vb.graph .vb-back-btn{display:inline-block}
  .vb.graph .vb-list{display:none}
}`;

// ---------------------------------------------------------------- graph layout (force-directed, small N)
const hueOf = (folder) => { let h = 0; for (const c of folder) h = (h * 31 + c.charCodeAt(0)) % 360; return 170 + (h % 70); };   // cyan..blue family, folder-dependent
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

export function initBrainViewer({ authHeaders }) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const back = document.createElement('div'); back.className = 'vb-back';
  back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true'); back.setAttribute('aria-label', '第二の脳');
  back.innerHTML = `<div class="vb">
    <div class="vb-top"><i></i><h2>SECOND BRAIN</h2>
      <button class="vb-btn vb-back-btn" type="button" data-back>◀ 一覧</button>
      <input class="vb-q" type="search" placeholder="ノートを検索" aria-label="ノートを検索">
      <button class="vb-btn" type="button" data-graph title="ノートのつながりの図">グラフ</button>
      <button class="vb-btn" type="button" data-reload title="再読み込み">↻</button>
      <button class="vb-btn vb-x" type="button" data-x>閉じる</button></div>
    <div class="vb-body"><div class="vb-list"></div><div class="vb-doc"><div class="vb-msg">左の一覧からノートを選んでください。</div></div>
      <div class="vb-gwrap"><canvas></canvas><div class="vb-gnote"></div></div></div></div>`;
  document.body.appendChild(back);
  const $ = (s) => back.querySelector(s);
  const vb = $('.vb'), listEl = $('.vb-list'), docEl = $('.vb-doc'), q = $('.vb-q'), gBtn = $('[data-graph]'), cv = $('.vb-gwrap canvas'), gNote = $('.vb-gnote');
  let notes = [], current = '', graph = null, searching = false, projInfo = null;
  const closed = new Set(); let openedDefault = false;

  async function call(tool, args) {
    if (window.__elvarDeviceLocked) throw new Error('スマホのロックを解除してから開いてください。');
    const r = await fetch('/api/google/execute', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify({ tool, args }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error('アクセストークンが違います（設定を確認してください）。');
    if (r.status === 503) throw new Error('サーバー側の設定が未完了です（Google連携・第二の脳）。');
    if (!j.ok) throw new Error(j.error || `サーバーエラー (${r.status})`);
    return j.result;
  }

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
    if (!items.length) { listEl.innerHTML = '<div class="vb-msg">ノートがありません。「覚えておいて」と話しかけると、ここに増えていきます。</div>'; return; }
    if (!snippets && !openedDefault) { openedDefault = true; if (items.length > 40) collectDirs(tree(items), '').forEach((d) => closed.add(d)); }
    const out = []; renderTree(snippets ? { dirs: new Map(), files: items } : tree(items), '', 0, snippets, out);
    listEl.innerHTML = (snippets ? '' : projectCards(items)) + out.join('');
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
    try { const r = await call('brain_projects', {}); projInfo = r.projects || []; if (!searching) renderList(notes); } catch { projInfo = null; }
  }

  async function loadList() {
    listEl.innerHTML = '<div class="vb-msg">読み込み中…</div>';
    try {
      const r = await call('brain_list', {}); notes = (r.notes || []).map((path) => ({ path })); renderList(notes);
      if (r.note) listEl.insertAdjacentHTML('beforeend', `<div class="vb-msg">${esc(r.note)}。検索で絞り込んでください。</div>`);
      loadGraph(); loadProjects();
    } catch (e) { listEl.innerHTML = `<div class="vb-msg warn">${esc(e.message)}</div>`; }
  }
  async function loadGraph() {
    try { graph = await call('brain_graph', {}); if (vb.classList.contains('graph')) drawGraphSoon(true); if (current) renderLinks(); } catch { graph = null; }
  }

  // ---------------- note + backlinks
  function renderLinks() {
    const old = docEl.querySelector('.vb-links'); if (old) old.remove();
    if (!graph || !current) return;
    const back = graph.edges.filter(([, b]) => b === current).map(([a]) => a), out = graph.edges.filter(([a]) => a === current).map(([, b]) => b);
    const btns = (arr) => arr.length ? arr.map((p) => `<button type="button" data-path="${esc(p)}">${esc(p.replace(/\.md$/i, ''))}</button>`).join('') : '<p>なし</p>';
    docEl.insertAdjacentHTML('beforeend', `<div class="vb-links"><h4>このノートへのリンク（バックリンク） ${back.length}</h4>${btns(back)}<h4 style="margin-top:14px">このノートからのリンク ${out.length}</h4>${btns(out)}</div>`);
  }
  async function openNote(path) {
    current = path; vb.classList.add('show-doc'); vb.classList.remove('graph'); gBtn.classList.remove('on');
    docEl.innerHTML = '<div class="vb-msg">読み込み中…</div>';
    listEl.querySelectorAll('.vb-n').forEach((b) => b.classList.toggle('on', b.dataset.path === path));
    try {
      const r = await call('brain_read', { path });
      docEl.innerHTML = `<div class="vb-path">${esc(r.path)}</div>` + renderMarkdown(r.content) + (r.truncated ? '<div class="vb-msg">（長いため、途中までを表示しています。全文はGitHubで開けます）</div>' : '');
      docEl.scrollTop = 0; renderLinks();
    } catch (e) { docEl.innerHTML = `<div class="vb-msg warn">${esc(e.message)}</div>`; }
  }
  const resolve = (name) => {
    const n = name.toLowerCase().replace(/\.md$/, ''), k = (x) => x.path.toLowerCase().replace(/\.md$/, '');
    return (notes.find((x) => k(x) === n) || notes.find((x) => k(x).split('/').pop() === n.split('/').pop()))?.path;
  };

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
    for (const [a, b] of lay.edges) { const hot = a === cur || b === cur; c.strokeStyle = hot ? 'rgba(143,227,255,.85)' : 'rgba(60,160,210,.28)'; c.beginPath(); c.moveTo(X(a), Y(a)); c.lineTo(X(b), Y(b)); c.stroke(); }
    c.font = '12px "Noto Sans JP","Yu Gothic UI",sans-serif'; c.textAlign = 'center';
    for (let i = 0; i < graph.nodes.length; i++) {
      const id = graph.nodes[i].id, folder = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '', r = (3.2 + Math.min(7, lay.deg[i] * 1.1)) * Math.min(1.6, Math.max(0.7, view.s));
      const isCur = i === cur, isNb = nb.has(i), isHover = i === hover, h0 = hueOf(folder);
      c.beginPath(); c.arc(X(i), Y(i), r, 0, Math.PI * 2);
      c.fillStyle = isCur ? '#ffffff' : `hsl(${h0},90%,${isNb || isHover ? 72 : 58}%)`; c.shadowColor = isCur ? '#8fe3ff' : 'transparent'; c.shadowBlur = isCur ? 14 : 0; c.fill(); c.shadowBlur = 0;
      if (isCur || isNb || isHover || view.s > 1.15 || lay.deg[i] >= 3) { c.fillStyle = isCur || isHover ? '#fff' : 'rgba(207,233,246,.85)'; c.fillText(id.split('/').pop().replace(/\.md$/i, ''), X(i), Y(i) - r - 5); }
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

  function toggleGraph() {
    const on = !vb.classList.contains('graph');
    vb.classList.toggle('graph', on); gBtn.classList.toggle('on', on);
    if (on) { vb.classList.remove('show-doc'); if (!graph) { gNote.textContent = '読み込み中…'; loadGraph(); } else drawGraphSoon(true); }
    else if (current) vb.classList.add('show-doc');
  }

  // ---------------- wiring
  let timer = 0;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const v = q.value.trim();
      vb.classList.remove('graph'); gBtn.classList.remove('on');
      if (!v) { searching = false; renderList(notes); return; }
      searching = true; listEl.innerHTML = '<div class="vb-msg">検索中…</div>'; vb.classList.remove('show-doc');
      try { const r = await call('brain_search', { query: v, maxResults: 10 }); if (!(r.results || []).length) listEl.innerHTML = '<div class="vb-msg">見つかりませんでした。</div>'; else renderList(r.results, true); }
      catch (e) { listEl.innerHTML = `<div class="vb-msg warn">${esc(e.message)}</div>`; }
    }, 350);
  });
  listEl.addEventListener('click', (e) => {
    const f = e.target.closest('[data-folder]');
    if (f) { const p = f.dataset.folder; closed.has(p) ? closed.delete(p) : closed.add(p); renderList(notes); return; }
    const pj = e.target.closest('[data-project]');
    if (pj) { const name = pj.dataset.project; closed.delete('プロジェクト/'); closed.delete(`プロジェクト/${name}/`); openNote(`プロジェクト/${name}/00_概要.md`); renderList(notes); return; }
    const b = e.target.closest('[data-path]'); if (b) openNote(b.dataset.path);
  });
  docEl.addEventListener('click', (e) => {
    const l = e.target.closest('.vb-links [data-path]'); if (l) { openNote(l.dataset.path); return; }
    const a = e.target.closest('a[data-note]'); if (!a) return;
    e.preventDefault(); const p = resolve(a.dataset.note);
    if (p) openNote(p); else { a.style.opacity = '.5'; a.title = 'このノートはまだありません'; }
  });
  back.addEventListener('click', (e) => {
    if (e.target === back || e.target.closest('[data-x]')) close();
    else if (e.target.closest('[data-back]')) { vb.classList.remove('show-doc', 'graph'); gBtn.classList.remove('on'); }
    else if (e.target.closest('[data-graph]')) toggleGraph();
    else if (e.target.closest('[data-reload]')) { graph = null; loadList(); if (current && !vb.classList.contains('graph')) openNote(current); }
  });

  const isOpen = () => back.classList.contains('on');
  function open(opts = {}) { back.classList.add('on'); vb.classList.remove('show-doc', 'graph'); gBtn.classList.remove('on'); q.value = ''; loadList(); if (opts && typeof opts.path === 'string' && opts.path) openNote(opts.path); }
  function close() { back.classList.remove('on'); }
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) { e.stopImmediatePropagation(); e.preventDefault(); close(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); isOpen() ? close() : open(); }
  }, true);
  document.addEventListener('click', (e) => { if (e.target.closest?.('.vm-nav-folder, [data-vh-nav="folder"]')) { e.preventDefault(); open(); } }, true);
  if (new URLSearchParams(location.search).get('brain') === '1') setTimeout(open, 600);
  return { open, close };
}
