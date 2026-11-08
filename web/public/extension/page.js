// Moved out of index.html so the page works under the site CSP (no inline scripts).
const $ = (id) => document.getElementById(id);
  $('origin').textContent = location.origin;
  $('copy').onclick = async () => { try { await navigator.clipboard.writeText(location.origin); $('copy').textContent = 'コピーしました'; } catch { $('copy').textContent = '手動でコピーしてください'; } };
  const check = () => {
    const ok = document.documentElement.dataset.elvarExtension === '1';
    $('status').innerHTML = ok
      ? '拡張機能：<b class="ok">検出しました ✓</b>　このアドレスで有効です。下の動作テストをお試しください。'
      : '拡張機能：<b class="no">未検出</b>　まだ入れていない、またはこのアドレスを追加していません。下の手順で進めてください。';
  };
  check(); setInterval(check, 1000);
  $('test').onclick = () => {
    let n = 5; $('test').disabled = true;
    const t = setInterval(() => {
      $('countdown').textContent = `${n}…`;
      if (n-- <= 0) { clearInterval(t); $('countdown').textContent = ''; $('test').disabled = false;
        window.postMessage({ source: 'elvar-hud', type: 'bring-to-front' }, location.origin); }
    }, 1000);
  };
