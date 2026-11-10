// Settings > 管理 (only for admins): the admin console. The list of accounts with metadata (e-mail, dates, status, storage, usage counters), the storage quota and the hard
// limits of one account (numbers only), one account's usage per day, and suspend / lift. An admin CANNOT see anybody's persona, conversations, notes, files, connectors or
// keys: the server returns only these columns (docs/ELVAR_MULTIUSER.md 2.4, M11, 6.3).
import { esc } from '../elvar/ui.js';
import { api, authClient } from '../elvar/auth.js';

const when = (v) => { try { return v ? new Date(v).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; } catch { return '—'; } };
const mb = (b) => `${(Number(b || 0) / 1048576).toFixed(1)} MB`;
const STATUS = { active: '利用中', suspended: '停止中', pending_deletion: '削除待ち' };

export function mountAdmin(root) {
  let users = [], catalog = {}, sel = null, detail = null;
  const msg = (t, cls = '') => { const m = root.querySelector('#ad-msg'); if (m) { m.textContent = t; m.className = 'ev-msg ' + cls; } };
  function draw() {
    root.innerHTML = `<section class="ev-sec"><h3>アカウント一覧（${users.length}件）</h3>
      <p class="ev-note" style="margin-top:0">メール・日付・状態・容量・利用回数だけが見えます。人格・会話・ノート・ファイル・キーは、管理者にも見えません。</p>
      <div style="overflow:auto"><table class="ev-table" style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="color:#b99b6a;text-align:left"><th>メール</th><th>登録</th><th>最終ログイン</th><th>状態</th><th>容量</th><th>今日の呼び出し</th><th>30日</th><th>個別の上限</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr style="border-top:1px solid rgba(232,185,106,.15)"><td>${esc(u.email || '—')}${u.isAdmin ? ' <span class="ev-chip ok">管理者</span>' : ''}</td><td>${esc(when(u.createdAt))}</td><td>${esc(when(u.lastSignInAt))}</td>
          <td><span class="ev-chip ${u.status === 'active' ? 'ok' : 'off'}">${esc(STATUS[u.status] || u.status)}</span></td><td>${esc(mb(u.storageUsedBytes))} / ${esc(mb(u.storageQuotaBytes))}</td><td>${esc(u.callsToday)}</td><td>${esc(u.calls30d)}</td><td>${Object.keys(u.hardLimits || {}).length ? `<span class="ev-chip ok">${Object.keys(u.hardLimits).length}件</span>` : '<span class="ev-note">既定</span>'}</td>
          <td>${u.status === 'pending_deletion' ? '' : `<button class="ev-btn sm" type="button" data-limits="${esc(u.userId)}">上限</button> <button class="ev-btn sm" type="button" data-usage="${esc(u.userId)}">利用</button> <button class="ev-btn sm" type="button" data-quota="${esc(u.userId)}" data-mb="${esc(Math.round(Number(u.storageQuotaBytes || 0) / 1048576))}" title="このアカウントの保存容量の上限を変えます（ファイルの中身は見えません）">容量</button> `}${u.isAdmin || u.status === 'pending_deletion' ? '' : u.status === 'suspended' ? `<button class="ev-btn sm" type="button" data-lift="${esc(u.userId)}">解除</button>` : `<button class="ev-btn sm danger" type="button" data-stop="${esc(u.userId)}">停止</button>`}</td></tr>`).join('')}</tbody></table></div>
    </section>${panel()}<div class="ev-msg" id="ad-msg" role="status"></div>`;
  }
  function panel() {
    const u = users.find((x) => x.userId === sel?.id); if (!u) return '';
    if (sel.kind === 'limits') return `<section class="ev-sec" id="ad-panel"><h3>${esc(u.email || '')} の上限（管理者が決める。数だけで、中身は見えません）</h3>
      <p class="ev-note" style="margin-top:0">空にすると、このサービスの既定値に戻ります。「なし」は上限を設けません。</p>
      <div class="ev-grid2">${Object.entries(catalog).map(([k, c]) => `<label class="ev-field"><span>${esc(c.label)}（${esc(c.unit)}）　既定: ${c.default === null ? 'なし' : esc(c.default)}</span><input class="ev-input" data-lim="${esc(k)}" type="number" min="0" step="1" value="${u.hardLimits?.[k] ?? ''}" placeholder="${c.default === null ? 'なし' : esc(c.default)}"></label>`).join('')}</div>
      <div class="ev-btns" style="margin-top:8px"><button class="ev-btn pri" type="button" data-savelim="${esc(u.userId)}">保存する</button><button class="ev-btn" type="button" data-closepanel>閉じる</button></div></section>`;
    const rows = detail?.usage || [], by = new Map(); for (const r of rows) { const k = `${r.provider}・${r.metric}`; by.set(k, (by.get(k) || 0) + r.amount); }
    const today = new Map(); const last = rows.reduce((m, r) => (r.day > m ? r.day : m), ''); for (const r of rows) if (r.day === last) today.set(`${r.provider}・${r.metric}`, (today.get(`${r.provider}・${r.metric}`) || 0) + r.amount);
    return `<section class="ev-sec" id="ad-panel"><h3>${esc(u.email || '')} の利用状況（直近14日・数だけ）</h3>
      ${by.size ? `<table class="ev-table" style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="color:#b99b6a;text-align:left"><th>項目</th><th>最新の日（${esc(last)}）</th><th>14日の合計</th></tr></thead><tbody>${[...by].sort().map(([k, v]) => `<tr style="border-top:1px solid rgba(232,185,106,.15)"><td>${esc(k)}</td><td>${esc(today.get(k) || 0)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>` : '<p class="ev-note">記録はありません。</p>'}
      <div class="ev-btns" style="margin-top:8px"><button class="ev-btn" type="button" data-closepanel>閉じる</button></div></section>`;
  }
  async function refresh() {
    root.innerHTML = '<p class="ev-note">読み込んでいます…</p>';
    try { await authClient().refresh(); } catch { /* reported by the call */ }
    const r = await api('/api/elvar/admin/users?limit=200');
    if (r.status !== 200) { root.innerHTML = `<p class="ev-msg warn">${r.status === 403 ? '管理者ではありません' : '読み込めませんでした'}</p>`; return; }
    users = r.body.users; catalog = r.body.limitCatalog || {}; draw();
  }
  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-closepanel]')) { sel = null; detail = null; draw(); return; }
    const lm = e.target.closest('[data-limits]');
    if (lm) { sel = { id: lm.dataset.limits, kind: 'limits' }; draw(); root.querySelector('#ad-panel')?.scrollIntoView?.({ block: 'nearest' }); return; }
    const us = e.target.closest('[data-usage]');
    if (us) { const r = await api(`/api/elvar/admin/users/${encodeURIComponent(us.dataset.usage)}/usage?days=14`); if (r.status !== 200) return msg('読み込めませんでした', 'warn'); sel = { id: us.dataset.usage, kind: 'usage' }; detail = r.body; draw(); return; }
    const sv = e.target.closest('[data-savelim]');
    if (sv) {
      const u = users.find((x) => x.userId === sv.dataset.savelim), limits = {};
      for (const i of root.querySelectorAll('[data-lim]')) { const t = String(i.value).normalize('NFKC').trim(), cur = u.hardLimits?.[i.dataset.lim]; if (t === '') { if (cur !== undefined) limits[i.dataset.lim] = null; continue; } const n = Number(t); if (!Number.isInteger(n) || n < 0) return msg('0 以上の整数で入力してください', 'warn'); if (n !== cur) limits[i.dataset.lim] = n; }
      if (!Object.keys(limits).length) return msg('変更はありません');
      try { await authClient().refresh(); } catch { /* reported by the call */ }
      const r = await api(`/api/elvar/admin/users/${encodeURIComponent(sv.dataset.savelim)}/limits`, { method: 'POST', body: { limits } });
      if (r.status === 200) { sel = null; await refresh(); msg('上限を保存しました（本人の操作の記録にも残ります）', 'ok'); } else msg(r.body?.message || r.body?.error || 'できませんでした', 'warn');
      return;
    }
    const q = e.target.closest('[data-quota]');
    if (q) {   // the storage quota of one account (O1: 500 MB by default)
      const mbText = prompt('このアカウントの保存容量の上限（MB）', q.dataset.mb); if (mbText === null) return;
      const n = Number(String(mbText).normalize('NFKC').trim());
      if (!Number.isFinite(n) || n < 0 || n > 1048576) { msg('0〜1048576 の数（MB）で入力してください', 'warn'); return; }
      try { await authClient().refresh(); } catch { /* reported by the call */ }
      const r = await api(`/api/elvar/admin/users/${encodeURIComponent(q.dataset.quota)}/quota`, { method: 'POST', body: { bytes: Math.round(n * 1048576) } });
      if (r.status === 200) { await refresh(); msg('保存容量の上限を変更しました', 'ok'); } else msg(r.body?.message || r.body?.error || 'できませんでした', 'warn');
      return;
    }
    const stop = e.target.closest('[data-stop]'), lift = e.target.closest('[data-lift]');
    if (!stop && !lift) return;
    const id = (stop || lift).dataset.stop || (stop || lift).dataset.lift;
    const reason = stop ? (prompt('停止の理由（任意・本人にも見えます）') ?? null) : '';
    if (stop && reason === null) return;
    try { await authClient().refresh(); } catch { /* reported by the call */ }
    const r = await api(`/api/elvar/admin/users/${encodeURIComponent(id)}/${stop ? 'suspend' : 'unsuspend'}`, { method: 'POST', body: { reason } });
    if (r.status === 200) { await refresh(); msg(stop ? '停止しました' : '解除しました', 'ok'); } else msg(r.body?.message || r.body?.error || 'できませんでした', 'warn');
  });
  return { refresh };
}
