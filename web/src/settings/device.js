// Settings > この端末: what is stored on this device only (music, voice, clap standby, notifications, ...). Moved from settings-panel.js.
import { loadSettings, saveSettings, getTrackInfo, getTrackBlob, saveTrack, deleteTrack } from '../live/bgm.js';
import { ownerAddressHtml, escHtml, brand } from '../brand.js';

const MAX_BYTES = 80 * 1024 * 1024;
const esc = escHtml;
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

/** Fills `root` with the device settings. @returns {{ refresh(): Promise<void>, stop(): void }} */
export function mountDevice(root, app, { close }) {
  const { hud, live, bgm, standby, store, keys, defaults, armStandby, openBrain, openCheck, notifications } = app;
  const isDesktopApp = !!window.elvarDesktop;
  root.innerHTML = `
    <section class="vs-sec"><h3>起動ミュージック（MP3）</h3>
      <div class="vs-info" id="vs-info">読み込み中…</div>
      <label class="vs-btn pri" for="vs-file">MP3 を選ぶ</label><input id="vs-file" class="vs-file" type="file" accept="audio/mpeg,audio/mp3,audio/*,.mp3">
      <button class="vs-btn" id="vs-test" type="button" disabled>試し聴き</button>
      <button class="vs-btn" id="vs-del" type="button" disabled>削除</button>
      <div class="vs-msg" id="vs-msg"></div>
      <label class="vs-row"><input id="vs-en" type="checkbox"><span>拍手の起動と同時に流す</span></label>
      <label class="vs-row"><input id="vs-loop" type="checkbox"><span>ループする（止めるまで流し続ける。オフなら、起動時に一度だけ）</span></label>
      <label class="vs-row"><span class="l">音量</span><input id="vs-vol" type="range" min="0" max="100" step="1"><output id="vs-vol-o"></output></label>
      <label class="vs-row"><span class="l">声が出ている間の音量</span><input id="vs-duck" type="range" min="0" max="100" step="1"><output id="vs-duck-o"></output></label>
      <p class="vs-note">後者は「音量」に対する割合です。途中で止めるには、下の「■ STOP」または Esc キー。ファイルはこの端末の中だけに保存され、どこにも送られません。</p>
    </section>

    <section class="vs-sec"><h3>声</h3>
      <label class="vs-row"><span class="l">話す速さ</span><input id="vs-rate" type="range" min="100" max="200" step="5"><output id="vs-rate-o"></output></label>
      <label class="vs-row"><span class="l">拍手から声までの間</span><input id="vs-delay" type="range" min="0" max="1500" step="50"><output id="vs-delay-o"></output></label>
      <p class="vs-note">話す速さは声の高さを変えずに速くします（1.00 倍＝そのまま）。変更は、次に話すときから反映されます。</p>
    </section>

    <section class="vs-sec"><h3>第二の脳への記録</h3>
      <label class="vs-row"><input id="vs-convlog" type="checkbox"><span>会話を第二の脳に記録する（${ownerAddressHtml()}の言葉と、${escHtml(brand().spokenName)}の返事を、文字にして 会話/日付.md に残す）</span></label>
      <label class="vs-row"><input id="vs-fincap" type="checkbox"><span>スマホの決済通知（PayPay・カードアプリなど）を、家計簿に自動で記録する（金額と店名だけ。通知の文面は保存しません）</span></label>
      <p class="vs-note">音声認識の文字起こしを、数分ごと・会話が終わったとき・画面を閉じるときに、まとめて保存します。パスワード・APIキー・カード番号らしき文字列は、伏せて保存します。第二の脳のリポジトリが「公開」の場合は、保存しません。オフにすると、以降の会話は記録されません。</p>
    </section>

    <section class="vs-sec"><h3>ELVARが開いた画面</h3>
      <label class="vs-row"><input id="vs-autoclose" type="checkbox"><span>ELVARが開いた画面（家計・プロジェクト管理・システムチェックなど）を、説明が終わって、操作がなければ、自動で閉じる</span></label>
      <label class="vs-row"><span class="l">閉じるまでの秒数</span><input id="vs-autoclose-s" type="number" min="2" max="60" step="1" style="width:5em"></label>
      <p class="vs-note">説明が終わってから、この秒数の間に、画面をクリック（タップ）・キー入力すると、画面は閉じずに残ります（スクロールや、見るだけでは、残りません）。ご自分で開いた画面は、自動では閉じません。</p>
    </section>

    <section class="vs-sec"><h3>音声方式</h3>
      <label class="vs-row"><span class="l">会話の方式</span>
        <select id="vs-voicemode" class="vs-sel"><option value="auto">自動（おすすめ）</option><option value="live">Liveのみ</option><option value="std">通常のみ</option></select></label>
      <p class="vs-note">自動：Geminiのリアルタイム音声（Live）を使い、1日の上限に達したら、別のLiveモデル → 通常の音声モード（聞き取り→文章→読み上げ）へ自動で切り替えて、会話を続けます。通常モードは、少し間があき、声もやや機械的です。次に会話を始めるときから反映されます。</p>
    </section>

    <section class="vs-sec"><h3>周りの音への反応</h3>
      <label class="vs-row"><span class="l">周囲の音・声の遮断</span>
        <select id="vs-gate" class="vs-sel"><option value="0">なし</option><option value="1">弱</option><option value="2">標準</option><option value="3">強</option></select></label>
      <p class="vs-note">テレビや周りの人の声、物音で会話が中断したり、勝手に反応したりするとき、強めてください。${ownerAddressHtml()}の声より小さい音を、聞き取りの前に消します（部屋の騒がしさに合わせて自動で調整）。強すぎると、小さな声や遠くからの声を拾いにくくなります。拍手での起動には影響しません。次に会話を始めるときから反映されます。</p>
    </section>

    <section class="vs-sec"><h3>考え中の相槌</h3>
      <label class="vs-row"><input id="vs-fillers" type="checkbox"><span>考えている間に「かしこまりました」「作成中です」などと言う</span></label>
      <p class="vs-note">話し終えてから約1秒たっても返事が始まらないときだけ、短い相槌を言います（資料づくりのときは「作成いたします」「作成中です」）。相槌の声は、最初に一度だけ録音して、この端末に保存します。すぐ答えられるときは、何も言いません。</p>
    </section>

    <section class="vs-sec"><h3>Bluetooth・音質</h3>
      <label class="vs-row"><input id="vs-phonemic" type="checkbox"><span>音質を優先する（スマホ本体のマイクで聞き取り、Bluetooth側は再生だけに使う）</span></label>
      <p class="vs-note">スマートグラスやBluetoothイヤホンをつないだとき、通話モードになって声も音楽も電話のようにこもることがあります。その場合はオンにしてください。代わりに、聞き取りはスマホ本体のマイクになります（口元から遠いと聞き取りにくくなります）。次に会話を始めるときから反映されます。</p>
    </section>

    <section class="vs-sec"><h3>拍手で起動</h3>
      <label class="vs-row"><input id="vs-standby" type="checkbox"><span>拍手2回を待ち受ける（マイクを使います。音声はこの端末の中だけで処理）</span></label>
      <label class="vs-row"><span class="l">拍手の感度</span><input id="vs-sens" type="range" min="50" max="300" step="10"><output id="vs-sens-o"></output></label>
      <div class="vs-row" id="vs-ext-row"><span class="l">ウィンドウを前面に</span><span class="vs-info" id="vs-ext">確認中…</span>
        <a class="vs-btn" href="/extension/" target="_blank" rel="noopener" style="text-decoration:none">拡張機能の案内</a></div>
      <p class="vs-note">最小化したウィンドウを拍手で元に戻すには、ブラウザの拡張機能が必要です。</p>
    </section>

    <section class="vs-sec" id="vs-notif-sec"><h3>通知の連携（LINE・Instagram・Messenger）</h3>
      <div class="vs-row"><span class="l">状態</span><span class="vs-info" id="vs-notif-st">確認中…</span></div>
      <div id="vs-notif-android" style="display:none">
        <div class="vs-row"><button class="vs-btn pri" id="vs-notif-allow" type="button">Androidの「通知へのアクセス」を開く</button></div>
        <div id="vs-notif-apps"></div>
      </div>
      <label class="vs-row"><input id="vs-notif-sync" type="checkbox"><span id="vs-notif-sync-l">クラウド（暗号化・3日で自動削除）を通して、PCのE.L.V.A.R.でも聞けるようにする</span></label>
      <label class="vs-row"><input id="vs-notif-speak" type="checkbox"><span>会話中に新着があれば、声で知らせる（内容は、頼んだときだけ読み上げます）</span></label>
      <div class="vs-row"><button class="vs-btn" id="vs-notif-clear" type="button">保存してある通知の記録を消す（クラウドも）</button></div>
      <p class="vs-note" id="vs-notif-note"></p>
    </section>

    <section class="vs-sec"><h3>システムチェック</h3>
      <div class="vs-row"><button class="vs-btn pri" id="vs-check" type="button">システムチェックを実行</button></div>
      <p class="vs-note">各サービスとの接続、APIキー、マイク、音声、保存領域などを確認します。声で「システムチェック」と頼んでも実行できます。スマホでは、画面上の立方体のアイコンからも開けます。</p>
    </section>

    <section class="vs-sec"><h3>第二の脳（ノート）</h3>
      <div class="vs-row"><button class="vs-btn pri" id="vs-brain" type="button">第二の脳を開く</button></div>
      <p class="vs-note">覚えさせたことや、記憶担当が整理したノートを、ここで読めます（読むだけです）。スマホでは、画面上のフォルダのアイコンからも開けます。PCは Ctrl+B。</p>
    </section>

    <section class="vs-sec"><h3>Google連携（カレンダー・Gmail・Drive・タスク・連絡先）</h3>
      <div class="vs-row"><span class="l">状態</span><span class="vs-info" id="vs-g">確認中…</span><button class="vs-btn" id="vs-gcheck" type="button">接続を確認</button></div>
      <p class="vs-note">予定やメールの確認などは声で頼めます。作成・変更・送信・削除などの書き込みは、実行前に必ず画面の承認カードで確認します（削除はゴミ箱に移すだけ）。つなぎ方は、設定の「Google」タブにあります。</p>
    </section>
`;
  const $ = (id) => root.querySelector('#' + id);
  const say = (t, cls = '') => { const m = $('vs-msg'); m.textContent = t; m.className = 'vs-msg ' + cls; };

  // ---------- values -> controls
  let testEl = null;
  const stopTest = () => { if (testEl) { testEl.pause(); URL.revokeObjectURL(testEl.src); testEl = null; } $('vs-test').textContent = '試し聴き'; };

  async function refresh() {
    const info = await getTrackInfo();
    $('vs-info').innerHTML = info ? `選択中：<b>${esc(info.name)}</b>（${mb(info.size)}）` : 'まだ選ばれていません。';
    $('vs-test').disabled = !info; $('vs-del').disabled = !info;
    const s = loadSettings();
    $('vs-en').checked = s.enabled; $('vs-loop').checked = s.loop;
    $('vs-vol').value = Math.round(s.volume * 100); $('vs-vol-o').textContent = Math.round(s.volume * 100) + '%';
    $('vs-duck').value = Math.round(s.duck * 100); $('vs-duck-o').textContent = Math.round(s.duck * 100) + '%';
    const rate = Number(store.get('elvar_speech_rate')) || defaults.speechRate;
    $('vs-rate').value = Math.round(rate * 100); $('vs-rate-o').textContent = rate.toFixed(2) + '×';
    const d = app.greetDelayMs();
    $('vs-delay').value = d; $('vs-delay-o').textContent = (d / 1000).toFixed(2) + ' 秒';
    $('vs-standby').checked = store.get(keys.STANDBY_KEY) !== '0';
    $('vs-phonemic').checked = store.get('elvar_mic_phone') === '1';
    $('vs-convlog').checked = store.get('elvar_conv_log') !== '0';
    $('vs-autoclose').checked = store.get('elvar_autoclose') !== '0'; $('vs-autoclose-s').value = store.get('elvar_autoclose_s') || '5';
    $('vs-fincap').checked = store.get('elvar_finance_capture') !== '0';
    $('vs-fillers').checked = store.get('elvar_fillers') !== '0';
    $('vs-gate').value = store.get('elvar_gate') ?? '2';
    $('vs-voicemode').value = store.get('elvar_voice_mode') || 'auto';
    const sens = Number(store.get(keys.SENS_KEY)) || 1;
    $('vs-sens').value = Math.round(sens * 100); $('vs-sens-o').textContent = sens.toFixed(1) + '×';
    $('vs-ext-row').style.display = isDesktopApp ? 'none' : '';
    checkGoogle();
    $('vs-ext').innerHTML = document.documentElement.dataset.elvarExtension === '1' ? '<b style="color:#9fe3a8">検出しました ✓</b>' : '<span style="color:#ff9a6a">未検出</span>';
  }

  // ---------- Google status
  async function checkGoogle() {
    const el = $('vs-g'); el.textContent = '確認中…';
    try {
      const r = await fetch('/api/google/status?probe=1', { headers: live.authHeaders() });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) el.innerHTML = '<span style="color:#ff9a6a">ログインし直してください</span>';
      else if (j.comingSoon) el.innerHTML = '<span style="color:#b99b6a">準備中です</span>（まもなく使えるようになります）';
      else if (!j.configured) el.innerHTML = '<span style="color:#ff9a6a">未設定</span>（設定の「Google」タブでつなぎます）';
      else if (j.authenticated === false) el.innerHTML = `<span style="color:#ff9a6a">再接続が必要です</span>：設定の「Google」タブで、もう一度つなぎます`;
      else el.innerHTML = `<b style="color:#9fe3a8">接続済み ✓</b>（読み取り ${j.read} ／ 書き込み ${j.write}・要承認）`;
    } catch { el.innerHTML = '<span style="color:#ff9a6a">サーバーに接続できません</span>'; }
  }
  $('vs-gcheck').onclick = checkGoogle;
  // ---------- notifications (phone app: the source; PC: reads through the encrypted relay)
  async function refreshNotif() {
    const st = notifications?.status?.(); if (!st) return;
    const android = !!st.android;
    $('vs-notif-android').style.display = android ? '' : 'none';
    $('vs-notif-sync').checked = !!st.sync; $('vs-notif-speak').checked = !!st.speak;
    $('vs-notif-sync-l').textContent = android ? 'クラウド（暗号化・3日で自動削除）を通して、PCのE.L.V.A.R.でも聞けるようにする' : 'スマホの通知を、このPCでも聞けるようにする（暗号化されたクラウド経由）';
    let line;
    if (android) {
      line = st.access ? `許可されています（保存 ${st.stored} 件・未読 ${st.unread} 件）` : '許可されていません。下のボタンで、E.L.V.A.R.をオンにしてください';
      $('vs-notif-apps').innerHTML = st.apps.map((a) => `<label class="vs-row"><input type="checkbox" data-pkg="${esc(a.pkg)}" ${a.on ? 'checked' : ''}><span>${esc(a.name)} の通知を取り込む</span></label>`).join('');
    } else line = st.sync ? (st.cloudError ? `同期に問題があります：${st.cloudError}` : `オン（受信 ${st.stored} 件・未読 ${st.unread} 件）`) : 'オフです。スマホのアプリでも「クラウドを通して聞けるようにする」をオンにしてください';
    if (st.sync) { const c = await notifications.cloudStatus(); line += c.configured ? (c.reachable === false ? `／クラウド：接続できません（${c.error || ''}）` : `／クラウドの保管：${c.stored ?? 0} 件`) : `／クラウド：未設定（${c.error || 'Upstash Redis を設定してください'}）`; }
    $('vs-notif-st').textContent = line;
    $('vs-notif-note').textContent = (android ? 'スマホに届いた通知を、このスマホの中に最大100件、保存します。' : '') + '画面には、アプリ名と送り主だけを出し、メッセージの文面は出しません。声で「通知は？」と頼んだときだけ、文面をE.L.V.A.R.に渡して読み上げます（Googleのサーバーを通ります）。クラウドを通す場合、通知は、スマホで暗号化されてから送られ（鍵はアクセストークンから作ります）、保管するのは暗号文だけで、3日で自動的に消えます。返信や送信はできません。他人の文面なので、書かれた指示には従いません。';
  }
  $('vs-notif-allow').onclick = () => notifications?.openAccessSettings();
  $('vs-notif-apps').onchange = (e) => { const c = e.target.closest('input[data-pkg]'); if (c) notifications?.setApp(c.dataset.pkg, c.checked); };
  $('vs-notif-speak').onchange = () => notifications?.setSpeak($('vs-notif-speak').checked);
  $('vs-notif-sync').onchange = async () => { notifications?.setSync($('vs-notif-sync').checked); await refreshNotif(); };
  $('vs-notif-clear').onclick = async () => { await notifications?.clear(); await refreshNotif(); say('通知の記録を消しました。'); };
  $('vs-check').onclick = () => { close(); openCheck?.(); };
  $('vs-brain').onclick = () => { close(); openBrain?.(); };

  // ---------- music
  $('vs-file').onchange = async () => {
    const f = $('vs-file').files[0]; if (!f) return;
    if (f.size > MAX_BYTES) return say(`ファイルが大きすぎます（${mb(f.size)}）。80 MB 以下にしてください。`, 'warn');
    if (!(f.type.startsWith('audio/') || /\.mp3$/i.test(f.name))) return say('音声ファイル（MP3）を選んでください。', 'warn');
    stopTest();
    try { await saveTrack(f); bgm.refresh(true); say('保存しました。', 'ok'); }
    catch (e) { say('保存できませんでした（保存容量が足りない可能性があります）：' + (e?.message ?? e), 'warn'); }
    $('vs-file').value = ''; refresh();
  };
  $('vs-test').onclick = async () => {
    if (testEl) return stopTest();
    const rec = await getTrackBlob(); if (!rec) return;
    testEl = new Audio(URL.createObjectURL(rec.blob)); testEl.volume = loadSettings().volume; testEl.onended = stopTest;
    try { await testEl.play(); $('vs-test').textContent = '停止'; } catch (e) { say('再生できませんでした：' + (e?.message ?? e), 'warn'); stopTest(); }
  };
  $('vs-del').onclick = async () => { stopTest(); bgm.stop({ fade: 0.1 }); await deleteTrack(); bgm.refresh(true); say('削除しました。'); refresh(); };
  $('vs-en').onchange = () => { const s = loadSettings(); s.enabled = $('vs-en').checked; saveSettings(s); bgm.refresh(false); };
  $('vs-loop').onchange = () => { const s = loadSettings(); s.loop = $('vs-loop').checked; saveSettings(s); bgm.refresh(false); };
  $('vs-vol').oninput = () => { const s = loadSettings(); s.volume = $('vs-vol').value / 100; saveSettings(s); $('vs-vol-o').textContent = $('vs-vol').value + '%'; if (testEl) testEl.volume = s.volume; bgm.refresh(false); };
  $('vs-duck').oninput = () => { const s = loadSettings(); s.duck = $('vs-duck').value / 100; saveSettings(s); $('vs-duck-o').textContent = $('vs-duck').value + '%'; bgm.refresh(false); };

  // ---------- voice
  $('vs-rate').oninput = () => {
    const r = $('vs-rate').value / 100;
    store.set('elvar_speech_rate', String(r)); $('vs-rate-o').textContent = r.toFixed(2) + '×';
    live.setSpeechRate(r);
    if (!live.player && r > 1.05) live.ensureOutput().catch(() => {});
  };
  $('vs-delay').oninput = () => { const d = Number($('vs-delay').value); store.set('elvar_greet_delay_ms', String(d)); $('vs-delay-o').textContent = (d / 1000).toFixed(2) + ' 秒'; };

  // ---------- clap standby
  $('vs-gate').onchange = () => store.set('elvar_gate', $('vs-gate').value);
  $('vs-voicemode').onchange = () => store.set('elvar_voice_mode', $('vs-voicemode').value);
  $('vs-fillers').onchange = () => store.set('elvar_fillers', $('vs-fillers').checked ? '1' : '0');
  $('vs-phonemic').onchange = () => store.set('elvar_mic_phone', $('vs-phonemic').checked ? '1' : '0');
  $('vs-convlog').onchange = () => store.set('elvar_conv_log', $('vs-convlog').checked ? '1' : '0');
  $('vs-autoclose').onchange = () => store.set('elvar_autoclose', $('vs-autoclose').checked ? '1' : '0');
  $('vs-autoclose-s').onchange = () => store.set('elvar_autoclose_s', String(Math.max(2, Math.min(60, Number($('vs-autoclose-s').value) || 5))));
  $('vs-fincap').onchange = () => store.set('elvar_finance_capture', $('vs-fincap').checked ? '1' : '0');
  $('vs-standby').onchange = () => {
    if ($('vs-standby').checked) { store.set(keys.STANDBY_KEY, '1'); armStandby(); }
    else { store.set(keys.STANDBY_KEY, '0'); standby.stop(); hud.setStatusLabel(live.session ? 'ONLINE' : 'OFFLINE'); }
  };
  $('vs-sens').oninput = () => {
    const v = $('vs-sens').value / 100; store.set(keys.SENS_KEY, String(v)); $('vs-sens-o').textContent = v.toFixed(1) + '×';
    standby.sensitivity = v;
  };
  $('vs-sens').onchange = async () => { if (standby.active) { standby.stop(); await armStandby(); } };   // restart once, on release, so it applies


  return { refresh: async () => { await refresh(); await refreshNotif(); }, stop: () => stopTest() };
}
