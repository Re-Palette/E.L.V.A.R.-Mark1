// 家計 panel: this month at a glance (spending, budget gauges, projection), category bars, a 6-month trend, subscriptions, assets, savings suggestions,
// recent entries and a paste-in box for card / bank statements. All numbers come from the server (finance_summary); this file only draws them.
import { timeZone } from './brand.js';
import { localDate } from '../../shared/tz.js';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const yen = (n) => `${n < 0 ? '-' : ''}¥${Math.round(Math.abs(n)).toLocaleString('ja-JP')}`;
const COLORS = ['#19d3ff', '#1ee8c0', '#ffb347', '#a78bfa', '#ff6b9d', '#7fb6d6', '#f5e663', '#5ee08a', '#ff8a5c', '#6ea8fe'];
const CSS = `
.vf-back{position:fixed;inset:0;z-index:55;display:none;align-items:center;justify-content:center;padding:12px;background:rgba(0,8,20,.82);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.vf-back.on{display:flex;animation:va-in .14s ease-out}
.vf{width:min(980px,100%);max-height:94vh;display:flex;flex-direction:column;background:linear-gradient(180deg,rgba(3,26,52,.98),rgba(1,14,30,.99));color:#d9eef9;border:1.5px solid rgba(30,166,216,.9);border-radius:6px;box-shadow:0 0 18px rgba(25,190,255,.4);font:14.5px/1.55 'Barlow Semi Condensed','Noto Sans JP','Yu Gothic UI','Meiryo',sans-serif}
.vf-top{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid rgba(40,150,200,.4)}.vf-top i{width:8px;height:8px;border-radius:50%;background:#19d3ff;box-shadow:0 0 7px #19d3ff}
.vf-top h2{margin:0;font-size:15px;letter-spacing:2.5px;color:#8fe3ff;font-weight:600}.vf-top .sp{margin-left:auto}
.vf-btn{background:transparent;color:#8fe3ff;border:1px solid rgba(25,211,255,.65);border-radius:3px;padding:4px 12px;cursor:pointer;font:inherit;font-size:13.5px}.vf-btn:hover{background:rgba(25,211,255,.2);color:#fff}.vf-btn:disabled{opacity:.4}
.vf-body{overflow:auto;padding:12px 16px 16px}
.vf-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}
.vf-k{border:1px solid rgba(40,150,200,.4);border-radius:4px;padding:8px 12px;background:rgba(25,211,255,.05)}.vf-k small{display:block;color:#7fb6d6;font-size:12px;letter-spacing:1px}.vf-k b{font-size:21px;color:#fff;font-weight:600}.vf-k em{font-style:normal;font-size:12px;color:#8fb5cc;display:block}
.vf-k.warn b{color:#ffb347}.vf-k.bad b{color:#ff6b6b}.vf-k.ok b{color:#5ee08a}
.vf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.vf-card{border:1px solid rgba(40,150,200,.35);border-radius:4px;padding:10px 12px;min-width:0;overflow:hidden}.vf-card h3{margin:0 0 8px;font-size:12.5px;letter-spacing:2px;color:#8fe3ff;font-weight:600}
.vf-row{display:flex;align-items:center;gap:8px;margin:5px 0;font-size:13.5px}.vf-row .n{flex:0 0 5.8em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.vf-row .v{margin-left:auto;color:#fff;white-space:nowrap;font-size:13px}
.vf-bar{flex:1;height:9px;background:rgba(25,211,255,.1);border-radius:5px;overflow:hidden;min-width:24px}.vf-bar i{display:block;height:100%;border-radius:5px}
.vf-tag{display:inline-block;padding:0 7px;border:1px solid currentColor;border-radius:9px;font-size:11.5px;margin-left:4px}.vf-tag.ok{color:#5ee08a}.vf-tag.warn{color:#ffb347}.vf-tag.bad{color:#ff6b6b}.vf-tag.off{color:#7f9bb0}
.vf-sug{margin:6px 0;padding-left:1.1em;text-indent:-1.1em;color:#e6f6ff}.vf-sug:before{content:'💡 '}.vf-muted{color:#7fb6d6;font-size:12.5px}
.vf-ta{width:100%;min-height:70px;background:rgba(0,12,28,.9);color:#d9eef9;border:1px solid rgba(40,150,200,.5);border-radius:3px;padding:6px;font:inherit;font-size:13px;resize:vertical}
.vf-banner{margin-bottom:10px;padding:8px 12px;border:1px solid rgba(25,211,255,.5);border-radius:4px;background:rgba(25,211,255,.08);color:#cfeeff;font-size:13.5px}.vf-banner.bad{border-color:rgba(255,179,71,.8);background:rgba(255,179,71,.1);color:#ffd9a0}.vf-ghost{opacity:.55}

/* One page: on a normal screen everything fits without scrolling (so nothing needs to be touched while the screen explains itself). */
.vf{height:min(94vh,800px)}
.vf-body{display:flex;flex-direction:column;gap:8px;min-height:0;flex:1;overflow:auto;padding:10px 14px 12px;font-size:clamp(11.5px,1.75vh,14px)}
.vf-kpis{margin-bottom:0;gap:8px;grid-template-columns:repeat(5,minmax(0,1fr))}.vf-k{padding:5px 10px}.vf-k b{font-size:clamp(15px,2.6vh,20px)}.vf-k em{font-size:11.5px;line-height:1.35}
.vf-grid{flex:1;min-height:0;grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:8px}
.vf-card{padding:7px 10px;display:flex;flex-direction:column;min-height:0}.vf-card h3{margin:0 0 4px;font-size:12px}
.vf-row{margin:2px 0;font-size:inherit}.vf-sug{margin:3px 0;font-size:inherit;line-height:1.4}
.vf-card svg{width:100%;flex:1 1 0;min-height:0}
.vf-foot{display:flex;align-items:center;gap:10px;border:1px solid rgba(40,150,200,.35);border-radius:4px;padding:5px 10px;font-size:12.5px;min-width:0}
.vf-foot .r{flex:1;display:flex;gap:14px;overflow:hidden;white-space:nowrap;color:#9fc3d8}.vf-foot .r span{overflow:hidden;text-overflow:ellipsis}
.vf-imp{position:absolute;inset:auto 14px 56px 14px;z-index:3;background:rgba(1,14,30,.98);border:1.5px solid rgba(30,166,216,.9);border-radius:6px;padding:10px 12px;box-shadow:0 0 14px rgba(25,190,255,.4)}
.vf{position:relative}.vf-modes{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}.vf-modes .on{background:rgba(25,211,255,.28);color:#fff}.vf-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.vf-fl span{display:block;font-size:12px;color:#7fb6d6}.vf-fl input,.vf-fl select{width:100%;box-sizing:border-box;background:rgba(0,12,28,.9);color:#d9eef9;border:1px solid rgba(40,150,200,.5);border-radius:3px;padding:5px 7px;font:inherit;font-size:13.5px}.vf-form .vf-ta{grid-column:1/-1}.vf-btn.pri{background:rgba(25,211,255,.25);color:#fff}.vf-imp[hidden]{display:none}
@media (max-width:900px){.vf-body{overflow:auto}.vf-kpis{grid-template-columns:repeat(auto-fit,minmax(130px,1fr))}.vf-grid{flex:none;grid-template-columns:1fr;grid-template-rows:none}.vf-card{min-height:auto;flex:none;overflow:visible}}
@media (min-width:901px) and (max-height:640px){.vf-body{gap:5px;padding:6px 12px 8px;font-size:11px}.vf-card{padding:5px 8px}.vf-card h3{margin:0 0 2px;font-size:11px}.vf-grid{gap:5px}.vf-card>.vf-row:nth-child(n+6),.vf-card>.vf-sug:nth-child(n+4),.vf-card>.vf-muted:last-child:not(:nth-child(2)){display:none}}
.vf-msg{min-height:1.3em;color:#1ee8c0;font-size:13px}.vf-msg.warn{color:#ffb347}
`;

/** Pure SVG strings (tested): spending per month as bars. */
export function trendSvg(monthly, w = 300, h = 110) {
  const max = Math.max(1, ...monthly.map((m) => m.spent)), bw = (w - 20) / monthly.length;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="月ごとの支出"><line x1="6" y1="${h - 20}" x2="${w - 6}" y2="${h - 20}" stroke="#2a7fa6" stroke-width="1"/>${monthly.map((m, i) => { const bh = Math.max(2, Math.round((m.spent / max) * (h - 34))), x = 10 + i * bw; return `<rect x="${x + 4}" y="${h - 20 - bh}" width="${bw - 8}" height="${bh}" rx="2" fill="${i === monthly.length - 1 ? '#19d3ff' : '#2a7fa6'}"/><text x="${x + bw / 2}" y="${h - 6}" text-anchor="middle" font-size="10" fill="#7fb6d6">${esc(m.month.slice(5))}月</text><text x="${x + bw / 2}" y="${h - 24 - bh}" text-anchor="middle" font-size="9.5" fill="#d9eef9">${m.spent ? Math.round(m.spent / 1000) + 'k' : ''}</text>`; }).join('')}</svg>`;
}
export function gaugeBar(pct, color) { return `<span class="vf-bar"><i style="width:${Math.min(100, Math.max(0, pct ?? 0))}%;background:${color}"></i></span>`; }

export function initFinanceView({ call }) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const back = document.createElement('div'); back.className = 'vf-back'; back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true'); back.setAttribute('aria-label', '家計');
  back.innerHTML = `<div class="vf"><div class="vf-top"><i></i><h2>FINANCE</h2><button class="vf-btn" data-prev type="button">◀</button><b id="vf-month" style="min-width:5.5em;text-align:center"></b><button class="vf-btn" data-next type="button">▶</button><span class="sp"></span><button class="vf-btn" data-open-shift type="button">シフト</button><button class="vf-btn" data-reload type="button">↻</button><button class="vf-btn" data-x type="button">閉じる</button></div><div class="vf-body" id="vf-body">読み込み中…</div></div>`;
  document.body.appendChild(back);
  const body = back.querySelector('#vf-body'), label = back.querySelector('#vf-month');
  let month = '', data = null;
  const shift = (m, d) => { const [y, mo] = m.split('-').map(Number), x = new Date(Date.UTC(y, mo - 1 + d, 1)); return x.toISOString().slice(0, 7); };
  const tagFor = (state) => ({ '順調': 'ok', '注意': 'warn', '超過': 'bad', '予算なし': 'off' }[state] || 'off');

  const GHOST_CATS = ['食費', '日用品', '交通', '住居', 'サブスク'];
  function render(d) {
    data = d; label.textContent = d.month.replace('-', '年') + '月';
    const none = !!d.empty, tb = d.budgetTotal, st = tb ? tagFor(tb.state) : '';
    const banner = d.unconfigured ? '<div class="vf-banner bad">第二の脳（GitHub）が未設定のため、まだ記録できません。設定すると、ここに家計が表示されます（下の表示は、記録がまだないときの見本です）。</div>'
      : d.error ? `<div class="vf-banner bad">家計の記録を読み込めませんでした：${esc(d.error)}</div>`
      : none ? '<div class="vf-banner">まだ記録がありません。「今日コンビニで580円使った」「今月の予算を15万円に」「預金は120万円」のように話しかけると、ここに反映されます。</div>' : '';
    const kpis = `<div class="vf-kpis">
      <div class="vf-k"><small>支出</small><b>${yen(d.spent)}</b><em>${d.count}件</em></div>
      <div class="vf-k"><small>収入</small><b>${yen(d.income)}</b><em>収支 ${yen(d.balance)}</em></div>
      <div class="vf-k ${tb ? (tb.projectedOver ? 'bad' : st) : ''}"><small>月末の予測</small><b>${yen(d.projected)}</b><em>${tb ? `予算 ${yen(tb.budget)}（${tb.pct}%使用）${tb.dailyAllowance != null ? ` ／ 1日 ${yen(tb.dailyAllowance)}まで` : ''}` : '予算は未設定です'}</em></div>
      <div class="vf-k"><small>サブスク</small><b>${yen(d.subscriptionMonthly)}</b><em>月額（年 ${yen(d.subscriptionMonthly * 12)}）${d.subscriptions.length}件</em></div>
      <div class="vf-k ${d.assets.change != null && d.assets.change < 0 ? 'warn' : ''}"><small>純資産</small><b>${d.assets.list.length ? yen(d.assets.net) : '—'}</b><em>${d.assets.change != null ? `約1か月で ${d.assets.change >= 0 ? '+' : ''}${yen(d.assets.change)}` : '資産の記録なし'}</em></div></div>`;
    const ghostBar = (name) => `<div class="vf-row vf-ghost"><span class="n">${esc(name)}</span>${gaugeBar(0, '#2a7fa6')}<span class="v">${yen(0)} <span class="vf-muted">0%</span></span></div>`;
    const cats = d.categories.length ? d.categories.slice(0, 9).map((c, i) => `<div class="vf-row"><span class="n">${esc(c.category)}</span>${gaugeBar(c.share, COLORS[i % COLORS.length])}<span class="v">${yen(c.amount)} <span class="vf-muted">${c.share}%</span></span></div>`).join('') : GHOST_CATS.map(ghostBar).join('') + '<p class="vf-muted">支出を記録すると、カテゴリごとの割合が出ます。</p>';
    const budgets = (tb ? `<div class="vf-row"><span class="n"><b>合計</b></span>${gaugeBar(tb.pct, tb.state === '超過' ? '#ff6b6b' : tb.state === '注意' ? '#ffb347' : '#5ee08a')}<span class="v">${yen(tb.spent)} / ${yen(tb.budget)}<span class="vf-tag ${tagFor(tb.state)}">${tb.state}</span></span></div>` : `<div class="vf-row vf-ghost"><span class="n"><b>合計</b></span>${gaugeBar(0, '#2a7fa6')}<span class="v">${yen(d.spent)} / 未設定<span class="vf-tag off">予算なし</span></span></div>`)
      + (d.budgets.map((b) => `<div class="vf-row"><span class="n">${esc(b.category)}</span>${gaugeBar(b.pct, b.state === '超過' ? '#ff6b6b' : b.state === '注意' ? '#ffb347' : '#5ee08a')}<span class="v">${yen(b.spent)} / ${yen(b.budget)}<span class="vf-tag ${tagFor(b.state)}">${b.state}</span></span></div>`).join('') || (tb ? '' : ghostBar('食費')))
      + (tb || d.budgets.length ? '' : '<p class="vf-muted">「今月の予算を15万円に」「食費は4万円まで」と話しかけると、ここに進み具合が出ます。</p>');
    const subs = d.subscriptions.length ? d.subscriptions.slice(0, 10).map((s) => `<div class="vf-row"><span class="n">${esc(s.name)}</span><span class="vf-muted">次 ${esc(s.nextDate.slice(5).replace('-', '/'))}</span><span class="v">${yen(s.monthly)}/月</span></div>`).join('') : '<div class="vf-row vf-ghost"><span class="n">（まだありません）</span><span class="v">' + yen(0) + '/月</span></div><p class="vf-muted">毎月同じ支払いが2か月以上続くと、自動でここに出ます。</p>';
    const assets = d.assets.list.length ? d.assets.list.map((a) => `<div class="vf-row"><span class="n">${esc(a.name)}</span><span class="vf-muted">${esc(a.kind)}</span><span class="v">${a.kind === '負債' ? '-' : ''}${yen(a.amount)}</span></div>`).join('') + `<div class="vf-row"><span class="n"><b>純資産</b></span><span class="v"><b>${yen(d.assets.net)}</b></span></div>` : ['資産', '負債', '純資産'].map((n) => `<div class="vf-row vf-ghost"><span class="n">${n}</span><span class="v">${yen(0)}</span></div>`).join('') + '<p class="vf-muted">「預金は120万円」「ローンの残りは800万円」と話しかけると、ここに出ます。</p>';
    const sug = d.suggestions.length ? d.suggestions.map((x) => `<div class="vf-sug">${esc(x.text)}${x.monthlyYen > 0 ? `<span class="vf-muted">（目安 月${yen(x.monthlyYen)}）</span>` : ''}</div>`).join('') : `<p class="vf-muted">${none ? '記録がたまると、増えた支出・少額の頻繁な支払い・予算超過・サブスクの重なりなどから、節約の提案が出ます。' : 'いまのところ、目立った節約の提案はありません。'}</p>`;
    const recent = d.recent.map((e) => `<div class="vf-row"><span class="vf-muted">${esc(e.date.slice(5).replace('-', '/'))}</span><span class="n" style="flex:1">${esc(e.description)}</span><span class="vf-muted">${esc(e.category)}</span><span class="v">${yen(e.amount)}</span></div>`).join('');
    const more = (n, k) => (n > k ? `<div class="vf-muted">ほか ${n - k} 件</div>` : '');
    const catsC = d.categories.length ? d.categories.slice(0, 6).map((c, i) => `<div class="vf-row"><span class="n">${esc(c.category)}</span>${gaugeBar(c.share, COLORS[i % COLORS.length])}<span class="v">${yen(c.amount)} <span class="vf-muted">${c.share}%</span></span></div>`).join('') + more(d.categories.length, 6) : GHOST_CATS.slice(0, 4).map(ghostBar).join('') + '<div class="vf-muted">支出を記録すると、カテゴリごとの割合が出ます。</div>';
    const subsC = d.subscriptions.length ? d.subscriptions.slice(0, 4).map((x) => `<div class="vf-row"><span class="n" style="flex:1">${esc(x.name)}</span><span class="vf-muted">次 ${esc(x.nextDate.slice(5).replace('-', '/'))}</span><span class="v">${yen(x.monthly)}/月</span></div>`).join('') + more(d.subscriptions.length, 4) : '<div class="vf-row vf-ghost"><span class="n" style="flex:1">（まだありません）</span><span class="v">' + yen(0) + '/月</span></div><div class="vf-muted">毎月同じ支払いが2か月以上続くと、自動で出ます。</div>';
    const assetsC = d.assets.list.length ? d.assets.list.slice(0, 4).map((a) => `<div class="vf-row"><span class="n" style="flex:1">${esc(a.name)}</span><span class="vf-muted">${esc(a.kind)}</span><span class="v">${a.kind === '負債' ? '-' : ''}${yen(a.amount)}</span></div>`).join('') + `<div class="vf-row"><span class="n"><b>純資産</b></span><span class="v"><b>${yen(d.assets.net)}</b></span></div>` : ['資産', '負債', '純資産'].map((n) => `<div class="vf-row vf-ghost"><span class="n">${n}</span><span class="v">${yen(0)}</span></div>`).join('') + '<div class="vf-muted">「預金は120万円」と話しかけると、ここに出ます。</div>';
    const sugC = d.suggestions.length ? d.suggestions.slice(0, 3).map((x) => `<div class="vf-sug">${esc(x.text)}${x.monthlyYen > 0 ? `<span class="vf-muted">（目安 月${yen(x.monthlyYen)}）</span>` : ''}</div>`).join('') : `<div class="vf-muted">${none ? '記録がたまると、増えた支出・少額の頻繁な支払い・予算超過・サブスクの重なりから、節約の提案が出ます。' : 'いまのところ、目立った節約の提案はありません。'}</div>`;
    const budgetsC = (tb ? `<div class="vf-row"><span class="n"><b>合計</b></span>${gaugeBar(tb.pct, tb.state === '超過' ? '#ff6b6b' : tb.state === '注意' ? '#ffb347' : '#5ee08a')}<span class="v">${yen(tb.spent)} / ${yen(tb.budget)}<span class="vf-tag ${tagFor(tb.state)}">${tb.state}</span></span></div>` : `<div class="vf-row vf-ghost"><span class="n"><b>合計</b></span>${gaugeBar(0, '#2a7fa6')}<span class="v">${yen(d.spent)} / 未設定<span class="vf-tag off">予算なし</span></span></div>`)
      + d.budgets.slice(0, 4).map((b) => `<div class="vf-row"><span class="n">${esc(b.category)}</span>${gaugeBar(b.pct, b.state === '超過' ? '#ff6b6b' : b.state === '注意' ? '#ffb347' : '#5ee08a')}<span class="v">${yen(b.spent)} / ${yen(b.budget)}<span class="vf-tag ${tagFor(b.state)}">${b.state}</span></span></div>`).join('') + (tb || d.budgets.length ? '' : ghostBar('食費') + '<div class="vf-muted">「今月の予算を15万円に」と話しかけると、進み具合が出ます。</div>');
    const recentC = d.recent.slice(0, 3).map((e) => `<span>${esc(e.date.slice(5).replace('-', '/'))} ${esc(e.description)} ${yen(e.amount)}</span>`).join('') || '<span>最近の記録：まだありません</span>';
    body.innerHTML = banner + kpis + `<div class="vf-grid">
      <div class="vf-card"><h3>予算（${esc(d.month)}）</h3>${budgetsC}</div>
      <div class="vf-card"><h3>カテゴリ別の支出</h3>${catsC}</div>
      <div class="vf-card"><h3>月ごとの支出（過去6か月）</h3>${trendSvg(d.monthly)}</div>
      <div class="vf-card"><h3>サブスクリプション</h3>${subsC}</div>
      <div class="vf-card"><h3>資産の状況</h3>${assetsC}</div>
      <div class="vf-card"><h3>節約の提案</h3>${sugC}</div></div>
      <div class="vf-foot"><span class="vf-muted">最近</span><div class="r">${recentC}</div><button class="vf-btn" data-showimport type="button">＋ 追加</button></div>`;
  }
  const CATS = ['食費', '日用品', '交通', '住居', '光熱費', '通信', 'サブスク', '医療', '衣服・美容', '趣味・娯楽', '交際費', '教育', '保険・税金', '貯蓄・投資', 'その他'];
  const today = () => localDate(Date.now(), timeZone());
  const MODES = { 支出: 'expense', 収入: 'income', サブスク: 'sub', 予算: 'budget', 資産: 'asset', 明細: 'paste' };
  const inp = (id, label, extra = '') => `<label class="vf-fl"><span>${label}</span><input id="vf-f-${id}" ${extra}></label>`;
  const FORMS = {
    expense: () => inp('date', '日付', `type="date" value="${today()}"`) + inp('amount', '金額（円）', 'type="number" min="1" inputmode="numeric" placeholder="580"') + inp('desc', '内容・店', 'type="text" placeholder="セブン-イレブン"') + `<label class="vf-fl"><span>カテゴリ</span><select id="vf-f-cat"><option value="">自動で分類</option>${CATS.map((c) => `<option>${c}</option>`).join('')}</select></label>` + inp('method', '支払い（任意）', 'type="text" placeholder="現金・クレジット・QR"'),
    income: () => inp('date', '日付', `type="date" value="${today()}"`) + inp('amount', '金額（円）', 'type="number" min="1" inputmode="numeric" placeholder="250000"') + inp('desc', '内容', 'type="text" placeholder="給与"'),
    sub: () => inp('name', 'サービス名', 'type="text" placeholder="Netflix"') + inp('amount', '月額（円）', 'type="number" min="1" inputmode="numeric" placeholder="1490"') + inp('day', '毎月の支払日', 'type="number" min="1" max="31" placeholder="5"') + '<label class="vf-fl"><span>操作</span><select id="vf-f-act"><option value="add">登録・変更</option><option value="cancel">解約した</option></select></label>',
    budget: () => `<label class="vf-fl"><span>対象</span><select id="vf-f-cat"><option value="合計">全体（合計）</option>${CATS.map((c) => `<option>${c}</option>`).join('')}</select></label>` + inp('amount', '月の予算（円）', 'type="number" min="0" inputmode="numeric" placeholder="150000"'),
    asset: () => inp('name', '名前', 'type="text" placeholder="預金・現金・NISA・住宅ローン"') + inp('amount', '残高（円）', 'type="number" min="0" inputmode="numeric" placeholder="1200000"') + '<label class="vf-fl"><span>種別</span><select id="vf-f-kind"><option>資産</option><option>負債</option></select></label>',
    paste: () => '<textarea class="vf-ta" id="vf-ta" placeholder="2026/11/03,セブン-イレブン,580&#10;2026/11/04,Netflix,1490"></textarea><div class="vf-muted">カード・銀行のCSVや、コピーした明細の文字列（日付・内容・金額の行）</div>',
  };
  let mode = 'expense';
  function addBox() { return `<div class="vf-card vf-imp" id="vf-imp" hidden><h3>追加（手で入力。話しかけても同じです）</h3><div class="vf-modes">${Object.entries(MODES).map(([l, m]) => `<button type="button" class="vf-btn${m === mode ? ' on' : ''}" data-mode="${m}">${l}</button>`).join('')}</div><div class="vf-form" id="vf-form">${FORMS[mode]()}</div><div style="margin-top:8px;display:flex;gap:10px;align-items:center"><button class="vf-btn pri" data-submit type="button">追加する</button><button class="vf-btn" data-cancel type="button">閉じる</button><span class="vf-msg" id="vf-msg"></span></div></div>`; }
  back.querySelector('.vf').insertAdjacentHTML('beforeend', addBox());   // the popup (built once the form helpers above exist)

  const emptyData = (m) => { const mm = (() => { const [y, mo] = m.split('-').map(Number); return Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(y, mo - 1 - 5 + i, 1)).toISOString().slice(0, 7)); })();
    return { month: m, spent: 0, income: 0, balance: 0, count: 0, projected: 0, categories: [], budgetTotal: null, budgets: [], subscriptions: [], subscriptionMonthly: 0, assets: { list: [], assetTotal: 0, debtTotal: 0, net: 0, change: null }, suggestions: [], recent: [], monthly: mm.map((x) => ({ month: x, spent: 0 })), empty: true, note: '金額・割合・予測は、記録された支出から計算した値です。' }; };
  async function load(m) {
    body.textContent = '読み込み中…';
    try { const d = await call('finance_summary', m ? { month: m } : {}); month = d.month; render(d); }
    catch (e) { const m2 = m || localDate(Date.now(), timeZone()).slice(0, 7); month = m2; render({ ...emptyData(m2), error: e.message }); }
  }
  back.addEventListener('click', async (e) => {
    if (e.target === back || e.target.closest('[data-x]')) back.classList.remove('on');
    else if (e.target.closest('[data-prev]')) load(shift(month || new Date().toISOString().slice(0, 7), -1));
    else if (e.target.closest('[data-next]')) load(shift(month || new Date().toISOString().slice(0, 7), 1));
    else if (e.target.closest('[data-reload]')) load(month);
    else if (e.target.closest('[data-showimport]')) { const b = back.querySelector('#vf-imp'); b.hidden = !b.hidden; if (!b.hidden) back.querySelector('#vf-form input,#vf-form textarea,#vf-form select')?.focus(); }
    else if (e.target.closest('[data-mode]')) { mode = e.target.closest('[data-mode]').dataset.mode; back.querySelector('#vf-imp').outerHTML = addBox(); back.querySelector('#vf-imp').hidden = false; }
    else if (e.target.closest('[data-cancel]')) back.querySelector('#vf-imp').hidden = true;
    else if (e.target.closest('[data-submit]')) {
      const msg = back.querySelector('#vf-msg'), v = (id) => (back.querySelector('#vf-f-' + id)?.value ?? '').trim(); msg.className = 'vf-msg'; msg.textContent = '追加中…';
      try {
        let r;
        if (mode === 'expense' || mode === 'income') r = await call('finance_add', { entries: [{ amount: Number(v('amount')), description: v('desc'), date: v('date'), ...(v('cat') ? { category: v('cat') } : {}), ...(v('method') ? { method: v('method') } : {}), ...(mode === 'income' ? { income: true } : {}) }] });
        else if (mode === 'sub') r = await call('finance_subscription', { name: v('name'), monthly: Number(v('amount')) || undefined, day: Number(v('day')) || undefined, action: v('act') || 'add' });
        else if (mode === 'budget') r = await call('finance_budget', { category: v('cat') === '合計' ? undefined : v('cat'), amount: Number(v('amount')) });
        else if (mode === 'asset') r = await call('finance_asset', { name: v('name'), amount: Number(v('amount')), kind: v('kind') });
        else r = await call('finance_import', { text: back.querySelector('#vf-ta').value });
        msg.textContent = r?.message || '追加しました';
        back.querySelectorAll('#vf-form input[type=text],#vf-form input[type=number],#vf-form textarea').forEach((x) => { x.value = ''; });
        await load(month);
        const box = back.querySelector('#vf-imp'); box.hidden = false; back.querySelector('#vf-msg').textContent = r?.message || '追加しました'; back.querySelector('#vf-msg').className = 'vf-msg';
      } catch (err) { msg.className = 'vf-msg warn'; msg.textContent = err.message; }
    }
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && back.classList.contains('on')) { e.stopImmediatePropagation(); back.classList.remove('on'); } }, true);
  return { open(m) { back.classList.add('on'); return load(m); }, /** show data the caller already has (no second request) */ show(d) { month = d.month; back.classList.add('on'); render(d); }, close() { back.classList.remove('on'); }, el: back, get data() { return data; } };
}
