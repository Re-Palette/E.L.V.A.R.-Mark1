// Chamfered (cut-corner) glowing frames, drawn as inline SVG.
// Coordinates are in design-stage pixels (stage = 1671 x 941, measured from the reference image).

export const STAGE_W = 1671;
export const STAGE_H = 941;

/** Polygon points for a rectangle with all four corners cut by `c`. */
function chamferPts(w, h, c, inset = 0.75) {
  const a = inset, r = w - inset, b = h - inset;
  return [
    [a + c, a], [r - c, a], [r, a + c], [r, b - c], [r - c, b], [a + c, b], [a, b - c], [a, a + c],
  ].map((p) => p.join(',')).join(' ');
}

/**
 * Shared paint servers (gold metal edge, dark glass fill, warm under-glow). Inserted once per layout,
 * outside the stage; every frame references them by id.
 */
export function hudDefs(prefix = 'vh') {
  return `<svg class="${prefix}-defs" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true" focusable="false"><defs>
    <linearGradient id="${prefix}-g-edge" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff4dc"/><stop offset=".14" stop-color="#e6c894"/><stop offset=".4" stop-color="#7d6038"/>
      <stop offset=".6" stop-color="#b08850"/><stop offset=".85" stop-color="#efd3a0"/><stop offset="1" stop-color="#fff0d0"/>
    </linearGradient>
    <linearGradient id="${prefix}-g-fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1d1710" stop-opacity=".9"/><stop offset=".28" stop-color="#0b0907" stop-opacity=".9"/>
      <stop offset=".8" stop-color="#090705" stop-opacity=".92"/><stop offset="1" stop-color="#1a130b" stop-opacity=".94"/>
    </linearGradient>
    <linearGradient id="${prefix}-g-sheen" x1="0" y1="0" x2=".9" y2=".75">
      <stop offset="0" stop-color="#ffe2b0" stop-opacity=".13"/><stop offset=".22" stop-color="#ffe2b0" stop-opacity=".03"/>
      <stop offset=".5" stop-color="#ffe2b0" stop-opacity="0"/><stop offset=".8" stop-color="#ffcf8a" stop-opacity=".02"/><stop offset="1" stop-color="#ffcf8a" stop-opacity=".07"/>
    </linearGradient>
    <radialGradient id="${prefix}-g-under" cx=".15" cy="1" r="1.05">
      <stop offset="0" stop-color="#e0a050" stop-opacity=".2"/><stop offset=".45" stop-color="#e0a050" stop-opacity=".05"/><stop offset="1" stop-color="#e0a050" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${prefix}-g-input" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#211a11" stop-opacity=".95"/><stop offset=".5" stop-color="#0a0806" stop-opacity=".95"/><stop offset="1" stop-color="#17110a" stop-opacity=".95"/>
    </linearGradient>
  </defs></svg>`;
}

/** Full-size SVG frame for a panel of size w x h: dark glass, inner bevel line, gold metal edge, glowing highlights. */
export function panelFrame(w, h, c = 11) {
  const b = h - 0.75, r = w - 0.75, f = (n) => +n.toFixed(2);
  // bright edge segments: top-left chamfer run, and the lit lower edge / lower-right corner
  const hi = `M0.75,${f(Math.min(h * 0.32, c + 46))} V${c + 0.75} L${c + 0.75},0.75 H${f(w * 0.36)}`
    + ` M${f(w * 0.08)},${f(b)} H${f(r - c)} L${f(r)},${f(b - c)} V${f(b - Math.min(h * 0.3, 70))}`
    + ` M${f(r)},${f(h * 0.12)} V${c + 0.75} L${f(r - c)},0.75 H${f(w * 0.78)}`;
  return `<svg class="vh-frame" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <polygon class="vh-frame-fill" points="${chamferPts(w, h, c, 2)}"/>
    <polygon class="vh-frame-under" points="${chamferPts(w, h, c, 2)}"/>
    <polygon class="vh-frame-sheen" points="${chamferPts(w, h, c, 2)}"/>
    <polygon class="vh-frame-bevel" points="${chamferPts(w, h, c - 1.5, 4.5)}"/>
    <polygon class="vh-frame-rim" points="${chamferPts(w, h, c)}"/>
    <polygon class="vh-frame-line" points="${chamferPts(w, h, c)}"/>
    <path class="vh-frame-hi" d="${hi}"/>
  </svg>`;
}

/** Input bar frame: chamfered pill with a bevel line and a raised ridge along the top edge (as in the reference). */
export function inputFrame(w, h) {
  const c = 14, f = (n) => +n.toFixed(2);
  const ridge = `M${f(w * 0.17)},4.5 L${f(w * 0.17 + 6)},0.75 H${f(w * 0.83 - 6)} L${f(w * 0.83)},4.5`;
  const hi = `M${f(w * 0.3)},${h - 0.75} H${f(w * 0.7)} M${w - 0.75},${c + 4} V${f(h - c - 4)} M0.75,${c + 4} V${f(h - c - 4)}`;
  return `<svg class="vh-frame" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <polygon class="vh-frame-fill vh-input-fill" points="${chamferPts(w, h, c, 2)}"/>
    <polygon class="vh-frame-sheen" points="${chamferPts(w, h, c, 2)}"/>
    <polygon class="vh-frame-bevel" points="${chamferPts(w, h, c - 1.5, 4.5)}"/>
    <polygon class="vh-frame-line" points="${chamferPts(w, h, c)}"/>
    <path class="vh-frame-ridge" d="${ridge}"/>
    <path class="vh-frame-hi" d="${hi}"/>
  </svg>`;
}

/**
 * Light streaks, floor line and flares around the core (decorative, behind the panels).
 * Stage coordinates; the whole layer is centre-anchored like the core.
 */
export function fxSvg() {
  const cx = 835, cy = 445;
  // faint rays from the core towards the frame
  const rays = [[-160, 330, 690], [-147, 340, 610], [-28, 330, 640], [-14, 360, 700], [152, 330, 620], [165, 360, 660], [20, 340, 640]];
  const f = (n) => +n.toFixed(1);
  const rayEls = rays.map(([deg, r0, r1], i) => {
    const a = (deg * Math.PI) / 180, x0 = cx + r0 * Math.cos(a), y0 = cy + r0 * Math.sin(a), x1 = cx + r1 * Math.cos(a), y1 = cy + r1 * Math.sin(a);
    return `<linearGradient id="vh-ray-${i}" gradientUnits="userSpaceOnUse" x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}">
      <stop offset="0" stop-color="#ffd99a" stop-opacity=".0"/><stop offset=".25" stop-color="#ffd99a" stop-opacity=".32"/><stop offset="1" stop-color="#ffd99a" stop-opacity="0"/></linearGradient>
      <path d="M${f(x0)},${f(y0)} L${f(x1)},${f(y1)}" stroke="url(#vh-ray-${i})"/>`;
  }).join('');
  return `<svg class="vh-fx" width="1671" height="941" viewBox="0 0 1671 941" aria-hidden="true">
    <defs>
      <linearGradient id="vh-floor" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#e8b96a" stop-opacity="0"/><stop offset=".2" stop-color="#e8b96a" stop-opacity=".35"/>
        <stop offset=".5" stop-color="#ffe2ae" stop-opacity=".9"/><stop offset=".8" stop-color="#e8b96a" stop-opacity=".35"/><stop offset="1" stop-color="#e8b96a" stop-opacity="0"/>
      </linearGradient>
      <radialGradient id="vh-flare"><stop offset="0" stop-color="#fff4dc"/><stop offset=".18" stop-color="#ffd99a" stop-opacity=".75"/><stop offset="1" stop-color="#e8a040" stop-opacity="0"/></radialGradient>
      <radialGradient id="vh-pool" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#e8a850" stop-opacity=".12"/><stop offset="1" stop-color="#e8a850" stop-opacity="0"/></radialGradient>
    </defs>
    <g class="vh-rays">${rayEls}</g>
    <ellipse cx="${cx}" cy="786" rx="520" ry="40" fill="url(#vh-pool)"/>
    <path class="vh-floor" d="M330,785 H1340" stroke="url(#vh-floor)"/>
    <path class="vh-floor-2" d="M420,800 L260,850 M1250,800 L1410,850 M560,800 L520,850 M1110,800 L1150,850" />
    <ellipse cx="${cx}" cy="785" rx="70" ry="5" fill="url(#vh-flare)"/>
    <ellipse cx="${cx}" cy="785" rx="16" ry="2.4" fill="#fff6e2"/>
    <ellipse cx="505" cy="786" rx="26" ry="2.5" fill="url(#vh-flare)" opacity=".7"/>
    <ellipse cx="1165" cy="786" rx="26" ry="2.5" fill="url(#vh-flare)" opacity=".7"/>
  </svg>`;
}

/**
 * Global decorative "chrome" lines: top-bar outline, outer frame, bottom rails.
 * Polylines traced from the reference image.
 */
// Elastic chrome: every vertex is [x, y, gx, gy]. On a display wider/taller than the 1671x941 design
// stage, a vertex moves by (dx*gx, dy*gy): gx/gy = 0 stays left/top, 0.5 centred, 1 right/bottom.
// Elements get the same factors via --fx/--fy in hud.css, so frames and content stay joined.
const CHROME = [
  // top bar outline
  [[20, 93, 0, 0], [20, 35, 0, 0], [33, 22, 0, 0], [585, 22, 0, 0], [600, 37, 0, 0], [1070, 37, 1, 0], [1086, 21, 1, 0], [1636, 21, 1, 0], [1648, 33, 1, 0], [1648, 94, 1, 0]],
  // top bar lower edge, left segment (ends at the nav underline gap)
  [[20, 93, 0, 0], [33, 81, 0, 0], [655, 81, 0.5, 0]],
  // lower edge under nav (right of the active underline)
  [[714, 81, 0.5, 0], [1012, 81, 0.5, 0]],
  [[1022, 78, 0.5, 0], [1154, 78, 1, 0], [1154, 30, 1, 0]],
  // lower edge under the clock / icons
  [[1161, 82, 1, 0], [1635, 82, 1, 0], [1648, 94, 1, 0]],
  // outer left frame + bottom-left rail rising into the input bar
  [[20, 121, 0, 0], [20, 887, 0, 1], [38, 905, 0, 1], [596, 905, 0.5, 1], [616, 885, 0.5, 1]],
  // bottom-middle rail + bottom-right step
  [[1055, 885, 0.5, 1], [1076, 905, 0.5, 1], [1378, 905, 1, 1], [1396, 886, 1, 1], [1648, 886, 1, 1], [1648, 869, 1, 1]],
  // right outer frame
  [[1648, 107, 1, 0], [1648, 840, 1, 1]],
];

export function chromeSvg(dx = 0, dy = 0) {
  const w = STAGE_W + dx, h = STAGE_H + dy;
  const f = (n) => +n.toFixed(2);
  const paths = CHROME.map((pts) =>
    `<path d="${pts.map(([x, y, gx, gy], i) => `${i ? 'L' : 'M'}${f(x + dx * gx)},${f(y + dy * gy)}`).join(' ')}"/>`).join('');
  const X = (x) => f(x + dx);
  // dark metal plate behind the top bar
  const bar = `M20,93 L20,35 L33,22 L585,22 L600,37 L${X(1070)},37 L${X(1086)},21 L${X(1636)},21 L${X(1648)},33 L${X(1648)},94 L${X(1635)},82 L33,82 Z`;
  return `<svg class="vh-chrome" width="${f(w)}" height="${f(h)}" viewBox="0 0 ${f(w)} ${f(h)}" aria-hidden="true">
    <defs>
      <linearGradient id="vh-bar-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1c160e" stop-opacity=".96"/><stop offset=".45" stop-color="#070605" stop-opacity=".96"/><stop offset="1" stop-color="#120d08" stop-opacity=".96"/>
      </linearGradient>
    </defs>
    <path class="vh-chrome-bar" d="${bar}" fill="url(#vh-bar-fill)"/>
    <g class="vh-chrome-band">${paths}</g>
    <g class="vh-chrome-band2">${paths}</g>
    <g class="vh-chrome-lines">${paths}</g>
    <path class="vh-chrome-dim" d="M114,${f(887 + dy)} L317,${f(887 + dy)}"/>
  </svg>`;
}

/** Small ring gauge SVG. arcs: [[startDeg,endDeg],...] clockwise from 12 o'clock. */
export function ringGauge(size, r, arcs, { width = 3.2, base = true, outer = true } = {}) {
  const cx = size / 2, cy = size / 2;
  const pt = (deg, rad) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  };
  const arcPath = ([s, e]) => {
    let span = e - s;
    if (span <= 0) span += 360;
    const [x1, y1] = pt(s, r);
    const [x2, y2] = pt(s + span, r);
    return `<path class="vh-gauge-arc" d="M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${span > 180 ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)}" stroke-width="${width}"/>`;
  };
  return `<svg class="vh-gauge" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    ${outer ? `<circle class="vh-gauge-outer" cx="${cx}" cy="${cy}" r="${r + width / 2 + 3}"/>` : ''}
    ${base ? `<circle class="vh-gauge-base" cx="${cx}" cy="${cy}" r="${r}" stroke-width="${width}"/>` : ''}
    <circle class="vh-gauge-inner" cx="${cx}" cy="${cy}" r="${r - width / 2 - 1.5}"/>
    ${arcs.map(arcPath).join('')}
  </svg>`;
}

/** Tiny waveform sparkline like the ACTIVE AGENTS rows. seed varies the shape. */
export function sparkline(seed = 0, w = 38, h = 18) {
  const base = [[0, .92], [.1, .6], [.18, .88], [.3, .2], [.4, .86], [.52, .3], [.62, .86], [.74, .15], [.86, .9], [.93, .6], [1, .92]];
  let rnd = (seed + 1) * 7919;
  const rand = () => ((rnd = (rnd * 9301 + 49297) % 233280) / 233280);
  const d = base.map(([x, y], i) => {
    const yy = i === 0 || i === base.length - 1 ? y : Math.min(.92, Math.max(.08, y + (rand() - .5) * .3));
    return `${i ? 'L' : 'M'}${(x * w).toFixed(1)},${(yy * h).toFixed(1)}`;
  }).join(' ');
  return `<svg class="vh-spark" width="${w}" height="${h + 2}" viewBox="0 0 ${w} ${h + 2}" aria-hidden="true">
    <path d="${d}"/><path class="vh-spark-base" d="M2,${h + 1} H${w - 2}"/>
  </svg>`;
}
