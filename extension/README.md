# E.L.V.A.R. Bring to Front (Chrome / Edge extension)

For people who run E.L.V.A.R. **in a browser tab**. A web page cannot restore a minimised browser or raise itself above other windows; a browser extension can (`chrome.windows.update`).

On the double clap the HUD page sends one message; this extension then:
1. **restores the browser window if it is minimised**,
2. **selects the E.L.V.A.R. tab** (even if you were on another tab),
3. **focuses the window** — and if Windows refuses keyboard focus to a background app, **flashes the taskbar button**.

It does nothing else: the content script only listens on the sites you allow and only for that one message from the page itself; it reads no page content.

## If you use E.L.V.A.R. as an installed Chrome app (PWA window)
This works the same: an installed app window is a browser window of the same Chrome profile, so the extension sees it.
- Install the extension **in the same Chrome profile** the app belongs to (steps below).
- The app window has no toolbar, so open the extension's options through `chrome://extensions` → the extension → **Details → Extension options**.
- After adding the address, **reload the app window** (Ctrl+R) or close and reopen the app once.
- Keep the app window **open** (minimise it instead of closing it with X): closing it stops the listener.
- **Reinstall the app once** (chrome://apps → right-click → Uninstall, then address bar → Install E.L.V.A.R.): the app now ships a proper manifest (icon, `standalone` window, "focus the existing window when launched").
- Start with Windows: press `Win+R` → `shell:startup`, and drop a copy of the app's Start-menu shortcut (type "E.L.V.A.R." in the Start menu → right-click → Open file location) into that folder.

## Install (Chrome or Edge, Windows)
1. Open `chrome://extensions` (Edge: `edge://extensions`), switch **Developer mode** on.
2. **Load unpacked** → choose this `extension` folder.
3. Click the extension's **Details → Extension options** (or right-click its icon → Options), enter your E.L.V.A.R. address (e.g. `https://your-app.vercel.app`), press **許可して追加**, allow the permission.
   `http://localhost` / `127.0.0.1` work out of the box.
4. **Reload the E.L.V.A.R. tab** once.

Keep the E.L.V.A.R. tab **open** (it can be minimised, on another tab, or behind other windows); closing the tab/browser stops the listener.

## Limits
- Verified in Chromium under a virtual display with a window manager: (a) minimised window + another tab on top → after the clap the window is restored and the E.L.V.A.R. tab is selected; (b) an `--app` window (type `app`, what an installed PWA is) minimised → restored. **Not verified on real Windows**: focus-lock behaviour, taskbar flash, and whether Chrome keeps the clap listener running in a minimised window (it should, because the microphone is open, but measure it with `?clapdebug=1`; if it ever stops, use the desktop app in `../desktop`, which disables background throttling).
- Fully closed browser / closed tab cannot be woken by any extension or web page.
- Unpacked extensions show a "developer mode" notice at browser start on Chrome; packaging for the Web Store is not done.
