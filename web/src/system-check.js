// E.L.V.A.R. system check: this device (mic, audio, storage, connection state) + the server (/api/system/check: every API key and service).
// Opens as a panel (phone: the cube icon in the top bar; settings; ?check=1) and by voice (the system_check tool). Reports what was measured.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ORDER = { fail: 0, warn: 1, ok: 2, off: 3 };

/** Counts + the items that need attention. */
export function summarize(items) {
  const counts = { ok: 0, warn: 0, fail: 0, off: 0 };
  for (const i of items) counts[i.status] = (counts[i.status] || 0) + 1;
  const problems = items.filter((i) => i.status === 'fail' || i.status === 'warn').sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const verdict = counts.fail ? `異常が ${counts.fail} 件あります` : counts.warn ? `注意が ${counts.warn} 件あります（動作はします）` : '異常はありません';
  return { counts, problems, verdict };
}
export const reportText = (items, at) => [`E.L.V.A.R. システムチェック ${at || ''}`, ...items.map((i) => `[${{ ok: 'OK', warn: '注意', fail: '異常', off: '未使用' }[i.status]}] ${i.label} — ${i.detail}${i.fix ? `（対処: ${i.fix}）` : ''}`)].join('\n');

export const stateWord = (i) => (i.status === 'ok' ? (i.verified ? '接続中' : '設定済み（未確認）') : i.status === 'warn' ? '注意' : i.status === 'fail' ? '異常' : '未設定');
export const voiceEngineName = (live) => (live?.session ? ({ live: 'Live（リアルタイム）', live2: '別のLive', std: '通常の音声モード' }[live.mode] || 'Live') : '待機中');
const timeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

export async function deviceChecks({ live, bgm, standby, store, keys, authHeaders, standbyInfo, notifications }) {
  const items = []; const add = (id, label, status, detail, fix) => items.push({ id, group: 'device', label, status, detail, ...(fix ? { fix } : {}) });
  const app = window.ElvarAndroid ? 'Androidアプリ' : window.elvarDesktop ? 'Windowsアプリ' : matchMedia('(display-mode: standalone)').matches ? 'ホーム画面のアプリ（PWA）' : 'ブラウザ';
  add('app', 'この端末・アプリ', 'ok', `${app}${window.__elvarDeviceLocked ? '（スマホがロック中。個人データの道具は止まっています）' : ''}`);
  if (window.__elvarDeviceLocked) items[0].status = 'warn';
  // network + server round trip
  {
    const t = performance.now();
    try { const r = await timeout(fetch('/api/health', { cache: 'no-store' }), 6000); const ms = Math.round(performance.now() - t);
      if (!r) add('net', 'ネットワーク・サーバー', 'fail', '6秒以内に応答がありません', '通信状況を確認');
      else add('net', 'ネットワーク・サーバー', r.ok ? (ms > 1500 ? 'warn' : 'ok') : 'fail', r.ok ? `応答 ${ms} ms${ms > 1500 ? '（遅めです）' : ''}` : `サーバーエラー (${r.status})`);
    } catch (e) { add('net', 'ネットワーク・サーバー', 'fail', navigator.onLine ? 'サーバーに接続できません' : '端末がオフラインです', '通信状況を確認'); }
  }
  // microphone permission + devices
  try {
    const st = navigator.permissions ? (await navigator.permissions.query({ name: 'microphone' })).state : null;
    if (st === 'granted') add('micperm', 'マイクの許可', 'ok', '許可されています');
    else if (st === 'denied') add('micperm', 'マイクの許可', 'fail', 'ブロックされています', 'ブラウザやアプリの設定でマイクを許可');
    else if (st === 'prompt') add('micperm', 'マイクの許可', 'warn', 'まだ許可されていません（最初の会話のときに許可を求めます）');
    else add('micperm', 'マイクの許可', 'off', 'この環境では判定できません');
  } catch { add('micperm', 'マイクの許可', 'off', 'この環境では判定できません'); }
  try {
    const n = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput').length;
    add('mic', 'マイク機器', n ? 'ok' : 'fail', n ? `${n} 台を検出` : 'マイクが見つかりません', n ? '' : 'マイクの接続を確認');
  } catch { add('mic', 'マイク機器', 'warn', '確認できませんでした'); }
  // audio output, live session, standby
  const oc = live.outCtx?.state;
  add('audio', '音声の出力', oc === 'running' ? 'ok' : oc === 'suspended' ? 'warn' : 'off', oc === 'running' ? '再生できる状態です' : oc === 'suspended' ? '一時停止中です（画面を一度タップすると再開します）' : 'まだ使っていません（最初の発話で準備されます）');
  add('live', '会話の接続', live.session ? 'ok' : 'off', live.session ? 'Geminiにつながっています' : '待機中です（話しかけるとつながります）');
  { // which voice engine is in use / whether the Live daily limit was hit recently
    const q = live.quotaState?.() || {}, pref = live.voicePref?.() || 'auto';
    const modeName = { live: 'Live', live2: '別のLive', std: '通常の音声' }[live.mode] || 'Live';
    if (q.main) add('voicemode', '音声方式', 'warn', `Liveの上限に達した記録があります（数時間は${q.fallback ? '通常の音声' : '別のLive→通常の音声'}で会話します）。現在：${live.session ? modeName : '待機中'}`);
    else add('voicemode', '音声方式', 'ok', `${pref === 'std' ? '通常の音声のみ（設定）' : pref === 'live' ? 'Liveのみ（設定）' : '自動（Live優先、上限で切り替え）'}。現在：${live.session ? modeName : '待機中'}`);
  }
  {
    const st = standbyInfo?.()?.last, off = store.get(keys.STANDBY_KEY) === '0', phone = !!window.ElvarAndroid;
    const tail = phone ? '（スマホでは、画面が消えている間は待ち受けません）' : '';
    if (standby.active) add('standby', '拍手の待ち受け', 'ok', '待ち受け中です' + tail);
    else if (off) add('standby', '拍手の待ち受け', 'off', '設定でオフです', '設定の「拍手で起動」をオンにする');
    else if (live.session) add('standby', '拍手の待ち受け', 'ok', '会話中のため一時停止しています（会話が終わると自動で再開します）');
    else if (st === 'needs-gesture') add('standby', '拍手の待ち受け', 'warn', 'ブラウザの制限で、まだ始まっていません', '画面を一度タップしてください');
    else if (st === 'denied') add('standby', '拍手の待ち受け', 'fail', 'マイクがブロックされています', 'ブラウザ/アプリの設定でマイクを許可');
    else if (st === 'error') add('standby', '拍手の待ち受け', 'fail', 'マイクを開けませんでした', 'マイクが他のアプリで使われていないか確認');
    else if (st === 'not-enabled' || st == null) add('standby', '拍手の待ち受け', 'warn', 'まだ有効になっていません（最初にマイクで会話すると、自動で有効になります）', '設定の「拍手で起動」をオンにするか、一度マイクで話しかける');
    else add('standby', '拍手の待ち受け', 'warn', '待ち受けていません（原因は特定できませんでした）', '画面を一度タップして、もう一度チェック');
  }
  // storage
  {
    let ls = false, idb = false;
    try { localStorage.setItem('elvar_chk', '1'); ls = localStorage.getItem('elvar_chk') === '1'; localStorage.removeItem('elvar_chk'); } catch {}
    try { idb = !!(await timeout(new Promise((res) => { const r = indexedDB.open('elvar_chk', 1); r.onsuccess = () => { r.result.close(); indexedDB.deleteDatabase('elvar_chk'); res(true); }; r.onerror = () => res(false); }), 3000)); } catch {}
    add('storage', '端末の保存領域', ls && idb ? 'ok' : 'fail', ls && idb ? '設定とMP3を保存できます' : `保存できません（設定:${ls ? 'OK' : 'NG'} / MP3用:${idb ? 'OK' : 'NG'}）`, ls && idb ? '' : 'プライベートモードやサイトデータの制限を確認');
  }
  {
    const st = live.stats;
    if (st) {
      const echo = st.interruptedMicQuiet, bad = st.interrupted >= 3 || st.underruns >= 3 || st.closes >= 2;
      const detail = `この画面を開いてから：返事の割り込み ${st.interrupted} 回（うち、マイクが静かなのに止まった ${echo} 回）、再生の途切れ ${st.underruns} 回（再生の余裕 ${st.prebufferMs} ms）、通信の切断 ${st.closes} 回`;
      const fixes = [];
      if (echo >= 2) fixes.push('スピーカーの音をマイクが拾っている可能性：イヤホンを使う、音量を下げる、「音質優先」をオフ、「周囲の音・声の遮断」を強めに');
      if (st.underruns >= 3) fixes.push('再生の途切れ：通信が不安定か、端末が忙しい状態です。Wi-Fiを確認し、他のアプリを閉じてください（再生の余裕は自動で増やしています）');
      if (st.closes >= 2) fixes.push('通信が切れています：電波の状態、省電力の設定を確認');
      add('voice', '声の安定性', bad ? 'warn' : 'ok', st.interrupted + st.underruns + st.closes === 0 ? 'この画面を開いてから、割り込み・途切れ・切断は、ありません' : detail, fixes.join(' ／ '));
    }
  }
  {
    const n = notifications?.status?.();
    if (!n || (!n.android && !n.cloud)) add('notif', '通知の連携（LINEなど）', 'off', 'スマホのアプリで使えます。PCで聞くには、設定の「スマホの通知を聞く」をオン');
    else if (!n.android) add('notif', '通知の連携（LINEなど）', n.cloudError ? 'warn' : 'ok', n.cloudError ? `スマホの通知の取得に問題があります：${n.cloudError}` : `スマホの通知を、クラウド経由で受信しています（受信 ${n.stored} 件、未読 ${n.unread} 件）`);
    else if (!n.access) add('notif', '通知の連携（LINEなど）', 'warn', 'Androidの「通知へのアクセス」が許可されていません', '設定の「通知の連携」から許可');
    else { const on = n.apps.filter((a) => a.on).map((a) => a.name); add('notif', '通知の連携（LINEなど）', on.length ? 'ok' : 'off', on.length ? `許可済み。対象: ${on.join('、')}（保存 ${n.stored} 件、未読 ${n.unread} 件）` : '許可済みですが、対象のアプリがすべてオフです'); }
  }
  try { const has = await bgm.hasTrack(); add('bgm', '起動ミュージック', has ? 'ok' : 'off', has ? 'MP3が登録されています' : 'MP3は未登録です'); } catch { add('bgm', '起動ミュージック', 'warn', '確認できませんでした'); }
  try { const r = await timeout(fetch('/fonts/NotoSansJP-Regular.ttf', { method: 'HEAD' }), 5000); add('font', 'PDF用の日本語フォント', r && r.ok ? 'ok' : 'warn', r && r.ok ? '配信されています' : '取得できません（PDF作成に影響します）'); } catch { add('font', 'PDF用の日本語フォント', 'warn', '取得できません（PDF作成に影響します）'); }
  return items;
}

const CSS = `
.vc-back{position:fixed;inset:0;z-index:46;display:none;align-items:center;justify-content:center;padding:14px;background:rgba(0,8,20,.8);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.vc-back.on{display:flex;animation:vs-in .16s ease-out}
.vc{display:flex;flex-direction:column;width:min(720px,100%);max-height:94vh;color:#d9eef9;font:15px/1.55 'Barlow Semi Condensed','Noto Sans JP','Yu Gothic UI','Meiryo',sans-serif;
  background:linear-gradient(180deg,rgba(3,26,52,.98),rgba(1,14,30,.99));outline:1.5px solid rgba(30,166,216,.9);outline-offset:-1px;filter:drop-shadow(0 0 10px rgba(25,190,255,.5))}
.vc-top{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid rgba(40,150,200,.32)}
.vc-top h2{margin:0;font-size:15px;letter-spacing:3px;color:#8fe3ff;font-weight:600}.vc-top i{width:7px;height:7px;border-radius:50%;background:#19d3ff;box-shadow:0 0 6px #19d3ff}
.vc-x{margin-left:auto}
.vc-sum{padding:12px 16px 6px;font-size:16px;font-weight:700}.vc-sum.ok{color:#1ee8c0}.vc-sum.warn{color:#ffb347}.vc-sum.fail{color:#ff6b7d}
.vc-sub{padding:0 16px 8px;color:#7fb6d6;font-size:12.5px}
.vc-list{overflow:auto;padding:4px 8px 10px}
.vc-g{padding:10px 8px 2px;font-size:12px;letter-spacing:2px;color:#3ac9ef}
.vc-r{display:flex;gap:10px;padding:6px 8px;border-radius:3px}.vc-r:nth-child(odd){background:rgba(25,211,255,.04)}
.vc-d{flex:0 0 12px;margin-top:7px;width:10px;height:10px;border-radius:50%}
.vc-d.ok{background:#1ee8c0;box-shadow:0 0 6px #1ee8c0}.vc-d.warn{background:#ffb347;box-shadow:0 0 6px #ffb347}.vc-d.fail{background:#ff5b6e;box-shadow:0 0 6px #ff5b6e}.vc-d.off{border:1.5px solid #5c7a90}
.vc-l{font-weight:600;color:#fff}.vc-t{color:#b9dcef;font-size:14px;word-break:break-word}.vc-f{color:#ffb347;font-size:13px}
.vc-b{display:flex;flex-wrap:wrap;gap:8px;padding:10px 16px 14px;border-top:1px solid rgba(40,150,200,.32)}
.vc-tag{display:inline-block;margin-left:6px;padding:0 7px;border:1px solid currentColor;border-radius:9px;font-size:12px;font-weight:600}.vc-tag.ok{color:#5ee08a}.vc-tag.warn{color:#ffb347}.vc-tag.fail{color:#ff6b6b}.vc-tag.off{color:#7f9bb0}
.vc-btn{background:transparent;color:#8fe3ff;border:1px solid rgba(25,211,255,.65);border-radius:3px;padding:5px 14px;cursor:pointer;font:inherit;font-size:14px;white-space:nowrap}
.vc-btn:hover:not(:disabled){background:rgba(25,211,255,.2);color:#fff}.vc-btn:disabled{opacity:.4;cursor:default}.vc-btn.pri{background:rgba(25,211,255,.2)}
`;

export function initSystemCheck({ live, bgm, standby, store, keys, authHeaders, standbyInfo, notifications }) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const back = document.createElement('div'); back.className = 'vc-back';
  back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true'); back.setAttribute('aria-label', 'システムチェック');
  back.innerHTML = `<div class="vc"><div class="vc-top"><i></i><h2>SYSTEM CHECK</h2><button class="vc-btn vc-x" type="button" data-x>閉じる</button></div>
    <div class="vc-sum" id="vc-sum">確認中…</div><div class="vc-sub" id="vc-sub"></div><div class="vc-list" id="vc-list"></div>
    <div class="vc-b"><button class="vc-btn pri" type="button" data-run>もう一度</button><button class="vc-btn" type="button" data-deep title="Geminiの会話用トークンの発行やニュースの取得も試します（少しだけ利用枠を使います）">詳細チェック</button><button class="vc-btn" type="button" data-copy>結果をコピー</button></div></div>`;
  document.body.appendChild(back);
  const $ = (s) => back.querySelector(s);
  let last = null, busy = false;

  function render(rep) {
    const s = summarize(rep.items.filter((i) => i.group !== 'api'));
    const sum = $('#vc-sum'); sum.textContent = s.verdict; sum.className = 'vc-sum ' + (s.counts.fail ? 'fail' : s.counts.warn ? 'warn' : 'ok');
    $('#vc-sub').textContent = `正常 ${s.counts.ok}・注意 ${s.counts.warn}・異常 ${s.counts.fail}・未使用 ${s.counts.off}　（${rep.deep ? '詳細' : '通常'}チェック ${new Date(rep.at).toLocaleTimeString('ja-JP')}）`;
    const row = (i) => `<div class="vc-r"><span class="vc-d ${i.status}"></span><div><div class="vc-l">${esc(i.label)}</div><div class="vc-t">${esc(i.detail)}</div>${i.fix ? `<div class="vc-f">対処：${esc(i.fix)}</div>` : ''}</div></div>`;
    const grp = (g, name) => { const it = rep.items.filter((i) => i.group === g).sort((a, b) => ORDER[a.status] - ORDER[b.status]); return it.length ? `<div class="vc-g">${name}</div>` + it.map(row).join('') : ''; };
    const apis = rep.items.filter((i) => i.group === 'api'), apiOk = apis.filter((i) => i.status === 'ok' && i.verified).length;
    const apiRow = (i) => `<div class="vc-r"><span class="vc-d ${i.status}"></span><div><div class="vc-l">${esc(i.label)} <span class="vc-tag ${i.status}">${esc(stateWord(i))}</span></div><div class="vc-t">${esc(i.detail)}</div>${i.fix ? `<div class="vc-f">対処：${esc(i.fix)}</div>` : ''}</div></div>`;
    const apiHtml = apis.length ? `<div class="vc-g">API接続状況（接続中 ${apiOk} / ${apis.length}　現在の会話：${esc(voiceEngineName(live))}）</div>` + apis.map(apiRow).join('') : '';
    $('#vc-list').innerHTML = apiHtml + grp('server', 'サーバー・各サービス') + grp('device', 'この端末');
  }

  async function run(deep = false, { show = true } = {}) {
    if (busy) return last;
    busy = true; if (show) open(); $('#vc-sum').textContent = '確認中…'; $('#vc-sum').className = 'vc-sum'; $('#vc-sub').textContent = deep ? '詳細チェック中（数秒かかります）' : '';
    back.querySelectorAll('.vc-b button').forEach((b) => (b.disabled = true));
    try {
      const [server, device] = await Promise.all([
        (async () => {
          try {
            const r = await timeout(fetch('/api/system/check' + (deep ? '?deep=1' : ''), { headers: authHeaders(), cache: 'no-store' }), deep ? 25000 : 15000);
            if (!r) return [{ id: 'srv', group: 'server', label: 'サーバーのチェック', status: 'fail', detail: '応答がありません（時間切れ）', fix: '通信状況とデプロイ状態を確認' }];
            if (r.status === 401) return [{ id: 'srv', group: 'server', label: 'アクセストークン', status: 'fail', detail: 'この端末のアクセストークンが違います', fix: '設定でアクセストークンを入れ直す' }];
            if (!r.ok) return [{ id: 'srv', group: 'server', label: 'サーバーのチェック', status: 'fail', detail: `エラー (${r.status})`, fix: '再デプロイ後にもう一度' }];
            return (await r.json()).items || [];
          } catch (e) { return [{ id: 'srv', group: 'server', label: 'サーバーのチェック', status: 'fail', detail: `接続できません: ${e?.message ?? e}`, fix: '通信状況を確認' }]; }
        })(),
        deviceChecks({ live, bgm, standby, store, keys, authHeaders, standbyInfo, notifications }),
      ]);
      last = { items: [...server, ...device], deep, at: new Date().toISOString() };
      render(last);
    } finally { busy = false; back.querySelectorAll('.vc-b button').forEach((b) => (b.disabled = false)); }
    return last;
  }

  /** What the voice model gets: the verdict and only the things that need attention (+ a count of the healthy ones). */
  async function voiceReport({ deep = false } = {}) {
    const rep = await run(deep, { show: true }); const s = summarize(rep.items.filter((i) => i.group !== 'api'));
    return { verdict: s.verdict, counts: s.counts, problems: s.problems.map(({ label, status, detail, fix }) => ({ label, status, detail, fix })), unusedFeatures: rep.items.filter((i) => i.status === 'off' && i.group === 'server').map((i) => i.label), checked: rep.items.length, deep, note: '画面にも結果の一覧を表示しています。' };
  }

  /** For the voice tool api_status: which APIs are connected, which are only configured, which are broken or not set (the panel opens too). */
  async function apiReport({ deep = false } = {}) {
    const rep = await run(deep, { show: true }); const apis = rep.items.filter((i) => i.group === 'api');
    const names = (f) => apis.filter(f).map((i) => i.label.replace(/（.*$/, ''));
    return {
      conversationNow: voiceEngineName(live),
      connected: names((i) => i.status === 'ok' && i.verified),
      keySetNotVerified: names((i) => i.status === 'ok' && !i.verified),
      problems: apis.filter((i) => i.status === 'warn' || i.status === 'fail').map((i) => ({ name: i.label.replace(/（.*$/, ''), state: stateWord(i), detail: i.detail, fix: i.fix })),
      notSet: names((i) => i.status === 'off'),
      note: '「接続中」は、いま実際に通信して確認できたもの。「設定済み（未確認）」はキーがあるだけで通信は確認していません（詳細チェックで確認できます）。',
    };
  }

  const isOpen = () => back.classList.contains('on');
  function open() { back.classList.add('on'); }
  function close() { back.classList.remove('on'); }
  back.addEventListener('click', async (e) => {
    if (e.target === back || e.target.closest('[data-x]')) close();
    else if (e.target.closest('[data-run]')) run(false);
    else if (e.target.closest('[data-deep]')) run(true);
    else if (e.target.closest('[data-copy]') && last) { const t = reportText(last.items, last.at); try { await navigator.clipboard.writeText(t); $('#vc-sub').textContent = 'クリップボードにコピーしました'; } catch { $('#vc-sub').textContent = 'コピーできませんでした'; } }
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) { e.stopImmediatePropagation(); e.preventDefault(); close(); } }, true);
  document.addEventListener('click', (e) => { if (e.target.closest?.('.vm-nav-cube, [data-vh-nav="cube"]')) { e.preventDefault(); open(); run(false); } }, true);   // phone HUD: the cube icon (was decoration)
  if (new URLSearchParams(location.search).get('check') === '1') setTimeout(() => run(false), 800);
  return { run, open, close, voiceReport, apiReport, el: back };
}
