# HUD notes (E.L.V.A.R. Mark1)

## Structure
- `web/index.html` holds `#hud-root` and loads `src/main.js` (owned by the live/Gemini code).
- `web/hud-demo.html` and `web/src/hud/demo.js` are a standalone demo with no backend. It has state buttons, level/pitch sliders, a synthetic speech envelope, and transcript/status buttons. Open the panel with the "demo ⚙" button or `?panel=1`.
  Other URL params: `?freeze=1`, `?state=`, `?level=`, `?pitch=`, `?source=mic|model`, `?synth=1`.
- `web/src/hud/`
  - `index.js`: `mountHud()`, the layout scaler, the clock and input wiring.
  - `template.js`: DOM markup.
  - `hud.css`: all styling.
  - `frames.js`: chamfered SVG frames, chrome lines, ring gauges, sparklines.
  - `icons.js`: inline SVG icons, logo and wordmark.
  - `sphere.js`: the Canvas 2D core sphere.
  - `mockData.js`: **PLACEHOLDER, not real data.** It holds the schedule, tasks, agents, activity, system stats and weather. You can override it with `mountHud(el, { data: { schedule: [...] } })`.
- Layout: a fixed design stage of 1671×941 (the reference image size). It is scaled with a CSS transform to fit the viewport and letterboxed on the grid background. Coordinates were traced from the reference.
  When the viewport is portrait (width/height < 1.05) the **phone layout** is used instead (see "Phone layout" below). Landscape phones keep the desktop layout.
- Fonts are self-hosted with `@fontsource/barlow-semi-condensed` (Latin UI text) and `@fontsource/noto-sans-jp` (Japanese and digits). Only the unicode-range slices a page uses are downloaded. Fallback stack: Hiragino Sans, Yu Gothic UI, Meiryo, sans-serif.

## API (`web/src/hud/index.js`)
```js
const hud = mountHud(rootEl, { data?, placeholder?, freezeClock?, layout? /*'auto'|'desktop'|'phone'*/, phoneAspect? /*1.05*/ });
hud.setState('idle'|'connecting'|'listening'|'thinking'|'speaking'|'error');
hud.setAudio({ level /*0..1*/, pitch /*0..1, default .5*/, source /*'mic'|'model'*/ }); // call every frame
hud.setTranscript(text, 'user'|'model');  // '' restores the placeholder
hud.setPlaceholder(text);
hud.setStatusLabel(text);                 // "ONLINE" default; /offline/i greys the dot
hud.setMicActive(bool);                   // visual only, does NOT fire onMicToggle
hud.onMicToggle(cb);                      // cb(isOn); returns an unsubscribe fn
hud.onSend(cb);                           // cb(text) from the send button or Enter; returns an unsubscribe fn
hud.layout;                               // 'desktop' | 'phone' (read-only)
hud.state; hud.audio;                     // current state and the last raw audio level { level, source } (read-only; used by other skins)
hud.setSphereRunning(bool);               // stop / resume drawing the core sphere while something covers it
hud.destroy();
```
`?layout=phone|desktop` forces a layout from the URL (the old `compactBreakpoint` option is gone).
- Audio is smoothed inside `sphere.js` with a 45 ms attack, a 300 ms release and a 180 ms pitch smoothing time constant.
  - Level drives the sphere scale, the core and halo glow, ring brightness and thickness, and node displacement.
  - Pitch drives the ripple spatial and temporal frequency, the hue shift (cyan to blue) and a rotation boost.
  - `source: 'mic'` gives a slight inward pull plus a node shimmer.
  - `source: 'model'` gives outward travelling waves plus expanding pulse rings on peaks.
- States:
  - connecting: arcs spin and a comet sweep runs around the dashed ring.
  - thinking: a 3-arm inner swirl appears and the arcs and mesh rotate faster.
  - error: an amber/red tint.
  - listening: the mic button pulses.
- `?freeze=1` (or `freezeClock: true`) pins the clock to `10:24` / `2025年4月21日 (月)`. The sphere keeps animating.
- The render loop pauses while the tab is hidden. `prefers-reduced-motion` slows all motion to 0.35× and turns off pulse rings; it does not remove them. The backing store follows devicePixelRatio and the CSS scale, capped at 1800px.

## How fidelity was verified
- A Playwright/Chromium script (in the agent scratchpad, not the repo) loads `hud-demo.html?freeze=1` at 1671×941. Region crops of the screenshot were compared side by side with the reference (top bar, each panel, sphere, input bar, bottom-right), and the result was iterated on.
- `docs/hud-compare.png`: the reference is on the left and the HUD is on the right.
- Automated checks:
  - Sphere animation: idle frames 1 s apart differ (mean abs diff about 6).
  - Audio response: level 0 vs 0.9 (model) gives a diff of about 23, and mean sphere luminance goes from 42.7 to 61.7.
  - All API methods behave as specified, including Enter-to-send and `setMicActive` not firing the callback.
  - No console errors or warnings.
  - At 390×844 there is no horizontal or vertical overflow.
  - `destroy()` empties the root.
  - `vite build` succeeds.

## Known deviations
- The sphere is procedural, so its node layout, line pattern and core bloom only approximate the reference painting. The reference mesh is a bit denser and softer.
- The fonts are close substitutes. The reference typeface is unknown; Barlow Semi Condensed plus Noto Sans JP is the best match found. The ELVAR wordmark and logo are hand-drawn SVG approximations.
- The placeholder uses the string from the spec, `どうぞ、話してください... (聞いています)`, with half-width parentheses. The image appears to show full-width `（ ）`.
- The decorative ring-gauge arcs copy the image (`arcs` in mockData), not the literal percentages.
- The top nav, View All links and side icons are visual only, with no routes.
- Not verified: real-GPU frame rate (headless Chromium measured about 50 rAF/s with software rendering), Safari/Firefox rendering, and the real Gemini audio feed.

## Full-screen elastic layout (added after Phase 1 review)
The 1671x941 design stage is scaled uniformly to fit, then the leftover space (`--dx`/`--dy`, in design px) is spread by anchoring: left panels left, right panels right, sphere + input bar centred, top bar top, bottom strip bottom (`--fx`/`--fy` per element in `hud.css`). The chrome frame lines are regenerated per size (`chromeSvg(dx, dy)` in `frames.js`) so they stay joined to the content. At exactly 1671x941 the output is pixel-identical to the previous fixed layout (verified: non-sphere diff = 0). Verified without overflow/errors at 1671x941, 1920x1200, 2560x1080, 1440x1080, 1280x720. Sphere size is not enlarged on large displays (known gap on very large/tall screens).

## Sphere motion: smoothing and containment (calmer revision)
- Audio path: noise gate (0.06) → soft compression → two low-pass stages (attack 70 ms / release 320 ms, then 120 ms) → gentle gains. Pitch is smoothed over 400 ms.
- Mesh ripples are slow and small (≤ ~3.5 % radius) and every projected node is hard-capped at r = 194 (inner thin ring is r = 207); speaking ripples are capped at r = 204.
- Measured with synthetic input (1800 frames, node harness): old max mesh radius 230 → new 194; mean frame-to-frame level change 0.049 → 0.003 (alternating 0/1 input) and 0.018 → 0.006 (speech-like input).

## Phone layout
- Files: `web/src/hud/template-mobile.js` (markup), `web/src/hud/hud-mobile.css` (styles, all scoped under `.vh-root.vh-phone`), plus phone icons / logo / wordmark in `icons.js` and `agentName` + `phoneAgents` in `mockData.js` (**PLACEHOLDER — not real data**; the weather card reuses `weather`).
- Reference: the 852x1846 phone screenshot. The OS status bar and home indicator are not drawn; the content respects `env(safe-area-inset-*)` (index.html has `viewport-fit=cover`).
- Selection: portrait (width/height < `phoneAspect`, default 1.05) => phone, otherwise desktop. `mountHud` picks the layout at mount; a ResizeObserver rebuilds the DOM when the viewport flips (rotation / window resize). On a rebuild the old sphere is destroyed (rAF + visibilitychange listener removed) and state is re-applied: setState, status label, transcript, placeholder, mic, ambient and the text typed in the input. Callbacks registered with `onSend` / `onMicToggle` survive. Verified over 18 flips: one canvas at a time, rAF rate does not grow, no errors.
- Scaling: the stage is 852 design px wide, `s = vw/852`. The top group (bar, date, ACTIVE AGENTS) is pinned to `max(101, safeTop/s + 4)`, the bottom group (cards + input) to `max(125, safeBottom/s + 40)` from the bottom (the reference values at 852x1846). The sphere block (side tabs, sphere, platform) is centred in the space between and scaled down (`--vm-m`, min 0.55) when the screen is short. Squarer screens (width/height > 0.62, e.g. tablets) fit the height instead (design height 1700) and centre the 852 column. The frame lines that run off-screen are drawn long enough to reach the viewport edge.
- Date: live (`MON` / `26` / `Oct 2026` format, English weekday and month); with `?freeze=1` it is fixed to `MON / 26 / Oct 2026`.
- Placeholder: the phone default is `話しかけてください…` (desktop keeps its own). `setPlaceholder(text)` overrides both; passing either default string brings back the per-layout default. The phone `<input>` also has the legacy `.vh-text` class that `main.js` reads.
- API on the phone:
  - LISTEN tab (left) lights up in `listening`, THINK tab (right) in `thinking`: the label, dot and line glow, the inner frame line brightens, and `>>` animates (no animation under reduced motion).
  - `setAudio` drives the shared sphere renderer exactly as on desktop. It also drives the mic glow, and the NEXA waveform bars scale with the smoothed level, clamped inside the card. In `speaking` the waveform glows brighter.
  - `setStatusLabel` sets the text under NEXA. `/offline/i` greys the dot, the `error` state turns it amber, and in `connecting` it blinks.
  - `setTranscript` shows in the input bar, and the real `<input>` stays typable. Enter or the send icon fires `onSend`, and the field clears.
  - `setAmbient(true)` dims the cards and tabs to 0.16, the top bar to 0.45 and the sphere to 0.7 opacity with brightness 0.7. `flash()` pulses and leaves ambient instantly.
- Sphere `variant: 'mobile'` (`sphere.js`, chosen automatically): 1 canvas unit = 1 reference px, centre (425.5, 869). It has a deeper blue body, a small white core, 560 evenly lit nodes and 6 bright arcs on a slightly tall ellipse (rx 223 / ry 231). There are thin rings at 190 / 201 / 208 / 246 / 277 / 290 / 300 / 316 / 348, a dash band at 258–266 and fine ticks at 278–286. The desktop variant's code path and constants are unchanged.
  - Smoothing and the audio path are shared.
  - Containment (node harness, 1800 frames each of max model, max mic, alternating 0/1 and random audio): the maximum mesh radius is 171.8, under the hard cap of 176 (innermost thin ring r = 188). Ripples are capped at 184.
- Verification (Playwright, scratchpad scripts):
  - `hud-demo.html?freeze=1` at 852x1846 was compared region by region with the reference. Ink bounding boxes of every text and icon element are within about 2 px of the reference.
  - Whole-image mean absolute difference: 8.9/255, excluding the OS bars.
  - `docs/hud-compare-mobile.png` shows the reference on the left and the HUD on the right.
  - At 852x1846, 393x852, 430x932, 360x640, 768x1024, 1024x1366 and 320x568 there is no horizontal or vertical overflow, every key element's box is inside the viewport, and the sphere rings do not overlap the cards.
  - Desktop at 1671x941: the diff against the pre-change baseline is 0 px outside the sphere box. At 1920x1080 and 1280x720 all diffs fall inside the sphere area.
  - With `prefers-reduced-motion` there are no errors. The sphere still animates (slowed) and the tab chevrons are static.
  - No console errors. `vite build` passes.
- Known deviations (phone):
  - The sphere is procedural, so its mesh pattern, core bloom and arc rotation phase only approximate the painting. The arcs slowly rotate, so they sit a few degrees off the photo depending on capture time.
  - The light streak above the sphere and the light column under the platform are fainter than in the photo.
  - Fonts are the same substitutes as on desktop (Barlow Semi Condensed / Noto Sans JP). The logo and wordmark are hand-traced SVGs.
  - The nav icons, agent buttons and chevron are visual only.

## ヒューマンプロトコル (Human Protocol)
Saying 「ヒューマンプロトコル」 (ASR variants such as フューマン… are accepted) or typing it turns E.L.V.A.R. into a humanoid made of particles; 「プロトコル解除」「通常に戻して」「ヒューマンプロトコル終了」, Escape, or the `human_protocol` tool (`action: 'stop'`) turns it back.
- Pure parts (command detector, timing/easing, viewport fit, data format): `web/src/human-protocol.js` (tested in `test/human-protocol.test.mjs`).
- Renderer + controller: `web/src/human/` (WebGL1, all motion in the vertex shaders; Canvas2D fallback with `?human2d=1` or when WebGL fails). Loaded with `import()` on first use.
  - The figure is drawn into its own full-resolution buffer (light scaled down for headroom), blurred by a 5-level down/up-sample bloom chain, and composited with hue-preserving tone mapping (bright cores stay orange/gold instead of flat white), a faint chromatic fringe, vignette and grain.
  - Particles are soft round sprites (≥ 2.4 px, faded instead of shrunk); wires are anti-aliased tapered ribbons along Catmull-Rom curves; trails follow particles while they fly.
  - Formation: radial burst → curled flight → soft landing, then a small "snap" (the figure tightens with a slight overshoot and the outline flares). Alive: breathing, head sway, a coherent flow field, layered parallax, a light wave rising through the body, a slow heartbeat of the orange cores.
  - Resolution: up to 2.5× device pixels (≤ 5.5 M px); an adaptive quality (0.5..1) lowers resolution / particle share when frames are slow (`?humanq=1` locks it).
- Assets: `web/src/human/human-data.bin` (particles, traced wire curves, orange hot nodes, stars) and `human-bg.webp` (background with the figure painted out), built offline from `scripts/assets/human-protocol-ref.webp` by `NODE_PATH=$(npm root -g) node scripts/build-human-particles.mjs [--debug dir]`.
- While active only the canvas and the input bar (with the mic) are visible; the voice, clap standby and tools keep working. The figure follows `hud.state` / `hud.audio`: listening brightens it, thinking sends pulses along the wires, speaking makes the hot nodes and the warm particles pulse with the voice level.
- Life (`web/src/human-rig.js`, tested): a small rig — chest, shoulders, neck, head — moved by irregular breathing (noise-varied rate and depth), a lub-dub heartbeat whose rings of light sweep out from the chest core along the wires (idle slow, thinking fast, speaking on the voice's onsets), random gestures every ~4–15 s (deep breath, head tilt, nod, look aside, shrug), the state (listening leans in, thinking tilts the head and sends waves from the forehead, speaking moves head/throat with the voice) and a recent pointer (the head turns towards it, nearby particles make way). Inner particles stream out from the heart and are reborn, outline particles drift off and are reborn, particles near the orange core orbit it.
- Gaze: while a pointer is on the page (moving or resting, up to ~8 s of rest; a touch for ~4 s) the face turns towards it (yaw ±~28°, pitch ±15°, as on a sphere, plus a little neck tilt) on a slightly under-damped spring; two faint cyan-white eye lights in the hollow face look ahead of the head (saccade-like), blink every 3–7 s and glow more while speaking or when the pointer is near the face (then it also leans in). `TUNE.eye` sets their strength (0 hides them). Reduced motion follows at 40 %.
- 3D: every particle has a depth (the 12th byte of its record, ±220 reference px). The build script turns the silhouette into a volume — every row is an elliptical cross-section (head ≈ as deep as wide, neck round, torso ≈ half as deep as wide) — and puts each particle on the front surface, the back surface or (sparsely) inside; each wire curve lies on one surface; extra rim particles cover the sides. The vertex shaders rotate the head on the neck in 3D (yaw / pitch / roll), turn the whole bust slowly, breathe front-back, and project through a perspective camera that drifts a little around the figure; the far side is darker, smaller and cooler. The 2D fallback fakes it (sideways shift by depth, perspective size).
- Stronger 3D (TUNE in `web/src/human/renderer.js`, 1 = default, 0 = off): `turn` the body's slow swing (±20–26°, plus a little lean), `orbit` the camera's orbit (±15–19° left/right, ±6–7° up/down, long irregular periods), `shade` light/dark by the surface's direction (head ellipsoid, round neck, torso cross-sections; light from the upper left front, the far side dim and translucent), `rim` the glowing silhouette edge, `dof` far/near particles grow larger and softer, `fog` the far side dims and turns blue, `dust` ~3200 floating 3D dust particles around the figure (parallax), `bgPar` the background / star parallax. Depth: head 1.15 × its width, neck 1.0, torso 0.64 (`DEPTH` in human-protocol.js); the camera stands 1700 reference px away. Try e.g. `__elvar.humanProtocol.controller.tune({ turn: 0.6, orbit: 0.6 })`.
- Pointer: moving it only steers the face and eyes. A click / tap (not on the input bar or the mic) sends a shock ring from that point and, on the figure, pushes the particles there aside for about a second (`clickEnv` in human-rig.js); off the figure only the faint ring shows.
- Hands (front camera, `web/src/hand-source.js` + `web/src/hand-gesture.js`): while the protocol is on (and the page visible, the phone unlocked) the front camera (640×480) feeds MediaPipe HandLandmarker in the browser; frames never leave the device (no upload, no storage, no recording) — only landmark coordinates go to the gesture tracker. A tiny dot + hand icon in the top-right corner shows that the camera is on (`?handcam=1` adds a small mirrored preview). The hand (mirrored; two hands → their midpoint) is the gaze target, ahead of the cursor while it is the most recent input; a fast sideways swipe turns the body that way; a pinch or a fist sends the click's shock ring at that point; an open palm held still draws the figure in (it leans in, the core beats harder); a near / far hand makes it lean in / draw back and the eyes glow more / less; waving gets a nod with a tilt ("greet"). Thresholds: `HAND` in hand-gesture.js; strengths: `HANDFX` in human-rig.js. Off with `localStorage.elvar_handtrack = '0'`. Refused / no camera / detector not loadable: nothing happens (console.warn only). MediaPipe's WASM (14 MB) is copied into the build by `web/vite.config.js` (`/mediapipe/`); the model (7.8 MB) comes from Google's model storage unless `/mediapipe/hand_landmarker.task` is provided. The Android app's WebView grants only the microphone today (camera requests are denied → hand tracking is simply off there).
- Smooth start: the app prepares the protocol while idle (~4 s after start, `requestIdleCallback`; not on a locked phone, with data saver or 2G; off with `?humanpreload=0`): module, data, background, shaders (compiled without blocking — `KHR_parallel_shader_compile` where available, otherwise one program per slice), buffers (uploaded between yields) and a few off-screen frames at the final size. The renderer is kept after a show for the next one. The HUD fades with opacity only on compositor layers (`will-change` only during a fade). The camera / hand detector start only after the formation, in an idle moment, and the detector (MediaPipe) runs in a Worker (`web/src/hand-worker.js`, frames as transferred ImageBitmaps). The adaptive quality ignores the first 2 s and changes at most once per 4 s (each change resizes the canvas). `controller.stats().startup` shows what the start cost.
- Debug (`?clapdebug=1`): `__elvar.humanProtocol.start()/stop()/active`, and `.controller` → `seek(sec)`, `freeze(bool)`, `advance(sec)` (with freeze: deterministic steps), `quality(q)`, `tune({...})`, `rig()`, `eyes()`, `pose({...})`, `syncTime(sec)` (with `?humanseed=N`: identical A/B runs), `feedHands(hands, t)`, `hands()`, `stats()` (frame times, draw calls).

- 履修登録サポート (course registration support: timetable, credits vs graduation requirements, CAP, checks, suggestions, link to the シフト screen): see `docs/COURSES.md`.

- ファイルの取り込み・保存・印刷 (file library on this device, 「〇〇プリントして」 with preview, approval card, print dialog and an honest 「印刷できましたか？」 check): see `docs/FILES_PRINT.md`. Reading the files' content, the memory (keywords / kind / tags / duplicates / search), 60 MB limit and the AI-reading approvals: `docs/FILES_MEMORY.md`.
