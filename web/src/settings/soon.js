// A settings tab for a feature that is not on the platform yet (Google, connected apps: docs/ELVAR_MULTIUSER.md P3). One clear message, nothing else.
import { esc } from '../elvar/ui.js';

export function mountSoon(root, { title, lines = [] }) {
  return {
    refresh() {
      root.innerHTML = `<section class="ev-sec"><h3>${esc(title)}</h3>
        <div class="ev-note" style="border:1px solid rgba(232,185,106,.35);background:rgba(232,185,106,.06);padding:12px 14px;color:#e9dcc4;font-size:14.5px"><b style="color:#FFD99A">準備中です。</b>まもなく使えるようになります。</div>
        ${lines.map((l) => `<p class="ev-p" style="font-size:14px">${esc(l)}</p>`).join('')}</section>`;
    },
  };
}
