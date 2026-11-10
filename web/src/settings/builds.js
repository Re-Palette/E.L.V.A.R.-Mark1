// Settings > 連携アプリ > 製作依頼（Claude Code）: "build requests" go to the user's OWN GitHub repository with the user's OWN token (docs/ELVAR_MULTIUSER.md 8.1).
// The repository is a setting (BUILD_REPO, owner/name); the token is a key in 「APIキー」 (BUILD_GITHUB_TOKEN). The list below is the user's own record of what they asked for:
// it can be removed here (the GitHub issue itself lives in their repository and stays).
import { esc } from '../elvar/ui.js';
import { api } from '../elvar/auth.js';
import { when } from './google-logic.js';

const STATE = { queued: ['依頼済み', 'off'], working: ['作業中', 'ok'], review: ['確認待ち', 'ok'], done: ['完成', 'ok'], failed: ['失敗', 'warn'] };
const REPO = /^(?!\.)[A-Za-z0-9_.-]{1,100}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;

export function mountBuilds(root) {
  let cfg = null, builds = [], note = { t: '', c: '' };
  const $ = (s) => root.querySelector(s);
  const say = (t, c = '') => { note = { t, c }; const m = $('#eb-msg'); if (m) { m.textContent = t; m.className = 'ev-msg ' + c; } };

  function draw() {
    if (!cfg) { root.innerHTML = ''; return; }
    const repo = cfg.settings?.BUILD_REPO?.value || '', self = cfg.settings?.BUILD_SELF_REPO?.value || '', tok = cfg.secrets?.BUILD_GITHUB_TOKEN || {};
    root.innerHTML = `<div class="ev-sec"><h3>製作依頼（Claude Code）</h3>
      <p class="ev-note" style="margin-top:0">「これを作って」と頼むと、あなた自身のGitHubリポジトリにIssueを作り、Claude Codeが実装します。リポジトリとトークンは、あなた専用の設定です。</p>
      <div class="ev-row"><span class="l">トークン</span><span class="ev-chip ${tok.set ? 'ok' : 'off'}">${tok.set ? '設定済み' + (tok.last4 ? '・末尾' + esc(tok.last4) : '') : '未設定'}</span><span class="ev-note" style="margin:0">「APIキー」タブの「製作依頼の GitHub トークン」に入れます</span></div>
      <label class="ev-field"><span>リポジトリ（owner/name）</span><input class="ev-input" id="eb-repo" value="${esc(repo)}" placeholder="your-name/your-builds" autocomplete="off" spellcheck="false"></label>
      <label class="ev-field"><span>E.L.V.A.R. 自身を直すためのリポジトリ（任意・自分のフォークだけ）</span><input class="ev-input" id="eb-self" value="${esc(self)}" placeholder="your-name/your-fork" autocomplete="off" spellcheck="false"></label>
      <div class="ev-btns"><button class="ev-btn sm pri" type="button" data-save>保存</button></div>
      ${builds.length ? `<h3 style="margin-top:14px">これまでの依頼</h3>${builds.map((b) => `<div class="ev-cx-card" data-id="${esc(b.id)}"><div class="ev-row" style="margin:0"><span class="nm">${esc(b.title)}</span><span class="ev-chip ${(STATE[b.state] || STATE.queued)[1]}">${esc((STATE[b.state] || STATE.queued)[0])}</span></div>
        <div class="host">${esc(b.repo)} #${esc(b.issueNumber)}${b.prNumber ? '・PR #' + esc(b.prNumber) : ''}・${esc(when(Date.parse(b.createdAt)))}</div>
        <div class="ev-btns" style="margin-top:6px"><button class="ev-btn sm danger" type="button" data-del>一覧から消す</button></div></div>`).join('')}
        <p class="ev-note">一覧から消しても、GitHubのIssueは消えません（あなたのリポジトリのものです）。</p>` : '<p class="ev-note">まだ、依頼はありません。</p>'}
      <div class="ev-msg" id="eb-msg" role="status">${esc(note.t)}</div></div>`;
    if (note.c) $('#eb-msg').className = 'ev-msg ' + note.c;
  }
  async function refresh() {
    const [c, b] = await Promise.all([api('/api/elvar/config'), api('/api/elvar/builds')]);
    if (c.status === 200 && b.status === 200) { cfg = c.body; builds = b.body.builds || []; } else cfg = null;
    draw();
  }
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    if ('save' in btn.dataset) {
      const repo = $('#eb-repo').value.trim(), self = $('#eb-self').value.trim();
      for (const v of [repo, self]) if (v && !REPO.test(v)) return say('owner/name の形で入力してください', 'warn');
      const r = await api('/api/elvar/config', { method: 'PATCH', body: { settings: { BUILD_REPO: repo || null, BUILD_SELF_REPO: self || null } } });
      if (r.status !== 200) return say(r.body?.message || '保存できませんでした', 'warn');
      cfg = r.body; note = { t: '保存しました', c: 'ok' }; draw();
    } else if ('del' in btn.dataset) {
      const id = btn.closest('[data-id]')?.dataset.id; if (!id) return;
      const r = await api(`/api/elvar/builds/${id}`, { method: 'DELETE' }); if (r.status === 200) { note = { t: '一覧から消しました', c: 'ok' }; await refresh(); }
    }
  });
  return { refresh };
}
