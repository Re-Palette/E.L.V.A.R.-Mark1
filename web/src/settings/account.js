// Settings > アカウント: who is signed in, usage, the password, signing out (this device / everywhere), notification devices, "my data" (export) and deleting the
// account (principle 7: immediately, or after a 7-day grace period during which signing in cancels it). Everything here is about the signed-in user only.
import { esc } from '../elvar/ui.js';
import { api, authClient, logout, currentSession } from '../elvar/auth.js';
import { authMessage } from '../elvar/gotrue.js';
import { passwordProblem } from '../auth/screens.js';

const when = (v) => { try { return new Date(v).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const mb = (b) => `${(Number(b || 0) / 1048576).toFixed(1)} MB`;

export function mountAccount(root, { openUsage = () => {} } = {}) {
  const msg = (t, cls = '') => { const m = root.querySelector('#ea-msg'); if (m) { m.textContent = t; m.className = 'ev-msg ' + cls; } };
  const $ = (id) => root.querySelector('#' + id);
  async function fresh() { try { await authClient().refresh(); } catch { /* the call below reports a problem */ } }
  async function refresh() {
    const s = currentSession(), me = authClient()?.session()?.user, google = me?.provider === 'google';
    const [dev, use] = await Promise.all([api('/api/elvar/devices'), api('/api/elvar/usage')]);
    const devices = dev.status === 200 ? dev.body.devices : [], u = use.status === 200 ? use.body : null;
    const calls = (u?.daily || []).filter((d) => d.metric === 'calls').reduce((a, d) => a + d.amount, 0);
    const used = u ? (u.storage.filesBytes + u.storage.textBytes + u.storage.notesBytes + u.storage.messagesBytes) : 0;
    root.innerHTML = `
      <section class="ev-sec"><h3>ログイン中のアカウント</h3>
        <div class="ev-kv"><span>メールアドレス</span><span>${esc(s?.user?.email || me?.email || '')}</span><span>ログイン方法</span><span>${google ? 'Google' : 'メールとパスワード'}</span>
          <span>保存容量</span><span>${esc(mb(used))} / ${esc(mb(u?.quotaBytes ?? s?.account?.storageQuotaBytes))}</span><span>直近30日のAI呼び出し</span><span>${esc(calls)} 回</span></div>
        <div class="ev-btns"><button class="ev-btn" id="ea-usage" type="button">利用状況を見る・上限を設定する</button></div>
        <div class="ev-btns"><button class="ev-btn" id="ea-out" type="button">この端末からログアウト</button><button class="ev-btn" id="ea-out-all" type="button">すべての端末からログアウト</button></div>
        <p class="ev-note">ログアウトすると、この端末に保存したあなたの履歴やファイルのキャッシュも消えます（サーバーのデータは残ります）。</p>
      </section>
      ${google ? '' : `<section class="ev-sec"><h3>パスワードの変更</h3>
        <label class="ev-field"><span>新しいパスワード（10文字以上・大文字／小文字／数字）</span><input class="ev-input" id="ea-new" type="password" autocomplete="new-password"></label>
        <div class="ev-btns" style="margin-top:8px"><button class="ev-btn pri" id="ea-pw" type="button">変更する</button></div></section>`}
      <section class="ev-sec"><h3>通知を受け取る端末（スマホアプリ用）</h3>
        ${devices.length ? devices.map((d) => `<div class="ev-device"><span class="nm">${esc(d.name)}<br><small>${esc(d.scopes.join('・'))}／登録 ${esc(when(d.createdAt))}${d.lastSeenAt ? `／最終 ${esc(when(d.lastSeenAt))}` : ''}</small></span><button class="ev-btn sm danger" type="button" data-rm="${esc(d.id)}">使えなくする</button></div>`).join('') : '<p class="ev-note" style="margin-top:0">登録した端末はありません。</p>'}
        <p class="ev-note">スマホの通知を、クラウドを通してPCでも聞く機能は、準備中です。</p>
      </section>
      <section class="ev-sec"><h3>私のデータ</h3>
        <p class="ev-p" style="font-size:14px">プロフィール・設定・APIキーの名前・端末・利用状況・操作の記録を、ファイルにして受け取れます。APIキーの値は、安全のため含まれません。</p>
        <div class="ev-btns"><button class="ev-btn" id="ea-export" type="button">データを書き出す</button></div>
      </section>
      <section class="ev-sec"><h3>アカウントの削除</h3>
        <p class="ev-p" style="font-size:14px">あなたのデータ（プロフィール・設定・暗号化したキー・端末・利用記録）を、すべて削除します。元に戻せません。</p>
        <label class="ev-check"><input type="radio" name="ea-grace" value="7" checked><span><b>7日後に削除する</b>（その間にログインすると、取り消せます）</span></label>
        <label class="ev-check"><input type="radio" name="ea-grace" value="0"><span><b>今すぐ削除する</b>（取り消せません）</span></label>
        <label class="ev-field"><span>${google ? '確認のため、メールアドレスを入力してください' : '確認のため、パスワードを入力してください'}</span><input class="ev-input" id="ea-confirm" type="${google ? 'email' : 'password'}" autocomplete="${google ? 'off' : 'current-password'}"></label>
        <div class="ev-btns"><button class="ev-btn danger" id="ea-del" type="button">アカウントを削除する</button></div>
        <p class="ev-note">利用者のバックアップには、削除後も最大7日間だけ残ることがあります（プライバシーポリシー参照）。</p>
      </section>
      <div class="ev-msg" id="ea-msg" role="status"></div>`;
  }
  root.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { const r = await api(`/api/elvar/devices/${encodeURIComponent(rm.dataset.rm)}`, { method: 'DELETE' }); if (r.status === 200) { await refresh(); msg('使えなくしました', 'ok'); } else msg('できませんでした', 'warn'); return; }
    if (e.target.closest('#ea-usage')) return openUsage();
    if (e.target.closest('#ea-out')) return logout({});
    if (e.target.closest('#ea-out-all')) return logout({ everywhere: true });
    if (e.target.closest('#ea-pw')) {
      const pw = $('ea-new').value, bad = passwordProblem(pw); if (bad) return msg(bad, 'warn');
      try { await authClient().updatePassword(pw); $('ea-new').value = ''; msg('パスワードを変更しました', 'ok'); } catch (err) { msg(authMessage(err), 'warn'); }
      return;
    }
    if (e.target.closest('#ea-export')) {
      await fresh(); msg('書き出しています…');
      const r = await fetch('/api/elvar/account/export', { cache: 'no-store' });
      if (!r.ok) { const j = await r.json().catch(() => ({})); return msg(j.error === 'rate_limited' ? j.message : j.error === 'reauth_required' ? 'もう一度ログインしてから、やり直してください' : '書き出せませんでした', 'warn'); }
      const blob = new Blob([JSON.stringify(await r.json(), null, 2)], { type: 'application/json' }), a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'elvar-export.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return msg('書き出しました', 'ok');
    }
    if (e.target.closest('#ea-del')) {
      const grace = Number(root.querySelector('input[name="ea-grace"]:checked')?.value ?? 7), me = authClient().session().user, typed = $('ea-confirm').value;
      if (!typed) return msg('確認の入力が必要です', 'warn');
      if (me.provider === 'google') { if (typed.trim().toLowerCase() !== String(me.email || '').toLowerCase()) return msg('メールアドレスが違います', 'warn'); await fresh(); }
      else { try { await authClient().signInWithPassword({ email: me.email, password: typed }); } catch (err) { return msg(authMessage(err), 'warn'); } }   // a new session: proves the password and is "fresh"
      if (!confirm(grace === 0 ? '本当に、今すぐ削除しますか？ 元に戻せません。' : '7日後に削除されます。よろしいですか？')) return;
      const r = await api('/api/elvar/account/delete', { method: 'POST', body: { graceDays: grace } });
      if (r.status !== 200) return msg(r.body?.message || '削除できませんでした', 'warn');
      await logout({ erase: true });
    }
  });
  return { refresh };
}
