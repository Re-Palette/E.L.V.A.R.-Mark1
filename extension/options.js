const $ = (id) => document.getElementById(id);
const idFor = (o) => 'elvar-' + o.replace(/[^a-z0-9]/gi, '_');
const say = (t, ok = true) => { $('msg').textContent = t; $('msg').className = ok ? 'ok' : 'err'; };

async function render() {
  const { origins = [] } = await chrome.storage.local.get('origins');
  $('list').innerHTML = '';
  for (const o of origins) {
    const li = document.createElement('li'); li.textContent = o + ' ';
    const b = document.createElement('button'); b.textContent = '削除';
    b.onclick = async () => {
      await chrome.scripting.unregisterContentScripts({ ids: [idFor(o)] }).catch(() => {});
      await chrome.permissions.remove({ origins: [o + '/*'] }).catch(() => {});
      await chrome.storage.local.set({ origins: origins.filter((x) => x !== o) });
      render();
    };
    li.appendChild(b); $('list').appendChild(li);
  }
  if (!origins.length) $('list').innerHTML = '<li><small>（なし。localhost だけ許可されています）</small></li>';
}

$('add').onclick = async () => {
  let origin;
  try { const u = new URL($('origin').value.trim()); if (!/^https?:$/.test(u.protocol)) throw 0; origin = u.origin; }
  catch { return say('アドレスの形式が正しくありません（https://... で入力）', false); }
  const granted = await chrome.permissions.request({ origins: [origin + '/*'] });   // needs this click
  if (!granted) return say('許可されませんでした', false);
  const id = idFor(origin);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (!existing.length) await chrome.scripting.registerContentScripts([{ id, matches: [origin + '/*'], js: ['content.js'], runAt: 'document_start', persistAcrossSessions: true }]);
  const { origins = [] } = await chrome.storage.local.get('origins');
  if (!origins.includes(origin)) await chrome.storage.local.set({ origins: [...origins, origin] });
  say('追加しました：' + origin); $('origin').value = ''; render();
};
render();
