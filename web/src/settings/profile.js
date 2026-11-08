// Settings > プロフィール / 機能: the owner profile (validated here and again on the server).
import { api } from '../elvar/auth.js';
import { setProfileCache } from '../brand.js';
import { validateProfile } from '../../../shared/profile.js';
import { renderFields, readFields, mergeInto, errorText } from './profile-form.js';

const GROUPS = {
  profile: [
    ['あなた', ['owner.name', 'owner.reading', 'owner.address', 'owner.avoidAddresses']],
    ['地域と言語', ['locale.language', 'locale.timeZone', 'locale.currency', 'home.city', 'home.labelEn']],
    ['アシスタント', ['assistant.spokenName', 'assistant.voice', 'assistant.personaPreset', 'assistant.customPersona', 'greeting.template', 'greeting.honorific']],
    ['ブリーフィングの時間', ['briefing.morning.from', 'briefing.morning.to', 'briefing.evening.from', 'briefing.evening.to']],
  ],
  features: [['使う機能', ['features.finance', 'features.shift', 'features.courses', 'features.build', 'features.humanProtocol', 'features.notifications']]],
};

export function mountProfile(root, which, { onSaved } = {}) {
  let profile = null, writable = false;
  const msg = (t, cls = '') => { const m = root.querySelector('.ev-msg'); m.textContent = t; m.className = 'ev-msg ' + cls; };
  async function refresh() {
    const r = await api('/api/elvar/profile');
    if (r.status !== 200) { root.innerHTML = '<p class="ev-msg warn">読み込めませんでした</p>'; return; }
    ({ profile, writable } = r.body);
    root.innerHTML = (writable ? '' : '<p class="ev-note">環境変数モードでは、プロフィールは ELVAR_PROFILE で変更します。</p>')
      + GROUPS[which].map(([h, paths]) => `<section class="ev-sec"><h3>${h}</h3><div class="${which === 'features' ? '' : 'ev-grid2'}">${renderFields(paths, profile, { disabled: !writable })}</div></section>`).join('')
      + (which === 'features' ? '<p class="ev-note">オフにした機能は、声の会話で案内されず、道具も渡されません。次の会話から反映されます。</p>' : '')
      + `<div class="ev-btns">${writable ? '<button class="ev-btn pri" type="button" data-save>保存</button>' : ''}</div><div class="ev-msg" role="status"></div>`;
  }
  root.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-save]')) return;
    const next = mergeInto(profile, readFields(root)), v = validateProfile(next, profile);
    if (!v.ok) return msg(errorText(v.errors), 'warn');
    const r = await api('/api/elvar/profile', { method: 'PUT', body: { profile: v.profile } });
    if (r.status !== 200) return msg(r.body?.errors ? errorText(r.body.errors) : '保存できませんでした', 'warn');
    profile = r.body.profile; setProfileCache(profile); onSaved?.(profile);
    msg('保存しました。次の会話から反映されます', 'ok');
  });
  return { refresh };
}
