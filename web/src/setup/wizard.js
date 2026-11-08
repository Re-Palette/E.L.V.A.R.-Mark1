// First-run setup wizard: storage check -> setup code + owner password -> Gemini key (+ check) -> name / address / language / time zone / city
// -> speaking style + greeting preview -> optional services -> done. Each step is saved on the server as it is completed; the step reached is kept
// on this device (elvar_setup_step), so a reload continues where it stopped. Keys are write-only: never shown again, only "設定済み・末尾4桁".
import { overlay, esc } from '../elvar/ui.js';
import { api, setToken, getToken, setSetupStep, setupStep, defaultDeviceName, loadSession } from '../elvar/auth.js';
import { validateProfile, DEFAULT_PROFILE } from '../../../shared/profile.js';
import { renderFields, readFields, mergeInto, errorText, browserTimeZone } from '../settings/profile-form.js';
import { greetingLine } from '../live/clap-standby.js';
import { setProfileCache } from '../brand.js';
import { keyStatusText } from './wizard-text.js';
export { keyStatusText };

export const STEPS = ['storage', 'owner', 'gemini', 'profile', 'persona', 'services', 'done'];
const TITLES = { storage: '保存先の確認', owner: 'オーナーの登録', gemini: 'Gemini の APIキー', profile: 'あなたについて', persona: '話し方と挨拶', services: 'ほかのサービス（任意）', done: '準備ができました' };

/** Where to start: the saved step (resume), or the first step that is not done yet. Pure (tested). */
export function startStep(state, saved, hasToken) {
  if (state?.storage === 'none') return 'storage';
  if (!state?.initialized) return 'owner';
  if (saved && STEPS.includes(saved) && hasToken && saved !== 'storage' && saved !== 'owner') return saved;
  return 'gemini';
}

export function runWizard({ state, setupCode = '' }) {
  return new Promise((resolve) => {
    const o = overlay({ title: 'E.L.V.A.R. SETUP', sub: '最初の設定', label: 'セットアップ' });
    o.back.classList.add('ev-setup');
    let st = state, step = startStep(st, setupStep(), Boolean(getToken()));
    let profile = structuredClone(DEFAULT_PROFILE);
    if (!profile.locale.timeZone || profile.locale.timeZone === 'Asia/Tokyo') profile.locale.timeZone = browserTimeZone();

    const bar = () => `<div class="ev-steps">${STEPS.slice(1).map((s) => `<span class="${s === step ? 'on' : STEPS.indexOf(s) < STEPS.indexOf(step) ? 'done' : ''}"></span>`).join('')}</div>`;
    const $ = (id) => o.panel.querySelector('#' + id);
    const msg = (t, cls = '') => { const m = $('ev-msg'); if (m) { m.textContent = t; m.className = 'ev-msg ' + cls; } };
    if (setupCode) setupCode = String(setupCode).toUpperCase();
    const go = (s) => { step = s; if (s !== 'storage' && s !== 'owner') setSetupStep(s); render(); };
    const busy = (on) => o.panel.querySelectorAll('button').forEach((b) => { b.disabled = on; });

    async function loadProfile() {
      const r = await api('/api/elvar/profile'); if (r.status === 200) { profile = r.body.profile; if (step === 'profile' && profile.locale.timeZone === DEFAULT_PROFILE.locale.timeZone) profile.locale.timeZone = browserTimeZone(); }
    }
    async function saveProfile(partial) {
      const next = mergeInto(profile, partial), v = validateProfile(next, profile);
      if (!v.ok) { msg(errorText(v.errors), 'warn'); return false; }
      const r = await api('/api/elvar/profile', { method: 'PUT', body: { profile: v.profile } });
      if (r.status !== 200) { msg(r.body?.errors ? errorText(r.body.errors) : r.body?.message || '保存できませんでした', 'warn'); return false; }
      profile = r.body.profile; setProfileCache(profile); return true;
    }

    const views = {
      storage: () => `
        <p class="ev-p">設定を暗号化して保存する場所がありません。</p>
        <p class="ev-p">Vercel では、ダッシュボードの <b>Storage</b> から <b>Upstash（Redis）</b> を追加し、このプロジェクトにつないで再デプロイしてください。環境変数は自動で入ります。</p>
        <p class="ev-note">ローカルで動かしている場合は、この画面は出ません（設定は ~/.elvar に保存されます）。</p>
        <div class="ev-btns"><button class="ev-btn pri" id="ev-go" type="button">もう一度確認</button></div>`,
      owner: () => `
        <p class="ev-p">このアシスタントの持ち主（オーナー）を登録します。パスワードは、新しい端末でログインするときに使います。</p>
        <label class="ev-field"><span>セットアップコード</span><input class="ev-input ev-code" id="ev-code" type="text" autocomplete="one-time-code" maxlength="12" placeholder="XXXX-XXXX" spellcheck="false" value="${esc(setupCode)}"></label>
        <p class="ev-note">${setupCode ? 'セットアップ用のリンクから入力しました。' : 'サーバーのログに <b>ELVAR SETUP CODE</b> として出ています（Vercel: Project → Logs、ローカル: サーバーを起動したターミナル。そこに出るリンクを開くと自動で入ります）。'}60分有効です。</p>
        <label class="ev-field"><span>パスワード（10文字以上）</span><input class="ev-input" id="ev-pw" type="password" autocomplete="new-password" minlength="10"></label>
        <label class="ev-field"><span>パスワード（確認）</span><input class="ev-input" id="ev-pw2" type="password" autocomplete="new-password"></label>
        <label class="ev-field"><span>この端末の名前</span><input class="ev-input" id="ev-dev" type="text" maxlength="40" value="${esc(defaultDeviceName())}"></label>
        <p class="ev-note">パスワードとすべての端末を失うと、保存した設定は開けなくなります。忘れないものにしてください。</p>
        <div class="ev-btns"><button class="ev-btn pri" id="ev-go" type="button">登録する</button></div>`,
      gemini: (cfg) => `
        <p class="ev-p">音声会話には Google の <b>Gemini API キー</b>が必要です。<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" style="color:#FFD99A">Google AI Studio</a> で無料で作れます。</p>
        <div class="ev-row"><span class="l">状態</span><span class="ev-chip ${cfg?.set ? 'ok' : 'off'}" id="ev-kst">${esc(keyStatusText(cfg))}</span></div>
        <label class="ev-field"><span>APIキー${cfg?.set ? '（入れ直すときだけ）' : ''}</span><input class="ev-input" id="ev-key" type="password" autocomplete="off" spellcheck="false" placeholder="AIza..."></label>
        <p class="ev-note">キーはサーバーで暗号化して保存します。保存したあとは画面に表示されません。</p>
        <div class="ev-btns"><button class="ev-btn pri" id="ev-go" type="button">保存して確認</button><button class="ev-btn" id="ev-skip" type="button">${cfg?.set ? '次へ' : 'あとで設定'}</button></div>`,
      profile: () => `
        <p class="ev-p">呼び方や時間の基準に使います。あとから設定で変えられます。</p>
        <div class="ev-grid2">${renderFields(['owner.name', 'owner.address', 'locale.language', 'locale.timeZone', 'home.city', 'home.labelEn'], profile)}</div>
        <div class="ev-btns"><button class="ev-btn pri" id="ev-go" type="button">保存して次へ</button><button class="ev-btn" id="ev-back" type="button">戻る</button></div>`,
      persona: () => `
        <div class="ev-grid2">${renderFields(['assistant.personaPreset', 'assistant.voice'], profile)}</div>
        <div id="ev-custom"${profile.assistant.personaPreset === 'custom' ? '' : ' hidden'}>${renderFields(['assistant.customPersona'], profile)}</div>
        <div class="ev-grid2">${renderFields(['greeting.template', 'greeting.honorific'], profile)}</div>
        <div class="ev-row"><span class="l">試聴</span><span class="ev-p" id="ev-line" style="margin:0"></span><button class="ev-btn sm" id="ev-hear" type="button">▶ 聞く</button></div>
        <p class="ev-note">試聴はこの端末の読み上げ機能です。本番は選んだ声で読み上げます。</p>
        <div class="ev-btns"><button class="ev-btn pri" id="ev-go" type="button">保存して次へ</button><button class="ev-btn" id="ev-back" type="button">戻る</button></div>`,
      services: (cfg) => `
        <p class="ev-p">なくても使えます。入れると、難しい推論（Groq）や本格的な調べもの（Exa）が使えます。</p>
        ${['GROQ_API_KEY', 'EXA_API_KEY'].map((k) => `<label class="ev-field"><span>${k === 'GROQ_API_KEY' ? 'Groq API キー' : 'Exa API キー'} <span class="ev-chip ${cfg?.[k]?.set ? 'ok' : 'off'}">${esc(keyStatusText(cfg?.[k]))}</span></span><input class="ev-input" data-key="${k}" type="password" autocomplete="off" spellcheck="false"></label>`).join('')}
        <p class="ev-note">Google（カレンダー・Gmail）は、あとで設定画面からつなぎます。</p>
        <div class="ev-btns"><button class="ev-btn pri" id="ev-go" type="button">保存して次へ</button><button class="ev-btn" id="ev-skip" type="button">スキップ</button></div>`,
      done: (cfg) => `
        <p class="ev-p">セットアップが終わりました。拍手2回、またはマイクのボタンで話しかけてください。</p>
        <div class="ev-kv"><span>オーナー</span><span>${esc(profile.owner.address)}</span><span>タイムゾーン</span><span>${esc(profile.locale.timeZone)}</span><span>Gemini</span><span class="ev-chip ${cfg?.set ? 'ok' : 'off'}">${esc(keyStatusText(cfg))}</span></div>
        <p class="ev-note">設定は、HUD の歯車のアイコン（Ctrl+,）からいつでも変えられます。</p>
        <div class="ev-btns"><button class="ev-btn pri" id="ev-go" type="button">HUD を開く</button></div>`,
    };

    async function render() {
      let cfg = null;
      if (['gemini', 'services', 'done'].includes(step)) { const r = await api('/api/elvar/config'); cfg = r.status === 200 ? r.body.secrets : null; }
      if (['profile', 'persona', 'done'].includes(step)) await loadProfile();
      const view = step === 'gemini' || step === 'done' ? views[step](cfg?.GEMINI_API_KEY) : views[step](cfg);
      o.panel.innerHTML = `${bar()}<h3 class="ev-h3" style="margin-top:14px">${esc(TITLES[step])}</h3>${view}<div class="ev-msg" id="ev-msg" role="status"></div>`;
      bind();
      setTimeout(() => o.panel.querySelector('input,select')?.focus(), 0);
    }

    function bind() {
      const back = $('ev-back'); if (back) back.onclick = () => go(STEPS[STEPS.indexOf(step) - 1]);
      const skip = $('ev-skip'); if (skip) skip.onclick = () => go(STEPS[STEPS.indexOf(step) + 1]);
      const btn = $('ev-go');
      const run = async (fn) => { busy(true); try { await fn(); } catch { msg('サーバーに接続できません', 'warn'); } finally { busy(false); } };
      o.panel.onkeydown = (e) => { if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && btn && !btn.disabled) btn.click(); };

      if (step === 'storage') btn.onclick = () => run(async () => { const r = await api('/api/elvar/state'); if (r.status === 200) { st = r.body; if (st.storage !== 'none') go(startStep(st, null, Boolean(getToken()))); else msg('まだ見つかりません。追加して再デプロイしたあと、もう一度押してください', 'warn'); } });
      if (step === 'owner') btn.onclick = () => run(async () => {
        const pw = $('ev-pw').value, pw2 = $('ev-pw2').value;
        if (pw.length < 10) return msg('パスワードは10文字以上にしてください', 'warn');
        if (pw !== pw2) return msg('確認のパスワードが一致しません', 'warn');
        const code = $('ev-code').value.trim(); if (!code) return msg('セットアップコードを入力してください', 'warn');
        const r = await api('/api/elvar/setup/claim', { method: 'POST', body: { setupCode: code, password: pw, deviceName: $('ev-dev').value } });
        if (r.status === 409) { msg('すでに登録されています。ログインしてください', 'warn'); setTimeout(() => { o.close(); setSetupStep(''); resolve(); }, 1200); return; }
        if (r.status !== 200) return msg(r.body?.message || '登録できませんでした', 'warn');
        setToken(r.body.token); st = { ...st, initialized: true };
        go('gemini');
      });
      if (step === 'gemini') btn.onclick = () => run(async () => {
        const key = $('ev-key').value.trim();
        if (key) {
          const r = await api('/api/elvar/config', { method: 'PATCH', body: { secrets: { GEMINI_API_KEY: key } } });
          $('ev-key').value = '';
          if (r.status !== 200) return msg(r.body?.message || '保存できませんでした', 'warn');
          $('ev-kst').textContent = keyStatusText(r.body.secrets.GEMINI_API_KEY); $('ev-kst').className = 'ev-chip ok';
        } else if ($('ev-kst').classList.contains('off')) return msg('キーを入力してください（あとで設定することもできます）', 'warn');
        msg('つながるか確認しています…');
        const t = await api('/api/elvar/config/test', { method: 'POST', body: { name: 'GEMINI_API_KEY' } });
        if (t.body?.status === 'ok') { msg('保存しました。' + t.body.detail, 'ok'); setTimeout(() => go('profile'), 700); }
        else { msg(`保存しました。ただし確認できませんでした：${t.body?.detail || ''}　このまま進むこともできます。`, 'warn'); $('ev-skip').textContent = '次へ'; }
      });
      if (step === 'profile') btn.onclick = () => run(async () => { if (await saveProfile(readFields(o.panel))) go('persona'); });
      if (step === 'persona') {
        const line = () => greetingLine(new Date(), mergeInto(profile, readFields(o.panel)));
        const upd = () => { $('ev-line').textContent = line(); $('ev-custom').hidden = o.panel.querySelector('[data-pf="assistant.personaPreset"]').value !== 'custom'; };
        o.panel.addEventListener('input', upd); o.panel.addEventListener('change', upd); upd();
        $('ev-hear').onclick = () => { try { const u = new SpeechSynthesisUtterance(line()); u.lang = /[ぁ-んァ-ヴ一-龠]/.test(line()) ? 'ja-JP' : 'en-US'; u.rate = 1.1; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch { msg('この端末では試聴できません', 'warn'); } };
        btn.onclick = () => run(async () => { if (await saveProfile(readFields(o.panel))) go('services'); });
      }
      if (step === 'services') btn.onclick = () => run(async () => {
        const secrets = {}; for (const el of o.panel.querySelectorAll('[data-key]')) if (el.value.trim()) secrets[el.dataset.key] = el.value.trim();
        if (Object.keys(secrets).length) {
          const r = await api('/api/elvar/config', { method: 'PATCH', body: { secrets } });
          o.panel.querySelectorAll('[data-key]').forEach((el) => { el.value = ''; });
          if (r.status !== 200) return msg(r.body?.message || '保存できませんでした', 'warn');
        }
        go('done');
      });
      if (step === 'done') btn.onclick = () => run(async () => { setSetupStep(''); await loadSession(); o.close(); resolve(); });
    }

    render();
  });
}
