// Inline SVG line icons (no icon font / CDN). All use currentColor.
// Each value is the inner markup for a 24x24 viewBox, stroke-based.

const P = {
  home: '<path d="M3.5 11.2 12 4l8.5 7.2"/><path d="M5.8 9.4V20h4.4v-5.6h3.6V20h4.4V9.4"/>',
  folder: '<path d="M3 6.5h6.2l1.8 2H21V19H3z"/><path d="M3 9.6h18"/>',
  cube: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
  sparkle: '<path d="M12 2.8c.9 5 3.3 8.1 8.2 9.2-4.9 1.1-7.3 4.2-8.2 9.2-.9-5-3.3-8.1-8.2-9.2 4.9-1.1 7.3-4.2 8.2-9.2z"/>',
  bell: '<path d="M6 16.4V11a6 6 0 0 1 12 0v5.4l1.7 2.1H4.3z"/><path d="M10 20.8a2.2 2.2 0 0 0 4 0"/>',
  sun: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M5.6 18.4l1.7-1.7M16.7 7.3l1.7-1.7"/>',
  wifi: '<path d="M2.5 9.2a14 14 0 0 1 19 0"/><path d="M5.6 12.6a9.4 9.4 0 0 1 12.8 0"/><path d="M8.7 15.9a4.8 4.8 0 0 1 6.6 0"/><circle cx="12" cy="19.3" r="1" fill="currentColor" stroke="none"/>',
  volume: '<path d="M3.5 9.3h3.6L12 5v14l-4.9-4.3H3.5z"/><path d="M15.4 9a4.3 4.3 0 0 1 0 6"/><path d="M18 6.4a8 8 0 0 1 0 11.2"/>',
  user: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="9.6" r="3.6"/><path d="M5.6 19.4c1.3-3 3.7-4.6 6.4-4.6s5.1 1.6 6.4 4.6"/>',
  settings: '<path d="M10.3 2.8h3.4l.5 2.6 1.6.9 2.5-.9 1.7 3-2 1.7v1.8l2 1.7-1.7 3-2.5-.9-1.6.9-.5 2.6h-3.4l-.5-2.6-1.6-.9-2.5.9-1.7-3 2-1.7v-1.8l-2-1.7 1.7-3 2.5.9 1.6-.9z"/><circle cx="12" cy="12" r="3.1"/>',
  chevron: '<path d="M9 5.5 15.5 12 9 18.5"/>',
  clipboard: '<rect x="5" y="5" width="14" height="16" rx="1"/><path d="M8.5 3v4M15.5 3v4M8.5 10.5h7M8.5 13.5h7M8.5 16.5h3M13 16.5h2.5"/>',
  calendar: '<rect x="4.5" y="5" width="15" height="16" rx="1"/><path d="M8.5 3v4M15.5 3v4M8 10.5h8M8 13.5h8M8 16.5h3.5M13 16.5h3"/>',
  nodes: '<circle cx="12" cy="7" r="2.6"/><circle cx="6" cy="17" r="2.6"/><circle cx="18" cy="17" r="2.6"/><path d="M10.7 9.2 7.3 14.8M13.3 9.2l3.4 5.6M8.6 17h6.8"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="1"/><path d="m3.5 6.5 8.5 6.8 8.5-6.8M3.5 17.5l6.3-5.8M20.5 17.5l-6.3-5.8"/>',
  mailFilled: '<rect x="3" y="5.5" width="18" height="13" rx="1" fill="currentColor" fill-opacity=".9"/><path d="m3.5 6.5 8.5 6.8 8.5-6.8M3.5 17.5l6.3-5.8M20.5 17.5l-6.3-5.8" stroke="#0a0806"/>',
  homeAgent: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 9.6V20h4.6v-5.8h3.8V20h4.6V9.6"/>',
  shield: '<path d="M12 3 19.5 6v5.6c0 4.6-3.2 8-7.5 9.4-4.3-1.4-7.5-4.8-7.5-9.4V6z"/><path d="M12 8.5v6M9.4 12.2 12 14.6l2.6-2.4"/>',
  doc: '<path d="M6 3h8.5L19 7.5V21H6z"/><path d="M14.3 3v4.6H19M9 11h7M9 14h7M9 17h5"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.6"/><path d="m8 12.3 2.8 2.8L16.4 9"/>',
  gear: '<path d="M10.3 2.8h3.4l.5 2.6 1.6.9 2.5-.9 1.7 3-2 1.7v1.8l2 1.7-1.7 3-2.5-.9-1.6.9-.5 2.6h-3.4l-.5-2.6-1.6-.9-2.5.9-1.7-3 2-1.7v-1.8l-2-1.7 1.7-3 2.5.9 1.6-.9z"/><circle cx="12" cy="12" r="3.1"/>',
  check: '<circle cx="12" cy="12.4" r="6"/><path d="m8.8 12.2 2.5 2.5 7.4-8.2M4 19.6l1.6-1.6"/>',
  ring: '<circle cx="12" cy="12" r="5.8"/>',
  mic: '<rect x="9" y="3" width="6" height="11.5" rx="3"/><path d="M5.8 11.2a6.2 6.2 0 0 0 12.4 0M12 17.4V21"/>',
  send: '<path d="M21 3 10.2 13.8M21 3l-6.6 18-4.2-7.2L3 9.6z"/>',
  // ---- phone layout ----
  mHome: '<path d="M3 11.6 12 3.8l9 7.8"/><path d="M5.6 9.6V20.2h4.7v-6h3.4v6h4.7V9.6"/>',
  mFolder: '<path d="M2.6 4.8h6.8l2 2.4h10v12.4H2.6z"/>',
  mCube: '<path d="M12 2.8 20.2 7.4v9.2L12 21.2l-8.2-4.6V7.4z"/><path d="M3.8 7.4 12 12l8.2-4.6M12 12v9.2"/>',
  mUser: '<circle cx="12" cy="12" r="10.3"/><circle cx="12" cy="9.3" r="3.7"/><path d="M5.1 19.4c1.5-3.1 4-4.7 6.9-4.7s5.4 1.6 6.9 4.7"/>',
  mSearch: '<circle cx="10.5" cy="10.5" r="6.3"/><path d="m15.2 15.2 5 5"/><circle cx="10.5" cy="10.5" r="1.3" fill="currentColor" stroke="none"/>',
  mCode: '<path d="M8 7.2 3.2 12 8 16.8M16 7.2l4.8 4.8L16 16.8M13.6 5.4l-3.2 13.2"/>',
  mMail: '<rect x="3" y="5.6" width="18" height="12.8" rx=".6"/><path d="m3.4 6.2 8.6 7 8.6-7"/>',
  mShield: '<path d="M12 2.9 19.4 5.8v5.6c0 4.7-3.2 8.2-7.4 9.7-4.2-1.5-7.4-5-7.4-9.7V5.8z"/><path d="M12 8.6v6.4M8.8 11.8h6.4"/>',
  mChevron: '<path d="M9 5 16 12l-7 7"/>',
  mMic: '<rect x="9.1" y="2.6" width="5.8" height="11.6" rx="2.9"/><path d="M5.6 11.2a6.4 6.4 0 0 0 12.8 0M12 17.6v3.8"/>',
  mSend: '<path d="M21.2 2.8 2.8 10.4l7.6 3.2 3.2 7.6z"/><path d="m21.2 2.8-10.8 10.8"/>',
  pin: '<path d="M12 21 6.6 13.6a6.6 6.6 0 1 1 10.8 0z"/><circle cx="12" cy="9.8" r="2.4"/>',
};

/** Returns an inline <svg> string for a named icon. */
export function icon(name, { size = 24, stroke = 1.6, cls = '' } = {}) {
  const body = P[name] || '';
  return `<svg class="vh-ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** ELVAR logo: faceted gold 4-point star over a smaller diagonal star (compass rose). `size` px square. */
export function logoMark({ size = 50, cls = 'vh-logo-mark', id = 'vh-star' } = {}) {
  const c = 25, f = (n) => +n.toFixed(2);
  const pt = (deg, r) => { const a = (deg * Math.PI) / 180; return [f(c + r * Math.cos(a)), f(c + r * Math.sin(a))]; };
  // each point is two triangles (lit / shaded half) so the star reads as bevelled metal
  const star = (r, w, rot, lit, dark) => [0, 90, 180, 270].map((d) => {
    const a = d + rot, T = pt(a, r), W1 = pt(a - 45, w), W2 = pt(a + 45, w);
    return `<path d="M${c},${c} L${T} L${W1}Z" fill="${lit}"/><path d="M${c},${c} L${T} L${W2}Z" fill="${dark}"/>`;
  }).join('');
  const outline = (r, w, rot) => 'M' + [0, 90, 180, 270].map((d) => `${pt(d + rot, r)} L${pt(d + rot + 45, w)}`).join(' L') + 'Z';
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 50 50" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="${id}-a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff3d6"/><stop offset=".5" stop-color="#f0c57a"/><stop offset="1" stop-color="#b07a33"/></linearGradient>
      <linearGradient id="${id}-b" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c8913f"/><stop offset=".6" stop-color="#7a4f1c"/><stop offset="1" stop-color="#4a2f10"/></linearGradient>
      <radialGradient id="${id}-c"><stop offset="0" stop-color="#fff6e0"/><stop offset=".35" stop-color="#ffd99a" stop-opacity=".9"/><stop offset="1" stop-color="#e8a040" stop-opacity="0"/></radialGradient>
    </defs>
    ${star(13.5, 2.6, 45, 'url(#' + id + '-a)', 'url(#' + id + '-b)')}
    ${star(24, 4.4, -90, 'url(#' + id + '-a)', 'url(#' + id + '-b)')}
    <path d="${outline(24, 4.4, -90)}" stroke="#ffe2a8" stroke-width=".7" stroke-linejoin="miter" opacity=".85"/>
    <circle cx="25" cy="25" r="5" fill="url(#${id}-c)"/>
  </svg>`;
}

/** "ELVAR" wordmark: wide-tracked display serif (Cinzel), gold-cream metal fill (see .vh-wordmark in hud.css). */
export function wordmark() {
  return '<span class="vh-wordmark" aria-hidden="true">ELVAR</span>';
}

/** Phone layout: the same star logo, 44 px. */
export function logoTri() {
  return logoMark({ size: 46, cls: 'vm-logo', id: 'vm-star' });
}

/** Phone layout: wide "ELVAR" wordmark. */
export function wordmarkWide() {
  return '<span class="vm-wordmark" aria-hidden="true">ELVAR</span>';
}
