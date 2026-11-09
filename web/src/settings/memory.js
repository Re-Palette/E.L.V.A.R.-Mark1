// Settings > 記憶: the user's own memory, all of it kept on the server for THEM only and under their control (principle 7): the second brain (notes), the
// conversation log with its retention, the notification box, and the optional mirror to their OWN GitHub repository (connector github-brain).
import { esc } from '../elvar/ui.js';
import { api } from '../elvar/auth.js';

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const RETENTION = [['7', '7日'], ['30', '30日'], ['90', '90日'], ['180', '180日（標準）'], ['365', '1年'], ['0', 'ずっと残す']];

/** @param {HTMLElement} root @param {{ openBrain?: Function, openConversations?: Function }} [hooks] */
export function mountMemory(root, hooks = {}) {
  let cfg = null, counts = { notes: 0, trash: 0, conversations: 0, inbox: 0 }, sync = null, note = { t: '', c: '' };
  const $ = (s) => root.querySelector(s);
  const say = (t, c = '') => { note = { t, c }; const m = $('#em-msg'); if (m) { m.textContent = t; m.className = 'ev-msg ' + c; } };

  function draw() {
    if (!cfg) { root.innerHTML = '<p class="ev-note">読み込めませんでした。ログインし直してください。</p>'; return; }
    const ret = cfg.settings?.MESSAGE_RETENTION_DAYS?.value || '180', repo = cfg.settings?.BRAIN_REPO?.value || '', tok = cfg.secrets?.BRAIN_GITHUB_TOKEN || {};
    const mirror = cfg.settings?.BRAIN_MIRROR?.value === '1';
    root.innerHTML = `
      <div class="ev-sec"><h3>第二の脳（あなたのノート）</h3>
        <p class="ev-note" style="margin-top:0">ノートは、このアプリの中の、あなた専用の保管庫にあります。ほかの人には見えません。1つずつ、見る・直す・消すことができ、直す前の版も残ります（新しい30版まで）。</p>
        <div class="ev-row"><span class="ev-chip ok">ノート ${esc(counts.notes)} 件</span>${counts.trash ? `<span class="ev-chip off">ゴミ箱 ${esc(counts.trash)} 件（30日で自動削除）</span>` : ''}</div>
        <div class="ev-btns"><button class="ev-btn sm pri" type="button" data-act="brain">第二の脳を開く</button><button class="ev-btn sm" type="button" data-act="trash-empty"${counts.trash ? '' : ' disabled'}>ゴミ箱を空にする</button>
          <button class="ev-btn sm danger" type="button" data-act="notes-all"${counts.notes + counts.trash ? '' : ' disabled'}>ノートをすべて完全に消す</button></div></div>

      <div class="ev-sec"><h3>会話の記録（短期の記憶）</h3>
        <p class="ev-note" style="margin-top:0">あなたの言葉と、返事を、文字にして残します。パスワード・APIキー・カード番号らしきものは、保存の前に伏せます。</p>
        <label class="ev-row"><input id="em-log" type="checkbox"${localStorage.getItem('elvar_conv_log') !== '0' ? ' checked' : ''}><span>この端末の会話を記録する</span></label>
        <label class="ev-field"><span>残す期間</span><select class="ev-select" id="em-ret">${RETENTION.map(([v, l]) => `<option value="${v}"${v === String(ret) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <div class="ev-row"><span class="ev-chip ok">会話 ${esc(counts.conversations)} 件</span></div>
        <div class="ev-btns"><button class="ev-btn sm pri" type="button" data-act="conv">会話の履歴を開く</button>
          <button class="ev-btn sm danger" type="button" data-act="conv-old">30日より前を消す</button><button class="ev-btn sm danger" type="button" data-act="conv-all">会話の記録をすべて消す</button></div></div>

      <div class="ev-sec"><h3>通知箱</h3>
        <div class="ev-row"><span class="ev-chip ok">${esc(counts.inbox)} 件</span></div>
        <div class="ev-btns"><button class="ev-btn sm danger" type="button" data-act="inbox-all"${counts.inbox ? '' : ' disabled'}>通知箱を空にする</button></div></div>

      <div class="ev-sec"><h3>自分のGitHubに写す（任意）</h3>
        <p class="ev-note" style="margin-top:0">ノートを、あなた自身のGitHubリポジトリ（Obsidianで開けます）に写せます。あなたのトークンだけを使い、一方通行です（こちらでノートを消しても、リポジトリのものは消えません）。使わなくてかまいません。</p>
        <div class="ev-row"><span class="l">トークン</span><span class="ev-chip ${tok.set ? 'ok' : 'off'}">${tok.set ? '設定済み' + (tok.last4 ? '・末尾' + esc(tok.last4) : '') : '未設定'}</span></div>
        <label class="ev-field"><span>トークン（Contents: Read and write だけを付けた、そのリポジトリ専用のもの）</span><input class="ev-input" id="em-tok" type="password" placeholder="${tok.set ? '変えるときだけ入力' : 'github_pat_…'}" autocomplete="off" spellcheck="false"></label>
        <label class="ev-field"><span>リポジトリ（owner/name）</span><input class="ev-input" id="em-repo" value="${esc(repo)}" placeholder="your-name/your-notes" autocomplete="off" spellcheck="false"></label>
        <label class="ev-row"><input id="em-mirror" type="checkbox"${mirror ? ' checked' : ''}><span>変更を、5分おきにまとめて写す</span></label>
        <div class="ev-btns"><button class="ev-btn sm pri" type="button" data-act="sync-save">保存</button>
          <button class="ev-btn sm" type="button" data-act="sync-import"${sync?.configured ? '' : ' disabled'}>リポジトリから取り込む</button><button class="ev-btn sm" type="button" data-act="sync-push"${sync?.configured ? '' : ' disabled'}>今すぐ写す</button></div>
        ${sync?.configured ? `<p class="ev-note">まだ写していない変更：${esc(sync.unpushed)} 件</p>` : ''}</div>
      <div class="ev-msg" id="em-msg" role="status">${esc(note.t)}</div>`;
    if (note.c) $('#em-msg').className = 'ev-msg ' + note.c;
  }

  async function refresh() {
    const [c, n, t, cv, ib, s] = await Promise.all([api('/api/elvar/config'), api('/api/elvar/notes'), api('/api/elvar/notes?trash=1'), api('/api/elvar/conversations?limit=200'), api('/api/elvar/inbox'), api('/api/elvar/brain-sync/status')]);
    cfg = c.status === 200 ? c.body : null;
    counts = { notes: n.body?.notes?.length || 0, trash: t.body?.notes?.length || 0, conversations: cv.body?.conversations?.length || 0, inbox: ib.body?.items?.length || 0 };
    sync = s.status === 200 ? s.body : null; draw();
  }

  root.addEventListener('change', async (e) => {
    if (e.target.id === 'em-log') { try { localStorage.setItem('elvar_conv_log', e.target.checked ? '1' : '0'); } catch { /* private mode */ } say(e.target.checked ? '会話の記録をオンにしました' : '会話の記録をオフにしました', 'ok'); }
    else if (e.target.id === 'em-ret') {
      const r = await api('/api/elvar/config', { method: 'PATCH', body: { settings: { MESSAGE_RETENTION_DAYS: e.target.value } } });
      if (r.status === 200) { cfg = r.body; say(e.target.value === '0' ? '会話の記録を、ずっと残します' : `${e.target.value}日より前の会話は、毎日の整理で自動的に消えます`, 'ok'); } else say(r.body?.message || '保存できませんでした', 'warn');
    }
  });
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const act = b.dataset.act, ask = (m) => confirm(m);
    if (act === 'brain') return hooks.openBrain?.();
    if (act === 'conv') return hooks.openConversations?.();
    if (act === 'trash-empty') { if (!ask('ゴミ箱のノートを、完全に消します。元に戻せません。')) return; const r = await api('/api/elvar/notes/trash/empty', { method: 'POST', body: {} }); say(r.status === 200 ? `${r.body.deleted} 件を完全に消しました` : '消せませんでした', r.status === 200 ? 'ok' : 'warn'); }
    else if (act === 'notes-all') { if (!ask('ノートを、ゴミ箱の分も含めて、すべて完全に消します。元に戻せません（先にエクスポートできます）。') || !ask('本当に、すべてのノートを消しますか？')) return; const r = await api('/api/elvar/notes/delete-all', { method: 'POST', body: { confirm: 'delete' } }); say(r.status === 200 ? `${r.body.deleted} 件を消しました` : '消せませんでした', r.status === 200 ? 'ok' : 'warn'); }
    else if (act === 'conv-old') { if (!ask('30日より前の会話の記録を消します。')) return; const r = await api('/api/elvar/messages/purge', { method: 'POST', body: { before: new Date(Date.now() - 30 * 864e5).toISOString() } }); say(r.status === 200 ? `${r.body.deleted} 件を消しました` : '消せませんでした', r.status === 200 ? 'ok' : 'warn'); }
    else if (act === 'conv-all') { if (!ask('会話の記録を、すべて消します。元に戻せません。')) return; const r = await api('/api/elvar/messages/purge', { method: 'POST', body: { all: true } }); say(r.status === 200 ? `${r.body.deleted} 件を消しました` : '消せませんでした', r.status === 200 ? 'ok' : 'warn'); }
    else if (act === 'inbox-all') { const r = await api('/api/elvar/inbox', { method: 'DELETE' }); say(r.status === 200 ? '通知箱を空にしました' : '消せませんでした', r.status === 200 ? 'ok' : 'warn'); }
    else if (act === 'sync-save') {
      const repo = $('#em-repo').value.trim(), tok = $('#em-tok').value.trim();
      if (repo && !REPO.test(repo)) return say('owner/name の形で入力してください', 'warn');
      const body = { settings: { BRAIN_REPO: repo || null, BRAIN_MIRROR: $('#em-mirror').checked ? '1' : null }, ...(tok ? { secrets: { BRAIN_GITHUB_TOKEN: tok } } : {}) };
      const r = await api('/api/elvar/config', { method: 'PATCH', body }); if (r.status !== 200) return say(r.body?.message || '保存できませんでした', 'warn'); say('保存しました', 'ok');
    } else if (act === 'sync-import') {
      say('取り込み中…'); const r = await api('/api/elvar/brain-sync/import', { method: 'POST', body: {} });
      if (r.status !== 200) return say(r.body?.message || '取り込めませんでした', 'warn');
      say(`新しく ${r.body.created} 件、更新 ${r.body.updated} 件、そのまま ${r.body.same} 件${r.body.conflicts?.length ? `。こちらで直してあった ${r.body.conflicts.length} 件は、そのままにしました` : ''}${r.body.more ? `。まだ ${r.body.more} 件あります（もう一度押してください）` : ''}`, 'ok');
    } else if (act === 'sync-push') {
      say('写しています…'); const r = await api('/api/elvar/brain-sync/push', { method: 'POST', body: { force: true } });
      if (r.status !== 200) return say(r.body?.message || '写せませんでした', 'warn'); say(`${r.body.pushed} 件を写しました${r.body.failed ? `（${r.body.failed} 件は失敗）` : ''}`, r.body.failed ? 'warn' : 'ok');
    }
    await refresh();
  });
  return { refresh, stop() {} };
}
