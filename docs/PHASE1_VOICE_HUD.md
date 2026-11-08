# Phase 1 — HUD + Gemini Live voice (first vertical slice)

Status legend: 構想 / 設計済み / 実装中 / 実装済み(未検証) / 検証済み

| Item | Status | Evidence / note |
|---|---|---|
| Ephemeral-token server (`server/`) | 検証済み (partial) | Auth gating (401/loopback), 503 w/o key, graceful upstream error verified with curl. A **real** key has not been tested. |
| Gemini Live client (`web/src/live/`) | 実装済み(未検証) | Written against SDK typings of `@google/genai@2.32.0`. **Not run end-to-end**: no API key and no microphone in the dev container. |
| HUD (`web/src/hud/`) | see `docs/HUD_NOTES.md` | Built by the HUD agent; fidelity evidence in that file. |
| Sphere audio-reactivity | see `docs/HUD_NOTES.md` | Driven by `hud.setAudio({level, pitch, source})`. |
| Session resumption / reconnect, `goAway` handling | 構想 | Not implemented. |
| Real data in side panels | 構想 | Panels show clearly marked placeholder data (`web/src/hud/mockData.js`). |

## Architecture (Phase 1)
```
Browser (HUD + mic/speaker)  ──ws──►  Gemini Live   (direct; audio never touches our server)
        │  POST /api/live-token
        ▼
Node server: holds GEMINI_API_KEY, mints single-use, 30-min, config-locked ephemeral tokens
             (persona/voice/transcription locked server-side, 30 tokens/hour cap)
```
- Input: mic → AudioWorklet → 16 kHz mono PCM16 (~32 ms chunks) → `sendRealtimeInput`.
- Output: 24 kHz PCM16 → scheduled `AudioBufferSource`s → analyser → HUD. `interrupted` flushes the queue (barge-in).
- State `thinking` is a **heuristic** (user went quiet >700 ms and the model has not started answering).

## Open items to confirm (DECISION/OPEN_QUESTIONS candidates)
1. **Model ID.** Per search results quoting Google's official model pages (the docs host itself is unreachable from the dev container, so not read first-hand): `gemini-3.8-live` is the current default Live model; `gemini-3.1-flash-live-preview` is labelled **legacy** (not Flash-Lite-only, just superseded); `gemini-live-2.5-flash-native-audio` is the older generation. Default is now `gemini-3.8-live`; override with `GEMINI_LIVE_MODEL`. 3.8 notes: `thinking_level` unsupported, proactive audio always on, affective dialog removed — our config sets none of these. **Unconfirmed:** that ephemeral tokens accept 3.8, and its free-tier/pricing (one third-party site lists $0.75/M input, $4.50/M output and no free tier — treat as unverified). Check AI Studio pricing before sustained use (spec: no unapproved paid usage).
2. **Ephemeral tokens need `apiVersion: 'v1alpha'`** (per SDK typings). Used on both server and client.
3. **Free-tier limits** (session length, concurrent sessions, rate) not confirmed.
4. **Hosting** of the Node server (cloud choice) — not decided; nothing deployed.

## Run it locally
```bash
copy .env.example .env   # Windows (macOS/Linux: cp). Set GEMINI_API_KEY (and optionally ELVAR_ACCESS_TOKEN). Node 22.12+
npm run dev:server     # terminal 1  (http://localhost:8787)
npm run dev:web        # terminal 2  (http://localhost:5173, proxies /api)
```
Open the page, click the mic button, allow the microphone, and talk. Use headphones for the first test (echo).

## Deploying to Vercel (config ready; **not deployed yet**)
- `vercel.json` sets `outputDirectory: web/dist` / `npm run build`; `/api/live-token` and `/api/health` are Vercel Functions in `api/` sharing `server/live-token-core.js` with the local server.
- Required Environment Variables (Project → Settings → Environment Variables): `GEMINI_API_KEY`, `ELVAR_ACCESS_TOKEN` (long random string; **without it the endpoint refuses everyone on Vercel**), optional `GEMINI_LIVE_MODEL`, `GEMINI_LIVE_VOICE`.
- Entering the token in the browser: on first use the page asks for `ELVAR_ACCESS_TOKEN` (stored in localStorage).
- Caveats: the 30-tokens/hour cap is per warm function instance (best-effort on serverless). Mic access needs HTTPS (Vercel provides it). Project must be created by the owner (none exists yet for this repo as of this commit).

## Double-clap wake + greeting (standby mode)
**What it does:** while the app is open but not in front (tab/PWA window in the background), a double clap wakes E.L.V.A.R.: it connects to Gemini Live, has the model read **"All systems online. Good Morning|Afternoon|Evening, sir."** (Morning 05–11, Afternoon 12–17, Evening otherwise, from the device clock), then opens the mic for conversation. If Gemini is unreachable it falls back to the browser's local speech synthesis (robotic) and returns to standby.

**Privacy / cost:** detection runs in an AudioWorklet in the browser only — nothing is recorded, stored or sent during standby; no API cost until a wake. The browser's own mic indicator stays on while standby is active. Opt out: open the app with `?standby=0` (persisted); `?standby=1` turns it back on. Standby starts automatically when the browser already has mic permission for the site (or after the mic button is used once); it needs one click/key per page load if the browser blocks audio until then (status shows `TAP TO ARM`). Status labels: `STANDBY` (listening), `CLAP ✓` (one clap heard), `TAP TO ARM`, `MIC BLOCKED`, `WAKING`.

**Detector** (`web/src/live/clap-detector.worklet.js`): 2nd-order 1.2 kHz high-pass → block RMS > max(0.025, 6× noise floor) and a sudden jump (>2× the decaying previous envelope, so reverb tails are not new claps) → must decay below 30 % of peak within 50 ms → two claps 0.12–0.75 s apart, ≥0.5 s calm before, 0.4 s calm after; 3 s cooldown. Browser echo-cancel/noise-suppression/AGC are disabled for the standby stream (they erase claps). Sensitivity: `localStorage.elvar_clap_sensitivity` or `?clapsens=2` (2 = more sensitive). Diagnose with `?clapdebug=1`: the input bar shows live level / threshold / claps heard / rejected.

| Verification | Result |
|---|---|
| Synthetic signals (8 seeds each): double clap at 0.2/0.3/0.6 s gaps, noisy room, softer clap | wakes 8/8 |
| Single clap, triple clap, 0.9 s / 0.06 s gaps, 150 Hz knock, speech-like, music tone, typing, applause (40 claps), room noise | wakes 0/8 |
| Distant/very quiet double clap (A=0.06) | wakes 8/8 |
| Real Chromium + fake mic fed a WAV (double clap / single clap / speech-like) | wakes / no / no |
| **Not verified:** real microphone & real room, real clapping distance, hidden-tab/minimised behaviour (headless Chromium never reports `hidden`), Safari/Firefox, battery impact, the greeting audio itself (no Gemini key in the test container) | — |

**Hard limits of a web app:** it cannot start itself when closed, and a page cannot raise a hidden/minimised window (it only calls `window.focus()` and, if notification permission was granted earlier, shows a notification; the greeting plays even if the window stays hidden, provided the page had a click/key earlier in this load). iOS/Safari suspend background mic capture. Launch-from-closed + bring-to-front belongs to the desktop shell (`desktop/`, below) — the owner's machine is **Windows**; read "Mac Local Worker" in the master spec as "PC (Windows) Local Worker".

**Fix log (owner report: "double clap does nothing"):** (1) standby never armed for users who used the mic before this feature existed (flag unset) and showed nothing → now auto-arms when mic permission is granted and shows its state; (2) browser audio-autoplay block now surfaces as `TAP TO ARM`; (3) default threshold lowered (0.045→0.025) with reverb-tail rejection; (4) added `?clapdebug=1` meter. Re-verified in Chromium **without** the autoplay flag and without stored settings.

## Instant wake (speed + "pop-on" screen)
- **Timeline:** at the *second* clap the app (a) flashes the HUD on and leaves ambient mode, and (b) starts the token request + Gemini connection in parallel; the detector confirms 0.4 s later (rejects a 3rd sound/applause/speech → `cancelPrewarm()` closes the speculative session) and the greeting is sent immediately on the already-warm connection. Measured in Chromium with a fake mic: connection started 0.38 s before the wake was confirmed; flash and connection start at the same instant.
- **Ambient look:** after 45 s without mouse/keyboard/touch activity while in standby, panels fade to ~16 %, top bar/chrome ~45 %, sphere dimmed (slow fade); any activity or the wake snaps it back in 0.14 s with a light pulse. `?ambient=N` sets N seconds (for testing).
- **Greeting delivery:** the model is told to read the line "like a native speaker, fast, crisp, no pauses, no extras" (in addition to the persona's fast-speech rule). Real audio speed is **not verified** (no Gemini key in the test container).
- **Still impossible for a web page:** raising a hidden/minimised window to the front (needs the native desktop app, see `desktop/`). The "pop-on" applies to a window that is open (e.g. on a second display); a hidden window only gets the sound (+ a notification click-to-focus if notification permission was granted).

## Voice speed (1.2x default, pitch preserved)
The Live API has no speaking-rate setting and prompts alone were too slow, so playback is sped up **in the browser** with a WSOLA time-scale worklet (`web/src/live/stretch-player.worklet.js`): the model's 24 kHz stream is time-compressed without raising the pitch. Default **1.2x** (2x and 1.3x were too fast); change with `?speed=1.5` (saved in `localStorage.elvar_speech_rate`; `1` = as generated, which bypasses the worklet). The greeting and all replies use it. Barge-in (`interrupted`) clears the buffer instantly; the mic opens only after the greeting has finished playing.
- Adaptive: with < ~0.2 s of audio buffered the speed eases toward 1x so a slow/real-time stream does not stutter; with a backlog (Gemini normally sends faster than real time) it runs at the full target. If the stream is real-time, 2x is physically limited by the stream.
- Verified: synthetic speech 6 s → plays in 3.1 s at 2x (x1.93), steady 150 Hz tone stays 150 Hz, no added clicks, barge-in silences within one block, 1x stream not distorted (Node harness); in Chromium real-time AudioContext 4.00 s → 4.00 s (1x) / 2.08 s (2x).
- **Not verified:** how real Gemini voice sounds at 2x (artefacts on consonants are possible at this speed), and the real stream's burst speed. Raise/lower with `?speed=` (e.g. `?speed=1.6`).

## Instant answer to the clap (cached greeting)
**Why it was slow:** the greeting used to be generated by Gemini *after* the clap (token ~0.3-0.8 s + connect ~0.5 s + speech generation ~1-2 s => 2-3 s).
**Now:** the greeting is one of only three fixed lines, so its audio is **recorded once and kept on the device** (IndexedDB `elvar-greetings`, raw 24 kHz PCM, ~100 KB each). At the second clap it is played locally through the same 1.2x pitch-preserving player: **audio starts ~46 ms after the HUD flash** (Chromium, measured with a saved greeting). The Gemini connection is warmed up in parallel; the mic opens only after the greeting has finished.
- **Filling the cache:** (1) in the background after standby arms (and every 5 min, covering the part of day changing) a throw-away Gemini session records today's line — never played, no HUD change, uses a single-use token, non-interactive (never pops a prompt), retries at most every 10 min; (2) otherwise the first wake records it. Up to 3 short sessions per voice/persona version. Opt out of (1): `?pregreet=0`.
- **Invalidation:** the server returns `cacheKey` = hash(model, voice, persona text, greeting prompt version); if it differs from a saved recording, the recording is ignored and re-recorded. Changing the voice or persona therefore never plays an old voice.
- **No recording yet:** a short local chime (~60 ms) plays instead and Gemini speaks the greeting as before (then it is saved).
- **Cancelled by applause/speech** within the 0.4 s confirmation: playback stops and the speculative session closes.
- **Not verified:** the real recording step (no Gemini key in the test container) and how the recorded voice sounds; the clap-to-flash delay is ~50 ms by design (decay check) plus audio-driver buffering (not measurable here). Standby mic now uses `latencyHint: 'interactive'` for lower input latency.

## Bring-to-front: desktop shell (`desktop/`)
A browser tab/PWA cannot raise itself (browser security), so a thin Electron app hosts the HUD and does what only a native app can: stays alive hidden (`backgroundThrottling:false`, tray), and at the 2nd clap the web page calls `window.elvarDesktop.bringToFront()` → main process: restore → `setAlwaysOnTop('screen-saver')` + `show/moveTop/focus` (+ `app.focus({steal:true})` and all-Spaces/full-screen visibility on macOS) for 2.5 s. Run instructions: `desktop/README.md`.
- **Verified (Linux, Xvfb, real Electron 45.2.1, fake mic WAV):** with the window **hidden** the clap was still detected → window became visible, focused, always-on-top; access token reaches the page through the preload.
- **Windows (the owner's OS):** `setAlwaysOnTop` + `show/moveTop` put the window visibly in front; Windows' foreground lock may still withhold keyboard focus, so a taskbar flash is the fallback. **Not verified:** any real Windows/macOS behaviour (Xvfb has no window manager, no real focus rules), tray, launch-at-login (needs a packaged .exe; until then use a `shell:startup` shortcut to `desktop/elvar.cmd`).
- Web build is unchanged for browsers; the call is a no-op outside the desktop app.

## Screen first, voice one beat later
At the 2nd clap the HUD flash / bring-to-front fires immediately (~50 ms detection); the greeting voice starts **700 ms later** (`?greetdelay=500` changes it, saved in `localStorage.elvar_greet_delay_ms`; 0 = immediately). The pause is a cancellable timer: applause/speech/3rd clap within the 0.4 s confirmation cancels it, so nothing is spoken. With no saved recording yet, a ~60 ms chime plays at once and Gemini speaks the line as soon as it is ready (always later than one beat). Measured (Chromium, saved greeting): flash at +0 ms, voice at +754 ms; triple clap -> screen lights (speculative) but no voice.

## Bring-to-front for BROWSER users: extension (`extension/`)
Owner uses a Chrome/Edge tab on Windows. A page cannot restore a minimised browser; an extension can. At the 2nd clap the page `postMessage`s `{source:'elvar-hud', type:'bring-to-front'}` (also harmless without the extension); `content.js` (only on allowed sites, same-window/same-origin check) relays it; `background.js` calls `chrome.windows.update({state:'normal' if minimised, focused:true, drawAttention:true})` + `chrome.tabs.update({active:true})`. Allowed sites are added on the options page (optional host permission + dynamic content script); localhost is built in. See `extension/README.md`.
- **Verified (Chromium + openbox under Xvfb, fake mic):** window minimised **and** another tab in front → clap heard → window `minimized→normal`, E.L.V.A.R. tab active; control run without the extension stays minimised.
- **Installed Chrome app (PWA) — the owner's setup:** added `web/public/manifest.webmanifest` (standalone, `launch_handler: focus-existing`, 3 icons, `id:/`) + icons; Chrome reports no installability errors. Extension verified on an `app`-type window: minimised → clap → restored. The owner must **reinstall** the app once to pick up the manifest, and install the extension in the same Chrome profile.
- **Not verified:** real Windows (foreground lock / taskbar flash), whether Chrome keeps listening in a *really* minimised window (Playwright/Xvfb always reports `visibilityState: visible`).

## Getting the extension installed (owner's report: "only the sound reacts")
Cause: the extension was simply not installed (window minimised → only the page's own audio can react). To remove the friction: `npm run build` now packs `extension/` into `web/public/elvar-extension.zip` (`scripts/pack-extension.mjs`, dependency-free ZIP) and the app serves a guide at **`/extension/`** (download button, steps, copy-address button, live "extension detected?" status, and a "minimise now, comes back in 5 s" self-test). The main HUD shows a one-time hint in the input bar when standby is armed but no extension is detected. Verified in Chromium: extension installed from the served ZIP → status flips to detected → test button restores a minimised window; without it the guide says "not detected". Still manual by nature (Chrome does not allow silent installs; Web Store packaging not done).

## Wake-up music (owner's own MP3 — plays once at wake-up; optional loop)
- **Settings page `/settings/`** (static): choose an MP3 (<= 80 MB), test-play, delete, on/off, volume, "volume while a voice is active" (default 30 %). The file is stored **only in this browser's IndexedDB** (`elvar-bgm`) — never uploaded, never in Git. Per device.
- **Playback (`web/src/live/bgm.js`):** at the **2nd clap** (same instant as the screen flash) the track starts from 0 with a 0.15 s fade-in and **plays once, then ends on its own** (owner's request: "only at start-up"). A **"ループする" option** (settings panel / `/settings/`, default off) makes it loop until stopped. Streams from a Blob via a media element → GainNode (no full decode, long tracks fine), own AudioContext at the native sample rate. Prepared while standby is armed so the wake needs no click.
- **Stop (while it plays):** the small `♪ BGM ■ STOP` pill at the bottom centre (only visible while playing; kept outside the HUD artwork), the **Esc** key, or the desktop app's tray item "起動ミュージックを停止". A false alarm (applause / 3rd clap within the 0.4 s confirmation) stops it at once.
- **Ducking:** while the greeting/reply voice is playing or the mic is open, the music volume drops to `volume x duck` (smooth 0.25 s ramps) and returns afterwards — also keeps the music out of the microphone.
- **Verified (Chromium, real MP3 made with ffmpeg):** file saved via the settings page; music starts 58 ms after the flash; a 2.4 s track keeps looping for 6 s; pill shows; Esc stops (paused, pill hidden); triple clap leaves nothing playing; gain trace 0 -> 0.8, 0.2 during the voice, 0.8 after. **Not verified:** real speakers/echo into a real microphone, very large files, Safari, the desktop tray item, the phone layout (clap wake is a desktop feature).

## In-app settings panel
Opens from the HUD's **gear icon** (top right), **Ctrl+,** (⌘+, on Mac) or `?settings=1`; closes with the button, a click outside, or **Esc** (Esc closes the panel first and does not stop the music). Implemented in `web/src/settings-panel.js`; the gear click is caught by event delegation, so the HUD artwork files are untouched. Sections: wake-up music (choose/test/delete the MP3, on/off, volume, volume while a voice is active), voice (speaking speed 1.00-2.00x applied live to the player; pause between the clap and the voice 0-1.5 s), clap standby (on/off, sensitivity 0.5-3x applied on release, extension status + link to `/extension/`). Everything is stored on the device (localStorage / IndexedDB) and persists across reloads. The URL options (`?speed=`, `?greetdelay=`, `?clapsens=`, `?standby=`) still work. `/settings/` remains as a standalone page for the music only.
- **Verified (Chromium):** gear opens it; file saved and listed; all sliders persist, survive reload, and the speed slider updates the live client; Esc / Ctrl+, behave; delete works; no page errors. **Not verified:** the phone layout (the gear is not in the phone design — an entry point there must be chosen once the phone HUD is finished), desktop-app tray, real-ears check of speed/delay changes.

## Phone layout (owner-approved Opus design pass) — added
Portrait viewports (width/height < 1.05) use a dedicated phone HUD matched to the owner's phone screenshot (`web/src/hud/template-mobile.js`, `hud-mobile.css`, sphere `variant:'mobile'`); landscape keeps the desktop HUD. Same API/behaviour (LISTEN/THINK tabs follow the state, NEXA card shows the status label, waveform follows `setAudio`, ambient/flash work). Details and fidelity evidence: `docs/HUD_NOTES.md` ("Phone layout"), side-by-side `docs/hud-compare-mobile.png`. The "NEXA" label comes from the owner's photo (`mockData.agentName`). **Settings on the phone:** the person icon (top right) opens the settings panel (`data-vh-settings`). Re-verified by the parent: desktop 1671x941 has 0 differing pixels outside the sphere vs the original baseline; the real app at 393x852 mounts the phone layout with no console errors, the settings panel opens from the person icon and fits the screen. **Not verified:** real iOS/Android devices (safe-area insets, touch), Safari/Firefox.
