// ELVAR HUD (gold theme) — public entry.
//
//   import { mountHud } from './hud/index.js';
//   const hud = mountHud(document.getElementById('hud-root'), options);
//
// Two layouts share one API: the desktop design (1671x941 stage, elastic anchoring) and the
// phone design (852-wide portrait stage). The layout is picked at mount and rebuilt when the
// viewport flips between landscape and portrait. See docs/HUD_NOTES.md for the full contract.
import '@fontsource/barlow-semi-condensed/400.css';
import '@fontsource/barlow-semi-condensed/500.css';
import '@fontsource/barlow-semi-condensed/600.css';
import '@fontsource/barlow-semi-condensed/700.css';
import '@fontsource/noto-sans-jp/300.css';
import '@fontsource/cinzel/400.css';
import '@fontsource/cinzel/500.css';
import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/500.css';
import './hud.css';
import './hud-mobile.css';

import * as mock from './mockData.js';
import { buildHud, renderPanel, PANEL_CLASS } from './template.js';
import { buildPhoneHud, WAVE_BARS } from './template-mobile.js';
import { inputFrame, chromeSvg, STAGE_W, STAGE_H } from './frames.js';
import { SphereRenderer } from './sphere.js';

const STATES = ['idle', 'connecting', 'listening', 'thinking', 'speaking', 'error'];
const DEFAULT_PLACEHOLDER = { desktop: 'どうぞ、話してください... (聞いています)', phone: '話しかけてください…' };
const WEEK_JP = ['日', '月', '火', '水', '木', '金', '土'];
const WEEK_EN = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Phone stage geometry (reference px of the 852x1846 phone design).
const PH = {
  W: 852, H: 1846,
  TOP_PAD: 101, // top bar outer edge from the top of the content area
  BOT_PAD: 125, // input bar bottom edge from the bottom of the content area
  TOP_END: 400, // bottom of the ACTIVE AGENTS card
  BOT_START: 1459, // top of the bottom cards
  INPUT_BOTTOM: 1721,
  MID_TOP: 520, MID_H: 820, CORE_Y: 869, // sphere block (side-tab tops .. platform glow), sphere centre
  MID_GAP: 60, MID_MIN: 0.55, // min free space above+below the block, min block scale
  TABLET_ASPECT: 0.62, TABLET_H: 1700, // squarer than this => fit the height (design height TABLET_H)
};

const SEL = {
  desktop: { stage: '.vh-stage', form: '.vh-input', input: '.vh-text', transcript: '.vh-transcript', mic: '.vh-mic', status: '.vh-status', sphere: '.vh-sphere' },
  phone: { stage: '.vm-stage', form: '.vm-input', input: '.vm-text', transcript: '.vm-transcript', mic: '.vm-mic', status: '.vm-status', sphere: '.vm-sphere' },
};

/**
 * @param {HTMLElement} rootEl
 * @param {{ data?: object, placeholder?: string, freezeClock?: boolean,
 *           layout?: 'auto'|'desktop'|'phone', phoneAspect?: number }} [options]
 */
export function mountHud(rootEl, options = {}) {
  if (!rootEl) throw new Error('mountHud: root element is required');
  const params = new URLSearchParams(location.search);
  const freezeClock = options.freezeClock ?? params.get('freeze') === '1';
  const data = { ...mock, ...(options.data || {}) };
  const forced = options.layout ?? params.get('layout') ?? 'auto';
  const phoneAspect = options.phoneAspect ?? 1.05; // width/height below this (portrait) => phone layout
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  // ---------- state that survives a layout rebuild ----------
  const st = {
    state: 'idle', status: 'ONLINE', transcript: '', role: 'user', mic: false, ambient: false, audio: { level: 0, source: 'mic' }, sphereOn: true,
    placeholder: options.placeholder ?? null, // null => the layout's default text
  };
  const micCbs = new Set();
  const sendCbs = new Set();

  rootEl.classList.add('vh-root');
  rootEl.dataset.state = 'idle';
  const flashEl = document.createElement('div');
  flashEl.className = 'vh-flash'; flashEl.setAttribute('aria-hidden', 'true');

  let v = null; // current view: { kind, els..., sphere, layout() }
  let lvlRaf = 0;

  const placeholderFor = (kind) => st.placeholder ?? DEFAULT_PLACEHOLDER[kind];

  function build(kind) {
    const prevValue = v ? v.input.value : '';
    if (v) teardownView();
    rootEl.classList.toggle('vh-phone', kind === 'phone');
    const ph = placeholderFor(kind);
    rootEl.innerHTML = kind === 'phone' ? buildPhoneHud(data, { placeholder: ph }) : buildHud(data, { placeholder: ph });
    rootEl.appendChild(flashEl);
    const s = SEL[kind];
    const $ = (q) => rootEl.querySelector(q);
    const view = {
      kind,
      stage: $(s.stage), form: $(s.form), input: $(s.input), transcript: $(s.transcript),
      mic: $(s.mic), status: $(s.status),
      time: $('.vh-time'), date: $('.vh-date'), // desktop clock
      wd: $('.vm-wd'), day: $('.vm-day'), mo: $('.vm-mo'), // phone date
      bars: [...rootEl.querySelectorAll('.vm-wbar')],
      lastDx: -1, lastDy: -1, lastKey: '',
    };
    if (kind === 'phone') view.input.classList.add('vh-text'); // legacy selector used by main.js
    view.sphere = new SphereRenderer($(s.sphere), { reducedMotion: reduced, variant: kind === 'phone' ? 'mobile' : 'desktop' });
    view.input.value = prevValue;

    // wiring (listeners live on this view's elements and go away with them)
    view.input.addEventListener('input', refreshField);
    view.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = view.input.value.trim();
      if (!text) return;
      view.input.value = '';
      refreshField();
      sendCbs.forEach((cb) => { try { cb(text); } catch (err) { console.error(err); } });
    });
    view.mic.addEventListener('click', () => {
      applyMic(!st.mic);
      micCbs.forEach((cb) => { try { cb(st.mic); } catch (err) { console.error(err); } });
    });
    v = view;

    // re-apply state
    view.sphere.setState(st.state);
    applyMic(st.mic);
    applyStatus();
    applyTranscript();
    tick();
    (kind === 'phone' ? layoutPhone : layoutDesktop)(true);
    if (st.sphereOn) view.sphere.start();
    view.sphere.renderOnce();
  }

  function teardownView() {
    v.sphere.destroy();
    cancelAnimationFrame(lvlRaf); lvlRaf = 0;
    v = null;
  }

  // ---------- desktop layout: scale the fixed design stage to the viewport ----------
  const chromeEl = (dx, dy) => { const t = document.createElement('template'); t.innerHTML = chromeSvg(dx, dy).trim(); return t.content.firstElementChild; };
  function layoutDesktop() {
    const vw = rootEl.clientWidth || window.innerWidth;
    const vh = rootEl.clientHeight || window.innerHeight;
    // Fill the whole display: scale uniformly so the design fits, then spread the extra
    // space (in design px) via --dx/--dy; hud.css anchors each element left/centre/right, top/centre/bottom.
    const s = Math.min(vw / STAGE_W, vh / STAGE_H);
    const dx = Math.max(0, vw / s - STAGE_W), dy = Math.max(0, vh / s - STAGE_H);
    const stage = v.stage;
    stage.style.transform = `scale(${s})`;
    stage.style.setProperty('--dx', `${dx}px`);
    stage.style.setProperty('--dy', `${dy}px`);
    if (Math.abs(dx - v.lastDx) > 0.5 || Math.abs(dy - v.lastDy) > 0.5 || v.lastDx < 0) {
      v.lastDx = dx; v.lastDy = dy;
      stage.querySelector('.vh-chrome')?.replaceWith(chromeEl(dx, dy));
    }
    const svg = v.form.querySelector('.vh-frame');
    if (svg && +svg.getAttribute('width') !== 623) svg.outerHTML = inputFrame(623, 57);
  }

  // ---------- phone layout ----------
  // Uniform scale from the width (s = vw/852); if the screen is too short even with the sphere block
  // shrunk to MID_MIN, scale to fit the height instead and centre the 852-wide column.
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;'
    + 'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  function layoutPhone() {
    const vw = rootEl.clientWidth || window.innerWidth;
    const vh = rootEl.clientHeight || window.innerHeight;
    if (!probe.isConnected) document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const sat = parseFloat(cs.paddingTop) || 0, sab = parseFloat(cs.paddingBottom) || 0;
    const fixedH = PH.TOP_END + (PH.H - PH.BOT_START) + 2 * PH.MID_GAP + PH.MID_H * PH.MID_MIN; // min design height
    let s = vw / PH.W;
    if (vw / vh > PH.TABLET_ASPECT) s = Math.min(s, vh / PH.TABLET_H); // tablet portrait: centred column, big sphere
    if (vh / s < fixedH) s = vh / fixedH;
    const H = vh / s, Wd = vw / s;
    const topPad = Math.max(PH.TOP_PAD, sat / s + 4);
    const botPad = Math.max(PH.BOT_PAD, sab / s + 40);
    const dt = topPad - PH.TOP_PAD;
    const db = (H - botPad) - PH.INPUT_BOTTOM;
    const availTop = PH.TOP_END + dt, availBot = PH.BOT_START + db;
    const space = availBot - availTop;
    const m = Math.max(0.3, Math.min(1, (space - 2 * PH.MID_GAP) / PH.MID_H));
    const blockTop = availTop + (space - PH.MID_H * m) / 2;
    const coreY = blockTop + (PH.CORE_Y - PH.MID_TOP) * m;
    const key = [vw, vh, sat, sab].join();
    if (key === v.lastKey) return;
    v.lastKey = key;
    const st2 = v.stage.style;
    st2.transform = `translate(${((Wd - PH.W) / 2) * s}px, 0) scale(${s})`;
    st2.height = `${H}px`;
    st2.setProperty('--vm-dt', `${dt}px`);
    st2.setProperty('--vm-db', `${db}px`);
    st2.setProperty('--vm-dc', `${H - PH.H}px`);
    st2.setProperty('--vm-dm', `${coreY - PH.CORE_Y}px`);
    st2.setProperty('--vm-m', `${m}`);
    rootEl.style.setProperty('--vm-cy', `${coreY * s}px`);
    rootEl.style.setProperty('--vm-grid', `${19 * s}px`);
  }

  function pickKind() {
    if (forced === 'phone' || forced === 'desktop') return forced;
    const vw = rootEl.clientWidth || window.innerWidth;
    const vh = rootEl.clientHeight || window.innerHeight;
    return vw / vh < phoneAspect ? 'phone' : 'desktop';
  }
  function onResize() {
    const kind = pickKind();
    if (!v || kind !== v.kind) build(kind);
    else (kind === 'phone' ? layoutPhone : layoutDesktop)();
  }

  // ---------- clock / date ----------
  function tick() {
    if (!v) return;
    const d = freezeClock ? null : new Date();
    if (v.kind === 'desktop') {
      if (!d) { v.time.textContent = '08:34'; v.date.textContent = '2026年11月6日 (金)'; return; }
      v.time.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      v.date.textContent = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 (${WEEK_JP[d.getDay()]})`;
    } else {
      if (!d) { v.wd.textContent = 'FRI'; v.day.textContent = '06'; v.mo.textContent = 'Nov 2026'; return; }
      v.wd.textContent = WEEK_EN[d.getDay()];
      v.day.textContent = String(d.getDate()).padStart(2, '0');
      v.mo.textContent = `${MONTH_EN[d.getMonth()]} ${d.getFullYear()}`;
    }
  }
  const clockTimer = setInterval(tick, 1000);

  // ---------- input / transcript ----------
  function refreshField() {
    if (!v) return;
    const show = st.transcript !== '' && v.input.value === '';
    v.form.classList.toggle('has-transcript', show);
    v.input.placeholder = show ? '' : placeholderFor(v.kind);
  }
  function applyTranscript() {
    // keep the tail visible for long utterances
    const max = v.kind === 'phone' ? 40 : 64;
    const t = st.transcript;
    v.transcript.textContent = t.length > max ? '…' + t.slice(-(max - 1)) : t;
    v.transcript.classList.toggle('is-model', st.role === 'model');
    v.transcript.classList.toggle('is-user', st.role !== 'model');
    refreshField();
  }
  function applyMic(on) {
    st.mic = !!on;
    if (!v) return;
    v.mic.classList.toggle('is-on', st.mic);
    v.mic.setAttribute('aria-pressed', String(st.mic));
  }
  function applyStatus() {
    v.status.textContent = st.status;
    rootEl.classList.toggle('is-offline', /offline/i.test(st.status));
  }

  // ---------- audio → mic button glow + phone waveform (once per frame at most) ----------
  let lastPush = 0, lastLvlStr = '';
  function pushLevel() {
    lvlRaf = 0;
    if (!v) return;
    const nowMs = performance.now();
    if (nowMs - lastPush < 45) return;       // ~30 Hz is plenty for a glow + 9 bars; every style write restyles the HUD
    lastPush = nowMs;
    const lvl = v.sphere.smoothedLevel;
    const ls = (Math.round(lvl * 12) / 12).toFixed(2);   // 12 steps: the CSS transition smooths between them, and the mic glow (a big blur) is not repainted on every tiny change
    if (ls !== lastLvlStr) { lastLvlStr = ls; v.mic.style.setProperty('--vh-lvl', ls); }
    if (v.bars.length) {
      const t = performance.now() / 1000;
      v.bars.forEach((b, n) => {
        const i = n % WAVE_BARS.length;   // the glow copies share the bar's motion
        const wob = reduced ? 0.6 : 0.5 + 0.5 * Math.abs(Math.sin(t * (5.2 + i * 1.7) + i * 1.3));
        const h = WAVE_BARS[i][1];
        const k = Math.min(54 / h, 1 + lvl * (0.4 + 0.8 * wob) * (h < 12 ? 2.2 : h > 40 ? 0.3 : 1)); // stay inside the card
        b.style.transform = `scaleY(${k.toFixed(3)})`;
      });
    }
  }

  const ro = new ResizeObserver(onResize);
  ro.observe(rootEl);
  build(pickKind());

  const hud = {
    setState(state) {
      if (!STATES.includes(state)) { console.warn('hud.setState: unknown state', state); return; }
      st.state = state;
      rootEl.dataset.state = state;
      v?.sphere.setState(state);
    },
    setAudio({ level = 0, pitch = 0.5, source = 'mic' } = {}) {
      st.audio.level = Math.max(0, Math.min(1, +level || 0)); st.audio.source = source === 'model' ? 'model' : 'mic';
      v?.sphere.setAudio({ level, pitch, source });
      if (!lvlRaf) lvlRaf = requestAnimationFrame(pushLevel);
    },
    setTranscript(text, role = 'user') {
      st.transcript = text == null ? '' : String(text);
      st.role = role;
      if (v) applyTranscript();
    },
    setPlaceholder(text) {
      const t = text == null ? '' : String(text);
      // restoring either layout's default keeps it layout-specific
      st.placeholder = t === DEFAULT_PLACEHOLDER.desktop || t === DEFAULT_PLACEHOLDER.phone ? null : t;
      refreshField();
    },
    setStatusLabel(text) {
      st.status = text == null ? '' : String(text);
      if (v) applyStatus();
    },
    setMicActive(on) { applyMic(on); },
    /** Ambient (standby look): panels fade back; leaving it is instant. */
    setAmbient(on) { st.ambient = !!on; rootEl.classList.toggle('vh-ambient', st.ambient); },
    /** One quick light pulse across the screen (wake-up). Also leaves ambient mode instantly. */
    flash() {
      st.ambient = false;
      rootEl.classList.remove('vh-ambient');
      flashEl.classList.remove('is-on'); void flashEl.offsetWidth; flashEl.classList.add('is-on');
    },
    /**
     * Swap real data into the cards without rebuilding the HUD (the sphere keeps running).
     * Keys: weather {city,temp,condition} · today/schedule → TODAY · tasks · nextEvent · agents · activity · system · phoneAgents [{label,busy}] · agentName.
     */
    setData(patch = {}) {
      Object.assign(data, patch);
      if (!v) return;
      const has = (...k) => k.some((x) => x in patch);
      if (has('weather')) {
        const w = data.weather || {};
        const set = (q, t) => { const el = rootEl.querySelector(q); if (el && el.textContent !== String(t ?? '')) el.textContent = t ?? ''; };
        if (v.kind === 'desktop') { set('.vh-wcity', w.city); set('.vh-wtemp', w.temp); set('.vh-wcond', w.condition); }
        else { set('.vm-city', w.city); set('.vm-temp', w.temp); set('.vm-cond', w.condition); }
      }
      if (v.kind === 'desktop') {
        const jobs = { today: has('today', 'schedule'), tasks: has('tasks'), next: has('nextEvent'), agents: has('agents'), activity: has('activity'), system: has('system') };
        for (const [name, on] of Object.entries(jobs)) {
          if (!on) continue;
          const old = rootEl.querySelector(PANEL_CLASS[name]); if (!old) continue;
          const tpl = document.createElement('template'); tpl.innerHTML = renderPanel(name, data).trim();
          old.replaceWith(tpl.content.firstElementChild);
        }
      } else {
        if (has('agentName')) { const el = rootEl.querySelector('.vm-name'); if (el) el.textContent = data.agentName || ''; }
        if (has('phoneAgents')) {
          const btns = [...rootEl.querySelectorAll('.vm-agent')], dots = [...rootEl.querySelectorAll('.vm-agdot')];
          (data.phoneAgents || []).forEach((a, i) => { if (btns[i]) { btns[i].setAttribute('aria-label', a.label || ''); btns[i].title = a.label || ''; } if (dots[i]) dots[i].classList.toggle('is-busy', !!a.busy); });
        }
      }
    },
    onMicToggle(cb) { if (typeof cb === 'function') micCbs.add(cb); return () => micCbs.delete(cb); },
    onSend(cb) { if (typeof cb === 'function') sendCbs.add(cb); return () => sendCbs.delete(cb); },
    /** Current assistant state ('idle' | 'listening' | 'thinking' | 'speaking' | …) and the last raw audio level (for other "skins", e.g. the human protocol). */
    get state() { return st.state; },
    get audio() { return st.audio; },
    /** Stop / resume drawing the core sphere (while something else covers it). */
    setSphereRunning(on) { st.sphereOn = !!on; if (!v) return; if (st.sphereOn) v.sphere.start(); else v.sphere.stop(); },
    /** Which layout is showing right now: 'desktop' | 'phone'. */
    get layout() { return v?.kind ?? null; },
    destroy() {
      if (v) teardownView();
      ro.disconnect();
      clearInterval(clockTimer);
      micCbs.clear(); sendCbs.clear();
      probe.remove();
      rootEl.innerHTML = '';
      flashEl.remove();
      rootEl.classList.remove('vh-root', 'vh-phone', 'is-offline', 'vh-ambient');
      rootEl.style.removeProperty('--vm-cy'); rootEl.style.removeProperty('--vm-grid');
      delete rootEl.dataset.state;
    },
  };
  return hud;
}

export default mountHud;
