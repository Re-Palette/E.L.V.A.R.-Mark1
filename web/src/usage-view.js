// 使用状況 screen: the API usage of THIS device drawn as meters and charts (today's use vs. the app's budget with a projection to the end of the day,
// 14 days of Gemini live minutes and tool calls, which tools were used most, and the real Groq quota when the API reported one).
// Data = the local ledger (usage.js) + the budgets the server reports (usage_report). Honest: the limits are the app's own estimates except Groq's,
// and the PC and the phone are counted separately. Same look as the other screens (.vf-* styles come from finance-view.js).
import { usage, buildReport } from './usage.js';
import { timeZone } from './brand.js';
import { localDate } from '../../shared/tz.js';
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
const lvlColor = (pct) => (pct >= 90 ? RED : pct >= 70 ? AMBER : GREEN);
const lvlText = (pct) => (pct >= 90 ? '危険' : pct >= 70 ? '注意' : '余裕あり');
const jstDay = (ms) => localDate(ms, timeZone());

/** Pure (tested): the last `n` days (oldest first, today last) from the ledger → [{ day, liveMinutes, liveSessions, calls, tools }]. Missing days are zeros. */
export function dayRows(raw, n = 14, nowMs = Date.now()) {
  const days = raw?.days || {}, out = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = jstDay(nowMs - i * 86400e3), d = days[day] || {}, tools = d.tools || {};
    out.push({ day, liveMinutes: Math.round(((d.liveSeconds || 0) / 60) * 10) / 10, liveSessions: d.liveSessions || 0, calls: Object.values(tools).reduce((a, c) => a + c, 0), tools });
  }
  return out;
}
/** Pure (tested): tool-call counts over the given rows, most used first → [{ name, count }] */
export function toolBreakdown(rows, top = 8) {
  const m = new Map(); for (const r of rows) for (const [k, v] of Object.entries(r.tools || {})) m.set(k, (m.get(k) || 0) + v);
  return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, top);
}
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

export function initUsageView({ call }) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const back = document.createElement('div'); back.className = 'vf-back'; back.id = 'vus-back'; back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true'); back.setAttribute('aria-label', 'API使用状況');
  back.innerHTML = `<div class="vf"><div class="vf-top"><i></i><h2>USAGE</h2><span class="vf-muted">APIの使用状況</span><span class="sp"></span><button class="vf-btn" data-reload type="button">更新 ↻</button><button class="vf-btn" data-x type="button">閉じる</button></div><div class="vf-body" id="vus-body">読み込み中…</div></div>`;
  document.body.appendChild(back);
  const body = back.querySelector('#vus-body');
  let last = null;

  function render(server) {
    const rep = buildReport(server || {}), raw = usage.raw(), rows = dayRows(raw, 14), q = raw.quotas?.groq;
    const gauge = (it) => {
      if (!(it.limit > 0)) return `<div class="vus-g"><div class="vus-gh"><b title="${esc(it.name)}">${esc(it.name)}</b><span>${it.used}${esc(it.unit)}</span><em class="vf-muted">上限なし/未設定</em></div><div class="vus-n">${esc(it.note || '')}</div></div>`;
      const pct = Math.min(100, it.usedPct), proj = it.projectedEndOfDayPct, c = lvlColor(Math.max(it.usedPct, Math.min(proj ?? 0, 100)));
      const cls = c === RED ? 'bad' : c === AMBER ? 'warn' : '';
      return `<div class="vus-g ${cls}"><div class="vus-gh"><b title="${esc(it.name)}">${esc(it.name)}</b><span>${it.used} / ${it.limit}${esc(it.unit)}</span><em style="color:${c}">${it.usedPct}%・${lvlText(Math.max(it.usedPct, Math.min(proj ?? 0, 100)))}</em></div>
        <div class="vus-bar" title="使用 ${it.usedPct}%（白い線は、今日の終わりまでの見込み ${proj ?? '?'}%）"><i style="width:${pct}%;--c:${c}"></i>${proj != null ? `<u style="left:${Math.min(100, proj)}%"></u>` : ''}</div>
        <div class="vus-n ${proj >= 100 ? 'ov' : ''}">残り ${it.remaining}${esc(it.unit)}${proj != null ? `・このペースだと今日の終わりに約${proj}%` : ''}${it.ifOver && it.usedPct >= 70 ? `。${esc(it.ifOver)}` : ''}</div></div>`;
    };
    const live = rows.map((r) => r.liveMinutes), liveLine = server?.budgets?.geminiLiveMinutesPerDay || null, calls = rows.map((r) => r.calls);
    const labs = rows.map((r) => `${Number(r.day.slice(5, 7))}/${Number(r.day.slice(8))}`);
    const tb = toolBreakdown(rows), tmax = Math.max(1, ...tb.map((t) => t.count));
    const tools = tb.length ? `<div class="vus-tl">${tb.map((t) => `<div class="vus-tr"><span title="${esc(t.name)}">${esc(toolLabel(t.name))}</span><div class="vus-bar"><i style="width:${Math.round((t.count / tmax) * 100)}%"></i></div><b>${t.count}</b></div>`).join('')}</div>` : '<div class="vf-muted">まだ記録がありません。</div>';
    const groq = q?.requestsLimit > 0 ? `<div class="vus-g"><div class="vus-gh"><b>難しい推論（Groq）の実際の残り</b><span>${q.requestsRemaining} / ${q.requestsLimit}</span></div><div class="vus-bar"><i style="width:${Math.round(((q.requestsLimit - q.requestsRemaining) / q.requestsLimit) * 100)}%;--c:${lvlColor(((q.requestsLimit - q.requestsRemaining) / q.requestsLimit) * 100)}"></i></div><div class="vus-n">Groqが返した実際の数値です（${esc(String(q.at || '').slice(5, 16).replace('T', ' '))}時点）</div></div>` : '';
    const tot = (a) => a.reduce((x, y) => x + y, 0);
    body.innerHTML = `<div class="vus-main">
      <div class="vf-card vus-first"><h3>今日の使用量（1日の経過 ${rep.dayElapsedPct}%）</h3><div class="vus-gauges">${rep.items.map(gauge).join('')}${groq}</div></div>
      <div class="vf-card"><h3>直近14日：Gemini会話の分数</h3><div class="vus-cap"><span>合計 ${Math.round(tot(live))}分・${tot(rows.map((r) => r.liveSessions))}回</span><span>棒＝1日（右が今日）</span></div>${barsSvg(live, labs, { line: liveLine, unit: '分', aria: '直近14日のGemini会話の分数' })}</div>
      <div class="vf-card"><h3>直近14日：道具の呼び出し回数</h3><div class="vus-cap"><span>合計 ${tot(calls)}回</span><span>よく使った順（14日）</span></div>${barsSvg(calls, labs, { unit: '回', color: '#8fb3ff', aria: '直近14日の道具の呼び出し回数', h: 70 })}${tools}</div>
    </div><div class="vus-guide" style="margin-top:6px"><b>見方：</b>棒は使った量、白い線は今日の終わりまでの見込みです。緑＝余裕、橙＝注意（70%〜）、赤＝危険（90%〜）。${esc(rep.scope)}。上限は、Groq以外はこのアプリの目安で、実際の残りはGoogle AI Studioなど各サービスで確認してください。</div>`;
  }

  async function load() { body.textContent = '読み込み中…'; try { last = await call('usage_report', {}); } catch { last = null; } render(last); }
  const isOpen = () => back.classList.contains('on');
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-x]')) back.classList.remove('on'); else if (e.target.closest('[data-reload]')) load(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) { e.stopImmediatePropagation(); e.preventDefault(); back.classList.remove('on'); } }, true);
  return { open() { back.classList.add('on'); return load(); }, show(server) { last = server; back.classList.add('on'); render(server); }, close() { back.classList.remove('on'); }, get isOpen() { return isOpen(); }, el: back };
}
