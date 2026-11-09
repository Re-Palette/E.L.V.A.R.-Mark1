// Sign-up wizard (docs/ELVAR_MULTIUSER.md 2.5): shown to a signed-in user who has no Gemini key yet. Gemini key (REQUIRED, checked against Google) -> name / address /
// language / time zone / city -> speaking style + greeting preview (the user's own persona, principle 2) -> optional services -> done. Each step is saved on the
// server as it is completed (the user's own profile and encrypted keys); the step reached is kept on this device (elvar_setup_step, per user), so a reload
// continues where it stopped. Keys are write-only: never shown again, only "設定済み・末尾4桁". Everyone brings their own AI keys: the platform has none.
import { overlay, esc } from '../elvar/ui.js';
import { api, setSetupStep, setupStep, loadSession, logout } from '../elvar/auth.js';
import { validateProfile, DEFAULT_PROFILE } from '../../../shared/profile.js';
import { renderFields, readFields, mergeInto, errorText, browserTimeZone } from '../settings/profile-form.js';
import { greetingLine } from '../live/clap-standby.js';
import { setProfileCache } from '../brand.js';
import { keyStatusText } from './wizard-text.js';
export { keyStatusText };

export const STEPS = ['gemini', 'profile', 'persona', 'services', 'done'];
const TITLES = { gemini: 'Gemini の APIキー', profile: 'あなたについて', persona: '話し方と挨拶', services: 'ほかのサービス（任意）', done: '準備ができました' };

/** Where to start: the saved step (resume), or the Gemini key step (the first thing a new user needs). Pure (tested). */
export function startStep(session, saved) {
  if (saved && STEPS.includes(saved) && saved !== 'done') return saved;
  return 'gemini';
}

export function runWizard({ state, session }) {
  return new Promise((resolve) => {
    const o = overlay({ title: 'E.L.V.A.R. SETUP', sub: 'あなた専用の設定', label: 'セットアップ' });
    o.back.classList.add('ev-setup');
    let step = startStep(session, setupStep());
    let profile = structuredClone(DEFAULT_PROFILE);
    if (!profile.locale.timeZone || profile.locale.timeZone === 'Asia/Tokyo') profile.locale.timeZone = browserTimeZone();

    const bar = () => `<div class="ev-steps">${STEPS.map((s) => `<span class="${s === step ? 'on' : STEPS.indexOf(s) < STEPS.indexOf(step) ? 'done' : ''}"></span>`).join('')}</div>`;
    const $ = (id) => o.panel.querySelector('#' + id);
    const msg = (t, cls = '') => { const m = $('ev-msg'); if (m) { m.textContent = t; m.className = 'ev-msg ' + cls; } };
    const go = (s) => { step = s; setSetupStep(s); render(); };
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
      gemini: (cfg) => `
        <p class="ev-p">E.L.V.A.R. は、あなた自身の <b>Gemini API キー</b>で動きます。<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" style="color:#FFD99A">Google AI Studio</a> で無料で作れます。AIの利用は、あなたのキーの枠で数えられます（運営はAIのキーを持ちません）。</p>
        <div class="ev-row"><span class="l">状態</span><span class="ev-chip ${cfg?.set ? 'ok' : 'off'}" id="ev-kst">${esc(keyStatusText(cfg))}</span></div>
        <label class="ev-field"><span>APIキー${cfg?.set ? '（入れ直すときだけ）' : ''}</span><input class="ev-input" id="ev-key" type="password" autocomplete="off" spellcheck="false" placeholder="AIza..."></label>
        <p class="ev-note">キーはサーバーで暗号化して保存します。保存したあとは画面に表示されません。</p>
        <div class="ev-btns"><button class="ev-btn pri" id="ev-go" type="button">保存して確認</button>${cfg?.set ? '<button class="ev-btn" id="ev-skip" type="button">次へ</button>' : ''}</div>`,
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
        <div class="ev-btns"><button class="ev-btn pri" id="ev-go" type="button">保存して次へ</button><button class="ev-btn" id="ev-skip" type="button">スキップ</button></div>`,
      done: (cfg) => `
        <p class="ev-p">セットアップが終わりました。拍手2回、またはマイクのボタンで話しかけてください。</p>
        <div class="ev-kv"><span>呼び方</span><span>${esc(profile.owner.address)}</span><span>タイムゾーン</span><span>${esc(profile.locale.timeZone)}</span><span>Gemini</span><span class="ev-chip ${cfg?.set ? 'ok' : 'off'}">${esc(keyStatusText(cfg))}</span></div>
        <p class="ev-note">設定は、HUD の歯車のアイコン（Ctrl+,）からいつでも変えられます。Googleとの連携は、準備中です。</p>
        <div class="ev-btns"><button class="ev-btn pri" id="ev-go" type="button">HUD を開く</button></div>`,
    };

    async function render() {
      let cfg = null;
      if (['gemini', 'services', 'done'].includes(step)) { const r = await api('/api/elvar/config'); cfg = r.status === 200 ? r.body.secrets : null; }
      if (['profile', 'persona', 'done'].includes(step)) await loadProfile();
      const view = step === 'gemini' || step === 'done' ? views[step](cfg?.GEMINI_API_KEY) : views[step](cfg);
      o.panel.innerHTML = `${bar()}<h3 class="ev-h3" style="margin-top:14px">${esc(TITLES[step])}</h3>${view}<div class="ev-msg" id="ev-msg" role="status"></div><p class="ev-note" style="text-align:right"><button class="ev-link" id="ev-out" type="button" style="background:none;border:0;color:#b99b6a;text-decoration:underline;cursor:pointer;font:inherit">ログアウト</button></p>`;
      bind();
      setTimeout(() => o.panel.querySelector('input,select')?.focus(), 0);
    }

    function bind() {
      const back = $('ev-back'); if (back) back.onclick = () => go(STEPS[Math.max(0, STEPS.indexOf(step) - 1)]);
      const skip = $('ev-skip'); if (skip) skip.onclick = () => go(STEPS[STEPS.indexOf(step) + 1]);
      const btn = $('ev-go');
      const run = async (fn) => { busy(true); try { await fn(); } catch { msg('サーバーに接続できません', 'warn'); } finally { busy(false); } };
      o.panel.onkeydown = (e) => { if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.id !== 'ev-out' && btn && !btn.disabled) btn.click(); };

      $('ev-out').onclick = () => logout({ erase: false });
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
        else { msg(`保存しました。ただし確認できませんでした：${t.body?.detail || ''}　このまま進むこともできます。`, 'warn'); if (!$('ev-skip')) { const n = document.createElement('button'); n.className = 'ev-btn'; n.id = 'ev-skip'; n.type = 'button'; n.textContent = '次へ'; n.onclick = () => go('profile'); $('ev-go').after(n); } }
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
