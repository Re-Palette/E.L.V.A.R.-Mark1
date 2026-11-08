// シフト panel (バイト・インターン): this month's shifts on a calendar grid, expected income vs. the goal, jobs and hourly wages, and shift suggestions that
// avoid the Google Calendar. Everything is computed by the server (shift_summary / shift_suggest); this file only draws it and sends the manual edits.
// It reuses the .vf-* look injected by finance-view.js (same family of screens).
import { timeZone } from './brand.js';
import { localDate } from '../../shared/tz.js';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => `${n < 0 ? '-' : ''}¥${Math.round(Math.abs(n || 0)).toLocaleString('ja-JP')}`;
const CSS = `
.vsh-cal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:2px;flex:1;min-height:0;grid-auto-rows:minmax(0,1fr)}
.vsh-dow{font-size:11px;color:#7fb6d6;text-align:center}.vsh-day{border:1px solid rgba(40,150,200,.22);border-radius:3px;padding:1px 3px;overflow:hidden;font-size:10.5px;line-height:1.25;min-height:0;display:flex;flex-wrap:wrap;align-items:center;gap:0 3px;align-content:center}
.vsh-day.out{opacity:.25}.vsh-day.today{border-color:#19d3ff;box-shadow:inset 0 0 6px rgba(25,211,255,.4)}.vsh-day b{color:#9fc3d8;font-weight:500;font-size:10.5px}
.vsh-chip{display:block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:rgba(25,211,255,.22);color:#eafaff;border-radius:2px;padding:0 3px}.vsh-chip.prop{background:rgba(255,179,71,.28);border:1px dashed #ffb347}
.vsh-day.busy{background:rgba(255,77,94,.20);border-color:rgba(255,92,108,.7)}.vsh-day.check{background:rgba(255,206,74,.17);border-color:rgba(255,206,74,.65)}
.vsh-ev{display:block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:9.5px;color:#cfe3ee;opacity:.9}.vsh-day.busy .vsh-ev{color:#ffc9cf}.vsh-day.check .vsh-ev{color:#ffe9a8}
.vsh-lg{display:flex;gap:12px;flex-wrap:wrap;font-size:10.5px;color:#9fc3d8;margin:3px 0}.vsh-lg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px;border:1px solid}
.vsh-lg .b{background:rgba(255,77,94,.35);border-color:#ff5c6c}.vsh-lg .c{background:rgba(255,206,74,.3);border-color:#ffce4a}.vsh-lg .s{background:rgba(25,211,255,.3);border-color:#19d3ff}
.vsh-li{display:flex;gap:6px;align-items:center;margin:2px 0;white-space:nowrap;overflow:hidden}.vsh-li .t{overflow:hidden;text-overflow:ellipsis;flex:1}.vsh-li .v{margin-left:auto;color:#fff}.vsh-x{background:none;border:0;color:#ff8a8a;cursor:pointer;padding:0 4px;font-size:13px}
.vsh-list{overflow:auto;min-height:0;flex:1}.vsh-sp2{grid-column:span 2}
@media (max-width:900px){.vsh-sp2{grid-column:auto}.vsh-cal{grid-auto-rows:minmax(52px,auto)}}
`;
export const WD = ['日', '月', '火', '水', '木', '金', '土'];
/** Pure (tested): the cells of a month grid (Sunday first) → [{date|null, day}] */
export function monthCells(month) {
  const [y, m] = month.split('-').map(Number), first = new Date(Date.UTC(y, m - 1, 1)), n = new Date(Date.UTC(y, m, 0)).getUTCDate(), cells = [];
  for (let i = 0; i < first.getUTCDay(); i++) cells.push({ date: null });
  for (let d = 1; d <= n; d++) cells.push({ date: `${month}-${String(d).padStart(2, '0')}`, day: d });
  while (cells.length % 7) cells.push({ date: null });
  return cells;
}
export const hhmmShort = (t) => String(t).replace(/^0/, '').replace(/:00$/, '時').replace(/:(\d\d)$/, '時$1');

export function initShiftView({ call }) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const back = document.createElement('div'); back.className = 'vf-back'; back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true'); back.setAttribute('aria-label', 'シフト');
  back.innerHTML = `<div class="vf"><div class="vf-top"><i></i><h2>SHIFT</h2><button class="vf-btn" data-prev type="button">◀</button><b id="vsh-month" style="min-width:5.5em;text-align:center"></b><button class="vf-btn" data-next type="button">▶</button><span class="sp"></span><button class="vf-btn" data-open-course type="button">履修</button><button class="vf-btn" data-suggest type="button">✦ 提案を作る</button><button class="vf-btn" data-reload type="button">↻</button><button class="vf-btn" data-x type="button">閉じる</button></div><div class="vf-body" id="vsh-body">読み込み中…</div></div>`;
  document.body.appendChild(back);
  const body = back.querySelector('#vsh-body'), label = back.querySelector('#vsh-month');
  let month = '', data = null, sug = null, mode = 'shift';
  const today = () => localDate(Date.now(), timeZone());
  const shiftMonth = (m, d) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + d, 1)).toISOString().slice(0, 7); };

  function render(d) {
    data = d; month = d.month; label.textContent = `${d.month.slice(0, 4)}年${Number(d.month.slice(5))}月`;
    const g = d.goal || {}, none = !d.jobs?.length;
    const banner = d.unconfigured ? '<div class="vf-banner bad">第二の脳が未設定のため、シフトは記録できません。</div>' : d.error ? `<div class="vf-banner bad">${esc(d.error)}</div>` : none ? '<div class="vf-banner">まだ職場が登録されていません。「＋ 追加」から、職場と時給を登録してください（話しかけても登録できます）。</div>' : (d.warnings || []).length ? `<div class="vf-banner bad">${esc(d.warnings[0])}</div>` : '';
    const y = d.year;
    const kpis = `<div class="vf-kpis">
      <div class="vf-k"><small>今月の見込み</small><b>${yen(d.projected)}</b><em>済み ${yen(d.earned)}／これから ${yen(d.planned)}</em></div>
      <div class="vf-k ${g.income ? (d.goalPct >= 100 ? 'ok' : '') : ''}"><small>月の目標</small><b>${g.income ? yen(g.income) : '未設定'}</b><em>${g.income ? `${d.goalPct}%（あと ${yen(d.remainingIncome)}）` : '「今月は8万円」と話すか、＋追加から'}</em></div>
      <div class="vf-k"><small>あと必要な時間</small><b>${d.hoursNeeded != null ? d.hoursNeeded + '時間' : '—'}</b><em>${d.perHour ? `時給の目安 ${yen(d.perHour)}（交通費込み）` : '職場の登録後に計算'}</em></div>
      <div class="vf-k ${(d.weekly || []).some((w) => w.over) ? 'warn' : ''}"><small>今月の合計</small><b>${d.hours}時間</b><em>${d.count}回${g.weeklyCap ? `／週の上限 ${g.weeklyCap}時間` : ''}</em></div>
      <div class="vf-k ${y?.pct >= 90 ? 'warn' : ''}"><small>今年の合計</small><b>${y ? yen(y.earned) : '—'}</b><em>${y?.cap ? `上限 ${yen(y.cap)}の ${y.pct}%` : '年収上限を決めると、近づいたときに知らせます'}</em></div></div>`;
    const byDate = new Map(); for (const s of d.shifts || []) (byDate.get(s.date) || byDate.set(s.date, []).get(s.date)).push({ t: `${hhmmShort(s.start)}-${hhmmShort(s.end)}`, job: s.job });
    const propBy = new Map(); for (const p of sug?.proposals || []) if (p.date.startsWith(d.month)) (propBy.get(p.date) || propBy.set(p.date, []).get(p.date)).push(`${hhmmShort(p.start)}-${hhmmShort(p.end)}`);
    const cd = d.calendarDays || {}, calDay = (dt) => cd[dt], calTitle = (dt) => `${cd[dt].status === 'busy' ? '入れられない日' : '要確認の日'}：${cd[dt].reason}\n${cd[dt].items.map((x) => `${x.time} ${x.title}`).join('\n')}`;
    const calEv = (dt) => (cd[dt] ? `<span class="vsh-ev">${esc(cd[dt].items[0].title)}${cd[dt].items.length > 1 ? ` 他${cd[dt].items.length - 1}件` : ''}</span>` : '');
    const legend = `<div class="vsh-lg"><span><i class="b"></i>入れられない日（予定で埋まっている）</span><span><i class="c"></i>要確認の日（予定あり・空きはある／終日の予定）</span><span><i class="s"></i>シフト</span>${d.calendarNote ? `<span>${esc(d.calendarNote)}</span>` : ''}</div>`;
    const cal = `<div class="vsh-cal">${WD.map((w) => `<div class="vsh-dow">${w}</div>`).join('')}${monthCells(d.month).map((c) => !c.date ? '<div class="vsh-day out"></div>' : `<div class="vsh-day ${c.date === today() ? 'today' : ''} ${calDay(c.date)?.status || ''}" ${calDay(c.date) ? `title="${esc(calTitle(c.date))}"` : ''}><b>${c.day}</b>${calEv(c.date)}${(byDate.get(c.date) || []).map((x) => `<span class="vsh-chip" title="${esc(x.job)}">${esc(x.t)}</span>`).join('')}${(propBy.get(c.date) || []).map((t) => `<span class="vsh-chip prop">案 ${esc(t)}</span>`).join('')}</div>`).join('')}</div>`;
    const jobsC = (d.byJob || []).map((j) => `<div class="vsh-li"><span class="t">${esc(j.job)}</span><span class="vf-muted">時給 ${yen(j.hourly)}／交通 ${yen(j.transport)}</span><span class="v">${yen(j.pay)}</span></div>`).join('') || '<div class="vf-muted">職場と時給を登録すると、収入を計算します。</div>';
    const listC = (d.shifts || []).slice(0, 40).map((s) => `<div class="vsh-li"><span class="t">${esc(s.date.slice(5).replace('-', '/'))}（${esc(s.weekday)}）${esc(s.start)}-${esc(s.end)} ${esc(s.job)}</span><span class="v">${yen(s.pay + s.transport)}</span><button class="vsh-x" data-del="${esc(s.id)}" title="取り消す" type="button">✕</button></div>`).join('') || '<div class="vf-muted">この月のシフトはまだありません。</div>';
    const sugC = sug ? (sug.proposals?.length ? `<div class="vsh-list">${sug.proposals.map((p, i) => `<label class="vsh-li"><input type="checkbox" data-p="${i}" checked><span class="t">${esc(p.date.slice(5).replace('-', '/'))}（${esc(p.weekday)}）${esc(p.start)}-${esc(p.end)}　${p.hours}時間</span><span class="v">${yen(p.pay)}</span></label>`).join('')}</div><div class="vf-muted">合計 ${sug.hours}時間・${yen(sug.pay)}${sug.shortfallHours ? `（目標まであと ${sug.shortfallHours}時間分は空きが足りません）` : ''}${sug.calendarNote ? '／' + esc(sug.calendarNote) : ''}</div><div style="margin-top:4px"><button class="vf-btn pri" data-apply type="button">選んだ案をシフトに登録</button></div>` : `<div class="vf-muted">条件に合う空きが見つかりませんでした。${esc(sug.calendarNote || '')}</div>`) : '<div class="vf-muted">「✦ 提案を作る」を押すか、「今月のシフトを組んで」と話しかけると、カレンダーの予定を避けた案を作ります（登録は了承してから）。</div>';
    body.innerHTML = banner + kpis + `<div class="vf-grid">
      <div class="vf-card vsh-sp2"><h3>${esc(label.textContent)}のシフト（橙の点線＝提案）</h3>${legend}${cal}</div>
      <div class="vf-card"><h3>職場と時給</h3>${jobsC}<div class="vf-muted" style="margin-top:4px">${esc(d.note || '')}</div></div>
      <div class="vf-card"><h3>この月のシフト</h3><div class="vsh-list">${listC}</div></div>
      <div class="vf-card vsh-sp2"><h3>シフトの提案</h3>${sugC}</div></div>
      <div class="vf-foot"><span class="vf-muted">${(d.warnings || []).length > 1 ? esc(d.warnings.slice(1).join('／')) : '話しかけても、ここから手で入力しても、同じように記録されます'}</span><div class="r"></div><button class="vf-btn" data-showadd type="button">＋ 追加</button></div>` + addBox();
  }

  const inp = (id, label, extra = '') => `<label class="vf-fl"><span>${label}</span><input id="vsh-f-${id}" ${extra}></label>`;
  const FORMS = {
    shift: () => inp('date', '日付', `type="date" value="${today()}"`) + inp('start', '開始', 'type="time" value="17:00"') + inp('end', '終了', 'type="time" value="22:00"') + `<label class="vf-fl"><span>職場</span><select id="vsh-f-job">${(data?.jobs || []).map((j) => `<option>${esc(j.name)}</option>`).join('') || '<option value="">（先に職場を登録）</option>'}</select></label>` + inp('break', '休憩（分・空欄で法定の最低）', 'type="number" min="0" inputmode="numeric"') + '<label class="vf-fl"><span>カレンダー</span><select id="vsh-f-cal"><option value="1">Googleカレンダーにも入れる</option><option value="0">入れない</option></select></label>',
    job: () => inp('name', '職場の名前', 'type="text" placeholder="コンビニ"') + inp('hourly', '時給（円）', 'type="number" min="1" inputmode="numeric" placeholder="1200"') + inp('transport', '交通費（円・1出勤）', 'type="number" min="0" inputmode="numeric" placeholder="400"') + '<label class="vf-fl"><span>操作</span><select id="vsh-f-act"><option value="add">登録・変更</option><option value="remove">削除</option></select></label>',
    goal: () => '<label class="vf-fl"><span>種類</span><select id="vsh-f-key"><option>月収目標</option><option>年収上限</option><option>週の上限時間</option><option>月の目標時間</option></select></label>' + inp('value', '数字（円 または 時間）', 'type="number" min="0" inputmode="numeric" placeholder="80000"') + '<label class="vf-fl"><span>範囲</span><select id="vsh-f-scope"><option value="">毎月の共通</option><option value="m">この月だけ</option></select></label>',
  };
  const MODES = { シフト: 'shift', 職場と時給: 'job', 目標と上限: 'goal' };
  function addBox() { return `<div class="vf-card vf-imp" id="vsh-imp" hidden><h3>追加（手で入力。話しかけても同じです）</h3><div class="vf-modes">${Object.entries(MODES).map(([l, m]) => `<button type="button" class="vf-btn${m === mode ? ' on' : ''}" data-mode="${m}">${l}</button>`).join('')}</div><div class="vf-form" id="vsh-form">${FORMS[mode]()}</div><div style="margin-top:8px;display:flex;gap:8px;align-items:center"><button class="vf-btn pri" data-submit type="button">追加</button><button class="vf-btn" data-cancel type="button">閉じる</button><span class="vf-msg" id="vsh-msg"></span></div></div>`; }

  async function load(m) {
    body.textContent = '読み込み中…';
    try { render(await call('shift_summary', m ? { month: m } : {})); }
    catch (e) { const m2 = m || today().slice(0, 7); render({ month: m2, shifts: [], jobs: [], byJob: [], weekly: [], goal: {}, warnings: [], projected: 0, earned: 0, planned: 0, hours: 0, count: 0, error: e.message }); }
  }
  const reopenBox = (text, bad) => { const box = back.querySelector('#vsh-imp'); if (!box) return; box.hidden = false; const msg = back.querySelector('#vsh-msg'); msg.textContent = text; msg.className = 'vf-msg' + (bad ? ' warn' : ''); };
  back.addEventListener('click', async (e) => {
    const t = e.target;
    if (t === back || t.closest('[data-x]')) back.classList.remove('on');
    else if (t.closest('[data-prev]')) { sug = null; load(shiftMonth(month || today().slice(0, 7), -1)); }
    else if (t.closest('[data-next]')) { sug = null; load(shiftMonth(month || today().slice(0, 7), 1)); }
    else if (t.closest('[data-reload]')) load(month);
    else if (t.closest('[data-showadd]')) { const b = back.querySelector('#vsh-imp'); b.hidden = !b.hidden; }
    else if (t.closest('[data-mode]')) { mode = t.closest('[data-mode]').dataset.mode; back.querySelector('#vsh-imp').outerHTML = addBox(); back.querySelector('#vsh-imp').hidden = false; }
    else if (t.closest('[data-cancel]')) back.querySelector('#vsh-imp').hidden = true;
    else if (t.closest('[data-suggest]')) { body.insertAdjacentHTML('afterbegin', '<div class="vf-banner">提案を作っています…</div>'); try { sug = await call('shift_suggest', { month }); } catch (err) { sug = { proposals: [], calendarNote: err.message }; } render(data); }
    else if (t.closest('[data-apply]')) {
      const picked = [...back.querySelectorAll('[data-p]')].filter((c) => c.checked).map((c) => sug.proposals[Number(c.dataset.p)]); if (!picked.length) return;
      try { const r = await call('shift_add', { shifts: picked.map((p) => ({ date: p.date, start: p.start, end: p.end, job: sug.job, breakMin: p.breakMin })) }); sug = null; await load(month); reopenBox(r?.message || '登録しました'); back.querySelector('#vsh-imp').hidden = true; }
      catch (err) { body.insertAdjacentHTML('afterbegin', `<div class="vf-banner bad">${esc(err.message)}</div>`); }
    }
    else if (t.closest('[data-del]')) {
      const id = t.closest('[data-del]').dataset.del; if (!confirm('このシフトを取り消しますか？（カレンダーの予定も消えます）')) return;
      try { await call('shift_cancel', { id, month, confirmed: true }); await load(month); } catch (err) { body.insertAdjacentHTML('afterbegin', `<div class="vf-banner bad">${esc(err.message)}</div>`); }
    }
    else if (t.closest('[data-submit]')) {
      const msg = back.querySelector('#vsh-msg'), v = (id) => (back.querySelector('#vsh-f-' + id)?.value ?? '').trim(); msg.className = 'vf-msg'; msg.textContent = '追加中…';
      try {
        let r;
        if (mode === 'shift') r = await call('shift_add', { date: v('date'), start: v('start'), end: v('end'), job: v('job'), ...(v('break') !== '' ? { breakMin: Number(v('break')) } : {}), calendar: v('cal') !== '0' });
        else if (mode === 'job') r = await call('shift_job', { name: v('name'), hourly: Number(v('hourly')) || undefined, transport: v('transport') !== '' ? Number(v('transport')) : undefined, action: v('act') || 'add' });
        else r = await call('shift_goal', { key: v('key'), value: Number(v('value')), ...(v('scope') === 'm' ? { month } : {}) });
        const text = r?.message || '追加しました';
        await load(month); reopenBox(text);
      } catch (err) { msg.className = 'vf-msg warn'; msg.textContent = err.message; }
    }
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && back.classList.contains('on')) { e.stopImmediatePropagation(); back.classList.remove('on'); } }, true);
  return {
    open(m) { back.classList.add('on'); return load(m); },
    show(d) { back.classList.add('on'); render(d); },
    /** voice asked for a suggestion: show it on the calendar with the register button */
    showSuggest(r) { sug = r; back.classList.add('on'); if (data && data.month === r.month) render(data); else return load(r.month); },
    close() { back.classList.remove('on'); }, el: back, get data() { return data; },
  };
}
