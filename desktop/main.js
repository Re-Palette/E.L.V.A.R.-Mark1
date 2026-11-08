// E.L.V.A.R. Mark1 — desktop shell (Electron).
// Why it exists: a web page can never raise its own window; the OS only allows that to a native app.
// What it does: hosts the HUD (ELVAR_URL), keeps it running while hidden/covered/minimised (no background
// throttling, autoplay allowed, mic allowed), keeps living in the tray/menu bar when the window is closed,
// and on a double clap puts the window in front of everything (also over full-screen apps).
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, session, systemPreferences } = require('electron');
const path = require('node:path');

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const START_URL = arg('url') || process.env.ELVAR_URL || 'http://localhost:8787';
// Access token for /api/live-token (Electron has no window.prompt): env ELVAR_ACCESS_TOKEN or --token=...
const ACCESS_TOKEN = arg('token') || process.env.ELVAR_ACCESS_TOKEN || '';
const TEST_LOG = process.env.ELVAR_TEST_LOG === '1'; // prints machine-readable events for automated checks
const log = (o) => { if (TEST_LOG) console.log('ELVAR_EVT ' + JSON.stringify({ t: Date.now(), ...o })); };

// Keep the renderer fully alive while the window is hidden/covered: the clap detector must never be throttled.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => bringToFront('second-instance'));

let win = null, tray = null, quitting = false, topTimer = null;
const origin = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const OUR_ORIGIN = origin(START_URL);

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 560,
    backgroundColor: '#000d1e', title: 'E.L.V.A.R.', autoHideMenuBar: true,
    show: process.env.ELVAR_START_HIDDEN !== '1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,
      additionalArguments: ACCESS_TOKEN ? [`--elvar-token=${ACCESS_TOKEN}`] : [],
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.setMenuBarVisibility(false);
  // Closing the window must NOT stop the clap listener: hide instead (quit from the tray/menu).
  win.on('focus', () => win.flashFrame(false));
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); log({ evt: 'hidden-by-close' }); } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (origin(url) !== OUR_ORIGIN) e.preventDefault(); });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;
    log({ evt: 'load-failed', code, desc });
    setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(START_URL); }, 3000); // server not up yet: retry
  });
  win.webContents.on('console-message', (_e, _lvl, message) => { if (TEST_LOG && /\[wake\]|ELVAR_TEST/.test(message)) log({ evt: 'page-console', message }); });
  win.loadURL(START_URL);
}

/** Put the window in front of everything, instantly, from any state (hidden / minimised / behind / other Space / full-screen app). */
function bringToFront(reason = 'ipc') {
  if (!win || win.isDestroyed()) createWindow();
  const before = { visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused() };
  if (win.isMinimized()) win.restore();
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); } catch {}
  win.setAlwaysOnTop(true, 'screen-saver');          // above normal windows and over full-screen apps
  win.show();
  win.moveTop();
  try { if (process.platform === 'darwin') { app.dock?.show(); app.focus({ steal: true }); } else { app.focus?.({ steal: true }); } } catch {}
  win.focus();
  if (process.platform === 'win32') {
    // Windows' foreground lock can refuse KEYBOARD focus to a background app. Topmost already puts the window visibly
    // in front; if it still did not get focus, flash its taskbar button (the OS-sanctioned nudge). Voice needs no focus.
    setTimeout(() => { if (win && !win.isDestroyed() && win.isVisible() && !win.isFocused()) win.flashFrame(true); }, 200);
  }
  clearTimeout(topTimer);
  topTimer = setTimeout(() => { // drop the "always on top" so it behaves like a normal window afterwards
    if (win && !win.isDestroyed()) { win.setAlwaysOnTop(false); try { win.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true }); } catch {} }
  }, 2500);
  log({ evt: 'bring-to-front', reason, before, after: { visible: win.isVisible(), focused: win.isFocused(), alwaysOnTop: win.isAlwaysOnTop() } });
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
  if (process.platform === 'darwin') img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('E.L.V.A.R. — 拍手2回で起動');
  const build = () => Menu.buildFromTemplate([
    { label: 'E.L.V.A.R. を前面に表示', click: () => bringToFront('tray') },
    { label: '起動ミュージックを停止', click: () => { if (win && !win.isDestroyed()) win.webContents.executeJavaScript('window.__elvarBgmStop && window.__elvarBgmStop()').catch(() => {}); } },
    { type: 'separator' },
    { label: 'ログイン時に自動で起動', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (m) => { app.setLoginItemSettings({ openAtLogin: m.checked }); } },
    { type: 'separator' },
    { label: '終了', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(build());
  tray.on('click', () => bringToFront('tray-click'));
}

app.whenReady().then(async () => {
  // Microphone only for our own origin; macOS also asks the OS once (Windows: Settings > Privacy > Microphone must allow desktop apps).
  const allowed = (url, perm) => origin(url) === OUR_ORIGIN && ['media', 'audioCapture', 'notifications'].includes(perm);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(allowed(wc.getURL(), perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm, reqOrigin) => allowed(reqOrigin || (wc && wc.getURL()), perm));
  if (process.platform === 'darwin') { try { await systemPreferences.askForMediaAccess('microphone'); } catch {} }

  ipcMain.on('elvar:bring-to-front', (e) => { if (win && e.sender === win.webContents) bringToFront('ipc'); });
  createWindow();
  try { createTray(); } catch (e) { log({ evt: 'tray-unavailable', message: String(e) }); }

  // test hooks (only used by automated checks)
  if (process.env.ELVAR_TEST_PROBE === '1') win.webContents.on('did-finish-load', async () => { log({ evt: 'probe', tokenLength: await win.webContents.executeJavaScript('(window.elvarDesktop && window.elvarDesktop.accessToken || "").length') }); });
  if (process.env.ELVAR_TEST_HIDE_AFTER_MS) setTimeout(() => { win.hide(); log({ evt: 'test-hid-window' }); }, Number(process.env.ELVAR_TEST_HIDE_AFTER_MS));
  app.on('activate', () => bringToFront('dock-activate'));
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* keep running in the tray */ });
