import { ownerAddress } from './brand.js';
// 製作の進捗 panel: how far each Claude Code build has come (a 7-stage meter per build), how much Claude Code ran through E.L.V.A.R. (24 h / 7 day charts),
// and whether the session limit seems to have been hit. Everything comes from the server (build_status: read from GitHub); this file only draws it.
// Honest by design: the remaining session quota is NOT readable by E.L.V.A.R., so only measured runs are drawn and the page says where the exact value is.
// Same look as the finance / shift screens: it reuses the .vf-* styles injected by finance-view.js (that module is initialised first).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const GREEN = '#5ee08a', AMBER = '#ffb347', RED = '#ff6b6b', CYAN = '#19d3ff', DIM = '#2a7fa6';
const CSS = `
.vbd-main{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);grid-template-rows:minmax(0,1fr) auto;gap:8px}
.vbd-builds{grid-row:1/3;display:flex;flex-direction:column;gap:4px;min-height:0}
.vbd-grid{flex:1;min-height:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:minmax(0,1fr);gap:8px}
.vbd-card{border:1px solid rgba(40,150,200,.4);border-radius:4px;padding:6px 10px;background:rgba(25,211,255,.04);min-width:0;min-height:0;overflow:hidden;display:flex;flex-direction:column;gap:3px}
.vbd-card.ghost{opacity:.5}.vbd-card.bad{border-color:rgba(255,107,107,.7)}
.vbd-h{display:flex;align-items:center;gap:6px;min-width:0}.vbd-h b{color:#fff;font-weight:600;font-size:1.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.vbd-kind{flex:none;font-size:10.5px;padding:0 6px;border:1px solid currentColor;border-radius:8px;color:#8fe3ff;white-space:nowrap}.vbd-kind.self{color:#a78bfa}
.vbd-steps{display:flex;gap:3px}.vbd-steps i{flex:1;height:8px;border-radius:2px;background:rgba(25,211,255,.12);border:1px solid rgba(40,150,200,.35)}
.vbd-steps i.done{background:var(--c,#19d3ff);opacity:.6;border-color:transparent}.vbd-steps i.current{background:var(--c,#19d3ff);border-color:#fff;box-shadow:0 0 7px var(--c,#19d3ff);animation:vbd-pulse 1.6s ease-in-out infinite}
@keyframes vbd-pulse{50%{opacity:.55}}@media (prefers-reduced-motion:reduce){.vbd-steps i.current{animation:none}}
.vbd-now{display:flex;align-items:baseline;gap:6px;white-space:nowrap;overflow:hidden}.vbd-now b{color:#fff}.vbd-now .pct{margin-left:auto;color:#fff;font-weight:600}
.vbd-bar{height:7px;background:rgba(25,211,255,.1);border-radius:4px;overflow:hidden}.vbd-bar i{display:block;height:100%;border-radius:4px;background:var(--c,#19d3ff)}
.vbd-meta{color:#8fb5cc;font-size:.92em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.vbd-meta .ok{color:${GREEN}}.vbd-meta .bad{color:${RED}}.vbd-meta .warn{color:${AMBER}}
.vbd-sum{color:#cfe6f3;font-size:.92em;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.vbd-link{margin-top:auto;font-size:11.5px;color:#8fe3ff;text-decoration:none;white-space:nowrap}.vbd-link:hover{color:#fff;text-decoration:underline}
.vbd-more{color:#7fb6d6;font-size:12px;text-align:right;flex:none}
.vbd-guide{display:flex;flex-direction:column;gap:2px;font-size:.9em;line-height:1.33;overflow:hidden}.vbd-guide p{margin:0;color:#d9eef9}.vbd-guide p b{color:#8fe3ff;font-weight:600}
.vbd-gt{display:flex;align-items:center;gap:8px}.vbd-gt h3{margin:0;flex:1}.vbd-i{background:none;border:1px solid rgba(25,211,255,.6);color:#8fe3ff;border-radius:50%;width:20px;height:20px;line-height:1;font-size:12px;cursor:pointer;padding:0}.vbd-i:hover{background:rgba(25,211,255,.25);color:#fff}
.vbd-chartcap{color:#7fb6d6;font-size:11.5px;display:flex;justify-content:space-between;gap:6px}
.vbd-sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:3px;vertical-align:-1px}
.vbd-banner{display:flex;gap:10px;align-items:baseline;margin-bottom:0;padding:5px 10px;font-size:12.5px;line-height:1.4}.vbd-banner>b{flex:none;color:#fff}.vbd-banner.hit{border-color:rgba(255,107,107,.85);background:rgba(255,107,107,.12);color:#ffd0d0}
.vbd-pop{position:absolute;left:14px;right:14px;top:56px;bottom:14px;z-index:3;overflow:auto;background:#010e1e;border:1.5px solid rgba(30,166,216,.9);border-radius:6px;padding:12px 16px;box-shadow:0 0 14px rgba(25,190,255,.4)}.vbd-pop[hidden]{display:none}
.vbd-pop h3{margin:10px 0 4px;color:#8fe3ff;font-size:13px;letter-spacing:1.5px}.vbd-pop h3:first-of-type{margin-top:0}.vbd-pop p,.vbd-pop li{margin:3px 0;font-size:13.5px;line-height:1.55;color:#e6f6ff}.vbd-pop ul{margin:2px 0;padding-left:1.2em}
@media (max-width:900px){.vbd-main{display:flex;flex-direction:column;flex:none}.vbd-builds,.vbd-grid{flex:none}.vbd-grid{grid-template-columns:1fr;grid-auto-rows:auto}.vbd-main .vf-card svg{flex:none;height:auto}.vbd-card{overflow:visible;flex:none}.vbd-sum{-webkit-line-clamp:4}.vbd-pop{top:50px}}
@media (min-width:901px) and (max-height:640px){.vbd-sum,.vbd-guide p:nth-child(n+4){display:none}.vbd-card{padding:4px 8px;gap:2px}.vbd-steps i{height:6px}.vbd-link{display:none}}
`;

export const STAGE_ORDER = ['received', 'started', 'implementing', 'pr', 'checks', 'review', 'done'];
export const STAGE_LABEL = { received: '依頼受付', started: '作業開始', implementing: '実装中', pr: 'PR作成', checks: 'テスト/チェック', review: '確認待ち', done: '完成' };

/** Pure (tested): the colour of a build's meter. */
export function stageColor(progress) {
  if (!progress) return DIM;
  if (progress.problem) return RED;
  if (progress.stage === 'done') return GREEN;
  if (progress.stage === 'review') return AMBER;
  return CYAN;
}
/** Pure (tested): 7 segments for the stage meter. Without a progress object (not known) every segment is empty. */
export function stageSegments(progress) {
  const list = progress?.stages?.length ? progress.stages : STAGE_ORDER.map((id) => ({ id, label: STAGE_LABEL[id], done: false, current: false }));
  return list.map((s) => ({ id: s.id, label: s.label || STAGE_LABEL[s.id], state: s.current ? 'current' : s.done ? 'done' : 'todo', problem: !!(s.current && progress?.problem) }));
}
export const stepperHtml = (progress) => { const c = stageColor(progress); return `<div class="vbd-steps" style="--c:${c}" role="img" aria-label="${esc(progress ? `${STAGE_LABEL[progress.stage] || ''}（${progress.percent}%）` : '段階は不明')}">${stageSegments(progress).map((s) => `<i class="${s.state}" title="${esc(s.label)}"></i>`).join('')}</div>`; };
/** Pure (tested) */
export const percentBar = (pct, color = CYAN) => `<div class="vbd-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, Math.max(0, Math.round(pct ?? 0)))}"><i style="width:${Math.min(100, Math.max(0, pct ?? 0))}%;--c:${color}"></i></div>`;
/** Pure (tested): 90 -> 1時間30分 */
export function fmtElapsed(min) {
  if (min == null || !Number.isFinite(min)) return '—';
  const m = Math.round(min); if (m < 60) return `${m}分`;
  if (m < 1440) return m % 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${Math.floor(m / 60)}時間`;
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60); return h ? `${d}日${h}時間` : `${d}日`;
}
export function fmtAgo(iso, now = Date.now()) { const t = Date.parse(iso); if (!Number.isFinite(t)) return ''; const m = Math.max(0, Math.round((now - t) / 60000)); return m < 1 ? 'たった今' : `${fmtElapsed(m)}前`; }
/** Pure (tested): the PR checks as one phrase + a class */
export function checksText(c) {
  if (!c) return null;
  if (c.state === 'unknown') return { cls: 'warn', text: c.error || '取得できませんでした（権限不足）' };
  if (c.state === 'none') return { cls: '', text: 'チェックなし' };
  const n = `${c.passed}/${c.total}`;
  return c.state === 'success' ? { cls: 'ok', text: `✔ チェック全て成功 ${n}` } : c.state === 'failure' ? { cls: 'bad', text: `✖ チェック失敗 ${c.failed}件（成功 ${n}）` } : { cls: 'warn', text: `… チェック実行中（成功 ${n}）` };
}
/** Pure (tested): the five KPI tiles. */
export function kpiOf(d) {
  const b = d.builds || [], by = (s) => b.filter((x) => x.state === s).length, u = d.usage, l = d.limit;
  const kp = [
    { label: '進行中', value: by('queued') + by('working'), sub: '依頼済み・作業中', cls: '' },
    { label: '確認待ち（PR）', value: by('review'), sub: by('review') ? ownerAddress() + 'の確認を待っています' : 'なし', cls: by('review') ? 'warn' : '' },
    { label: '完成', value: by('done'), sub: '直近14日', cls: by('done') ? 'ok' : '' },
  ];
  if (!u || u.available === false) kp.push({ label: '直近5時間の実行', value: '—', sub: u?.error || '取得できませんでした', cls: '' });
  else kp.push({ label: '直近5時間の実行', value: `${u.last5h.runs}回`, sub: u.runLimit5h ? `ご自分の目安 ${u.runLimit5h}回に対し ${Math.round((u.ratio5h || 0) * 100)}%` : `合計 ${u.last5h.minutes}分`, cls: u.runLimit5h && u.ratio5h >= 1 ? 'bad' : u.runLimit5h && u.ratio5h >= 0.8 ? 'warn' : '', meter: u.runLimit5h ? Math.min(100, Math.round((u.ratio5h || 0) * 100)) : null });
  if (l?.hit) kp.push({ label: '上限の状態', value: '達した可能性', sub: l.resetHint ? `リセット：${l.resetHint}` : '上限に達したと思われる表示あり', cls: 'bad' });
  else if (l?.suspect) kp.push({ label: '上限の状態', value: '不明', sub: '直近の実行が失敗（原因は不明）', cls: 'warn' });
  else kp.push({ label: '上限の状態', value: '表示なし', sub: '正確な残りは、E.L.V.A.R.からは見えません', cls: '' });
  return kp;
}

/** Pure SVG strings (tested). 24 hourly bars (runs per hour); the last 5 hours sit on a highlighted band. */
export function hourlySvg(usage, w = 300, h = 84) {
  const hrs = usage?.hourly?.length ? usage.hourly : Array.from({ length: 24 }, (_, i) => ({ hoursAgo: 23 - i, runs: 0, minutes: 0 }));
  const max = Math.max(1, ...hrs.map((x) => x.runs)), bw = (w - 16) / hrs.length, base = h - 16, top = 12;
  const bars = hrs.map((x, i) => { const bh = x.runs ? Math.max(3, Math.round((x.runs / max) * (base - top))) : 0, bx = 8 + i * bw; return `<g><title>${esc(`${x.hoursAgo}時間前：${x.runs}回・${x.minutes}分`)}</title>${x.runs ? `<rect x="${(bx + 1).toFixed(1)}" y="${base - bh}" width="${(bw - 2).toFixed(1)}" height="${bh}" rx="1.5" fill="${x.hoursAgo < 5 ? CYAN : DIM}"/>` : ''}</g>`; }).join('');
  const bx5 = 8 + (hrs.length - 5) * bw;
  const lab = (i, t) => `<text x="${(8 + i * bw + (i ? bw / 2 : 0)).toFixed(1)}" y="${h - 3}" text-anchor="${i ? 'middle' : 'start'}" font-size="9.5" fill="#7fb6d6">${t}</text>`;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="直近24時間の実行回数（1時間ごと）"><rect x="${bx5.toFixed(1)}" y="2" width="${(w - 8 - bx5).toFixed(1)}" height="${base - 1}" fill="#19d3ff" opacity=".1" rx="2"/><line x1="6" y1="${base}" x2="${w - 6}" y2="${base}" stroke="#2a7fa6"/>${bars}<text x="${(bx5 + 3).toFixed(1)}" y="11" font-size="9.5" fill="#8fe3ff">直近5時間</text><text x="8" y="11" font-size="9.5" fill="#7fb6d6">最大 ${max}回/時</text>${lab(0, '24時間前')}${lab(6, '18')}${lab(12, '12')}${lab(18, '6')}${lab(23, 'いま')}</svg>`;
}
/** Pure SVG strings (tested). 7 daily bars (runs per day, JST). */
export function dailySvg(usage, w = 300, h = 84) {
  const ds = usage?.daily?.length ? usage.daily : Array.from({ length: 7 }, () => ({ date: '', runs: 0, minutes: 0 }));
  const max = Math.max(1, ...ds.map((x) => x.runs)), bw = (w - 16) / ds.length, base = h - 16, top = 14;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="直近7日の実行回数（1日ごと）"><line x1="6" y1="${base}" x2="${w - 6}" y2="${base}" stroke="#2a7fa6"/>${ds.map((x, i) => { const bh = x.runs ? Math.max(3, Math.round((x.runs / max) * (base - top))) : 0, bx = 8 + i * bw, last = i === ds.length - 1; return `<g><title>${esc(`${x.date}：${x.runs}回・${x.minutes}分`)}</title>${x.runs ? `<rect x="${(bx + 5).toFixed(1)}" y="${base - bh}" width="${(bw - 10).toFixed(1)}" height="${bh}" rx="2" fill="${last ? CYAN : DIM}"/><text x="${(bx + bw / 2).toFixed(1)}" y="${base - bh - 3}" text-anchor="middle" font-size="9.5" fill="#d9eef9">${x.runs}</text>` : ''}<text x="${(bx + bw / 2).toFixed(1)}" y="${h - 3}" text-anchor="middle" font-size="9.5" fill="#7fb6d6">${x.date ? `${Number(x.date.slice(5, 7))}/${Number(x.date.slice(8))}` : ''}</text></g>`; }).join('')}</svg>`;
}

const GUIDE_LINES = [
  ['段階', '依頼受付→作業開始→実装中→PR作成→テスト/チェック→確認待ち→完成の7つ。濃い色が済み、光っているのがいまです。'],
  ['％', '段階から決めた大まかな目安です。残り時間の予測ではありません。'],
  ['実行回数', 'E.L.V.A.R.経由でClaude Codeが動いた回数と分数です（GitHub Actionsの記録）。'],
  ['色', '水色＝進行中、橙＝確認待ち、緑＝完成・成功、赤＝失敗や上限の疑い。'],
  ['上限', 'セッションの正確な残りは、E.L.V.A.R.からは読めません。claude.ai の 設定→使用状況、またはPCのClaude Codeで /usage を見てください。'],
];
const GUIDE_FULL = `<h3>この画面でわかること</h3><p>${ownerAddress()}がClaude Codeに頼んだ製作（新規製作・E.L.V.A.R.の自己改造）が、いまどこまで進んでいるかを、GitHubの記録から読み取って表示します。</p>
<h3>7つの段階の読み方</h3><ul><li><b>依頼受付</b>：依頼（GitHubのIssue）ができた。まだ誰も着手していません。</li><li><b>作業開始</b>：Claude Codeの実行が始まった。</li><li><b>実装中</b>：Claude Codeが進み具合をコメントしている。まだPull Request（変更案）はありません。</li><li><b>PR作成</b>：PRが下書きでできた。仕上げの最中です。</li><li><b>テスト/チェック</b>：PRの自動チェックを実行中、または失敗している（赤）。</li><li><b>確認待ち</b>：PRができて、チェックも通った（またはチェックなし）。${ownerAddress()}の確認を待っています。</li><li><b>完成</b>：PRがマージされた、または依頼が完了（クローズ）になった。</li></ul>
<h3>％（進み具合）について</h3><p>％は、上の段階に一定の数字を割り当てただけの目安です（例：実装中は40%、確認待ちは90%）。かかる時間の予測ではなく、「あと何分」とは言えません。</p>
<h3>実行回数・分数</h3><p>製作用のリポジトリで、Claude Code（GitHub Actions）が動いた回数と、その実行時間の合計です。直近24時間は1時間ごと、直近7日は1日ごと（日本時間）に集計しています。分数は、その実行が始まった時間帯に数えています。</p>
<h3>セッションの上限について（大切）</h3><ul><li>Claudeの「5時間のセッション上限」「週の上限」の<b>正確な残りは、E.L.V.A.R.からは読み取れません</b>（Anthropicが外部に公開していないためです）。</li><li>正確な残りは、${ownerAddress()}ご自身が <b>claude.ai の 設定→使用状況</b>、またはPCのClaude Codeで <b>/usage</b> を実行すると確認できます。</li><li>ここに出るのは「E.L.V.A.R.経由で動いた分」だけです。同じアカウントでの claude.ai、他のリポジトリ、PCでの利用は含みません。</li><li>「上限の状態」は、Claude Codeのコメントに上限らしい文言があったときだけ「達した可能性」と出ます。確実ではありません。</li><li>環境変数 CLAUDE_SESSION_RUN_LIMIT に、ご自分で決めた「5時間あたりの回数の目安」を入れると、5時間の実行回数を、その目安に対する割合のメーターで表示します（公式の上限ではありません）。</li></ul>
<h3>色</h3><p>水色＝進行中／橙＝確認待ち・注意／緑＝完成・成功／赤＝失敗・上限の疑い／灰色＝まだ（または取得できない）。</p>`;

export function initBuildView({ call }) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const back = document.createElement('div'); back.className = 'vf-back'; back.id = 'vbd-back'; back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true'); back.setAttribute('aria-label', '製作の進捗');
  back.innerHTML = `<div class="vf"><div class="vf-top"><i></i><h2>BUILD</h2><span class="vf-muted" id="vbd-sub">製作の進捗</span><span class="sp"></span><button class="vf-btn" data-reload type="button" title="GitHubから読み直します">更新 ↻</button><button class="vf-btn" data-x type="button">閉じる</button></div><div class="vf-body" id="vbd-body">読み込み中…</div><div class="vbd-pop" id="vbd-pop" hidden></div></div>`;
  document.body.appendChild(back);
  const body = back.querySelector('#vbd-body'), pop = back.querySelector('#vbd-pop'), sub = back.querySelector('#vbd-sub');
  pop.innerHTML = `<div style="display:flex;align-items:center"><b style="color:#fff;flex:1">この画面の見方・説明</b><button class="vf-btn" data-closepop type="button">閉じる</button></div>${GUIDE_FULL}`;
  let data = null;
  const SHOW = 4;

  const kindOf = (b) => (b.self ? '<span class="vbd-kind self">自己改造</span>' : '<span class="vbd-kind">新規製作</span>');
  function buildCard(b, now) {
    const p = b.progress, c = stageColor(p), pr = b.pr, ck = pr ? checksText(pr.checks) : null;
    const runTxt = !b.run ? '' : b.run.error ? `Action：${esc(b.run.error)}` : `Action：${b.run.status === 'in_progress' ? '実行中' : b.run.status === 'queued' ? '待機中' : b.run.conclusion === 'success' ? '成功' : b.run.conclusion === 'failure' ? '失敗' : '完了'}（${b.run.count}回・${b.run.minutes}分）`;
    const stats = pr ? (pr.stats ? `${pr.stats.changedFiles ?? '?'}ファイル <span class="ok">+${pr.stats.additions ?? '?'}</span> <span class="bad">−${pr.stats.deletions ?? '?'}</span>・${pr.stats.commits ?? '?'}コミット` : esc(pr.statsError || '')) : '';
    return `<div class="vbd-card${p?.problem ? ' bad' : ''}" data-build="${esc(b.key)}"><div class="vbd-h"><b title="${esc(b.title)}">${esc(b.title)}</b>${kindOf(b)}</div>
      ${stepperHtml(p)}
      <div class="vbd-now"><span>いま：<b>${esc(STAGE_LABEL[p?.stage] || b.stateLabel || '—')}</b> <small class="vf-muted">${p ? STAGE_ORDER.indexOf(p.stage) + 1 : '?'}/7</small></span><span class="pct">${p ? p.percent + '%' : '—'}</span></div>
      ${percentBar(p?.percent ?? 0, c)}
      <div class="vbd-meta">経過 ${fmtElapsed(b.elapsedMin)}${runTxt ? `・${runTxt}` : ''}</div>
      ${pr ? `<div class="vbd-meta">PR #${pr.number}${pr.draft ? '（下書き）' : ''}${stats ? `・${stats}` : ''}</div>` : ''}
      ${ck || p?.problem ? `<div class="vbd-meta">${ck ? `<span class="${ck.cls}">${esc(ck.text)}</span>` : ''}</div>` : ''}
      ${b.summary ? `<div class="vbd-sum" title="${esc(b.summary)}">${esc(b.summary)}</div>` : ''}
      ${b.url ? `<a class="vbd-link" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer">GitHubで開く ↗</a>` : ''}</div>`;
  }
  const ghostCard = (t) => `<div class="vbd-card ghost"><div class="vbd-h"><b>${t}</b><span class="vbd-kind">新規製作</span></div>${stepperHtml(null)}<div class="vbd-now"><span>いま：<b>—</b></span><span class="pct">—</span></div>${percentBar(0)}<div class="vbd-meta">経過 — ・ Action — ・ PR —</div></div>`;

  function render(d) {
    data = d; const now = Date.now(), builds = d.builds || [], u = d.usage, l = d.limit, none = !builds.length;
    sub.textContent = d.generatedAt ? `製作の進捗（${new Date(d.generatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 時点）` : '製作の進捗';
    const banner = d.unconfigured ? '<div class="vf-banner bad">製作依頼の連携が未設定です（環境変数 BUILD_REPO / BUILD_SELF_REPO と BUILD_GITHUB_TOKEN）。設定すると、ここに進み具合が出ます（下は、まだないときの見本です）。</div>'
      : d.error ? `<div class="vf-banner bad">読み込めませんでした：${esc(d.error)}</div>`
      : l?.hit ? `<div class="vf-banner vbd-banner hit" role="alert"><b>上限に達した可能性があります</b><span>上限に達したと思われる表示がありました${l.at ? `（${esc(fmtAgo(l.at, now))}）` : ''}。${l.resetHint ? `リセット：${esc(l.resetHint)}。` : ''}確実ではありません。正確な状況は claude.ai の 設定→使用状況、またはPCの /usage で。${l.text ? ` 表示：「${esc(l.text.slice(0, 90))}」` : ''}</span></div>`
      : none ? '<div class="vf-banner">まだ製作の依頼はありません。「〇〇を作って」と話しかけると、Claude Codeに依頼でき、ここに進み具合が出ます（下は見本です）。</div>' : '';
    const kp = kpiOf(d);
    const kpis = `<div class="vf-kpis">${kp.map((k) => `<div class="vf-k ${k.cls}"><small>${esc(k.label)}</small><b${String(k.value).length > 4 ? ' style="font-size:clamp(13px,2.1vh,16px)"' : ''}>${esc(k.value)}</b><em>${esc(k.sub)}</em>${k.meter != null ? percentBar(k.meter, k.meter >= 100 ? RED : k.meter >= 80 ? AMBER : CYAN) : ''}</div>`).join('')}</div>`;
    const shown = builds.slice(0, SHOW), more = builds.length - shown.length;
    const cards = none ? ghostCard('製作の名前') + ghostCard('もうひとつの製作') : shown.map((b) => buildCard(b, now)).join('');
    const usageCard = u && u.available !== false
      ? `<div class="vf-card"><h3>Claude Codeの実行（E.L.V.A.R.経由・目安）</h3>${hourlySvg(u)}<div class="vbd-chartcap"><span>▲ 1時間ごとの回数（直近24時間）</span><span><i class="vbd-sw" style="background:${CYAN}"></i>直近5時間</span></div>${dailySvg(u)}<div class="vbd-chartcap"><span>▲ 1日ごとの回数（直近7日）</span></div><div class="vf-muted">5時間：${u.last5h.runs}回・${u.last5h.minutes}分／7日：${u.last7d.runs}回・${u.last7d.minutes}分。他の利用は含みません</div></div>`
      : `<div class="vf-card vf-ghost"><h3>Claude Codeの実行（E.L.V.A.R.経由・目安）</h3>${hourlySvg(null)}${dailySvg(null)}<div class="vf-muted">${esc(u?.error || '実行の記録はまだ取得できていません')}。${esc(u?.caveat || '')}</div></div>`;
    const guide = `<div class="vf-card"><div class="vbd-gt"><h3>見方・説明</h3><button class="vbd-i" data-pop type="button" title="詳しい説明を開く" aria-label="詳しい説明を開く">i</button></div><div class="vbd-guide">${GUIDE_LINES.map(([k, t]) => `<p><b>${k}</b>：${esc(t)}</p>`).join('')}</div></div>`;
    body.innerHTML = banner + kpis + `<div class="vbd-main"><div class="vbd-builds"><div class="vbd-grid">${cards}</div>${more > 0 ? `<div class="vbd-more">ほか ${more} 件（新しい順に ${SHOW} 件を表示）</div>` : ''}</div>${usageCard}${guide}</div>`;
  }

  async function load() {
    body.textContent = '読み込み中…';
    try { render(await call('build_status', {})); }
    catch (e) { const msg = String(e?.message ?? e); render({ builds: [], count: 0, unconfigured: /未設定/.test(msg), error: /未設定/.test(msg) ? '' : msg }); }
  }
  back.addEventListener('click', (e) => {
    const t = e.target;
    if (t === back || t.closest('[data-x]')) { pop.hidden = true; back.classList.remove('on'); }
    else if (t.closest('[data-reload]')) load();
    else if (t.closest('[data-pop]')) pop.hidden = !pop.hidden;
    else if (t.closest('[data-closepop]')) pop.hidden = true;
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && back.classList.contains('on')) { e.stopImmediatePropagation(); if (!pop.hidden) pop.hidden = true; else back.classList.remove('on'); } }, true);
  return { open() { back.classList.add('on'); return load(); }, show(d) { back.classList.add('on'); render(d); }, close() { pop.hidden = true; back.classList.remove('on'); }, el: back, get data() { return data; } };
}
