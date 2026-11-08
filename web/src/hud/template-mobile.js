// Phone (portrait) HUD markup. Coordinates are reference pixels of the 852x1846 phone design;
// index.js scales the 852-wide stage uniformly and moves the top / middle / bottom groups
// so they stay pinned to the safe areas (see layoutPhone in index.js).
import { icon, logoTri, wordmarkWide } from './icons.js';
import { hudDefs } from './frames.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f = (n) => +n.toFixed(2);

/** Chamfered rectangle path (all four corners cut by c), stroke-centred on the given box. */
function chamfer(x0, y0, x1, y1, c) {
  return `M${f(x0 + c)},${y0} H${f(x1 - c)} L${x1},${f(y0 + c)} V${f(y1 - c)} L${f(x1 - c)},${y1} H${f(x0 + c)} L${x0},${f(y1 - c)} V${f(y0 + c)} Z`;
}
const mirror = (d) => d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, x, y) => `${f(852 - +x)},${y}`)
  .replace(/H(-?\d+(?:\.\d+)?)/g, (_, x) => `H${f(852 - +x)}`);

// ---------------------------------------------------------------- top bar frame
const TOP_OUTER = 'M30,102 H485 L488.5,105.5 H544.5 L548,102 H822 L837.5,117.5 V169.5 L822,184.5 H593 L590,181.5 H499 L496,184.5 H339 L336,181.5 H271 L268,184.5 H30 L14.5,169.5 V117.5 Z';

// side tabs (left; right is mirrored). Lines run past x=0 so they always leave the screen.
const TAB_OUTER = 'M-600,-65 L0,535 L112.5,647.5 Q118,653 118,661 V1040 L83,1075 V1100 L-600,1783';
const TAB_INNER = 'M-600,-18 L0,582 L27,609 Q30,612 30,616 V1094 L0,1124 L-600,1724';

// bottom chrome (anchored to the viewport bottom)
const BOT_LINE = 'M-600,1120 L0,1740 L75,1817.5 H215 L243,1846 L290,1894';

const INPUT_OUTER = 'M63.5,1619 H790 L812.5,1641.5 V1698.5 L790,1721 H63.5 L40,1698.5 V1642.5 Z';
const INPUT_INNER = 'M97,1621.5 Q88,1621.5 80,1626 L63,1638 Q60,1640 60,1644 V1697 Q60,1700 63,1702 L80,1715 Q88,1720 97,1720 H750 Q760,1720 768,1716 L789,1703 Q792.5,1701 792.5,1697 V1646 Q792.5,1642 789,1640 L766,1626 Q758,1621.5 745,1621.5 Z';

function tab(side, label) {
  return `<div class="vm-tab vm-tab-${side}" data-tab="${label.toLowerCase()}">
    <i class="vm-tab-dot"></i><i class="vm-tab-line"></i>
    <span class="vm-tab-label">${esc(label)}</span>
    <svg class="vm-tab-chev" width="18" height="12" viewBox="0 0 18 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 1.5 6.5 6 2 10.5M9.5 1.5 14 6l-4.5 4.5"/></svg>
  </div>`;
}

// waveform bars of the assistant card: [x, height] in reference px (centre line y = 1510.75)
export const WAVE_BARS = [[620, 9], [628.5, 22], [637, 47], [642.5, 9], [645.5, 15], [653.5, 21]];

export function buildPhoneHud(data, { placeholder }) {
  const agents = data.phoneAgents || [];
  const w = data.weather || {};
  const nav = [['mHome', 'home', 35], ['mFolder', 'folder', 33], ['mCube', 'cube', 34], ['bell', 'bell', 33], ['mUser', 'user', 43]];
  return `
  <div class="vm-bg" aria-hidden="true"></div>
  ${hudDefs()}
  <div class="vm-stage">
    <svg class="vm-botchrome" width="852" height="1846" viewBox="0 0 852 1846" aria-hidden="true">
      <path d="${BOT_LINE}"/><path d="${mirror(BOT_LINE)}"/>
    </svg>

    <!-- ===== middle: sphere, platform, side tabs ===== -->
    <div class="vm-mid">
      <svg class="vm-midfx" width="852" height="1846" viewBox="0 0 852 1846" aria-hidden="true">
        <defs>
          <linearGradient id="vm-vline" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#ecbf73" stop-opacity="0"/><stop offset=".12" stop-color="#ecbf73" stop-opacity=".35"/>
            <stop offset=".75" stop-color="#ecbf73" stop-opacity=".45"/><stop offset="1" stop-color="#ecbf73" stop-opacity="0"/>
          </linearGradient>
          <linearGradient id="vm-hline" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#ecbf73" stop-opacity="0"/><stop offset=".15" stop-color="#ecbf73" stop-opacity=".3"/>
            <stop offset=".85" stop-color="#ecbf73" stop-opacity=".3"/><stop offset="1" stop-color="#ecbf73" stop-opacity="0"/>
          </linearGradient>
          <radialGradient id="vm-pglow" cx=".5" cy=".5" r=".5">
            <stop offset="0" stop-color="#f3d6a5" stop-opacity=".95"/><stop offset=".35" stop-color="#e8b358" stop-opacity=".6"/>
            <stop offset="1" stop-color="#e5aa43" stop-opacity="0"/>
          </radialGradient>
          <linearGradient id="vm-halofade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#ddac57" stop-opacity=".45"/><stop offset=".45" stop-color="#ddac57" stop-opacity=".12"/><stop offset=".7" stop-color="#ddac57" stop-opacity="0"/>
          </linearGradient>
          <radialGradient id="vm-cone" cx=".5" cy=".3" r=".6">
            <stop offset="0" stop-color="#de9b28" stop-opacity=".22"/><stop offset="1" stop-color="#de9b28" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="vm-phalo" cx=".5" cy=".5" r=".5">
            <stop offset=".7" stop-color="#e8b153" stop-opacity="0"/><stop offset=".9" stop-color="#e8b153" stop-opacity=".09"/>
            <stop offset="1" stop-color="#e8b153" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <ellipse cx="426" cy="1330" rx="75" ry="140" fill="url(#vm-cone)"/>
        <g class="vm-grid">${[1300, 1322, 1348, 1378, 1412, 1450].map((y) => `<path d="M0,${y} H852"/>`).join('')}${[-260, -150, -60, 20, 90, 160, 230, 300].map((d) => `<path d="M${426 + d * 0.45},1286 L${426 + d * 1.6},1470"/><path d="M${426 - d * 0.45},1286 L${426 - d * 1.6},1470"/>`).join('')}</g>
        <path class="vm-vline" d="M426,430 V1460"/>
        <path class="vm-hline" d="M126,868 H726"/>
        <path class="vm-tabvl" d="M126,655 V1045"/><path class="vm-tabvl" d="M726,655 V1045"/>
        <ellipse cx="426" cy="1238" rx="330" ry="56" fill="url(#vm-phalo)"/>
        <ellipse class="vm-plat-in" cx="425" cy="1240" rx="190" ry="27"/>
        <path class="vm-plat-seg" d="M182,1244 H272 M598,1249 H668"/>
        <ellipse class="vm-plat-halo" cx="426" cy="1245" rx="300" ry="53" stroke="url(#vm-halofade)"/>
        <ellipse class="vm-plat" cx="425.5" cy="1245" rx="245" ry="41"/>
        <ellipse cx="426" cy="1222" rx="210" ry="27" fill="url(#vm-pglow)" opacity=".28"/>
        <ellipse cx="426" cy="1226" rx="100" ry="15" fill="url(#vm-pglow)"/>
        <ellipse cx="426" cy="1225" rx="48" ry="7" fill="url(#vm-pglow)"/>
        <g class="vm-sparks">${[[426, 1178, 1.3], [426, 1191, 1.5], [426, 1232, 2], [426, 1286, 2], [126, 868, 1.8], [726, 868, 1.8], [426, 550, 2.2]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('')}</g>
        <g class="vm-tabframe">
          <path class="vm-tab-o" d="${TAB_OUTER}"/><path class="vm-tab-o" d="${mirror(TAB_OUTER)}"/>
          <path class="vm-tab-i vm-tab-i-l" d="${TAB_INNER}"/><path class="vm-tab-i vm-tab-i-r" d="${mirror(TAB_INNER)}"/>
        </g>
      </svg>
      <div class="vm-core"><canvas class="vh-sphere vm-sphere" aria-label="ELVAR core"></canvas></div>
      ${tab('l', 'LISTEN')}
      ${tab('r', 'THINK')}
    </div>

    <!-- ===== top: bar, date, agents ===== -->
    <div class="vm-top">
      <svg class="vm-topfx" width="852" height="420" viewBox="0 0 852 420" aria-hidden="true">
        <defs>
          <linearGradient id="vm-navglow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#d59f43" stop-opacity="0"/><stop offset=".5" stop-color="#d9a448" stop-opacity=".14"/><stop offset="1" stop-color="#dfa94b" stop-opacity=".6"/>
          </linearGradient>
          <radialGradient id="vm-spot" cx=".5" cy=".5" r=".5">
            <stop offset="0" stop-color="#eec784" stop-opacity=".7"/><stop offset="1" stop-color="#eec784" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <path class="vm-fill" d="${TOP_OUTER}"/>
        <rect x="510" y="136" width="66" height="37" fill="url(#vm-navglow)"/>
        <path class="vm-line" d="${TOP_OUTER}"/>
        <path class="vm-line-hi" d="M548,102 H598 M296,102 H322 M800,102 H822"/>
        <ellipse cx="426" cy="98" rx="60" ry="5" fill="url(#vm-spot)"/>
        <ellipse cx="410" cy="190" rx="60" ry="3" fill="url(#vm-spot)"/>
        <path class="vm-card-fill" d="${chamfer(475.5, 238, 831.5, 400.5, 15.5)}"/>
        <path class="vm-line" d="${chamfer(475.5, 238, 831.5, 400.5, 15.5)}"/>
      </svg>
      <div class="vm-brand">${logoTri()}<span class="vm-wm" role="img" aria-label="ELVAR">${wordmarkWide()}</span></div>
      <i class="vm-vdiv vm-vdiv-1"></i>
      <div class="vm-tagline"><span>An Intelligence</span><span>Beyond Assistance</span></div>
      <nav class="vm-nav">${nav.map(([ic, n, sz], i) => `<button class="vm-navbtn vm-nav-${n} ${i === 0 ? 'is-active' : ''}" type="button" aria-label="${n === 'user' ? '設定' : n}"${n === 'user' ? ' data-vh-settings' : ` data-vh-nav="${n}"`}>${icon(ic, { size: sz, stroke: ic === 'mUser' ? 1.45 : 1.7 })}</button>`).join('')}</nav>

      <div class="vm-date">
        <span class="vm-wd">FRI</span><span class="vm-day">06</span><i class="vm-vdiv vm-vdiv-2"></i>
        <span class="vm-mo">Nov 2026</span><i class="vm-date-ul"></i>
      </div>

      <section class="vm-agents" aria-label="Active agents">
        <i class="vm-ag-spot"></i>
        <h2 class="vm-ag-title">ACTIVE AGENTS</h2>
        <span class="vm-ag-chev">${icon('mChevron', { size: 17, stroke: 1.7 })}</span>
        ${agents.map((a, i) => `<button class="vm-agent" type="button" tabindex="-1" aria-label="${esc(a.label || a.icon)}" style="left:${f(501.5 + i * 64)}px">${icon(a.icon, { size: 27, stroke: 1.75 })}</button><i class="vm-agdot" style="left:${f(522.3 + i * 64)}px"></i>`).join('')}
      </section>
    </div>

    <!-- ===== bottom: cards + input ===== -->
    <div class="vm-bottom">
      <svg class="vm-botfx" width="852" height="1846" viewBox="0 0 852 1846" aria-hidden="true">
        <defs>
          <linearGradient id="vm-inhi" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#f3d6a5" stop-opacity="0"/><stop offset=".3" stop-color="#f3d6a5" stop-opacity=".75"/>
            <stop offset=".6" stop-color="#f3d6a5" stop-opacity=".75"/><stop offset="1" stop-color="#f3d6a5" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path class="vm-card-fill" d="${chamfer(35.5, 1459, 286, 1566, 15.5)}"/>
        <path class="vm-card-fill" d="${chamfer(583, 1459, 816, 1566, 15.5)}"/>
        <path class="vm-line" d="${chamfer(35.5, 1459, 286, 1566, 15.5)}"/>
        <path class="vm-line" d="${chamfer(583, 1459, 816, 1566, 15.5)}"/>
        <path class="vm-in-fill vm-inframe" d="${INPUT_OUTER}"/>
        <path class="vm-in-inner vm-inframe" d="${INPUT_INNER}"/>
        <path class="vm-line vm-inframe" d="${INPUT_OUTER}"/>
        <path class="vm-inframe" d="M220,1619 H700" stroke="url(#vm-inhi)" stroke-width="1.6"/>
      </svg>

      <div class="vm-weather">
        <svg class="vm-sun" width="46" height="46" viewBox="0 0 46 46" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <circle cx="23" cy="23" r="9.6"/>
          <path d="M23 2.5v5.6M23 37.9v5.6M2.5 23h5.6M37.9 23h5.6M8.5 8.5l3.8 3.8M33.7 33.7l3.8 3.8M8.5 37.5l3.8-3.8M33.7 12.3l3.8-3.8"/>
        </svg>
        <span class="vm-city">${esc(w.city || '')}</span>
        <span class="vm-temp">${esc(w.temp || '')}</span><span class="vm-cond">${esc(w.condition || '')}</span>
      </div>

      <div class="vm-assist">
        <svg class="vm-wave" width="60" height="56" viewBox="608 1483 60 56" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M612,1510.75 H617 M660,1510.75 H665"/>
          ${WAVE_BARS.map(([x, h]) => `<path class="vm-wbar vm-wglow" d="M${x},${f(1510.75 - h / 2)} V${f(1510.75 + h / 2)}"/>`).join('')}
          ${WAVE_BARS.map(([x, h]) => `<path class="vm-wbar" d="M${x},${f(1510.75 - h / 2)} V${f(1510.75 + h / 2)}"/>`).join('')}
        </svg>
        <span class="vm-name">${esc(data.agentName || '')}</span>
        <i class="vm-sdot"></i><span class="vm-status">ONLINE</span>
      </div>

      <form class="vm-input" autocomplete="off">
        <button class="vm-mic" type="button" aria-label="マイク" aria-pressed="false">${icon('mMic', { size: 40, stroke: 1.55 })}</button>
        <div class="vm-field">
          <input class="vm-text" type="text" enterkeyhint="send" aria-label="メッセージ" placeholder="${esc(placeholder)}">
          <div class="vm-transcript" aria-live="polite"></div>
        </div>
        <button class="vm-send" type="submit" aria-label="送信">${icon('mSend', { size: 40, stroke: 1.7 })}</button>
      </form>
    </div>
  </div>`;
}
