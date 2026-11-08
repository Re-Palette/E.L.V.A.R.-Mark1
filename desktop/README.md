# E.L.V.A.R. desktop shell (Electron) — Windows first

A web page can never raise its own window; only a native app can. This thin app hosts the same HUD and:

- keeps the HUD (and the clap listener) **running while the window is hidden, covered or minimised** (no background throttling);
- **closing the window only hides it** — the app stays in the system tray (quit from the tray icon);
- on a **double clap puts the window in front of everything instantly** (always-on-top for 2.5 s, then it behaves like a normal window). On Windows the OS may refuse *keyboard focus* to a background app: the window is still visibly in front, and if it did not get focus its taskbar button flashes (voice conversation does not need focus);
- allows the microphone and audio autoplay for the HUD's own origin only (no click needed to start listening);
- tray menu: show in front · launch at login · quit.

## Run on Windows
Needs Node.js 22.12 or newer. In PowerShell:
```powershell
cd desktop
npm install
npm start -- --url=https://YOUR-APP.vercel.app
```
(or set the environment first: `$env:ELVAR_URL="https://..."; npm start`; in cmd.exe use `set ELVAR_URL=...`). Sign in inside the app the first time; optionally pre-set a device token with the environment variable `ELVAR_DEVICE_TOKEN` (never on the command line).

**Double-click launcher:** copy `elvar.example.cmd` to `elvar.cmd`, fill in the URL, double-click it. For "start with Windows", put a shortcut to `elvar.cmd` in the folder opened by `Win+R` → `shell:startup`.

- `--url` / `ELVAR_URL` — where the HUD is served (default `http://localhost:8787`, i.e. `npm run build` then `npm start` in the repo root).
- `ELVAR_DEVICE_TOKEN` (or `ELVAR_ACCESS_TOKEN` in env mode) — optional, environment only; otherwise the app shows its sign-in screen.
- Windows may ask once for microphone access; also check **Settings → Privacy & security → Microphone → "Let desktop apps access your microphone"**.
- Add `?standby=1` to the URL the first time if the clap listener does not start on its own.
- If your mic driver has "audio enhancements" / noise suppression, turn them off (Sound settings → Recording → your mic → Properties → Enhancements): they can erase the sharp transient of a clap before the app hears it. Use `?clapdebug=1` to see what the detector hears.

## Notes / limits
- `desktop/` is a separate package so the root `npm install` (and Vercel builds) never download Electron.
- The tray menu's "launch at login" registers the running binary; during `npm start` that is Electron itself, so use the `shell:startup` shortcut above until the app is **packaged** (`.exe` installer — not done yet).
- Verified only on Linux (real Electron under a virtual display). Windows-specific behaviour (foreground lock, tray, Start-up) and macOS/Spaces are untested.
