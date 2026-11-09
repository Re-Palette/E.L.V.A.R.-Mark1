// Settings > 連携アプリ: the owner adds other apps themselves.
//   MCPサーバー (URL + 認証なし / トークン / OAuth)  or  HTTPアプリ (URL + 道具の一覧 + 認証ヘッダー)
//   add flow: 種類 -> 接続先 -> 認証 -> 接続を確認 -> 道具の確認（有効・承認レベル）-> 保存
// Secrets are write-only (the server returns only { set, last4 }). Everything an app says about itself (names, descriptions) is shown as text, never as markup.
import { esc } from '../elvar/ui.js';
import { api } from '../elvar/auth.js';
import { externalMode, when } from './google-logic.js';
import { statusOf, APPROVAL_LABEL, approvalChoices, shownApproval, diffTool, toolPrefsFrom, parseToolsJson, EXAMPLE_TOOLS, firstError } from './connectors-logic.js';

const C = '/api/elvar/connectors';
const CSS = `
.ev-cx-card{padding:10px 0;border-bottom:1px solid rgba(232,185,106,.12)}.ev-cx-card:last-child{border-bottom:0}
.ev-cx-card .nm{font-size:15px;color:var(--txt,#f6efe2)}.ev-cx-card .host{font-size:12.5px;color:#b99b6a;word-break:break-all}
.ev-chip.warn{border-color:rgba(255,122,74,.7);color:#ff9a6a}
.ev-cx-pick{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}
.ev-cx-pick button{text-align:left;padding:14px;background:#0d0a06;border:1px solid rgba(232,185,106,.45);color:#f6efe2;cursor:pointer;font:inherit}
.ev-cx-pick button:hover,.ev-cx-pick button.on{border-color:#FFD99A;background:#15100a}.ev-cx-pick b{display:block;color:#FFD99A;margin-bottom:2px}.ev-cx-pick span{font-size:12.5px;color:#b99b6a}
.ev-cx-tool{padding:10px 0;border-bottom:1px solid rgba(232,185,106,.12)}.ev-cx-tool .d{font-size:12.5px;color:#b99b6a;margin:2px 0 6px 28px;word-break:break-word}
.ev-cx-tool .ctl{margin-left:28px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.ev-cx-tool select{width:auto;max-width:100%;padding:4px 8px}
.ev-cx-diff{margin:6px 0 6px 28px;border:1px solid rgba(255,122,74,.55);background:rgba(255,122,74,.07);padding:8px 12px;font-size:13px;color:#ffcfb8}.ev-cx-diff .old{color:#b99b6a;text-decoration:line-through}.ev-cx-diff div{margin:2px 0;word-break:break-word}
.ev-cx-warn{border:1px solid rgba(255,122,74,.55);background:rgba(255,122,74,.07);padding:8px 12px;margin:8px 0;color:#ffcfb8;font-size:13.5px}
.ev-cx-steps{display:flex;gap:6px;margin:6px 0 10px;font-size:12.5px;color:#b99b6a;flex-wrap:wrap}.ev-cx-steps span.on{color:#FFD99A}.ev-cx-steps span+span::before{content:'›';margin-right:6px;color:#8A5A20}
.ev-cx-json{font:12.5px/1.5 monospace;min-height:12em}
@media (max-width:560px){.ev-cx-pick{grid-template-columns:1fr}}
`;
let cssDone = false;

export function mountConnectors(root, { onChange = () => {} } = {}) {
  if (!cssDone) { cssDone = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
  let data = null, view = 'list', wiz = null, detail = null, edits = {}, grants = null, note = { t: '', c: '' }, poll = 0;
  const $ = (sel) => root.querySelector(sel);
  const say = (t, c = '') => { note = { t, c }; const m = $('#ecx-msg'); if (m) { m.textContent = t; m.className = 'ev-msg ' + c; } };
  const stopPoll = () => { clearInterval(poll); poll = 0; };

  // ------------------------------------------------------------ list
  function drawList() {
    const list = data.connectors;
    root.innerHTML = `
      <p class="ev-note" style="margin-top:0">好きなアプリ（MCPサーバーや、HTTPで呼べるサービス）をつないで、声やチャットから使えるようにします。外のサービスに何かを送る操作は、毎回、承認カードで確認します。</p>
      ${list.length ? list.map((c) => { const [lab, cls] = statusOf(c); return `
        <div class="ev-cx-card" data-id="${esc(c.id)}">
          <div class="ev-row" style="margin:0"><span class="nm">${esc(c.name)}</span><span class="ev-chip ${cls}">${esc(lab)}</span><span class="ev-chip off">${c.type === 'mcp' ? 'MCP' : 'HTTP'}</span></div>
          <div class="host">${esc(c.host)}・道具 ${c.tools.filter((t) => t.enabled).length}/${c.tools.length}${c.syncedAt ? '・同期 ' + esc(when(c.syncedAt)) : ''}</div>
          ${c.lastError ? `<div class="ev-msg warn" style="margin:2px 0">${esc(c.lastError)}</div>` : ''}
          <div class="ev-btns" style="margin-top:8px">
            <button class="ev-btn sm" type="button" data-act="open">開く</button>
            ${c.type === 'mcp' ? '<button class="ev-btn sm" type="button" data-act="sync">同期</button>' : ''}
            <button class="ev-btn sm danger" type="button" data-act="del">削除</button>
          </div>
        </div>`; }).join('') : '<p class="ev-note">まだ、つないだアプリはありません。</p>'}
      ${data.writable ? `<div class="ev-btns"><button class="ev-btn pri" type="button" data-act="add" ${list.length >= data.maxConnectors ? 'disabled' : ''}>アプリを追加</button></div>` : '<p class="ev-note">セットアップが済むと、ここでアプリを追加できます（環境変数モードでは使えません）。</p>'}
      <div class="ev-sec"><h3>データ</h3>
        <p class="ev-note" style="margin-top:0">つないだアプリの設定は、いつでも書き出し・削除できます。書き出したファイルに、トークンやシークレットは含まれません。</p>
        <div class="ev-btns" style="margin-top:6px"><button class="ev-btn sm" type="button" data-act="export">設定を書き出す</button>${data.writable && list.length ? '<button class="ev-btn sm danger" type="button" data-act="delall">連携をすべて削除</button>' : ''}</div></div>
      <div class="ev-msg" id="ecx-msg" role="status">${esc(note.t)}</div>`;
    if (note.c) $('#ecx-msg').className = 'ev-msg ' + note.c;
  }

  // ------------------------------------------------------------ tools review (shared by the wizard's last step and the detail screen)
  function toolsHtml(c) {
    const anyAuto = c.tools.some((t) => (edits[t.name]?.approval ?? shownApproval(t)) === 'auto');
    return `
      ${c.tools.length ? c.tools.map((t) => {
        const e = edits[t.name] || {}, on = e.enabled ?? t.enabled, ap = e.approval ?? shownApproval(t), d = t.needsReapproval ? diffTool(t) : null;
        return `<div class="ev-cx-tool" data-t="${esc(t.name)}">
          <label class="ev-check" style="margin:0"><input type="checkbox" data-en ${on ? 'checked' : ''}><span><b>${esc(t.name)}</b>
            ${t.readOnly ? '<span class="ev-chip ok">読み取り</span>' : ''}${t.danger === 'high' ? '<span class="ev-chip warn">取り消せない可能性</span>' : ''}${t.needsReapproval ? '<span class="ev-chip warn">内容が変わりました</span>' : ''}${t.isNew ? '<span class="ev-chip">新しい道具</span>' : ''}</span></label>
          <div class="d">${esc(t.description)}（外部サービスの説明）</div>
          ${d ? `<div class="ev-cx-diff"><b>前回承認したあとで、内容が変わりました。</b>
            ${d.description ? `<div class="old">前：${esc(t.prevDef.description)}</div><div>今：${esc(t.description)}</div>` : ''}
            ${d.params.length ? `<div>引数：${esc(d.params.join('  '))}</div>` : ''}${d.hints ? '<div>読み取り・危険度の表示が変わりました</div>' : ''}
            <div>内容を読んで問題なければ、チェックを入れて保存すると、また使えます。</div></div>` : ''}
          <div class="ev-cx-ctl ctl"><select class="ev-select" data-ap aria-label="承認">${approvalChoices(t).map((a) => `<option value="${a}" ${a === ap ? 'selected' : ''}>${esc(APPROVAL_LABEL[a])}</option>`).join('')}</select>
            ${c.type === 'mcp' || true ? `<select class="ev-select" data-ex aria-label="出し方"><option value="pinned" ${(e.expose ?? t.expose) === 'pinned' ? 'selected' : ''}>声の道具として直接出す</option><option value="gateway" ${(e.expose ?? t.expose) === 'gateway' ? 'selected' : ''}>一覧から呼ぶ（数が多いとき）</option></select>` : ''}</div>
          ${ap === 'auto' ? '<div class="ev-note" style="margin-left:28px;color:#ffcfb8">「読み取り」と書かれていますが、これは相手のサービスの自己申告です。確認なしで実行され、問い合わせの内容は外部に送られます。</div>' : ''}
        </div>`; }).join('') : '<p class="ev-note">取り込まれた道具はありません。</p>'}
      ${data.agents.length && (anyAuto || (grants || c.grantAgents).length) ? `<div class="ev-sec"><h3>裏作業のエージェントに使わせる</h3><p class="ev-note" style="margin-top:0">確認なしの道具だけが、ここで選んだエージェントから使えます。</p>
        ${data.agents.map((a) => `<label class="ev-check"><input type="checkbox" data-grant="${esc(a.id)}" ${(grants || c.grantAgents).includes(a.id) ? 'checked' : ''}><span>${esc(a.label)}</span></label>`).join('')}</div>` : ''}`;
  }
  function readEdits() {
    for (const el of root.querySelectorAll('[data-t]')) {
      const n = el.dataset.t; edits[n] = { ...(edits[n] || {}), enabled: el.querySelector('[data-en]').checked, approval: el.querySelector('[data-ap]').value, expose: el.querySelector('[data-ex]')?.value };
    }
    const g = [...root.querySelectorAll('[data-grant]')]; if (g.length) grants = g.filter((x) => x.checked).map((x) => x.dataset.grant);
  }
  const saveBody = (c, extra = {}) => { readEdits(); return { toolPrefs: toolPrefsFrom(c.tools, edits), ...(grants ? { grantAgents: grants } : {}), ...extra }; };

  // ------------------------------------------------------------ wizard
  const STEPS = ['種類', '接続先', '認証', '接続の確認', '道具の確認'];
  const stepsHtml = (n) => `<div class="ev-cx-steps">${STEPS.map((s, i) => `<span class="${i + 1 === n ? 'on' : ''}">${i + 1}. ${s}</span>`).join('')}</div>`;
  function drawWizard() {
    const w = wiz, isMcp = w.type === 'mcp';
    let body = '';
    if (w.step === 1) body = `<div class="ev-cx-pick"><button type="button" data-type="mcp" class="${isMcp ? 'on' : ''}"><b>MCPサーバー</b><span>Notion や GitHub など、MCP に対応したサービス（Streamable HTTP）</span></button>
      <button type="button" data-type="http" class="${w.type === 'http' ? 'on' : ''}"><b>HTTPアプリ</b><span>HTTPで呼べるサービス（Home Assistant、自作のWebhook など）。道具は自分で書きます</span></button></div>
      <div class="ev-btns"><button class="ev-btn pri" type="button" data-next ${w.type ? '' : 'disabled'}>次へ</button><button class="ev-btn" type="button" data-cancel>やめる</button></div>`;
    else if (w.step === 2) body = `
      <label class="ev-field"><span>名前</span><input class="ev-input" data-w="name" value="${esc(w.name)}" maxlength="40" placeholder="例：ノート"></label>
      <label class="ev-field"><span>${isMcp ? 'MCPサーバーのURL' : 'アプリの基本URL'}</span><input class="ev-input" data-w="url" value="${esc(w.url)}" placeholder="${isMcp ? 'https://mcp.example.com/mcp' : 'https://home.example.com'}" autocomplete="off" spellcheck="false"></label>
      <p class="ev-note">https:// のアドレスだけ使えます。社内・自宅のアドレス（192.168… など）や localhost には、つなげません${data.vercel ? '' : '（自分のPCで動かしているときだけ、下の設定で許可できます）'}。</p>
      ${!isMcp ? `<label class="ev-field"><span>道具の一覧（JSON）</span><textarea class="ev-area ev-cx-json" data-w="toolsText" spellcheck="false">${esc(w.toolsText)}</textarea></label>
        <div class="ev-btns" style="margin-top:4px"><button class="ev-btn sm" type="button" data-example>例を入れる</button></div>
        <p class="ev-note">各道具: name・description・method・path（{{args.名前}} だけ使えます）・body・inputSchema・readOnly。DELETE は「取り消せない」扱いになります。</p>` : ''}
      ${data.vercel ? '' : `<label class="ev-check"><input type="checkbox" data-w="allowPrivate" ${w.allowPrivate ? 'checked' : ''}><span>自宅・社内のネットワークのアドレスを許可する（このPCで動かしているときだけ）</span></label>`}
      <div class="ev-btns"><button class="ev-btn pri" type="button" data-next>次へ</button><button class="ev-btn" type="button" data-back>戻る</button><button class="ev-btn" type="button" data-cancel>やめる</button></div>`;
    else if (w.step === 3) body = `
      <label class="ev-field"><span>認証</span><select class="ev-select" data-w="authType">${(isMcp ? [['none', '認証なし'], ['bearer', 'アクセストークン'], ['oauth', 'OAuth（ブラウザでログイン）']] : [['none', '認証なし'], ['bearer', 'アクセストークン（Bearer）'], ['header', 'ヘッダーを指定'], ['basic', 'ユーザー名:パスワード']]).map(([v, l]) => `<option value="${v}" ${w.authType === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${w.authType === 'header' ? `<div class="ev-grid2"><label class="ev-field"><span>ヘッダー名</span><input class="ev-input" data-w="header" value="${esc(w.header)}" placeholder="X-Api-Key"></label><label class="ev-field"><span>値の頭に付ける文字（任意）</span><input class="ev-input" data-w="prefix" value="${esc(w.prefix)}" placeholder="Bearer "></label></div>` : ''}
      ${['bearer', 'header', 'basic'].includes(w.authType) ? `<label class="ev-field"><span>${w.authType === 'basic' ? 'ユーザー名:パスワード' : 'トークン / 値'}</span><input class="ev-input" type="password" autocomplete="off" spellcheck="false" data-w="secret" value="${esc(w.secret)}"></label><p class="ev-note">暗号化して保存し、画面には二度と表示しません。</p>` : ''}
      ${w.authType === 'oauth' ? `<p class="ev-note">サーバーが自動登録に対応していれば、入力は要りません。対応していないときだけ、サーバー側で作ったクライアントIDを入れてください。</p>
        <div class="ev-grid2"><label class="ev-field"><span>クライアントID（任意）</span><input class="ev-input" data-w="clientId" value="${esc(w.clientId)}" autocomplete="off"></label><label class="ev-field"><span>クライアントシークレット（任意）</span><input class="ev-input" type="password" data-w="clientSecret" value="${esc(w.clientSecret)}" autocomplete="off"></label></div>` : ''}
      <div class="ev-btns"><button class="ev-btn pri" type="button" data-test>${w.authType === 'oauth' ? '認証して接続を確認' : '接続を確認'}</button><button class="ev-btn" type="button" data-back>戻る</button><button class="ev-btn" type="button" data-cancel>やめる</button></div>`;
    else if (w.step === 4) body = `<p class="ev-p">${w.waiting ? 'ブラウザの画面でログインして、許可してください。終わると、ここで自動で続きます。' : '確認しています…'}</p>
      <div class="ev-btns"><button class="ev-btn" type="button" data-cancel>やめる</button>${w.waiting ? '<button class="ev-btn" type="button" data-claim>ログインを終えた</button>' : ''}</div>`;
    else body = `<p class="ev-p"><span class="ev-chip ok">接続できました</span> ${esc(w.connector.serverInfo?.name || w.connector.name)}${w.connector.tools.length ? `・道具 ${w.connector.tools.length} 個` : ''}</p>
      <p class="ev-note">使う道具を選びます。初期値は、毎回確認します。確認なしにできるのは、読み取り専用と示された道具だけです。</p>
      ${toolsHtml(w.connector)}
      <div class="ev-btns"><button class="ev-btn pri" type="button" data-save>保存して使う</button><button class="ev-btn" type="button" data-cancel>やめる</button></div>`;
    root.innerHTML = `<h3 class="ev-h3" style="margin-top:0">アプリを追加</h3>${stepsHtml(w.step === 5 ? 5 : w.step)}${body}<div class="ev-msg" id="ecx-msg" role="status">${esc(note.t)}</div>`;
    if (note.c) $('#ecx-msg').className = 'ev-msg ' + note.c;
  }
  const readWiz = () => { for (const el of root.querySelectorAll('[data-w]')) wiz[el.dataset.w] = el.type === 'checkbox' ? el.checked : el.value; };
  const draftBody = () => {
    const w = wiz, isMcp = w.type === 'mcp', t = isMcp ? { ok: true, tools: [] } : parseToolsJson(w.toolsText);
    if (!t.ok) return { error: t.message };
    const auth = { type: w.authType, ...(w.authType === 'header' ? { header: w.header, prefix: w.prefix } : {}), ...(w.authType === 'oauth' ? { ...(w.clientId ? { clientId: w.clientId.trim() } : {}), ...(w.clientSecret ? { clientSecret: w.clientSecret } : {}) } : {}), ...(w.secret ? { secret: w.secret } : {}) };
    return { body: { type: w.type, name: w.name.trim(), ...(isMcp ? { mcp: { url: w.url.trim() } } : { http: { baseUrl: w.url.trim() }, tools: t.tools }), auth, ...(w.allowPrivate ? { network: { allowPrivate: true } } : {}) } };
  };
  async function testConnection() {
    readWiz(); const d = draftBody(); if (d.error) return say(d.error, 'warn');
    say('保存して、接続を確認しています…');
    let r;
    if (!wiz.id) { r = await api(C, { method: 'POST', body: d.body }); if (r.status !== 200) return say(firstError(r.body), 'warn'); wiz.id = r.body.connector.id; }
    else { const { type, ...patch } = d.body; r = await api(`${C}/${wiz.id}`, { method: 'PATCH', body: patch }); if (r.status !== 200) return say(firstError(r.body), 'warn'); }
    if (wiz.authType === 'oauth') return startOauth();
    return syncDraft();
  }
  async function syncDraft() {
    wiz.step = 4; wiz.waiting = false; drawWizard();
    const s = await api(`${C}/${wiz.id}/sync`, { method: 'POST', body: {} });
    if (s.status !== 200 || !s.body.ok) { wiz.step = 3; drawWizard(); const b = s.body || {}; return say(b.oauthPossible ? 'このサーバーは認証が必要です。認証を「アクセストークン」か「OAuth」にしてください。' : b.message || '接続できませんでした', 'warn'); }
    wiz.connector = s.body.connector; edits = {}; grants = null; wiz.step = 5; note = { t: '', c: '' }; drawWizard();
  }
  async function startOauth() {
    const mode = externalMode(window), tab = mode === 'browser' ? window.open('', '_blank') : null;
    const r = await api(`${C}/${wiz.id}/oauth/start`, { method: 'POST', body: {} });
    if (r.status !== 200 || !r.body?.url) { try { tab?.close(); } catch { /* ignore */ } return say(r.body?.message || '認証を始められませんでした', 'warn'); }
    wiz.state = r.body.state; wiz.step = 4; wiz.waiting = true; note = { t: '', c: '' };
    if (mode === 'android') window.ElvarAndroid.openExternal(r.body.url); else if (mode === 'desktop') window.elvarDesktop.openExternal(r.body.url); else if (tab) { try { tab.opener = null; } catch { /* ignore */ } tab.location.href = r.body.url; }
    drawWizard(); stopPoll(); poll = setInterval(claimTick, 2000);
  }
  async function claimTick() {
    if (!wiz?.waiting || !root.isConnected) return stopPoll();
    const r = await api(`${C}/${wiz.id}/oauth/claim`, { method: 'POST', body: { state: wiz.state } });
    if (r.body?.pending) return;
    stopPoll();
    if (r.body?.claimed) { wiz.waiting = false; return syncDraft(); }
    wiz.waiting = false; wiz.step = 3; drawWizard(); say(r.body?.message || '認証を完了できませんでした。もう一度お試しください', 'warn');
  }
  async function cancelWizard() {
    stopPoll(); const id = wiz?.id; wiz = null; view = 'list';
    if (id) await api(`${C}/${id}`, { method: 'DELETE' });
    await refresh();
  }

  // ------------------------------------------------------------ detail
  function drawDetail() {
    const c = detail, [lab, cls] = statusOf(c);
    root.innerHTML = `<div class="ev-row" style="margin-top:0"><h3 class="ev-h3" style="margin:0">${esc(c.name)}</h3><span class="ev-chip ${cls}">${esc(lab)}</span><span class="ev-chip off">${c.type === 'mcp' ? 'MCP' : 'HTTP'}</span></div>
      <div class="host" style="color:#b99b6a;font-size:12.5px;word-break:break-all">${esc(c.url)}${c.serverInfo?.name ? '・' + esc(c.serverInfo.name) + ' ' + esc(c.serverInfo.version || '') : ''}</div>
      ${c.lastError ? `<div class="ev-cx-warn">${esc(c.lastError)}</div>` : ''}
      ${c.status === 'needs_auth' && c.auth.type === 'oauth' ? '<div class="ev-cx-warn">認証が必要です。下の「認証し直す」を押してください。</div>' : ''}
      <label class="ev-check"><input type="checkbox" id="ecx-enabled" ${c.enabled ? 'checked' : ''}><span>このアプリを使う</span></label>
      ${['bearer', 'header', 'basic'].includes(c.auth.type) ? `<label class="ev-field"><span>認証の値 <span class="ev-chip ${c.auth.set ? 'ok' : 'off'}">${c.auth.set ? '設定済み・末尾' + esc(c.auth.last4 || '') : '未設定'}</span></span><input class="ev-input" type="password" id="ecx-secret" autocomplete="off" placeholder="入れ直すときだけ入力"></label>` : ''}
      <div class="ev-btns" style="margin-top:8px">${c.type === 'mcp' ? '<button class="ev-btn sm" type="button" data-sync>道具を同期</button>' : '<button class="ev-btn sm" type="button" data-sync>接続を確認</button>'}${c.auth.type === 'oauth' ? `<button class="ev-btn sm" type="button" data-reauth>${c.auth.connected ? '認証し直す' : '認証する'}</button>` : ''}</div>
      <div class="ev-sec"><h3>道具</h3>${toolsHtml(c)}</div>
      <div class="ev-btns"><button class="ev-btn pri" type="button" data-save>保存</button><button class="ev-btn" type="button" data-back>戻る</button><button class="ev-btn danger" type="button" data-del>このアプリを削除</button></div>
      <div class="ev-msg" id="ecx-msg" role="status">${esc(note.t)}</div>`;
    if (note.c) $('#ecx-msg').className = 'ev-msg ' + note.c;
  }
  async function saveDetail() {
    const c = detail, secret = $('#ecx-secret')?.value.trim();
    const body = saveBody(c, { enabled: $('#ecx-enabled').checked, ...(secret ? { auth: { secret } } : {}) });
    const r = await api(`${C}/${c.id}`, { method: 'PATCH', body });
    if (r.status !== 200) return say(firstError(r.body), 'warn');
    edits = {}; grants = null; detail = r.body.connector; await refresh(false); drawDetail(); say(r.body.warnings?.length ? r.body.warnings.map((w) => w.message).join(' ') : '保存しました', r.body.warnings?.length ? 'warn' : 'ok'); onChange();
  }

  // ------------------------------------------------------------ events
  const redraw = () => (view === 'wizard' ? drawWizard() : view === 'detail' ? drawDetail() : drawList());
  async function refresh(draw = true) {
    const r = await api(C);
    if (r.status !== 200) { root.innerHTML = '<p class="ev-msg warn">読み込めませんでした</p>'; return; }
    data = r.body; if (detail) detail = data.connectors.find((x) => x.id === detail.id) || null;
    if (!detail && view === 'detail') view = 'list';
    if (draw) redraw();
  }
  root.addEventListener('change', (e) => { if (view === 'wizard' && e.target.matches('[data-w="authType"]')) { readWiz(); drawWizard(); } else if (e.target.matches('[data-ap]') && (view === 'detail' || wiz?.step === 5)) { readEdits(); redraw(); } });
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const run = async (fn) => { b.disabled = true; try { await fn(); } catch { say('サーバーに接続できません', 'warn'); } finally { b.disabled = false; } };
    const card = b.closest('[data-id]'), id = card?.dataset.id, c = data?.connectors.find((x) => x.id === id);
    if (view === 'list') {
      if (b.dataset.act === 'add') { wiz = { step: 1, type: '', name: '', url: '', authType: 'none', secret: '', header: '', prefix: '', clientId: '', clientSecret: '', toolsText: '', allowPrivate: false }; view = 'wizard'; note = { t: '', c: '' }; drawWizard(); }
      else if (b.dataset.act === 'open' && c) { detail = c; edits = {}; grants = null; view = 'detail'; note = { t: '', c: '' }; drawDetail(); }
      else if (b.dataset.act === 'sync' && c) run(async () => { say(`${c.name} を同期しています…`); const r = await api(`${C}/${c.id}/sync`, { method: 'POST', body: {} }); await refresh(); const d = r.body.diff; say(r.body.ok ? (d && (d.changed.length || d.added.length) ? `同期しました。変更された道具 ${d.changed.length}・新しい道具 ${d.added.length}（開いて確認してください）` : '同期しました。変更はありません') : r.body.message || '同期できませんでした', r.body.ok ? (d?.changed.length ? 'warn' : 'ok') : 'warn'); onChange(); });
      else if (b.dataset.act === 'del' && c) run(async () => { if (!confirm(`「${c.name}」の連携を削除します。保存したトークンも消えます。よろしいですか？`)) return; await api(`${C}/${c.id}`, { method: 'DELETE' }); await refresh(); say('削除しました', 'ok'); onChange(); });
      else if (b.dataset.act === 'export') run(async () => { const r = await api(`${C}/export`); if (r.status !== 200) return say('書き出せませんでした', 'warn'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(r.body, null, 2)], { type: 'application/json' })); a.download = 'elvar-connectors.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); say('書き出しました（トークンは含まれません）', 'ok'); });
      else if (b.dataset.act === 'delall') run(async () => { if (!confirm('つないだアプリの設定・保存したトークンを、すべて削除します。元に戻せません。よろしいですか？')) return; const r = await api(`${C}/delete-all`, { method: 'POST', body: { confirm: 'delete' } }); await refresh(); say(r.status === 200 ? `${r.body.connectors} 件を削除しました` : '削除できませんでした', r.status === 200 ? 'ok' : 'warn'); onChange(); });
    } else if (view === 'wizard') {
      if (b.dataset.type) { wiz.type = b.dataset.type; wiz.authType = 'none'; drawWizard(); }
      else if ('next' in b.dataset) { readWiz(); if (wiz.step === 2 && (!wiz.name.trim() || !wiz.url.trim())) return say('名前とURLを入れてください', 'warn'); note = { t: '', c: '' }; wiz.step++; drawWizard(); }
      else if ('back' in b.dataset) { readWiz(); wiz.step = Math.max(1, wiz.step - 1); note = { t: '', c: '' }; drawWizard(); }
      else if ('example' in b.dataset) { readWiz(); wiz.toolsText = EXAMPLE_TOOLS; drawWizard(); }
      else if ('test' in b.dataset) run(testConnection);
      else if ('claim' in b.dataset) run(claimTick);
      else if ('cancel' in b.dataset) run(cancelWizard);
      else if ('save' in b.dataset) run(async () => {
        const r = await api(`${C}/${wiz.id}`, { method: 'PATCH', body: saveBody(wiz.connector, { enabled: true }) });
        if (r.status !== 200) return say(firstError(r.body), 'warn');
        const warn = r.body.warnings?.length; wiz = null; view = 'list'; await refresh(); say(warn ? r.body.warnings.map((w) => w.message).join(' ') : '保存しました。すぐに使えます', warn ? 'warn' : 'ok'); onChange();
      });
    } else if (view === 'detail') {
      if ('back' in b.dataset) { view = 'list'; detail = null; note = { t: '', c: '' }; await refresh(); }
      else if ('save' in b.dataset) run(saveDetail);
      else if ('sync' in b.dataset) run(async () => { readEdits(); say('確認しています…'); const r = await api(`${C}/${detail.id}/sync`, { method: 'POST', body: {} }); await refresh(false); drawDetail(); const d = r.body.diff; say(r.body.ok ? (d?.changed.length ? `内容が変わった道具が ${d.changed.length} 個あります。確認してください` : '接続できました') : r.body.message || '接続できませんでした', r.body.ok && !d?.changed.length ? 'ok' : 'warn'); });
      else if ('reauth' in b.dataset) run(async () => { wiz = { id: detail.id, authType: 'oauth', step: 4 }; const mode = externalMode(window), tab = mode === 'browser' ? window.open('', '_blank') : null; const r = await api(`${C}/${detail.id}/oauth/start`, { method: 'POST', body: {} }); if (r.status !== 200 || !r.body?.url) { try { tab?.close(); } catch { /* ignore */ } wiz = null; return say(r.body?.message || '認証を始められませんでした', 'warn'); } wiz.state = r.body.state; wiz.waiting = true; if (mode === 'android') window.ElvarAndroid.openExternal(r.body.url); else if (mode === 'desktop') window.elvarDesktop.openExternal(r.body.url); else if (tab) { try { tab.opener = null; } catch { /* ignore */ } tab.location.href = r.body.url; } say('ブラウザでログインしてください。終わると自動で続きます'); stopPoll(); poll = setInterval(async () => { const q = await api(`${C}/${detail.id}/oauth/claim`, { method: 'POST', body: { state: wiz.state } }); if (q.body?.pending) return; stopPoll(); wiz = null; await refresh(false); drawDetail(); say(q.body?.claimed ? '認証しました。「道具を同期」を押してください' : q.body?.message || '認証できませんでした', q.body?.claimed ? 'ok' : 'warn'); onChange(); }, 2000); });
      else if ('del' in b.dataset) run(async () => { if (!confirm(`「${detail.name}」の連携を削除します。よろしいですか？`)) return; await api(`${C}/${detail.id}`, { method: 'DELETE' }); view = 'list'; detail = null; await refresh(); say('削除しました', 'ok'); onChange(); });
    }
  });
  return { refresh: () => { if (view === 'wizard' && wiz) return redraw(); return refresh(); }, hasAttention: async () => { const r = await api(C); return r.status === 200 && r.body.connectors.some((c) => c.enabled && c.status !== 'connected'); } };
}
