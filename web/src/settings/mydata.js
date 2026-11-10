// Settings > 私のデータ (docs/ELVAR_MULTIUSER.md 7.2, 7.3; principle 7): every kind of data the service holds about the signed-in user, with its count and size, a button to the
// existing screen where it is seen and edited, a button to remove it; my own audit log; and the full export (a zip in parts, made in the background, links that expire after
// 24 hours). Everything here is about the signed-in user only; secret values are never shown.
import { esc } from '../elvar/ui.js';
import { api, authClient } from '../elvar/auth.js';

const mb = (b) => (b == null ? '' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const when = (v) => { try { return v ? new Date(v).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; } catch { return ''; } };
const ACTION_JA = { 'export.requested': 'データの書き出しを依頼', 'export.completed': 'データの書き出しが完了', 'account.quota_changed': '管理者が保存容量の上限を変更', 'account.limits_changed': '管理者が上限を変更', 'account.suspended': '管理者がアカウントを停止', 'account.unsuspended': '管理者が停止を解除', 'account.delete_requested': 'アカウントの削除を依頼', 'account.delete_cancelled': 'アカウントの削除を取り消し', 'connector.created': '連携アプリを追加' };
/** Pure (tested): the sentence for one audit row. */
export const auditText = (e) => `${ACTION_JA[e.action] || (String(e.action).startsWith('mydata.') ? `「私のデータ」から ${String(e.action).split('.')[1]} を削除` : e.action)}${e.actor === 'admin' ? '（管理者）' : e.actor === 'system' ? '（自動）' : ''}`;
/** Pure (tested): what to say while an export is being made. */
export const progressText = (job) => (job.status === 'done' ? '完成しました' : job.status === 'failed' ? '作成に失敗しました。もう一度お試しください' : `作成しています…（原本 ${job.progress?.originals ?? 0} 件を入れました・${job.parts} 個目まで）`);

/** @param {HTMLElement} root @param {{ goTab?: (tab:string) => void, actions?: Record<string, Function> }} hooks  actions: brain / conversations / files / usage */
export function mountMyData(root, { goTab = () => {}, actions = {} } = {}) {
  let data = null, jobs = [], audit = null, msg = { t: '', c: '' }, busy = false;
  const $ = (s) => root.querySelector(s);
  const say = (t, c = '') => { msg = { t, c }; const m = $('#emd-msg'); if (m) { m.textContent = t; m.className = 'ev-msg ' + c; } };
  const fresh = async () => { try { await authClient().refresh(); } catch { /* the call reports a problem */ } };

  function draw() {
    if (!data) { root.innerHTML = '<p class="ev-note">読み込めませんでした。ログインし直してください。</p>'; return; }
    const pct = Math.min(100, Math.round((data.storage.usedBytes / Math.max(1, data.storage.quotaBytes)) * 100)), job = jobs[0];
    root.innerHTML = `
      <section class="ev-sec"><h3>あなたのデータ</h3>
        <p class="ev-note" style="margin-top:0">このサービスがあなたについて持っているデータの、すべての種類です。ほかの人には見えません。1つずつ、見る・直す・消す・持ち出すことができます。</p>
        <div class="ev-row"><span class="ev-chip ok">保存容量 ${esc(mb(data.storage.usedBytes))} / ${esc(mb(data.storage.quotaBytes))}（${pct}%）</span></div>
        <div id="emd-list">${data.types.map((t) => `<div class="ev-device" data-type="${esc(t.id)}"><span class="nm"><b>${esc(t.label)}</b>　<span class="ev-chip off">${esc(t.count)} 件${t.bytes != null ? `・${esc(mb(t.bytes))}` : ''}${t.detail ? `・${esc(t.detail)}` : ''}</span><br><small>${esc(t.note)}</small>${t.id === 'notes' ? `<br><small>うち ${data.noteFolders.map((f) => `${esc(f.label)} ${esc(f.count)}件`).join('・')}</small>` : ''}</span>
          <span class="ev-btns" style="margin:0">${t.open ? `<button class="ev-btn sm" type="button" data-open="${esc(t.id)}">開く</button>` : ''}${t.del ? `<button class="ev-btn sm danger" type="button" data-del="${esc(t.id)}"${t.count ? '' : ' disabled'}>${esc(t.del.label)}</button>` : ''}</span></div>`).join('')}</div>
      </section>
      <section class="ev-sec"><h3>データを書き出す（持ち出す）</h3>
        <p class="ev-p" style="font-size:14px">ノート（Markdown）・会話・設定・ファイルの原本など、すべてを zip にまとめます。大きいときは、いくつかのファイルに分かれます。APIキーなどの<b>秘密の値は含まれません</b>（名前と末尾4桁だけ）。作成はバックグラウンドで進み、できあがったら<b>24時間</b>のあいだダウンロードできます（そのあと自動で消えます）。書き出しは1日1回までです。</p>
        <div class="ev-btns" style="margin-top:8px"><button class="ev-btn pri" type="button" id="emd-export"${busy ? ' disabled' : ''}>全データの書き出しを始める</button></div>
        <div id="emd-jobs">${jobs.map((j) => `<div class="ev-device"><span class="nm">${esc(when(j.createdAt))}　<span class="ev-chip ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'off' : ''}">${esc(progressText(j))}</span>${j.status === 'done' ? `<br><small>${esc(mb(j.bytes))}・${j.parts} 個のファイル・${j.downloads ? `リンクの期限 ${esc(when(j.expiresAt))}` : '期限が切れました'}${j.progress?.missing ? `・読めなかった原本 ${esc(j.progress.missing)} 件（書き出し内の export-report.json に一覧があります）` : ''}</small>` : ''}</span>
          <span class="ev-btns" style="margin:0">${(j.downloads || []).map((d) => `<a class="ev-btn sm" href="${esc(d.url)}" download="${esc(d.name)}" rel="noopener">ダウンロード ${j.downloads.length > 1 ? esc(d.part) : ''}</a>`).join('')}<button class="ev-btn sm danger" type="button" data-rmjob="${esc(j.id)}">消す</button></span></div>`).join('') || '<p class="ev-note">書き出しはまだありません。</p>'}</div>
      </section>
      <section class="ev-sec"><h3>操作の記録</h3>
        <p class="ev-note" style="margin-top:0">あなたと管理者が、あなたのアカウントに対して行った操作の記録です（1年で消えます）。</p>
        <div class="ev-btns" style="margin-top:6px"><button class="ev-btn sm" type="button" id="emd-audit">${audit ? '閉じる' : '記録を見る'}</button></div>
        ${audit ? `<div id="emd-auditlist">${audit.length ? audit.map((e) => `<div class="ev-kv"><span>${esc(auditText(e))}</span><span class="ev-note" style="margin:0">${esc(when(e.at))}</span></div>`).join('') : '<p class="ev-note">記録はありません。</p>'}</div>` : ''}
      </section>
      <section class="ev-sec"><h3>アカウントの削除</h3><p class="ev-note" style="margin-top:0">すべてのデータ（ファイルを含む）を完全に消します。「アカウント」の画面から、すぐに／7日後を選べます。</p>
        <div class="ev-btns" style="margin-top:6px"><button class="ev-btn sm danger" type="button" data-goto="account">アカウントの画面へ</button></div></section>
      <div class="ev-msg ${esc(msg.c)}" id="emd-msg" role="status">${esc(msg.t)}</div>`;
  }

  async function load() {
    const [m, e] = await Promise.all([api('/api/elvar/mydata'), api('/api/elvar/export')]);
    data = m.status === 200 ? m.body : null; jobs = e.status === 200 ? e.body.jobs : []; draw();
    if (jobs.some((j) => ['queued', 'running'].includes(j.status))) pump(jobs.find((j) => ['queued', 'running'].includes(j.status)).id);
  }
  /** Ask for the next part until the job is done (the server builds one part per step). */
  async function pump(id) {
    if (busy) return; busy = true; draw();
    try {
      for (let i = 0; i < 400; i++) {
        const r = await api(`/api/elvar/export/${id}/step`, { method: 'POST', body: {} });
        if (r.status !== 200) { say(r.body?.message || '書き出しを進められませんでした', 'warn'); break; }
        jobs = [r.body.job, ...jobs.filter((j) => j.id !== id)]; draw();
        if (!['queued', 'running'].includes(r.body.job.status)) { say(r.body.job.status === 'done' ? '書き出しが完成しました。24時間のあいだ、ダウンロードできます' : progressText(r.body.job), r.body.job.status === 'done' ? 'ok' : 'warn'); break; }
      }
    } finally { busy = false; draw(); }
  }

  root.addEventListener('click', async (e) => {
    const t = e.target;
    const go = t.closest('[data-goto]'); if (go) return goTab(go.dataset.goto);
    const op = t.closest('[data-open]');
    if (op) {
      const k = data.types.find((x) => x.id === op.dataset.open); if (!k?.open) return;
      if (k.open.tab) return goTab(k.open.tab);
      if (k.open.action === 'audit') { audit = audit || (await api('/api/elvar/audit')).body?.audit || []; draw(); $('#emd-audit')?.scrollIntoView?.({ block: 'center' }); return; }
      return actions[k.open.action]?.();
    }
    const del = t.closest('[data-del]');
    if (del) {
      const k = data.types.find((x) => x.id === del.dataset.del); if (!k?.del) return;
      if (!confirm(`「${k.label}」を削除します（${k.count}件）。${k.del.label}\n元に戻せません。よろしいですか？`)) return;
      await fresh();
      const r = k.del.route ? await api(k.del.route.path, { method: k.del.route.method, ...(k.del.route.method === 'DELETE' ? {} : { body: k.del.route.body }) }) : await api(`/api/elvar/mydata/${k.del.type}/delete`, { method: 'POST', body: { confirm: 'delete' } });
      if (r.status === 200) { await load(); say(`${k.label}を削除しました`, 'ok'); } else say(r.body?.message || '削除できませんでした', 'warn');
      return;
    }
    if (t.closest('#emd-export')) {
      await fresh(); say('書き出しを始めています…');
      const r = await api('/api/elvar/export', { method: 'POST', body: {} });
      if (r.status === 401) return say('もう一度ログインしてから、やり直してください', 'warn');
      if (r.status !== 200) return say(r.body?.message || '書き出しを始められませんでした', 'warn');
      jobs = [r.body.job, ...jobs.filter((j) => j.id !== r.body.job.id)]; draw(); if (['queued', 'running'].includes(r.body.job.status)) pump(r.body.job.id); else say('書き出しが完成しました。24時間のあいだ、ダウンロードできます', 'ok');
      return;
    }
    const rm = t.closest('[data-rmjob]');
    if (rm) { const r = await api(`/api/elvar/export/${rm.dataset.rmjob}`, { method: 'DELETE' }); if (r.status === 200) { jobs = jobs.filter((j) => j.id !== rm.dataset.rmjob); draw(); say('書き出しを消しました', 'ok'); } else say('消せませんでした', 'warn'); return; }
    if (t.closest('#emd-audit')) { if (audit) audit = null; else audit = (await api('/api/elvar/audit')).body?.audit || []; draw(); }
  });
  return { refresh: load };
}
