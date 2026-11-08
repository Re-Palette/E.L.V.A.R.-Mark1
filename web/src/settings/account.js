// Settings > アカウント: devices that can use this assistant (revoke), the owner password, sign out.
import { esc } from '../elvar/ui.js';
import { api, logout } from '../elvar/auth.js';

const when = (ms) => { try { return new Date(ms).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

export function mountAccount(root, { mode }) {
  const msg = (t, cls = '') => { const m = root.querySelector('#ea-msg'); if (m) { m.textContent = t; m.className = 'ev-msg ' + cls; } };
  async function refresh() {
    const m = mode();
    if (m !== 'vault') {
      root.innerHTML = `<p class="ev-p">${m === 'env' ? '環境変数のアクセストークンで動いています（端末ごとのログインはありません）。' : 'まだセットアップされていません。'}</p>`;
      return;
    }
    const r = await api('/api/elvar/devices');
    const list = r.status === 200 ? r.body.devices : [];
    root.innerHTML = `
      <section class="ev-sec"><h3>ログインしている端末</h3>
        ${list.map((d) => `<div class="ev-device"><span class="nm">${esc(d.name)} ${d.current ? '<span class="ev-chip ok">この端末</span>' : ''}<br><small>最終利用 ${esc(when(d.lastSeenAt))}・登録 ${esc(when(d.createdAt))}</small></span>
          <button class="ev-btn sm danger" type="button" data-rm="${esc(d.id)}">${d.current ? 'ログアウト' : '使えなくする'}</button></div>`).join('')}
        <p class="ev-note">なくした端末は「使えなくする」で、すぐに使えなくなります。</p>
      </section>
      <section class="ev-sec"><h3>パスワードの変更</h3>
        <label class="ev-field"><span>今のパスワード</span><input class="ev-input" id="ea-cur" type="password" autocomplete="current-password"></label>
        <label class="ev-field"><span>新しいパスワード（10文字以上）</span><input class="ev-input" id="ea-new" type="password" autocomplete="new-password"></label>
        <div class="ev-btns" style="margin-top:8px"><button class="ev-btn pri" id="ea-pw" type="button">変更する</button></div>
      </section>
      <div class="ev-msg" id="ea-msg" role="status"></div>`;
  }
  root.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      const r = await api(`/api/elvar/devices/${encodeURIComponent(rm.dataset.rm)}`, { method: 'DELETE' });
      if (r.status === 200 && r.body.self) { await logout(); location.reload(); return; }
      if (r.status === 200) { await refresh(); msg('使えなくしました', 'ok'); } else msg('できませんでした', 'warn');
    }
    if (e.target.closest('#ea-pw')) {
      const r = await api('/api/elvar/auth/password', { method: 'POST', body: { current: root.querySelector('#ea-cur').value, next: root.querySelector('#ea-new').value } });
      root.querySelector('#ea-cur').value = ''; root.querySelector('#ea-new').value = '';
      msg(r.status === 200 ? 'パスワードを変更しました' : r.body?.message || '変更できませんでした', r.status === 200 ? 'ok' : 'warn');
    }
  });
  return { refresh };
}
