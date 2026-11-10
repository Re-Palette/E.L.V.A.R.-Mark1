// 利用状況 screen: the ACCOUNT's usage (all devices together, counted by the server) drawn as meters and charts: today and this month per provider, the limits the user
// set (warn or stop), the limits an administrator set for the account (read only), 14 days of Gemini calls and Live minutes, which tools were used most, and the storage meter.
// Honest about where a number comes from: calls and tokens are counted by the server; Live time and tool counts are reported by the page. Same look as the other screens
// (.vf-* styles come from finance-view.js).
import { usage, } from './usage.js';
import { api } from './elvar/auth.js';
import { addDays } from '../../shared/tz.js';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const GREEN = '#5ee08a', AMBER = '#ffb347', RED = '#ff6b6b', CYAN = '#19d3ff';
const CSS = `
.vus-main{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr);gap:8px}
.vus-first{grid-row:1/3;display:flex;flex-direction:column;gap:5px;min-height:0}.vus-gauges{flex:1;display:flex;flex-direction:column;gap:6px;min-height:0;overflow:auto}
.vus-g{border:1px solid rgba(40,150,200,.35);border-radius:4px;padding:5px 9px;display:flex;flex-direction:column;gap:2px}
.vus-g.warn{border-color:rgba(255,179,71,.7)}.vus-g.bad{border-color:rgba(255,107,107,.8)}
.vus-gh{display:flex;align-items:baseline;gap:8px}.vus-gh b{color:#fff;font-weight:600;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.vus-gh span{color:#fff;white-space:nowrap}.vus-gh em{font-style:normal;font-size:.92em;white-space:nowrap}
.vus-bar{position:relative;height:9px;background:rgba(25,211,255,.1);border-radius:5px;overflow:visible}.vus-bar i{display:block;height:100%;border-radius:5px;background:var(--c,#19d3ff)}.vus-bar u{position:absolute;top:-3px;bottom:-3px;width:2px;background:#fff;opacity:.8;text-decoration:none}
.vus-n{color:#8fb5cc;font-size:.9em;line-height:1.35}.vus-n.ov{color:${AMBER}}
.vus-cap{display:flex;justify-content:space-between;gap:6px;color:#7fb6d6;font-size:11.5px}
.vus-main .vf-card svg{width:100%;flex:1 1 0;min-height:0}
.vus-tl{display:flex;flex-direction:column;gap:3px;overflow:auto;min-height:0}.vus-tr{display:grid;grid-template-columns:minmax(0,9em) 1fr 2.6em;gap:6px;align-items:center;font-size:.95em}.vus-tr span:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.vus-tr .vus-bar{height:7px}.vus-tr b{text-align:right;color:#fff;font-weight:500}
.vus-guide{color:#cfe6f3;font-size:.92em;line-height:1.4}.vus-guide b{color:#8fe3ff;font-weight:600}
@media (max-width:900px){.vus-main{display:flex;flex-direction:column;flex:none}.vus-gauges{overflow:visible}.vus-main .vf-card svg{flex:none;height:110px}}
@media (min-width:901px) and (max-height:640px){.vus-n{display:none}.vus-g{padding:3px 8px;gap:1px}}
`;

/** Pure (tested): the last `n` days (oldest first, today last) from the server's daily rows [{day, provider, metric, amount}] -> [{ day, liveMinutes, calls, tokens }]. Missing days are zeros. */
export function dayRows(daily, today, n = 14) {
  const by = new Map();
  for (const x of daily || []) { const d = by.get(x.day) || { liveSeconds: 0, calls: 0, tokens: 0 }; if (x.metric === 'live_seconds') d.liveSeconds += x.amount; else if (x.metric === 'calls') d.calls += x.amount; else if (x.metric === 'input_tokens' || x.metric === 'output_tokens') d.tokens += x.amount; by.set(x.day, d); }
  const out = []; for (let i = n - 1; i >= 0; i--) { const day = addDays(today, -i), d = by.get(day) || { liveSeconds: 0, calls: 0, tokens: 0 }; out.push({ day, liveMinutes: Math.round((d.liveSeconds / 60) * 10) / 10, calls: d.calls, tokens: d.tokens }); }
  return out;
}
/** Pure (tested): the server's tool counts [{name, count}] most used first, top N. */
export function toolBreakdown(tools, top = 8) { return [...(tools || [])].map((t) => ({ name: t.name, count: t.count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, top); }
/** Pure (tested): the rows of the "today / this month" panel: every provider and metric with a number or a limit, in catalog order. */
export function usageRows(s) {
  const rows = [];
  for (const [p, def] of Object.entries(s.catalog || {})) for (const [m, md] of Object.entries(def.metrics)) {
    const t = s.today?.[p]?.[m] || 0, mo = s.month?.[p]?.[m] || 0, meters = (s.meters || []).filter((x) => x.provider === p && x.metric === m);
    if (!t && !mo && !meters.length) continue;
    rows.push({ provider: p, metric: m, label: `${def.label}・${md.label}`, unit: md.unit, scale: md.scale, today: t, month: mo, meters, source: s.sources?.[m] || 'server' });
  }
  return rows;
}
const fmt = (n, scale = 1, unit = '') => { const v = (Number(n) || 0) * scale; return `${(unit === '分' ? Math.round(v * 10) / 10 : Math.round(v)).toLocaleString('ja-JP')}${unit}`; };
export const SOURCE_JA = { server: 'サーバーで計測', client: '端末からの報告' };
const lvlColor = (level) => (level === 'over' ? RED : level === 'warn' ? AMBER : GREEN);
const lvlText = (level) => (level === 'over' ? '上限に達しました' : level === 'warn' ? '上限に近づいています' : '余裕あり');
const TOOL_JA = { calendar_list_events: 'カレンダーを見る', calendar_create_event: '予定を作る', gmail_search: 'メール検索', gmail_read: 'メールを読む', web_search: 'Web検索', deep_think: '難しい推論', news: 'ニュース', weather: '天気', current_datetime: '日時', usage_report: '使用状況', system_check: 'システムチェック', api_status: 'API接続', notes_search: '第二の脳を探す', notes_read: '第二の脳を読む', shift_summary: 'シフト', finance_summary: '家計', build_status: '製作の進捗', human_protocol: '人型の姿', tasks_list: 'タスク', create_document: '資料作成', show_choice: '選択カード' };
export const toolLabel = (n) => TOOL_JA[n] || n;

/** Pure SVG (tested): daily bars. values = numbers, labels = 'M/D' strings; `line` = a budget line (same unit) or null; the last bar (today) is brighter. */
export function barsSvg(values, labels, { line = null, unit = '', w = 330, h = 96, color = CYAN, aria = '' } = {}) {
  const n = Math.max(1, values.length), max = Math.max(1, ...values, line || 0) * 1.08, bw = (w - 16) / n, base = h - 16, top = 12;
  const bars = values.map((v, i) => { const bh = v ? Math.max(3, Math.round((v / max) * (base - top))) : 0, x = 8 + i * bw, over = line && v > line;
    return `<g><title>${esc(`${labels[i]}：${v}${unit}`)}</title>${v ? `<rect x="${(x + 2).toFixed(1)}" y="${base - bh}" width="${Math.max(2, bw - 4).toFixed(1)}" height="${bh}" rx="1.5" fill="${over ? RED : color}" opacity="${i === n - 1 ? 1 : 0.62}"/>` : ''}${v ? `<text x="${(x + bw / 2).toFixed(1)}" y="${base - bh - 2}" text-anchor="middle" font-size="8.5" fill="#cfe6f3">${v}</text>` : ''}</g>`; }).join('');
  const ly = line ? base - Math.round((line / max) * (base - top)) : null;
  const lab = (i) => `<text x="${(8 + i * bw + bw / 2).toFixed(1)}" y="${h - 3}" text-anchor="middle" font-size="9" fill="#7fb6d6">${esc(labels[i])}</text>`;
  const idx = n > 7 ? [0, Math.floor(n / 2), n - 1] : values.map((_, i) => i);
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(aria)}"><line x1="6" y1="${base}" x2="${w - 6}" y2="${base}" stroke="#2a7fa6"/>${ly != null ? `<line x1="6" y1="${ly}" x2="${w - 6}" y2="${ly}" stroke="${AMBER}" stroke-dasharray="4 3"/><text x="${w - 8}" y="${ly - 2}" text-anchor="end" font-size="9" fill="${AMBER}">目安 ${line}${esc(unit)}</text>` : ''}${bars}${idx.map(lab).join('')}</svg>`;
}


const EXTRA_CSS = `
.vus-lim{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:6px;align-items:end;margin-top:6px}.vus-lim label{display:flex;flex-direction:column;gap:2px;font-size:11.5px;color:#7fb6d6}
.vus-lim select,.vus-lim input{background:rgba(0,12,28,.9);color:#d9eef9;border:1px solid rgba(40,150,200,.45);border-radius:3px;padding:4px 6px;font:inherit}
.vus-li{display:flex;gap:8px;align-items:center;font-size:.95em;padding:2px 0;flex-wrap:wrap}.vus-li span{flex:1;min-width:0}.vus-src{font-size:10.5px;color:#7fb6d6;border:1px solid rgba(40,150,200,.35);border-radius:8px;padding:0 6px;white-space:nowrap}
.vus-stor{display:flex;height:9px;border-radius:5px;overflow:hidden;background:rgba(25,211,255,.1)}.vus-stor i{display:block;height:100%}
.vus-msg{min-height:1.3em;font-size:12.5px;color:#8fe3ff}.vus-msg.warn{color:${AMBER}}
`;

export function initUsageView() {
  const style = document.createElement('style'); style.textContent = CSS + EXTRA_CSS; document.head.appendChild(style);
  const back = document.createElement('div'); back.className = 'vf-back'; back.id = 'vus-back'; back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true'); back.setAttribute('aria-label', '利用状況');
  back.innerHTML = `<div class="vf"><div class="vf-top"><i></i><h2>USAGE</h2><span class="vf-muted">利用状況（すべての端末の合計）</span><span class="sp"></span><button class="vf-btn" data-reload type="button">更新 ↻</button><button class="vf-btn" data-x type="button">閉じる</button></div><div class="vf-body" id="vus-body">読み込み中…</div></div>`;
  document.body.appendChild(back);
  const body = back.querySelector('#vus-body');
  let last = null, msg = '';

  const meterBar = (pct, level) => `<div class="vus-bar" title="${pct}%"><i style="width:${Math.min(100, pct)}%;--c:${lvlColor(level)}"></i></div>`;
  function render(s) {
    if (!s) { body.innerHTML = '<div class="vf-muted">読み込めませんでした。ネットワークを確認して、「更新」を押してください。</div>'; return; }
    const rows = usageRows(s);
    const gauge = (r) => {
      const m = r.meters.find((x) => x.period === 'day') || r.meters[0], cls = m?.level === 'over' ? 'bad' : m?.level === 'warn' ? 'warn' : '';
      return `<div class="vus-g ${cls}"><div class="vus-gh"><b title="${esc(r.label)}">${esc(r.label)}</b><span>今日 ${esc(fmt(r.today, r.scale, r.unit))}</span><em class="vf-muted">今月 ${esc(fmt(r.month, r.scale, r.unit))}</em></div>
        ${m ? `${meterBar(m.pct, m.level)}<div class="vus-n ${m.level !== 'ok' ? 'ov' : ''}">${esc(m.text)}・${esc(lvlText(m.level))}${m.softAction === 'block' ? '（上限で止まります）' : '（知らせるだけ）'}</div>` : ''}
        <div class="vus-cap"><span class="vus-src">${esc(SOURCE_JA[r.source] || r.source)}</span></div></div>`;
    };
    const hard = (s.hardMeters || []).map((m) => `<div class="vus-g ${m.level === 'over' ? 'bad' : m.level === 'warn' ? 'warn' : ''}"><div class="vus-gh"><b>${esc(m.label)}</b><span>${m.used.toLocaleString('ja-JP')} / ${m.limit.toLocaleString('ja-JP')}</span><em style="color:${lvlColor(m.level)}">${m.pct}%</em></div>${meterBar(m.pct, m.level)}<div class="vus-n">管理者が設定した上限です（あなたからは変えられません）</div></div>`).join('');
    const h = s.hard || {}, plat = [h.requestsPerMinute != null ? `1分に ${h.requestsPerMinute} リクエスト` : '', h.liveTokensPerHour != null ? `Live 開始 1時間に ${h.liveTokensPerHour} 回` : '', h.connectorCallsPerDay != null ? `連携アプリ 1日 ${h.connectorCallsPerDay} 回` : ''].filter(Boolean).join('／');
    const drows = dayRows(s.daily, s.day, 14), live = drows.map((r) => r.liveMinutes), calls = drows.map((r) => r.calls), labs = drows.map((r) => `${Number(r.day.slice(5, 7))}/${Number(r.day.slice(8))}`);
    const tb = toolBreakdown(s.tools, 8), tmax = Math.max(1, ...tb.map((t) => t.count)), tot = (a) => a.reduce((x, y) => x + y, 0);
    const tools = tb.length ? `<div class="vus-tl">${tb.map((t) => `<div class="vus-tr"><span title="${esc(t.name)}">${esc(toolLabel(t.name))}</span><div class="vus-bar"><i style="width:${Math.round((t.count / tmax) * 100)}%"></i></div><b>${t.count}</b></div>`).join('')}</div>` : '<div class="vf-muted">まだ記録がありません。</div>';
    const st = s.storage, parts = [['files', '原本', CYAN], ['text', '文字', '#8fb3ff'], ['notes', 'ノート', '#d9a441'], ['messages', '会話', '#b58cff']];
    const mbs = (b) => `${(Number(b || 0) / 1048576).toFixed(1)} MB`, pctOf = (b) => Math.min(100, (b / Math.max(1, st.quotaBytes)) * 100);
    const lims = (s.limits || []).map((l) => `<div class="vus-li"><span>${esc(s.catalog[l.provider]?.label || l.provider)}・${esc(s.catalog[l.provider]?.metrics[l.metric]?.label || l.metric)}（${l.period === 'day' ? '1日' : '1か月'}）：${esc(fmt(l.soft, s.catalog[l.provider]?.metrics[l.metric]?.scale, s.catalog[l.provider]?.metrics[l.metric]?.unit))}・${l.softAction === 'block' ? '上限で止める' : '上限で知らせる'}</span><button class="vf-btn" type="button" data-dellim="${esc(`${l.provider}/${l.metric}/${l.period}`)}">解除</button></div>`).join('') || '<div class="vf-muted">上限はまだ設定していません。</div>';
    const provOpts = Object.entries(s.catalog).map(([p, d]) => `<option value="${esc(p)}">${esc(d.label)}</option>`).join('');
    body.innerHTML = `<div class="vus-main">
      <div class="vf-card vus-first"><h3>今日・今月の使用量</h3><div class="vus-gauges">${rows.length ? rows.map(gauge).join('') : '<div class="vf-muted">まだ記録がありません。</div>'}${hard}</div></div>
      <div class="vf-card"><h3>直近14日：Gemini の呼び出しとライブ会話の分数</h3><div class="vus-cap"><span>呼び出し 合計 ${tot(calls)}回・ライブ ${Math.round(tot(live))}分</span><span>棒＝1日（右が今日）</span></div>${barsSvg(live, labs, { unit: '分', aria: '直近14日のライブ会話の分数' })}${barsSvg(calls, labs, { unit: '回', color: '#8fb3ff', aria: '直近14日の呼び出し回数', h: 70 })}</div>
      <div class="vf-card"><h3>よく使った道具（端末からの報告）</h3>${tools}</div>
    </div>
    <div class="vf-card" style="margin-top:6px"><h3>保存容量　${esc(mbs(st.usedBytes))} / ${esc(mbs(st.quotaBytes))}</h3><div class="vus-stor" role="img" aria-label="保存容量の内訳">${parts.map(([k, l, c]) => `<i style="width:${pctOf(st.breakdown[k]).toFixed(2)}%;background:${c}" title="${l} ${esc(mbs(st.breakdown[k]))}"></i>`).join('')}</div><div class="vus-cap"><span>${parts.map(([k, l]) => `${l} ${esc(mbs(st.breakdown[k]))}`).join('　')}</span></div></div>
    <div class="vf-card" style="margin-top:6px"><h3>あなたの上限（知らせる／止める）</h3>${lims}
      <div class="vus-lim"><label>項目<select id="vus-p">${provOpts}</select></label><label>指標<select id="vus-m"></select></label><label>期間<select id="vus-per"><option value="day">1日</option><option value="month">1か月</option></select></label>
        <label><span id="vus-unit">上限（回）</span><input id="vus-v" type="number" min="0" step="1" inputmode="numeric"></label><label>超えたら<select id="vus-a"><option value="warn">知らせる</option><option value="block">止める</option></select></label><button class="vf-btn" data-addlim type="button">設定する</button></div>
      <div class="vus-msg ${msg.startsWith('!') ? 'warn' : ''}" id="vus-msg" role="status">${esc(msg.replace(/^!/, ''))}</div>
      <div class="vus-guide">「知らせる」は、80%と100%でメーターの色が変わり、ライブ会話の中でも一言お伝えします。「止める」は、その項目の呼び出しを上限で止めます（いつでも変更・解除できます）。${plat ? `<br><b>このアカウントの共通の上限：</b>${esc(plat)}（管理者が決めます）` : ''}</div></div>
    <div class="vus-guide" style="margin-top:6px"><b>見方：</b>${esc(s.scope)}を、サーバーで数えています。<b>呼び出し・トークン・Live の開始</b>はサーバーで計測、<b>Live の時間と道具の回数</b>は端末からの報告（サーバーが時間の長さを検算）です。日付はあなたのタイムゾーンで区切ります。AI の費用は、あなた自身の API キーの契約にかかります。</div>`;
    fillMetrics(s);
  }
  function fillMetrics(s) {
    const p = body.querySelector('#vus-p'), m = body.querySelector('#vus-m'); if (!p || !m) return;
    const upd = () => { const ms = s.catalog[p.value].metrics; m.innerHTML = Object.entries(ms).map(([k, d]) => `<option value="${esc(k)}">${esc(d.label)}</option>`).join(''); unit(); };
    const unit = () => { const d = s.catalog[p.value]?.metrics[m.value]; body.querySelector('#vus-unit').textContent = `上限（${d?.unit || '回'}）`; };
    p.addEventListener('change', upd); m.addEventListener('change', unit); upd();
  }
  async function load(force = true) { if (!last) body.textContent = '読み込み中…'; last = await usage.summary({ force }); render(last); return last; }
  const isOpen = () => back.classList.contains('on');
  back.addEventListener('click', async (e) => {
    if (e.target === back || e.target.closest('[data-x]')) { back.classList.remove('on'); return; }
    if (e.target.closest('[data-reload]')) { msg = ''; load(); return; }
    const del = e.target.closest('[data-dellim]');
    if (del) { const r = await api(`/api/elvar/usage/limits/${del.dataset.dellim}`, { method: 'DELETE' }); msg = r.status === 200 ? '上限を解除しました' : '!解除できませんでした'; await load(); return; }
    if (e.target.closest('[data-addlim]')) {
      const q = (id) => body.querySelector(id), d = last.catalog[q('#vus-p').value]?.metrics[q('#vus-m').value], v = Number(String(q('#vus-v').value).normalize('NFKC').trim());
      if (!Number.isFinite(v) || v < 0 || q('#vus-v').value === '') { msg = '!上限の数を入れてください'; render(last); return; }
      const r = await api('/api/elvar/usage/limits', { method: 'PUT', body: { provider: q('#vus-p').value, metric: q('#vus-m').value, period: q('#vus-per').value, soft: Math.round(v / (d?.scale || 1)), softAction: q('#vus-a').value } });
      msg = r.status === 200 ? '上限を設定しました' : `!${r.body?.message || '設定できませんでした'}`; await load(); return;
    }
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) { e.stopImmediatePropagation(); e.preventDefault(); back.classList.remove('on'); } }, true);
  return { open() { back.classList.add('on'); return load(); }, show(server) { back.classList.add('on'); if (server?.catalog) { last = server; render(server); } else load(); }, close() { back.classList.remove('on'); }, get isOpen() { return isOpen(); }, el: back };
}
