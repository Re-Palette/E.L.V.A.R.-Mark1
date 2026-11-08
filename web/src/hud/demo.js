// Standalone HUD demo: simulates states and synthetic audio levels without any backend.
// URL params: ?freeze=1 (fixed clock), ?panel=1 (open controls), ?state=..., ?level=0..1, ?pitch=0..1, ?source=mic|model
import { mountHud } from './index.js';

const q = new URLSearchParams(location.search);
const hud = mountHud(document.getElementById('hud-root'));
window.hud = hud; // for manual poking / automated tests
const bgmTab = document.getElementById('elvar-bgm-stop');
if (bgmTab) { if (q.get('bgm') === '0') bgmTab.classList.remove('on'); bgmTab.onclick = () => bgmTab.classList.remove('on'); }

const panel = document.getElementById('demo-panel');
const log = (m) => { const el = document.getElementById('demo-log'); el.textContent = `${m}\n${el.textContent}`.slice(0, 600); };
document.getElementById('demo-toggle').onclick = () => panel.classList.toggle('is-hidden');
if (q.get('panel') === '1') panel.classList.remove('is-hidden');
if (q.get('freeze') === '1' && q.get('panel') !== '1') document.getElementById('demo-toggle').style.display = 'none';

const states = ['idle', 'connecting', 'listening', 'thinking', 'speaking', 'error'];
const stWrap = document.getElementById('demo-states');
let state = q.get('state') || 'idle';
for (const s of states) {
  const b = document.createElement('button');
  b.textContent = s; b.dataset.s = s;
  b.onclick = () => setState(s);
  stWrap.appendChild(b);
}
function setState(s) {
  state = s; hud.setState(s);
  stWrap.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.s === s));
  if (s === 'speaking') setSource('model');
  if (s === 'listening') setSource('mic');
}

let source = q.get('source') || 'mic';
function setSource(s) {
  source = s;
  document.querySelectorAll('[data-src]').forEach((b) => b.classList.toggle('on', b.dataset.src === s));
}
document.querySelectorAll('[data-src]').forEach((b) => (b.onclick = () => setSource(b.dataset.src)));

const lvl = document.getElementById('level'), pit = document.getElementById('pitch'), synth = document.getElementById('synth');
if (q.get('level')) lvl.value = q.get('level');
if (q.get('pitch')) pit.value = q.get('pitch');
if (q.get('synth') === '1') synth.checked = true;
setSource(source);
setState(state);

// synthetic speech-like envelope: syllable bursts + phrase gaps; pitch wanders
function synthAudio(t) {
  const phrase = Math.sin(t * 0.7) > -0.3 ? 1 : 0.05;
  const syl = Math.max(0, Math.sin(t * 11.5) * 0.6 + Math.sin(t * 4.3) * 0.4);
  const level = Math.min(1, phrase * syl * (0.7 + 0.3 * Math.sin(t * 1.9)) + Math.random() * 0.05);
  const pitch = 0.5 + 0.3 * Math.sin(t * 1.3) + 0.1 * Math.sin(t * 5.1);
  return { level, pitch };
}

function frame(now) {
  let level = +lvl.value, pitch = +pit.value;
  if (synth.checked) ({ level, pitch } = synthAudio(now / 1000));
  document.getElementById('lv').textContent = level.toFixed(2);
  document.getElementById('pv').textContent = pitch.toFixed(2);
  hud.setAudio({ level, pitch, source });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

document.getElementById('t-user').onclick = () => hud.setTranscript('明日の予定を教えて', 'user');
document.getElementById('t-model').onclick = () => hud.setTranscript('明日は9時からTeam Meetingがあります。', 'model');
document.getElementById('t-clear').onclick = () => hud.setTranscript('', 'user');
document.getElementById('s-online').onclick = () => hud.setStatusLabel('ONLINE');
document.getElementById('s-conn').onclick = () => hud.setStatusLabel('CONNECTING');
document.getElementById('s-off').onclick = () => hud.setStatusLabel('OFFLINE');

hud.onMicToggle((on) => { log(`mic → ${on}`); setState(on ? 'listening' : 'idle'); });
hud.onSend((text) => { log(`send: ${text}`); setState('thinking'); setTimeout(() => setState('idle'), 1500); });
