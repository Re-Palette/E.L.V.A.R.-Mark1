// Settings > 管理 (only for admins): the list of accounts with metadata and usage, and suspend / lift. An admin CANNOT see anybody's persona, conversations,
// notes, files or keys: the server returns only these columns (docs/ELVAR_MULTIUSER.md 2.4, M11).
import { esc } from '../elvar/ui.js';
import { api, authClient } from '../elvar/auth.js';

const when = (v) => { try { return v ? new Date(v).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; } catch { return '—'; } };
const mb = (b) => `${(Number(b || 0) / 1048576).toFixed(1)} MB`;
const STATUS = { active: '利用中', suspended: '停止中', pending_deletion: '削除待ち' };

export function mountAdmin(root) {
  let users = [];
  const msg = (t, cls = '') => { const m = root.querySelector('#ad-msg'); if (m) { m.textContent = t; m.className = 'ev-msg ' + cls; } };
  function draw() {
    root.innerHTML = `<section class="ev-sec"><h3>アカウント一覧（${users.length}件）</h3>
      <p class="ev-note" style="margin-top:0">メール・日付・状態・容量・利用回数だけが見えます。人格・会話・ノート・ファイル・キーは、管理者にも見えません。</p>
      <div style="overflow:auto"><table class="ev-table" style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="color:#b99b6a;text-align:left"><th>メール</th><th>登録</th><th>最終ログイン</th><th>状態</th><th>容量</th><th>今日の呼び出し</th><th>30日</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr style="border-top:1px solid rgba(232,185,106,.15)"><td>${esc(u.email || '—')}${u.isAdmin ? ' <span class="ev-chip ok">管理者</span>' : ''}</td><td>${esc(when(u.createdAt))}</td><td>${esc(when(u.lastSignInAt))}</td>
          <td><span class="ev-chip ${u.status === 'active' ? 'ok' : 'off'}">${esc(STATUS[u.status] || u.status)}</span></td><td>${esc(mb(u.storageUsedBytes))} / ${esc(mb(u.storageQuotaBytes))}</td><td>${esc(u.callsToday)}</td><td>${esc(u.calls30d)}</td>
          <td>${u.isAdmin || u.status === 'pending_deletion' ? '' : u.status === 'suspended' ? `<button class="ev-btn sm" type="button" data-lift="${esc(u.userId)}">解除</button>` : `<button class="ev-btn sm danger" type="button" data-stop="${esc(u.userId)}">停止</button>`}</td></tr>`).join('')}</tbody></table></div>
    </section><div class="ev-msg" id="ad-msg" role="status"></div>`;
  }
  async function refresh() {
    root.innerHTML = '<p class="ev-note">読み込んでいます…</p>';
    try { await authClient().refresh(); } catch { /* reported by the call */ }
    const r = await api('/api/elvar/admin/users?limit=200');
    if (r.status !== 200) { root.innerHTML = `<p class="ev-msg warn">${r.status === 403 ? '管理者ではありません' : '読み込めませんでした'}</p>`; return; }
    users = r.body.users; draw();
  }
  root.addEventListener('click', async (e) => {
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
