// プロジェクト管理 panel: every project at a glance (health, progress, deadline, risks, next action), the cross-project priorities and a map of related
// projects. Data comes from the server (project_insights: computed from the real notes and conversation logs); this file only draws it.
// Always draws the full layout, also when there is no project yet or the second brain is not set up.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HC = { 良好: '#5ee08a', 注意: '#ffb347', 危険: '#ff6b6b' };
const CSS = `
.vp-back{position:fixed;inset:0;z-index:55;display:none;align-items:center;justify-content:center;padding:12px;background:rgba(0,8,20,.82);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.vp-back.on{display:flex;animation:va-in .14s ease-out}
.vp{width:min(1020px,100%);max-height:94vh;display:flex;flex-direction:column;background:linear-gradient(180deg,rgba(3,26,52,.98),rgba(1,14,30,.99));color:#d9eef9;border:1.5px solid rgba(30,166,216,.9);border-radius:6px;box-shadow:0 0 18px rgba(25,190,255,.4);font:14.5px/1.55 'Barlow Semi Condensed','Noto Sans JP','Yu Gothic UI','Meiryo',sans-serif}
.vp-top{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid rgba(40,150,200,.4)}.vp-top i{width:8px;height:8px;border-radius:50%;background:#19d3ff;box-shadow:0 0 7px #19d3ff}
.vp-top h2{margin:0;font-size:15px;letter-spacing:2.5px;color:#8fe3ff;font-weight:600}.vp-top .sp{margin-left:auto}
.vp-btn{background:transparent;color:#8fe3ff;border:1px solid rgba(25,211,255,.65);border-radius:3px;padding:4px 12px;cursor:pointer;font:inherit;font-size:13.5px}.vp-btn:hover{background:rgba(25,211,255,.2);color:#fff}.vp-btn:disabled{opacity:.4}
.vp-body{overflow:auto;padding:12px 16px 16px}
.vp-banner{margin-bottom:10px;padding:8px 12px;border:1px solid rgba(25,211,255,.5);border-radius:4px;background:rgba(25,211,255,.08);color:#cfeeff;font-size:13.5px}.vp-banner.bad{border-color:rgba(255,179,71,.8);background:rgba(255,179,71,.1);color:#ffd9a0}
.vp-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:12px}
.vp-k{border:1px solid rgba(40,150,200,.4);border-radius:4px;padding:8px 12px;background:rgba(25,211,255,.05)}.vp-k small{display:block;color:#7fb6d6;font-size:12px;letter-spacing:1px}.vp-k b{font-size:21px;color:#fff;font-weight:600}.vp-k em{font-style:normal;font-size:12.5px;color:#8fb5cc;display:block;word-break:break-all}
.vp-k.bad b{color:#ff6b6b}.vp-k.warn b{color:#ffb347}.vp-k.ok b{color:#5ee08a}
.vp-h{margin:14px 0 8px;font-size:12.5px;letter-spacing:2px;color:#8fe3ff;font-weight:600}
.vp-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.vp-card{border:1px solid rgba(40,150,200,.4);border-radius:4px;padding:10px 12px;background:rgba(25,211,255,.04);min-width:0}.vp-card.click{cursor:pointer}.vp-card.click:hover{border-color:rgba(25,211,255,.9);background:rgba(25,211,255,.1)}.vp-card.ghost{opacity:.5}
.vp-card h4{margin:0 0 4px;font-size:15px;color:#fff;display:flex;align-items:center;gap:8px;word-break:break-all}
.vp-tag{display:inline-block;padding:0 8px;border:1px solid currentColor;border-radius:9px;font-size:11.5px;font-weight:600;white-space:nowrap}
.vp-bar{height:8px;background:rgba(25,211,255,.1);border-radius:5px;overflow:hidden;margin:6px 0}.vp-bar i{display:block;height:100%;border-radius:5px}
.vp-meta{display:flex;flex-wrap:wrap;gap:4px 12px;color:#8fb5cc;font-size:12.5px}
.vp-next{margin-top:6px;color:#e6f6ff}.vp-next:before{content:'▶ ';color:#19d3ff}
.vp-risk{margin-top:4px;font-size:13px;color:#ffd9a0}.vp-risk.high{color:#ff9a9a}.vp-risk:before{content:'⚠ '}
.vp-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
.vp-box{border:1px solid rgba(40,150,200,.35);border-radius:4px;padding:10px 12px;min-width:0}

/* One page: everything fits on a normal screen without scrolling; small screens fall back to scrolling. */
.vp{height:min(94vh,800px)}
.vp-body{display:flex;flex-direction:column;gap:8px;min-height:0;flex:1;overflow:auto;padding:10px 14px 12px;font-size:clamp(11.5px,1.75vh,14px)}
.vp-kpis{margin-bottom:0;gap:8px;grid-template-columns:repeat(5,minmax(0,1fr))}.vp-k{padding:5px 10px}.vp-k b{font-size:clamp(15px,2.6vh,20px)}.vp-k em{font-size:11.5px;line-height:1.35;max-height:2.8em;overflow:hidden}
.vp-h{margin:2px 0 0;font-size:12px}
.vp-cards{flex:3 1 0;min-height:0;overflow:hidden;grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-rows:minmax(0,1fr);gap:8px;align-content:start}
.vp-card{padding:6px 10px;overflow:hidden;display:flex;flex-direction:column;justify-content:center}.vp-card h4{font-size:1.05em;margin:0}.vp-bar{margin:4px 0}
.vp-card .l1{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.vp-next{margin-top:3px}.vp-risk{margin-top:2px}
.vp-two{flex:2 1 0;min-height:0;margin-top:0!important}.vp-box{padding:7px 10px;overflow:hidden;display:flex;flex-direction:column;min-height:0}.vp-box .vp-h{margin:0 0 4px}.vp-box svg{width:100%;flex:1 1 0;min-height:0}.vp-li{margin:2px 0;line-height:1.3;font-size:clamp(11px,1.7vh,14px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;min-height:0}.vp-li .vp-act{opacity:.92}.vp-box .vp-muted{font-size:clamp(10px,1.5vh,12.5px)}
@media (max-width:900px),(max-height:640px){.vp-body{overflow:auto}.vp-kpis{grid-template-columns:repeat(auto-fit,minmax(130px,1fr))}.vp-cards{grid-template-columns:1fr;overflow:visible;grid-auto-rows:auto}.vp-two{flex:none}.vp-box{overflow:visible}.vp-li{white-space:normal}.vp-card{justify-content:flex-start}}

.vp{position:relative}.vp-pop{position:absolute;left:14px;right:14px;top:56px;z-index:3;background:rgba(1,14,30,.98);border:1.5px solid rgba(30,166,216,.9);border-radius:6px;padding:10px 12px;box-shadow:0 0 14px rgba(25,190,255,.4)}.vp-pop[hidden]{display:none}
.vp-modes{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}.vp-modes .on{background:rgba(25,211,255,.28);color:#fff}.vp-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px}.vp-fl span{display:block;font-size:12px;color:#7fb6d6}
.vp-fl input,.vp-fl select,.vp-fl textarea{width:100%;box-sizing:border-box;background:rgba(0,12,28,.9);color:#d9eef9;border:1px solid rgba(40,150,200,.5);border-radius:3px;padding:5px 7px;font:inherit;font-size:13.5px}.vp-fl.wide{grid-column:1/-1}.vp-btn.pri{background:rgba(25,211,255,.25);color:#fff}.vp-msg{color:#1ee8c0;font-size:13px}.vp-msg.warn{color:#ffb347}
.vp-legend{display:flex;align-items:center;gap:8px;flex:none;color:#7fb6d6;font-size:clamp(10px,1.5vh,12.5px);min-width:0}.vp-legend .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.vp-legend b{color:#8fe3ff;font-weight:600}.vp-i{flex:none;background:none;border:1px solid rgba(25,211,255,.6);color:#8fe3ff;border-radius:50%;width:20px;height:20px;line-height:1;font-size:12px;cursor:pointer;padding:0}.vp-i:hover{background:rgba(25,211,255,.25);color:#fff}
.vp-guide{top:50px;bottom:14px;overflow:auto;background:#010e1e}.vp-guide h4{margin:10px 0 3px;color:#8fe3ff;font-size:13px;letter-spacing:1.5px}.vp-guide p,.vp-guide li{margin:3px 0;font-size:13.5px;line-height:1.55;color:#e6f6ff}.vp-guide ul{margin:2px 0;padding-left:1.2em}
@media (max-width:900px),(max-height:640px){.vp-legend .t{white-space:normal}}
.vp-li{margin:5px 0;color:#e6f6ff}.vp-li small{color:#7fb6d6}.vp-muted{color:#7fb6d6;font-size:12.5px}
`;

/** Pure SVG (tested): projects on a circle, a line per relation (thicker = more shared; dashed = one names the other). */
export function relationSvg(projects, relations, w = 460, h = 130) {
  const names = projects.map((p) => p.name).slice(0, 12), n = names.length, cx = w / 2, cy = h / 2, rx = w / 2 - 56, ry = h / 2 - 22, r = ry;
  if (!n) return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="プロジェクトの関連"><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="#2a7fa6" stroke-dasharray="4 5" opacity=".6"/><text x="${cx}" y="${cy}" text-anchor="middle" font-size="12" fill="#7fb6d6">プロジェクトがまだありません</text></svg>`;
  const pos = Object.fromEntries(names.map((nm, i) => { const a = (i / n) * Math.PI * 2 - Math.PI / 2; return [nm, { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry }]; }));
  const edges = (relations || []).filter((e) => pos[e.a] && pos[e.b]).map((e) => `<line x1="${pos[e.a].x.toFixed(1)}" y1="${pos[e.a].y.toFixed(1)}" x2="${pos[e.b].x.toFixed(1)}" y2="${pos[e.b].y.toFixed(1)}" stroke="#19d3ff" stroke-width="${(1 + Math.min(1, e.score) * 3).toFixed(1)}" opacity=".75"${e.explicit ? ' stroke-dasharray="5 4"' : ''}/>`).join('');
  const nodes = projects.slice(0, 12).map((p) => { const { x, y } = pos[p.name], c = HC[p.health] || '#7fb6d6', label = p.name.length > 9 ? p.name.slice(0, 8) + '…' : p.name; return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="${c}" stroke="#001428" stroke-width="2"/><text x="${x.toFixed(1)}" y="${(y + (y < cy ? -11 : 19)).toFixed(1)}" text-anchor="middle" font-size="11" fill="#d9eef9">${esc(label)}</text>`; }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="プロジェクトの関連">${edges}${nodes}</svg>`;
}
/** The full reading guide (what 健康度 / 進み / 最優先 mean and exactly how they are computed: server/project-intel.js). */
export const guideHtml = (note) => `<div style="display:flex;align-items:center"><b style="color:#fff;flex:1">この画面の見方</b><button class="vp-btn" data-closeguide type="button">閉じる</button></div>
<h4>健康度（良好・注意・危険）</h4><p>各プロジェクトのノート（00_概要など）の中身から、100点を持ち点にして、次に当てはまるたびに減点します。</p><ul><li>30日より長く更新がない：−25点（14日より長く更新がなく、未完了もある：−15点）</li><li>「次にやること」が決まっていない：−15点</li><li>未完了が8件以上で、完了が0件：−10点</li><li>期限まで3日以内で、未完了がある：−20点（期限を過ぎている：−30点）</li><li>ノートに課題・停滞の記述がある：−10点</li></ul><p>残った点が75点以上なら「良好」、50〜74点は「注意」、49点以下は「危険」です。一覧は点の低い順（気にかけたい順）に並びます。</p>
<h4>進み（％）</h4><p>ノートのチェックボックスのうち、完了したものの割合です：完了 ÷（完了＋未完了）。かかる時間の見積もりではありません。チェック項目がないプロジェクトは0%と表示されます。</p>
<h4>最優先</h4><p>未完了か「次にやること」があるプロジェクトのうち、期限がいちばん近いものです。期限が同じ（または無い）ときは、健康度の点が低いものを選びます。</p>
<h4>色と関連</h4><p>緑＝良好、橙＝注意、赤＝危険。右下の関連図は、ノートに共通する言葉や、互いの名前が出てくることから見つけた手がかりで、確実な関係とは限りません。</p>
<p class="vp-muted">${esc(note || '健康度・リスク・関連は、ノートと会話の記録から計算した値です。')}</p>`;
export const progressPct = (p) => { const t = (p.openTasks || 0) + (p.doneTasks || 0); return t ? Math.round((p.doneTasks / t) * 100) : 0; };

export function initProjectView({ call, onOpenNote = () => {}, onUpdate = null }) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const back = document.createElement('div'); back.className = 'vp-back'; back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true'); back.setAttribute('aria-label', 'プロジェクト管理');
  back.innerHTML = `<div class="vp"><div class="vp-top"><i></i><h2>PROJECTS</h2><span class="sp"></span><button class="vp-btn" data-add type="button">＋ 追加</button>${onUpdate ? '<button class="vp-btn" data-update type="button" title="進捗ログを更新して、統合ダッシュボードを作り直します">進捗を更新</button>' : ''}<button class="vp-btn" data-open-build type="button" title="Claude Codeに頼んだ製作の進み具合を見ます">製作</button><button class="vp-btn" data-reload type="button">↻</button><button class="vp-btn" data-x type="button">閉じる</button></div><div class="vp-body" id="vp-body">読み込み中…</div><div class="vp-pop" id="vp-pop" hidden></div><div class="vp-pop vp-guide" id="vp-guide" hidden></div></div>`;
  document.body.appendChild(back);
  const body = back.querySelector('#vp-body');
  let data = null, mode = 'new';
  const pop = back.querySelector('#vp-pop');
  const guide = back.querySelector('#vp-guide');
  const MODES = { 新規プロジェクト: 'new', やること: 'task', アイデア: 'idea', 進捗: 'progress' };
  const KIND = { task: 'やること', idea: 'アイデア', progress: '進捗' };
  const names = () => (data?.projects || []).map((p) => p.name);
  function form() {
    if (mode === 'new') return `<label class="vp-fl"><span>プロジェクト名</span><input id="vp-f-name" type="text" placeholder="家計簿アプリ"></label><label class="vp-fl"><span>一言で（何を作る・やる？）</span><input id="vp-f-sum" type="text"></label><label class="vp-fl wide"><span>アイデア・きっかけ（任意）</span><textarea id="vp-f-idea" rows="2"></textarea></label>`;
    const opts = names().map((n) => `<option>${esc(n)}</option>`).join('');
    return `<label class="vp-fl"><span>プロジェクト</span><select id="vp-f-proj">${opts || '<option value="">（まだありません）</option>'}</select></label><label class="vp-fl wide"><span>${mode === 'task' ? 'やること' : mode === 'idea' ? 'アイデア' : '進捗（ここまで進んだこと）'}</span><textarea id="vp-f-text" rows="2"></textarea></label>`;
  }
  function popHtml() { return `<div class="vp-modes">${Object.entries(MODES).map(([l, m]) => `<button type="button" class="vp-btn${m === mode ? ' on' : ''}" data-mode="${m}">${l}</button>`).join('')}</div><div class="vp-form">${form()}</div><div style="margin-top:8px;display:flex;gap:10px;align-items:center"><button class="vp-btn pri" data-submit type="button">追加する</button><button class="vp-btn" data-cancel type="button">閉じる</button><span class="vp-msg" id="vp-msg"></span></div>`; }
  const ghost = (name, health) => `<div class="vp-card ghost"><h4>${name} <span class="vp-tag" style="color:${HC[health]}">${health}</span></h4><div class="vp-bar"><i style="width:${health === '良好' ? 60 : 25}%;background:${HC[health]}"></i></div><div class="vp-meta"><span>最終更新 —</span><span>未完了 — / 完了 —</span></div><div class="vp-next">次の行動：—</div></div>`;

  function render(d) {
    data = d; const list = d.projects || [], none = !list.length;
    const banner = d.unconfigured ? '<div class="vp-banner bad">第二の脳（GitHub）が未設定のため、まだプロジェクトを管理できません。設定すると、ここに表示されます（下の表示は、まだないときの見本です）。</div>'
      : d.error ? `<div class="vp-banner bad">プロジェクトを読み込めませんでした：${esc(d.error)}</div>`
      : none ? '<div class="vp-banner">まだプロジェクトがありません。新しいアイデアを話すと「新規プロジェクトファイルを作成しますか？」と尋ねます。作ると、ここに表示されます。</div>' : '';
    const risky = (d.summary?.atRisk || []).length, soon = list.filter((p) => p.deadline && p.deadline.inDays <= 7 && p.openTasks > 0);
    const kpis = `<div class="vp-kpis">
      <div class="vp-k"><small>プロジェクト</small><b>${d.count || 0}</b><em>${list.filter((p) => p.health === '良好').length} 件が良好</em></div>
      <div class="vp-k ${risky ? 'warn' : 'ok'}"><small>注意・危険</small><b>${risky}</b><em>${esc((d.summary?.atRisk || []).slice(0, 2).join('・')) || '問題なし'}</em></div>
      <div class="vp-k"><small>いま最優先</small><b style="font-size:16px">${esc(d.summary?.focus?.project || '—')}</b><em>${esc(d.summary?.focus?.action || 'まだありません')}</em></div>
      <div class="vp-k ${soon.length ? 'bad' : ''}"><small>期限が1週間以内</small><b>${soon.length}</b><em>${esc(soon.slice(0, 2).map((p) => `${p.name}（${p.deadline.inDays <= 0 ? '今日まで' : p.deadline.inDays + '日後'}）`).join('・')) || 'なし'}</em></div>
      <div class="vp-k"><small>関連のある組</small><b>${(d.relations || []).length}</b><em>${esc((d.relations || []).slice(0, 1).map((r) => `${r.a} ⇄ ${r.b}`).join('')) || 'まだ見つかっていません'}</em></div></div>`;
    const SHOW = 6, shown = list.slice(0, SHOW);
    const cards = (none ? ghost('プロジェクトの名前', '良好') + ghost('止まっているプロジェクト', '注意') : shown.map((p) => `<div class="vp-card click" data-open="${esc(p.name)}"><h4>${esc(p.name)} <span class="vp-tag" style="color:${HC[p.health] || '#7fb6d6'}">${esc(p.health)}</span></h4>
        <div class="vp-bar" title="完了の割合"><i style="width:${progressPct(p)}%;background:${HC[p.health] || '#7fb6d6'}"></i></div>
        <div class="vp-meta l1"><span>進み ${progressPct(p)}%（${p.doneTasks}/${p.doneTasks + p.openTasks}）</span><span>更新 ${p.daysSinceUpdate != null ? p.daysSinceUpdate + '日前' : '—'}</span>${p.deadline ? `<span>期限 ${esc(p.deadline.date.slice(5).replace('-', '/'))}</span>` : ''}${p.mentionsLast14d ? `<span>会話 ${p.mentionsLast14d}回</span>` : ''}</div>
        <div class="vp-next l1">${esc(p.nextAction)}</div>${p.risks[0] ? `<div class="vp-risk l1 ${p.risks[0].severity}">${esc(p.risks[0].text)}${p.risks.length > 1 ? `（ほか${p.risks.length - 1}件）` : ''}</div>` : ''}</div>`).join('')); const moreN = Math.max(0, list.length - SHOW);
    const next = list.filter((p) => p.openTasks > 0 || p.nextActions.length).sort((a, b) => (a.deadline?.inDays ?? 99) - (b.deadline?.inDays ?? 99) || a.score - b.score).slice(0, 4).map((p) => `<div class="vp-li"><b>${esc(p.name)}</b> <small>${esc(p.health)}</small> <span class="vp-act">${esc(p.nextAction)}</span></div>`).join('') || '<p class="vp-muted">プロジェクトができると、次にやることを優先順に出します。</p>';
    const rel = (d.relations || []).slice(0, 2).map((r) => `<div class="vp-li"><b>${esc(r.a)}</b> ⇄ <b>${esc(r.b)}</b> <small>${esc(r.reason)}${r.explicit ? '' : `（類似 ${Math.round(r.score * 100)}%）`}</small></div>`).join('') || '<p class="vp-muted">プロジェクトが2つ以上あり、共通の言葉や名前の出現があると、関連をここに出します（手がかりであり、確実な関係とは限りません）。</p>';
    body.innerHTML = banner + kpis + `<div class="vp-h">プロジェクト一覧（健康度の低い順。押すと概要を開く）${moreN ? `　<span class="vp-muted">ほか ${moreN} 件は省略</span>` : ''}</div><div class="vp-cards">${cards}</div>
      <div class="vp-two"><div class="vp-box"><div class="vp-h" style="margin-top:0">次の行動（優先順）</div>${next}</div><div class="vp-box"><div class="vp-h" style="margin-top:0">プロジェクト間の関連</div>${relationSvg(list, d.relations)}${rel}</div></div>
      <div class="vp-legend"><span class="t"><b>見方</b>　健康度＝100点から減点（75点以上 良好／50〜74 注意／49以下 危険）　進み＝完了÷（完了＋未完了）　最優先＝期限が近く、点の低いもの</span><button class="vp-i" data-guide type="button" title="この画面の見方を開く" aria-label="この画面の見方を開く">i</button></div>`;
    guide.innerHTML = guideHtml(d.note);
  }
  async function load() {
    body.textContent = '読み込み中…';
    try { render(await call('project_insights', {})); }
    catch (e) { render({ count: 0, projects: [], relations: [], summary: {}, error: e.message }); }
  }
  back.addEventListener('click', async (e) => {
    if (e.target === back || e.target.closest('[data-x]')) { guide.hidden = true; back.classList.remove('on'); }
    else if (e.target.closest('[data-reload]')) load();
    else if (e.target.closest('[data-guide]')) guide.hidden = !guide.hidden;
    else if (e.target.closest('[data-closeguide]')) guide.hidden = true;
    else if (e.target.closest('[data-add]')) { pop.innerHTML = popHtml(); pop.hidden = !pop.hidden; if (!pop.hidden) pop.querySelector('input,textarea,select')?.focus(); }
    else if (e.target.closest('[data-mode]')) { mode = e.target.closest('[data-mode]').dataset.mode; pop.innerHTML = popHtml(); }
    else if (e.target.closest('[data-cancel]')) pop.hidden = true;
    else if (e.target.closest('[data-submit]')) {
      const msg = pop.querySelector('#vp-msg'), v = (id) => (pop.querySelector('#vp-f-' + id)?.value ?? '').trim(); msg.className = 'vp-msg'; msg.textContent = '追加中…';
      try {
        const r = mode === 'new' ? await call('project_create', { name: v('name'), summary: v('sum') || undefined, idea: v('idea') || undefined, trigger: '画面から手で追加' }) : await call('project_add', { project: v('proj'), kind: KIND[mode], text: v('text') });
        await load(); pop.innerHTML = popHtml(); pop.hidden = false; const m2 = pop.querySelector('#vp-msg'); m2.className = 'vp-msg'; m2.textContent = r?.message || '追加しました';
      } catch (err) { msg.className = 'vp-msg warn'; msg.textContent = err.message; }
    }
    else if (e.target.closest('[data-update]')) { try { onUpdate?.(); } catch {} const b = back.querySelector('[data-update]'); if (b) { b.textContent = '更新を依頼しました'; b.disabled = true; } }
    else { const c = e.target.closest('[data-open]'); if (c) onOpenNote(`プロジェクト/${c.dataset.open}/00_概要.md`); }
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && back.classList.contains('on')) { e.stopImmediatePropagation(); back.classList.remove('on'); } }, true);
  return { open() { back.classList.add('on'); return load(); }, show(d) { back.classList.add('on'); render(d); }, close() { back.classList.remove('on'); }, el: back, get data() { return data; } };
}
