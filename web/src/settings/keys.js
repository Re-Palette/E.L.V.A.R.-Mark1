// Settings > APIキー: write-only. The server returns { set, source, last4 } only; inputs are never filled with a key.
import { esc } from '../elvar/ui.js';
import { api } from '../elvar/auth.js';
import { keyStatusText } from '../setup/wizard-text.js';

const HELP = {
  GEMINI_API_KEY: '音声会話・文章・検索（必須）', GROQ_API_KEY: '難しい推論・サブエージェント', EXA_API_KEY: '本格的な調べもの', NEWSDATA_API_KEY: 'ニュース',
  SARASHINA_API_KEY: '日本語の要約・分類', BRAIN_GITHUB_TOKEN: '第二の脳（GitHub のノート）', BUILD_GITHUB_TOKEN: '製作依頼（Claude Code）',
};

export function mountKeys(root) {
  let cfg = null;
  const msg = (t, cls = '') => { const m = root.querySelector('#ek-msg'); m.textContent = t; m.className = 'ev-msg ' + cls; };
  function draw() {
    const ro = !cfg.writable;
    root.innerHTML = `
      ${ro ? `<p class="ev-note">${cfg.mode === 'env' ? '環境変数モードです。キーは環境変数で変更してください（ここでは状態だけ表示します）。' : 'セットアップが済むと、ここでキーを保存できます。'}</p>` : '<p class="ev-note">保存したキーは暗号化され、画面には二度と表示されません。入れ直すときは、新しいキーを入力して保存します。</p>'}
      ${Object.entries(cfg.secrets).map(([k, s]) => `
        <div class="ev-key" data-k="${esc(k)}">
          <div class="ev-row" style="margin:0"><span class="nm">${esc(s.label)}</span><span class="ev-chip ${s.set ? 'ok' : 'off'}">${esc(keyStatusText(s))}</span></div>
          <div class="st">${esc(HELP[k] || '')}</div>
          ${ro ? '' : `<div class="ev-row"><input class="ev-input" style="flex:1;min-width:12em" type="password" autocomplete="off" spellcheck="false" aria-label="${esc(s.label)}" data-in>
            <button class="ev-btn sm pri" type="button" data-save>保存</button>
            ${s.testable && s.set ? '<button class="ev-btn sm" type="button" data-test>確認</button>' : ''}
            ${s.set && s.source === 'app' ? '<button class="ev-btn sm danger" type="button" data-del>削除</button>' : ''}</div>`}
        </div>`).join('')}
      <div class="ev-msg" id="ek-msg" role="status"></div>`;
  }
  async function refresh() {
    const r = await api('/api/elvar/config');
    if (r.status !== 200) { root.innerHTML = '<p class="ev-msg warn">読み込めませんでした</p>'; return; }
    cfg = r.body; draw();
  }
  root.addEventListener('click', async (e) => {
    const box = e.target.closest('[data-k]'); if (!box) return;
    const k = box.dataset.k, input = box.querySelector('[data-in]');
    if (e.target.closest('[data-save]')) {
      const v = input.value.trim(); if (!v) return msg('キーを入力してください', 'warn');
      const r = await api('/api/elvar/config', { method: 'PATCH', body: { secrets: { [k]: v } } });
      input.value = '';
      if (r.status !== 200) return msg(r.body?.message || '保存できませんでした', 'warn');
      cfg = r.body; draw(); msg(`${cfg.secrets[k].label} を保存しました`, 'ok');
    } else if (e.target.closest('[data-del]')) {
      const r = await api('/api/elvar/config', { method: 'PATCH', body: { secrets: { [k]: null } } });
      if (r.status === 200) { cfg = r.body; draw(); msg('削除しました', 'ok'); }
    } else if (e.target.closest('[data-test]')) {
      msg('確認しています…');
      const r = await api('/api/elvar/config/test', { method: 'POST', body: { name: k } });
      msg(r.body?.detail || '確認できませんでした', r.body?.status === 'ok' ? 'ok' : 'warn');
    }
  });
  return { refresh };
}
