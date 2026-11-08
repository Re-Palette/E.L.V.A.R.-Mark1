// Builds the HUD DOM (static markup). Positions are design-stage pixels from the reference.
import { icon, logoMark, wordmark } from './icons.js';
import { panelFrame, inputFrame, chromeSvg, ringGauge, sparkline, hudDefs, fxSvg } from './frames.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function panel(cls, w, h, title, inner, { viewAll = false, chevron = false } = {}) {
  return `<section class="vh-panel ${cls}">
    ${panelFrame(w, h)}
    <header class="vh-ph"><i class="vh-dot"></i><h2>${esc(title)}</h2>
      ${viewAll ? `<a class="vh-viewall" href="#" tabindex="-1">View All ${icon('chevron', { size: 11, stroke: 2 })}</a>` : ''}
      ${chevron ? `<span class="vh-ph-chev">${icon('chevron', { size: 13, stroke: 1.8 })}</span>` : ''}
    </header>
    ${inner}
  </section>`;
}

function todayPanel(d) {
  const t = d.today;
  const rows = d.schedule.map((r, i) => `
    <div class="vh-srow" style="top:${(104 + i * 49.6).toFixed(1)}px">
      <i class="vh-pdot"></i><span class="vh-stime">${esc(r.time)}</span>
      <i class="vh-cdot ${r.accent === 'blue' ? 'is-blue' : ''}"></i>
      <span class="vh-stitle" title="${esc(r.title)}">${esc(r.title)}</span><span class="vh-ssub" title="${esc(r.sub)}">${esc(r.sub)}</span>
      <span class="vh-chev">${icon('chevron', { size: 17, stroke: 1.8 })}</span>
      ${i < d.schedule.length - 1 ? '<i class="vh-sep"></i>' : ''}
    </div>`).join('');
  return panel('vh-today', 287, 361, 'TODAY', `
    <i class="vh-hline" style="top:37px"></i>
    <div class="vh-bigday">${esc(t.day)}</div>
    <div class="vh-wd">${esc(t.weekday)}</div><div class="vh-mo">${esc(t.month)}</div>
    <i class="vh-hline" style="top:96px"></i>
    <div class="vh-taskring">${ringGauge(80, 33, t.arcs || [[0, 112], [205, 252]], { width: 4.2 })}
      <div class="vh-tr-num">${t.tasksDone}/${t.tasksTotal}</div><div class="vh-tr-lbl">Tasks</div></div>
    ${rows}`);
}

function tasksPanel(d) {
  const rows = d.tasks.map((r, i) => `
    <div class="vh-trow" style="top:${38 + i * 54}px">
      <span class="vh-ticon${r.checked ? ' is-done' : ''}">${icon(r.checked ? 'check' : 'ring', { size: 32, stroke: 1.5 })}</span>
      <span class="vh-ttitle" title="${esc(r.title)}">${esc(r.title)}</span><span class="vh-tcount">${r.done}/${r.total}</span>
      <i class="vh-bar"><i style="width:${((r.done / r.total) * 100).toFixed(1)}%"></i></i>
      ${i < d.tasks.length - 1 ? '<i class="vh-sep"></i>' : ''}
    </div>`).join('');
  return panel('vh-tasks', 287, 205, "TODAY'S TASKS", rows, { viewAll: true });
}

function nextPanel(d) {
  const e = d.nextEvent;
  return panel('vh-next', 287, 93, 'NEXT EVENT', `
    <i class="vh-hline" style="top:34px"></i>
    <span class="vh-nicon">${icon('calendar', { size: 27, stroke: 1.7 })}</span>
    <span class="vh-ntitle" title="${esc(e.title)}">${esc(e.title)}</span><span class="vh-nsub" title="${esc(e.sub)}">${esc(e.sub)}</span>
    <span class="vh-ntime">${esc(e.time)}</span><span class="vh-nwhen">${esc(e.when)}</span>`);
}

function agentsPanel(d) {
  const rows = d.agents.map((a, i) => `
    <div class="vh-arow${a.busy ? ' is-busy' : ''}" style="top:${(66 + i * 59) - 30}px">
      <span class="vh-aicon">${icon(a.icon, { size: 29, stroke: 1.9 })}</span>
      <i class="vh-gdot" style="top:19px"></i><i class="vh-gdot is-soft" style="top:40px"></i>
      <span class="vh-aname" title="${esc(a.name)}">${esc(a.name)}</span><span class="vh-astat">${esc(a.status)}</span>
      <span class="vh-aspark">${sparkline(i)}</span>
      <span class="vh-chev">${icon('chevron', { size: 17, stroke: 1.8 })}</span>
      ${i < d.agents.length - 1 ? '<i class="vh-sep"></i>' : ''}
    </div>`).join('');
  return panel('vh-agents', 284, 336, 'ACTIVE AGENTS', `<i class="vh-hline" style="top:36px"></i>${rows}`, { viewAll: true });
}

function activityPanel(d) {
  const rows = d.activity.map((a, i) => `
    <div class="vh-crow" style="top:${58 + i * 53 - 27}px">
      <span class="vh-cicon">${icon(a.icon, { size: 26, stroke: 1.8 })}</span>
      <i class="vh-cdot2"></i>
      <span class="vh-ctitle" title="${esc(a.title)}">${esc(a.title)}</span><span class="vh-csub" title="${esc(a.sub)}">${esc(a.sub)}</span>
      <span class="vh-cago">${esc(a.ago)}</span>
      ${i < d.activity.length - 1 ? '<i class="vh-sep"></i>' : ''}
    </div>`).join('');
  return panel('vh-activity', 284, 248, 'RECENT ACTIVITY', `<i class="vh-hline" style="top:36px"></i>${rows}`, { viewAll: true });
}

function systemPanel(d) {
  const g = d.system.map((s, i) => {
    const arcs = s.arcs || [[0, Math.max(1, s.pct * 360)]];
    return `<div class="vh-sg" style="left:${43 + i * 68 - 33}px">${ringGauge(66, 27, arcs, { width: 3.8 })}
      <span class="vh-sg-l">${esc(s.label)}</span><span class="vh-sg-v">${esc(s.value)}<small class="${s.unit === '%' ? 'is-pct' : ''}">${esc(s.unit)}</small></span></div>`;
  }).join('');
  return panel('vh-system', 284, 110, 'SYSTEM STATUS', g, { chevron: true });
}

/** Re-render one panel (used by hud.setData to swap real data in without rebuilding the whole HUD). */
export const PANELS = { today: todayPanel, tasks: tasksPanel, next: nextPanel, agents: agentsPanel, activity: activityPanel, system: systemPanel };
export const PANEL_CLASS = { today: '.vh-today', tasks: '.vh-tasks', next: '.vh-next', agents: '.vh-agents', activity: '.vh-activity', system: '.vh-system' };
export function renderPanel(name, data) { return PANELS[name](data); }

const NAV_LABELS = { home: 'ホーム（開いた画面を閉じる）', folder: '第二の脳', cube: 'システムチェック', sparkle: 'プロジェクト', sun: '収支', bell: '通知欄' };

export function buildHud(data, { placeholder }) {
  const navItems = ['home', 'folder', 'cube', 'sparkle', 'sun', 'bell'];
  return `
  <div class="vh-viewport">
    <div class="vh-bg"></div>
    ${hudDefs()}
    <div class="vh-stage">
      ${chromeSvg()}
      ${fxSvg()}

      <header class="vh-top">
        <div class="vh-brand">${logoMark({ size: 54 })}<span class="vh-wm" role="img" aria-label="ELVAR">${wordmark()}</span></div>
        <i class="vh-vdiv vh-vdiv-1"></i>
        <div class="vh-tagline">An Intelligence Beyond Assistance</div>
        <nav class="vh-nav">${navItems.map((n, i) => `<button class="vh-navbtn ${i === 0 ? 'is-active' : ''}" type="button" aria-label="${NAV_LABELS[n] || n}" title="${NAV_LABELS[n] || n}" data-vh-nav="${n}">${icon(n, { size: 27, stroke: 1.55 })}</button>`).join('')}<i class="vh-nav-ul"></i></nav>
        <div class="vh-clock"><div class="vh-time">08:34</div><div class="vh-date">2026年11月6日 (金)</div></div>
        <i class="vh-vdiv vh-vdiv-2"></i>
        <div class="vh-sys">
          <span class="vh-sysi vh-wifi">${icon('wifi', { size: 30, stroke: 1.7 })}</span>
          <span class="vh-sysi vh-vol">${icon('volume', { size: 28, stroke: 1.6 })}</span>
          <span class="vh-sysi vh-user">${icon('user', { size: 32, stroke: 1.6 })}</span>
          <span class="vh-sysi vh-set">${icon('settings', { size: 26, stroke: 1.6 })}</span>
        </div>
      </header>

      ${todayPanel(data)}
      ${tasksPanel(data)}
      ${nextPanel(data)}

      <div class="vh-weather">
        <svg class="vh-xhair" width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="22"/><circle cx="32" cy="32" r="11.5"/>
          <path d="M32 3v18M32 43v18M3 32h18M43 32h18"/>
          <circle class="vh-xhair-core" cx="32" cy="32" r="7"/>
        </svg>
        <span class="vh-wpin">${icon('pin', { size: 15, stroke: 1.8 })}</span>
        <span class="vh-wcity">${esc(data.weather.city)}</span>
        <span class="vh-wsun">${icon('sun', { size: 16, stroke: 1.6 })}</span>
        <span class="vh-wtemp">${esc(data.weather.temp)}</span><span class="vh-wcond">${esc(data.weather.condition)}</span>
      </div>

      ${agentsPanel(data)}
      ${activityPanel(data)}
      ${systemPanel(data)}

      <div class="vh-core">
        <canvas class="vh-sphere" aria-label="ELVAR core"></canvas>
      </div>

      <form class="vh-input" autocomplete="off">
        ${inputFrame(623, 57)}
        <button class="vh-mic" type="button" aria-label="マイク" aria-pressed="false">${icon('mic', { size: 22, stroke: 1.7 })}</button>
        <div class="vh-field">
          <input class="vh-text" type="text" enterkeyhint="send" aria-label="メッセージ" placeholder="${esc(placeholder)}">
          <div class="vh-transcript" aria-live="polite"></div>
        </div>
        <button class="vh-send" type="submit" aria-label="送信">${icon('send', { size: 24, stroke: 1.5 })}</button>
      </form>

      <div class="vh-create">CREATE SOMETHING AMAZING</div>
      <div class="vh-mode"><span>ELVAR</span><span class="vh-slash">/</span><span>CREATIVE MODE</span>
        <span class="vh-status">ONLINE</span><i class="vh-sdot"></i></div>
    </div>
  </div>`;
}
