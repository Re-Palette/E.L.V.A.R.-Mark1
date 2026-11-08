// Moved out of index.html so the page works under the site CSP (no inline scripts).
// Must match web/src/live/bgm.js
  const DB = 'elvar-bgm', STORE = 'bgm', KEY = 'track', SETTINGS_KEY = 'elvar_bgm', REV_KEY = 'elvar_bgm_rev';
  const DEFAULTS = { enabled: true, volume: 0.8, duck: 0.3, loop: false };
  const MAX_BYTES = 80 * 1024 * 1024;
  const $ = (id) => document.getElementById(id);
  const load = () => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...DEFAULTS }; } };
  const save = (s) => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {} };
  const say = (t, cls = '') => { $('msg').textContent = t; $('msg').className = 'note ' + cls; };
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

  const open = () => new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const get = async () => { const db = await open(); return new Promise((res) => { const q = db.transaction(STORE).objectStore(STORE).get(KEY); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); };
  const put = async (rec) => { const db = await open(); return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(rec, KEY); tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); };
  const del = async () => { const db = await open(); return new Promise((res) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(KEY); tx.oncomplete = res; tx.onerror = res; }); };
  const bump = () => { try { localStorage.setItem(REV_KEY, String(Date.now())); } catch {} };

  let testEl = null;
  function stopTest() { if (testEl) { testEl.pause(); URL.revokeObjectURL(testEl.src); testEl = null; } $('test').textContent = '試し聴き'; }

  async function refresh() {
    const rec = await get();
    $('info').innerHTML = rec ? `選択中：<b class="ok">${rec.name.replace(/[<>&]/g, '')}</b>（${mb(rec.blob.size)}）` : 'まだ選ばれていません。';
    $('test').disabled = !rec; $('del').disabled = !rec;
    const s = load();
    $('enabled').checked = s.enabled; $('loop').checked = s.loop;
    $('volume').value = Math.round(s.volume * 100); $('volumeOut').textContent = Math.round(s.volume * 100) + '%';
    $('duck').value = Math.round(s.duck * 100); $('duckOut').textContent = Math.round(s.duck * 100) + '%';
  }

  $('file').onchange = async () => {
    const f = $('file').files[0]; if (!f) return;
    if (f.size > MAX_BYTES) { say(`ファイルが大きすぎます（${mb(f.size)}）。80 MB 以下にしてください。`, 'warn'); return; }
    if (!(f.type.startsWith('audio/') || /\.mp3$/i.test(f.name))) { say('音声ファイル（MP3）を選んでください。', 'warn'); return; }
    stopTest();
    try { await put({ name: f.name, type: f.type || 'audio/mpeg', blob: f, savedAt: Date.now() }); bump(); say('保存しました。', 'ok'); }
    catch (e) { say('保存できませんでした（端末の保存容量が足りない可能性があります）：' + (e && e.message || e), 'warn'); }
    $('file').value = ''; refresh();
  };
  $('test').onclick = async () => {
    if (testEl) { stopTest(); return; }
    const rec = await get(); if (!rec) return;
    testEl = new Audio(URL.createObjectURL(rec.blob)); testEl.volume = load().volume;
    testEl.onended = stopTest;
    try { await testEl.play(); $('test').textContent = '停止'; } catch (e) { say('再生できませんでした：' + (e && e.message || e), 'warn'); stopTest(); }
  };
  $('del').onclick = async () => { stopTest(); await del(); bump(); say('削除しました。'); refresh(); };
  $('loop').onchange = () => { const s = load(); s.loop = $('loop').checked; save(s); };
  $('enabled').onchange = () => { const s = load(); s.enabled = $('enabled').checked; save(s); };
  $('volume').oninput = () => { const s = load(); s.volume = $('volume').value / 100; save(s); $('volumeOut').textContent = $('volume').value + '%'; if (testEl) testEl.volume = s.volume; };
  $('duck').oninput = () => { const s = load(); s.duck = $('duck').value / 100; save(s); $('duckOut').textContent = $('duck').value + '%'; };
  refresh();
