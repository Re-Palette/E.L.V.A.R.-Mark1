import { ownerAddress } from './brand.js';
// 履修 panel (履修登録サポート): the weekly timetable of a term (月–土 × 時限), credit meters per category and in total against the graduation requirements,
// the per-term cap (CAP), the course list, the checks ("注意") and course suggestions. Everything is computed by the server (course_summary / course_suggest);
// this file only draws it and sends the manual edits. The app cannot see the university's registration site or syllabus: the data is what the owner entered.
// It reuses the .vf-* look injected by finance-view.js (same family of screens).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PALETTE = ['#19d3ff', '#1ee8c0', '#a78bfa', '#ff6b9d', '#5ee08a', '#6ea8fe', '#f5e663', '#ff8a5c'];
const STATUSES = ['候補', '履修', '抽選待ち', '取消', '修得済み'];
const DAYS = ['月', '火', '水', '木', '金', '土'];
/** Pure (tested): a stable colour for a category name. */
export function catColor(name) { let h = 0; for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return name ? PALETTE[h % PALETTE.length] : '#7fb6d6'; }
/** Pure (tested): 'YYYY-前期' ± n terms. */
export function shiftTerm(t, d) { const i = Number(t.slice(0, 4)) * 2 + (t.slice(5) === '前期' ? 0 : 1) + d; return `${Math.floor(i / 2)}-${i % 2 ? '後期' : '前期'}`; }
export const termName = (t) => `${t.slice(0, 4)}年度 ${t.slice(5)}`;
export function currentTermName(nowMs = Date.now()) { const d = new Date(nowMs + 9 * 3600e3), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1; return `${m >= 4 ? y : y - 1}-${m >= 4 && m <= 9 ? '前期' : '後期'}`; }
/** Pure (tested): the cells of the timetable as an HTML string (days across, periods down). */
export function timetableHtml(grid) {
  const days = grid?.days || DAYS, periods = grid?.periods || [], cells = grid?.cells || {};
  const head = '<div class="vcr-h"></div>' + days.map((d) => `<div class="vcr-h">${d}</div>`).join('');
  const rows = periods.map((p) => `<div class="vcr-p" title="${p.start ? `${p.n}限 ${p.start}–${p.end}` : `${p.n}限`}"><b>${p.n}</b><small>${esc(p.start ? p.start.replace(/^0/, '') : '')}</small></div>` + days.map((d) => {
    const items = cells[`${d}${p.n}`] || [];
    return `<div class="vcr-c">${items.map((c) => { const cls = ['vcr-chip', c.status === '候補' || c.status === '抽選待ち' ? 'cand' : '', c.status === '修得済み' ? 'done' : '', c.conflict === 'registered' ? 'bad' : c.conflict ? 'warn' : ''].join(' ');
      return `<span class="${cls}" style="--c:${catColor(c.category)}" title="${esc(`${c.name}（${c.status}・${c.credits}単位${c.category ? '・' + c.category : ''}${c.conflict ? '・時間が重なっています' : ''}）`)}">${c.first ? (c.status === '抽選待ち' ? '？' : '') + esc(c.name) : '〃'}</span>`; }).join('')}</div>`;
  }).join('')).join('');
  return head + rows;
}
const CSS = `
.vcr-tt{display:grid;grid-template-columns:2.7em repeat(6,minmax(0,1fr));grid-template-rows:auto;grid-auto-rows:minmax(0,1fr);gap:2px;flex:1;min-height:0}
.vcr-h{font-size:11px;color:#7fb6d6;text-align:center;line-height:1.2}
.vcr-p{display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1;font-size:11px;color:#9fc3d8;min-height:0}.vcr-p small{font-size:8.5px;color:#6f9db8}
.vcr-c{border:1px solid rgba(40,150,200,.2);border-radius:3px;display:flex;gap:1px;min-width:0;min-height:0;overflow:hidden;background:rgba(25,211,255,.025)}
.vcr-chip{flex:1;min-width:0;display:flex;align-items:center;font-size:10.5px;line-height:1.1;padding:0 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#eafaff;background:color-mix(in srgb,var(--c) 30%,transparent);border-left:3px solid var(--c);border-radius:2px}
.vcr-chip.cand{background:rgba(255,179,71,.16);border:1px dashed #ffb347;color:#ffe1b0}.vcr-chip.done{opacity:.55}
.vcr-chip.bad{background:rgba(255,77,94,.3);border:1px solid #ff5c6c;color:#fff}.vcr-chip.warn{background:rgba(255,77,94,.16);border:1px dashed #ff5c6c}
.vcr-off{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px;font-size:10.5px;color:#9fc3d8}.vcr-off .vcr-chip{flex:none;max-width:48%;padding:1px 5px}
.vcr-lg{display:flex;gap:10px;flex-wrap:wrap;font-size:10.5px;color:#9fc3d8;margin:0 0 3px}.vcr-lg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px;border:1px solid}
.vcr-lg .a{background:rgba(25,211,255,.3);border-color:#19d3ff}.vcr-lg .b{background:rgba(255,179,71,.2);border:1px dashed #ffb347}.vcr-lg .c{background:rgba(255,77,94,.35);border-color:#ff5c6c}
.vcr-m{display:flex;align-items:center;gap:6px;margin:2px 0;white-space:nowrap;overflow:hidden}.vcr-m .n{flex:0 0 6.3em;overflow:hidden;text-overflow:ellipsis}.vcr-m .v{flex:0 0 auto;color:#fff;font-size:.92em}
.vcr-bar{flex:1;height:8px;min-width:30px;background:rgba(25,211,255,.1);border-radius:4px;overflow:hidden;display:flex}.vcr-bar i{display:block;height:100%}.vcr-bar .e{background:#19d3ff}.vcr-bar .g{background:#1ee8c0;opacity:.75}.vcr-bar .l{background:#ffb347;opacity:.6}.vcr-bar.over{outline:1px solid #ff5c6c}
.vcr-li{display:flex;gap:6px;align-items:center;margin:2px 0;white-space:nowrap;overflow:hidden}.vcr-li .t{overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}.vcr-li .v{color:#9fc3d8;font-size:.92em;flex:none}.vcr-li .sq{width:8px;height:8px;border-radius:2px;flex:none}
.vcr-li select{background:rgba(0,12,28,.9);color:#d9eef9;border:1px solid rgba(40,150,200,.45);border-radius:3px;font:inherit;font-size:.9em;padding:0 2px;flex:none}
.vcr-x{background:none;border:0;color:#8fe3ff;cursor:pointer;padding:0 3px;font-size:13px}.vcr-x.d{color:#ff8a8a}
.vcr-list{overflow:auto;min-height:0;flex:1}.vcr-sp2{grid-column:span 2}
.vcr-ck{display:flex;gap:6px;align-items:baseline;margin:2px 0;overflow:hidden;white-space:nowrap}.vcr-ck span{overflow:hidden;text-overflow:ellipsis;min-width:0}.vcr-ck b{flex:none;width:8px;height:8px;border-radius:50%;display:inline-block;background:#7fb6d6}.vcr-ck.bad b{background:#ff5c6c}.vcr-ck.warn b{background:#ffb347}.vcr-ck.bad span{color:#ffc9cf}.vcr-ck.warn span{color:#ffe1b0}
.vcr-pf{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:.92em;margin-bottom:3px;color:#cfe3ee}.vcr-pf select{background:rgba(0,12,28,.9);color:#d9eef9;border:1px solid rgba(40,150,200,.45);border-radius:3px;font:inherit;padding:0 2px}.vcr-sf{display:flex;gap:6px;align-items:center;margin-top:3px}.vcr-sf .vf-muted{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.vcr-sf .vf-btn{flex:none;padding:2px 10px}.vcr-pf .vf-btn{padding:1px 8px}.vcr-pf label{display:flex;gap:3px;align-items:center;white-space:nowrap}
@media (min-width:901px){.vcr-grid.vf-grid{grid-template-rows:minmax(0,1.3fr) minmax(0,1fr)}}
@media (min-width:901px) and (max-height:640px){.vcr-chip{font-size:10px}.vcr-p small{display:none}.vcr-lg{display:none}}
@media (max-width:900px){.vcr-sp2{grid-column:auto}.vcr-tt{grid-auto-rows:minmax(30px,auto)}.vcr-tt .vcr-chip{font-size:9.5px;padding:0 2px}.vcr-list{max-height:260px}.vf-top{flex-wrap:wrap}}
`;

export function initCourseView({ call }) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const back = document.createElement('div'); back.className = 'vf-back'; back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true'); back.setAttribute('aria-label', '履修');
  back.innerHTML = `<div class="vf"><div class="vf-top"><i></i><h2>COURSES</h2><button class="vf-btn" data-prev type="button">◀</button><b id="vcr-term" style="min-width:7em;text-align:center"></b><button class="vf-btn" data-next type="button">▶</button><span class="sp"></span><button class="vf-btn" data-open-shift type="button">シフト</button><button class="vf-btn" data-suggest type="button">✦ 提案</button><button class="vf-btn" data-reload type="button">↻</button><button class="vf-btn" data-x type="button">閉じる</button></div><div class="vf-body" id="vcr-body">読み込み中…</div></div>`;
  document.body.appendChild(back);
  const body = back.querySelector('#vcr-body'), label = back.querySelector('#vcr-term');
  let term = '', data = null, sug = null, mode = 'course', editing = null, prefs = { avoid1限: false, freeDay: '', maxPerDay: '' };
  const num1 = (n) => (Math.round(Number(n) * 10) / 10).toString();

  function meters(d) {
    const cr = d.credits || {}, t = cr.total || {}, row = (n, e, g, l, max, text, tag) => { const m = Math.max(max || 0, e + g + l, 1); return `<div class="vcr-m"><span class="n" title="${esc(n)}">${esc(n)}</span><span class="vcr-bar${e + g > (max || Infinity) ? ' over' : ''}"><i class="e" style="width:${(e / m) * 100}%"></i><i class="g" style="width:${(g / m) * 100}%"></i><i class="l" style="width:${(l / m) * 100}%"></i></span><span class="v">${text}</span>${tag || ''}</div>`; };
    const rows = [];
    rows.push(row('卒業単位', t.earned || 0, t.registered || 0, 0, t.required, t.required != null ? `${num1((t.earned || 0) + (t.registered || 0))}/${t.required}` : `${num1((t.earned || 0) + (t.registered || 0))}単位`, t.required != null && t.remaining > 0 ? `<span class="vf-tag warn">あと${num1(t.remaining)}</span>` : t.required != null ? '<span class="vf-tag ok">達成</span>' : ''));
    rows.push(row('今学期の上限', 0, cr.registered || 0, cr.over ? 0 : Math.min(cr.lottery || 0, Math.max(0, (cr.cap ?? Infinity) - (cr.registered || 0))), cr.cap, cr.cap != null ? `${num1(cr.registered)}/${cr.cap}` : `${num1(cr.registered)}（上限未設定）`, cr.over ? '<span class="vf-tag bad">超過</span>' : ''));
    for (const c of cr.categories || []) rows.push(row(c.name, c.earned, c.registered, 0, c.required, c.required != null ? `${num1(c.earned + c.registered)}/${c.required}` : `${num1(c.earned + c.registered)}`, c.short ? `<span class="vf-tag warn">あと${num1(c.remaining)}</span>` : c.required != null ? '<span class="vf-tag ok">OK</span>' : ''));
    const none = !t.required && !(cr.categories || []).some((c) => c.required != null);
    return rows.join('') + `<div class="vf-muted">${'<span style="color:#19d3ff">■</span> 修得済み　<span style="color:#1ee8c0">■</span> 履修　<span style="color:#ffb347">■</span> 抽選待ち'}${none ? '　卒業要件は未設定（「卒業に124単位」のように話すか、＋追加から）' : ''}</div>`;
  }
  function suggestionsHtml() {
    const dayOpts = ['', ...DAYS].map((x) => `<option value="${x}"${prefs.freeDay === x ? ' selected' : ''}>${x ? x + '曜' : 'なし'}</option>`).join(''), mpd = ['', '2', '3', '4'].map((x) => `<option value="${x}"${prefs.maxPerDay === x ? ' selected' : ''}>${x ? x + 'コマ' : 'なし'}</option>`).join('');
    const ctl = `<div class="vcr-pf"><label><input type="checkbox" data-pf="avoid1"${prefs.avoid1限 ? ' checked' : ''}>1限なし</label><label>空ける<select data-pf="free">${dayOpts}</select></label><label>1日<select data-pf="mpd">${mpd}</select></label><button class="vf-btn" data-suggest type="button">✦ 作る</button></div>`;
    if (!sug) return ctl + '<div class="vf-muted">「候補」の科目から、必修と足りない区分を優先し、重ならず上限を超えない組み合わせを選びます（登録は了承してから。大学の履修登録は、ご自身でします）。</div>';
    if (!sug.proposals?.length) return ctl + `<div class="vf-muted">${esc(sug.notes?.[0] || '条件に合う候補がありませんでした。')}</div>`;
    const sumText = `合計 ${num1(sug.addedCredits)}単位 → 履修 ${num1(sug.registeredAfter)}${sug.cap != null ? `／上限${sug.cap}` : ''}単位・${(sug.daysAfter || []).join('・') || 'なし'}曜${sug.notes?.length ? '／' + sug.notes[0] : ''}`;
    return ctl + `<div class="vcr-list" style="min-height:44px">${sug.proposals.map((p, i) => `<label class="vcr-li" title="${esc(p.reason)}"><input type="checkbox" data-p="${i}" checked><span class="t">${esc(p.name)}　${esc(p.slotsText)}・${num1(p.credits)}単位${p.required ? '・必修' : ''}</span><span class="v">${esc((p.reason || '').split('。')[0])}</span></label>`).join('')}</div><div class="vcr-sf"><span class="vf-muted" title="${esc(sumText)}">${esc(sumText)}</span><button class="vf-btn pri" data-apply type="button">履修にする</button></div>`;
  }

  function render(d) {
    data = d; term = d.term; label.textContent = termName(d.term);
    const cr = d.credits || {}, checks = d.checks || [], bad = checks.filter((c) => c.level !== 'info').length, regConf = (d.conflicts || []).filter((c) => c.level === 'registered').length;
    const banner = d.unconfigured ? '<div class="vf-banner bad">第二の脳が未設定のため、履修は記録できません。</div>' : d.error ? `<div class="vf-banner bad">${esc(d.error)}</div>` : d.empty && !d.hasRequirements ? '<div class="vf-banner">まだ科目がありません。「＋ 追加」から科目を入れるか、「月曜3限に線形代数、2単位」のように話しかけてください。大学の履修登録システムとは連動していません。</div>' : '';
    const t = cr.total || {}, kpis = `<div class="vf-kpis">
      <div class="vf-k ${cr.over ? 'bad' : ''}"><small>今学期の履修</small><b>${num1(cr.registered || 0)}単位</b><em>${cr.cap != null ? `上限 ${cr.cap}（${cr.over ? num1(-cr.capLeft) + '超過' : '残り ' + num1(cr.capLeft)}）` : '上限は未設定'}</em></div>
      <div class="vf-k"><small>候補・抽選待ち</small><b>${num1((cr.candidate || 0) + (cr.lottery || 0))}単位</b><em>候補 ${num1(cr.candidate || 0)}／抽選待ち ${num1(cr.lottery || 0)}</em></div>
      <div class="vf-k ${t.required != null && t.remaining === 0 ? 'ok' : ''}"><small>卒業まで</small><b>${t.required != null ? `あと ${num1(t.remaining)}` : '—'}</b><em>${t.required != null ? `修得 ${num1(t.earned)}＋履修 ${num1(t.registered)}／${t.required}` : '卒業単位は未設定'}</em></div>
      <div class="vf-k ${regConf ? 'bad' : ''}"><small>時間の重なり</small><b>${(d.conflicts || []).length}件</b><em>${regConf ? `履修同士 ${regConf}件` : '履修同士の重なりなし'}</em></div>
      <div class="vf-k ${bad ? 'warn' : ''}"><small>注意</small><b>${bad}件</b><em>${esc(checks.find((c) => c.level !== 'info')?.text.slice(0, 20) || '大きな問題なし')}</em></div></div>`;
    const grid = d.grid || {};
    const off = (grid.offGrid || []).length ? `<div class="vcr-off">時間割外：${grid.offGrid.map((c) => `<span class="vcr-chip${c.status === '候補' || c.status === '抽選待ち' ? ' cand' : ''}" style="--c:${catColor(c.category)}">${esc(c.name)}（${esc(c.kind)}）</span>`).join('')}</div>` : '';
    const tt = `<div class="vcr-lg"><span><i class="a"></i>履修</span><span><i class="b"></i>候補・抽選待ち</span><span><i class="c"></i>時間が重なる</span><span>色＝区分</span></div><div class="vcr-tt">${timetableHtml(grid)}</div>${off}`;
    const list = (d.courses || []).map((c) => `<div class="vcr-li" title="${esc(`${c.name} ${c.time || c.slotsText}${c.instructor ? '／' + c.instructor : ''}${c.room ? '／' + c.room : ''}${c.memo ? '／' + c.memo : ''}`)}"><i class="sq" style="background:${catColor(c.category)}"></i><span class="t">${esc(c.name)}${c.required ? ' ★' : ''}</span><span class="v">${esc(c.slotsText)}・${num1(c.credits)}</span><select data-st="${esc(c.id)}" aria-label="状態">${STATUSES.map((s) => `<option${s === c.status ? ' selected' : ''}>${s}</option>`).join('')}</select><button class="vcr-x" data-edit="${esc(c.id)}" title="直す" type="button">✎</button><button class="vcr-x d" data-del="${esc(c.id)}" title="記録を消す" type="button">✕</button></div>`).join('') || '<div class="vf-muted">この学期の科目はまだありません。</div>';
    const chk = checks.map((c) => `<div class="vcr-ck ${c.level}" title="${esc(c.text)}"><b></b><span>${esc(c.text)}</span></div>`).join('') || '<div class="vf-muted">記録された範囲では、気になる点はありません。</div>';
    body.innerHTML = banner + kpis + `<div class="vf-grid vcr-grid">
      <div class="vf-card vcr-sp2"><h3>${esc(termName(d.term))}の時間割</h3>${tt}</div>
      <div class="vf-card"><h3>単位のメーター</h3><div class="vcr-list">${meters(d)}</div></div>
      <div class="vf-card"><h3>科目（${(d.courses || []).length}件・状態は選んで変更）</h3><div class="vcr-list">${list}</div></div>
      <div class="vf-card"><h3>注意</h3><div class="vcr-list">${chk}</div></div>
      <div class="vf-card"><h3>履修の提案</h3>${suggestionsHtml()}</div></div>
      <div class="vf-foot"><span class="vf-muted">${esc(d.note ? '大学の履修登録システム・シラバスは見えません。ここは、' + ownerAddress() + 'が教えた内容だけです' : '')}</span><div class="r"></div><button class="vf-btn" data-showadd type="button">＋ 追加</button></div>` + addBox();
  }

  const inp = (id, lab, extra = '') => `<label class="vf-fl"><span>${lab}</span><input id="vcr-f-${id}" ${extra}></label>`;
  const sel = (id, lab, opts, v = '') => `<label class="vf-fl"><span>${lab}</span><select id="vcr-f-${id}">${opts.map(([val, t]) => `<option value="${esc(val)}"${val === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  const FORMS = {
    course: () => { const c = editing ? (data?.courses || []).find((x) => x.id === editing) : null, cats = Object.keys(data?.requirements?.categories || {}); return inp('name', '科目名', `type="text" value="${esc(c?.name || '')}"`) + inp('slot', '曜日・時限（月3 / 火2-3 / 集中）', `type="text" placeholder="月3" value="${esc(c?.slotsText || '')}"`) + inp('credits', '単位', `type="number" min="0" step="0.5" inputmode="decimal" value="${c ? c.credits : ''}"`) + `<label class="vf-fl"><span>区分</span><input id="vcr-f-category" list="vcr-cats" value="${esc(c?.category || '')}"><datalist id="vcr-cats">${[...new Set([...cats, '必修', '選択必修', '選択', '教養', '専門', '自由'])].map((x) => `<option>${esc(x)}</option>`).join('')}</datalist></label>` + sel('status', '状態', STATUSES.map((s) => [s, s]), c?.status || '候補') + sel('required', '必修', [['', '区分から自動'], ['1', '必修'], ['0', '必修ではない']], c ? (c.required ? '1' : '0') : '') + inp('instructor', '教員', `type="text" value="${esc(c?.instructor || '')}"`) + inp('room', '教室', `type="text" value="${esc(c?.room || '')}"`) + inp('memo', 'メモ', `type="text" value="${esc(c?.memo || '')}"`); },
    req: () => inp('total', '卒業に必要な単位', 'type="number" min="0" inputmode="numeric" placeholder="124"') + inp('cap', '1学期の履修上限（CAP）', 'type="number" min="0" inputmode="numeric" placeholder="24"') + inp('catname', '区分の名前', 'type="text" placeholder="必修"') + inp('catcr', 'その区分に必要な単位', 'type="number" min="0" inputmode="numeric" placeholder="30"') + inp('required', '必修科目（、区切り）', 'type="text" placeholder="線形代数、微分積分"'),
    time: () => sel('period', '時限', [1, 2, 3, 4, 5, 6, 7].map((n) => [String(n), `${n}限`]), '1') + inp('start', '開始', 'type="time" value="09:00"') + inp('end', '終了', 'type="time" value="10:30"') + sel('tp', '授業期間を決める学期（任意）', [['', '（変えない）'], ['前期', '前期'], ['後期', '後期']]) + inp('from', '授業開始（月-日）', 'type="text" placeholder="10-01"') + inp('to', '授業終了（月-日）', 'type="text" placeholder="01-31"'),
  };
  const MODES = { 科目: 'course', '卒業要件・上限': 'req', 時限の時刻: 'time' };
  function addBox() { return `<div class="vf-card vf-imp" id="vcr-imp" hidden><h3>${editing ? '科目を直す' : '追加'}（手で入力。話しかけても同じです）</h3><div class="vf-modes">${Object.entries(MODES).map(([l, m]) => `<button type="button" class="vf-btn${m === mode ? ' on' : ''}" data-mode="${m}">${l}</button>`).join('')}</div><div class="vf-form" id="vcr-form">${FORMS[mode]()}</div><div style="margin-top:8px;display:flex;gap:8px;align-items:center"><button class="vf-btn pri" data-submit type="button">${editing ? '更新' : '追加'}</button><button class="vf-btn" data-cancel type="button">閉じる</button><span class="vf-msg" id="vcr-msg"></span></div></div>`; }

  async function load(t) {
    body.textContent = '読み込み中…';
    try { render(await call('course_summary', t ? { term: t } : {})); }
    catch (e) { render({ term: t || currentTermName(), courses: [], grid: {}, conflicts: [], credits: {}, checks: [], error: e.message }); }
  }
  const showBox = (text, bad) => { const box = back.querySelector('#vcr-imp'); if (!box) return; box.hidden = false; const msg = back.querySelector('#vcr-msg'); msg.textContent = text || ''; msg.className = 'vf-msg' + (bad ? ' warn' : ''); };
  const fail = (err) => body.insertAdjacentHTML('afterbegin', `<div class="vf-banner bad">${esc(err.message)}</div>`);
  const prefArgs = () => ({ term, ...(prefs.avoid1限 ? { avoid1限: true } : {}), ...(prefs.freeDay ? { freeDays: [prefs.freeDay] } : {}), ...(prefs.maxPerDay ? { maxPerDay: Number(prefs.maxPerDay) } : {}) });
  back.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.matches('[data-pf]')) { const k = t.dataset.pf; if (k === 'avoid1') prefs.avoid1限 = t.checked; else if (k === 'free') prefs.freeDay = t.value; else prefs.maxPerDay = t.value; }
    else if (t.matches('[data-st]')) { try { await call('course_update', { id: t.dataset.st, term, status: t.value }); sug = null; await load(term); } catch (err) { fail(err); } }
  });
  back.addEventListener('click', async (e) => {
    const t = e.target;
    if (t === back || t.closest('[data-x]')) back.classList.remove('on');
    else if (t.closest('[data-prev]')) { sug = null; load(shiftTerm(term || currentTermName(), -1)); }
    else if (t.closest('[data-next]')) { sug = null; load(shiftTerm(term || currentTermName(), 1)); }
    else if (t.closest('[data-reload]')) load(term);
    else if (t.closest('[data-showadd]')) { editing = null; mode = 'course'; const b = back.querySelector('#vcr-imp'); const was = b.hidden; b.outerHTML = addBox(); back.querySelector('#vcr-imp').hidden = !was; }
    else if (t.closest('[data-edit]')) { editing = t.closest('[data-edit]').dataset.edit; mode = 'course'; back.querySelector('#vcr-imp').outerHTML = addBox(); back.querySelector('#vcr-imp').hidden = false; }
    else if (t.closest('[data-mode]')) { editing = null; mode = t.closest('[data-mode]').dataset.mode; back.querySelector('#vcr-imp').outerHTML = addBox(); back.querySelector('#vcr-imp').hidden = false; }
    else if (t.closest('[data-cancel]')) { editing = null; back.querySelector('#vcr-imp').hidden = true; }
    else if (t.closest('[data-suggest]')) { body.insertAdjacentHTML('afterbegin', '<div class="vf-banner">提案を作っています…</div>'); try { sug = await call('course_suggest', prefArgs()); } catch (err) { sug = { proposals: [], notes: [err.message] }; } render(data); }
    else if (t.closest('[data-apply]')) {
      const picked = [...back.querySelectorAll('[data-p]')].filter((c) => c.checked).map((c) => sug.proposals[Number(c.dataset.p)].id); if (!picked.length) return;
      try { await call('course_update', { ids: picked, term, status: '履修' }); sug = null; await load(term); } catch (err) { fail(err); }
    }
    else if (t.closest('[data-del]')) {
      const id = t.closest('[data-del]').dataset.del; if (!confirm('この科目の記録を消しますか？（履修をやめた・抽選に落ちた場合は、消さずに状態を「取消」にできます）')) return;
      try { await call('course_cancel', { id, term, confirmed: true }); await load(term); } catch (err) { fail(err); }
    }
    else if (t.closest('[data-submit]')) {
      const msg = back.querySelector('#vcr-msg'), v = (id) => (back.querySelector('#vcr-f-' + id)?.value ?? '').trim(); msg.className = 'vf-msg'; msg.textContent = '保存中…';
      try {
        let r;
        if (mode === 'course') {
          const a = { name: v('name'), slot: v('slot'), credits: v('credits') === '' ? undefined : Number(v('credits')), category: v('category'), status: v('status'), instructor: v('instructor'), room: v('room'), memo: v('memo'), ...(v('required') !== '' ? { required: v('required') === '1' } : {}) };
          r = editing ? await call('course_update', { id: editing, term, ...a }) : await call('course_add', { ...a, term });
        } else if (mode === 'req') {
          const a = {}; if (v('total') !== '') a.totalCredits = Number(v('total')); if (v('cap') !== '') a.cap = Number(v('cap')); if (v('catname') && v('catcr') !== '') { a.category = v('catname'); a.credits = Number(v('catcr')); }
          if (v('required')) a.requiredCourses = v('required').split(/[、,，]/).map((x) => x.trim()).filter(Boolean); r = await call('course_requirements', a);
        } else r = await call('course_requirements', { period: Number(v('period')), start: v('start'), end: v('end'), ...(v('tp') ? { termPeriod: v('tp'), from: v('from'), to: v('to') } : {}) });
        const text = r?.message || (r?.changed ? r.changed.join('／') : '保存しました'); editing = null; sug = null; await load(term); const box = back.querySelector('#vcr-imp'); if (box) { box.hidden = true; } body.insertAdjacentHTML('afterbegin', `<div class="vf-banner">${esc(text)}</div>`);
      } catch (err) { msg.className = 'vf-msg warn'; msg.textContent = err.message; }
    }
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && back.classList.contains('on')) { e.stopImmediatePropagation(); back.classList.remove('on'); } }, true);
  return {
    open(t) { back.classList.add('on'); return load(t); },
    show(d) { back.classList.add('on'); render(d); },
    /** voice asked for a suggestion: show it in the suggestions card with the apply button */
    showSuggest(r) { sug = r; back.classList.add('on'); if (data && data.term === r.term) render(data); else return load(r.term); },
    close() { back.classList.remove('on'); }, el: back, get data() { return data; },
  };
}
