// ヒューマンプロトコル renderer: WebGL1, all particle / wire motion computed in the vertex shaders.
// Per frame:
//   figure buffer (full resolution, light scaled by GAIN so bright cores keep headroom in 8 bits):
//     wire curves (anti-aliased tapered ribbons) → particles (soft round sprites; + 2 trail passes while they fly) → orange hot nodes
//   bloom: 5-level down-sample / tent up-sample chain of the figure buffer (soft inner glow, wide halo)
//   screen: nebula background (+ vignette, fine grain) → stars → figure + bloom, hue-preserving tone mapping, faint chromatic aberration.
// A small Canvas2D fallback draws a reduced figure when WebGL is not available.
import { TIMING, seeds, formProgress, exitProgress, flightPoint, snapScale, Z_MAX, zOf, DEPTH } from '../human-protocol.js';

const T = TIMING;
const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const GAIN = 0.42;          // light written into the 8-bit figure buffer is scaled by this; the composite undoes it before tone mapping
const BLOOM_LEVELS = 5;
export const CAM_D = 1700;   // camera distance (reference px): close enough for a clear perspective

/** Look constants (brightness / glow), tuned against the reference artwork. */
export const TUNE = { part: 3, partSize: 1, line: 2.1, lineWidth: 0.7, node: 1.7, nodeSize: 1.1, bloom: 1.55, bloomUp: 0.62, exposure: 1.6, ca: 0.0016, grain: 1, trail: 0.5, eye: 1.1, ripple: 0.5,
  // 3D look: turn = the body's swing, orbit = the camera's orbit, shade = light/dark by the surface's direction, rim = glowing silhouette edge,
  // dof = far / near particles grow soft, fog = the far side dims and turns blue, dust = 3D floating dust around the figure, bgPar = background parallax
  turn: 1, orbit: 1, shade: 1, rim: 1, dof: 1, fog: 1, dust: 1, bgPar: 1 };   // eye: the eye lights (kept faint: the face stays hollow and smooth)

// Shared vertex code. The figure is a 3D volume: every particle has a depth (z, + towards the viewer). The rig (chest, shoulders,
// neck, head) deforms and rotates it in 3D, the body turns slowly, and a perspective camera drifting around it projects it to the screen.
// The flights out of / back into the core run in the projected plane, with their depth as a scale.
const COMMON = `
precision highp float;
uniform vec2 uRes; uniform vec3 uFit; uniform vec2 uRef;
uniform float uT, uFormT, uExitT, uExiting, uMotion, uLag, uSnap;
uniform vec2 uCoreRef; uniform float uCoreR;     // the core sphere (reference px): start and end of every flight
uniform vec4 uRig0, uRig1, uRig2, uRig3, uRig4, uRig5;
// (breath, chest, shoulder L, shoulder R) (sway, tilt, yaw, nod) (lean, voice bob, outline pulse, -) (pitch, gaze x, gaze y, eye open) (eye glow, eye size, near, -) (body yaw, camera yaw, camera pitch, -)
uniform vec4 uWav[4]; uniform vec4 uWavSpeed; uniform float uBeat;
uniform vec4 uClk[3];                            // clicks: (x, y ref px, age s, strength)
uniform vec4 uShade;                             // (shade, rim, depth of field, fog) strengths
float gLife; float gGlow; float gDepth; float gScale;
float eio(float p){ p = clamp(p, 0., 1.); return p < .5 ? 4.*p*p*p : 1. - pow(-2.*p + 2., 3.) / 2.; }
float eout(float p){ p = clamp(p, 0., 1.); return 1. - pow(1. - p, 3.); }
float flightEase(float p){ return .35 * eout(p) + .65 * eio(p); }
float exitEase(float p){ p = clamp(p, 0., 1.); return .6 * p*p*p + .4 * eio(p); }
vec2 flight(vec2 a, vec2 b, float e, vec4 s){
  vec2 d = b - a; float len = max(length(d), 1.); vec2 u = d / len;
  float ang = 6.2832 * s.z;
  vec2 r = normalize(vec2(cos(ang), sin(ang)) * .65 + u * .35 + 1e-5);
  vec2 p1 = a + r * len * (.22 + .25 * s.w);
  vec2 p2 = b - u * len * .25 + vec2(-u.y, u.x) * (s.x - .5) * .7 * len - vec2(0., len * .12 * s.y);
  float v = 1. - e;
  vec2 p = v*v*v*a + 3.*v*v*e*p1 + 3.*v*e*e*p2 + e*e*e*b;
  float w = sin(3.14159 * e) * len * .06;
  return p + vec2(sin(e * 9.4 + s.x * 20.), cos(e * 7.5 + s.y * 20.)) * w;
}
vec2 field(vec2 p, float t){
  return vec2(sin(p.y * .021 + t * 1.3) + .6 * sin(p.y * .047 - p.x * .013 + t * .7),
              cos(p.x * .019 - t * 1.1) + .6 * cos(p.x * .041 + p.y * .017 + t * .9));
}
vec2 rot(vec2 q, float a){ float c = cos(a), s = sin(a); return vec2(q.x * c - q.y * s, q.x * s + q.y * c); }
vec3 rotY(vec3 q, float a){ float c = cos(a), s = sin(a); return vec3(q.x * c + q.z * s, q.y, -q.x * s + q.z * c); }
vec3 rotX(vec3 q, float a){ float c = cos(a), s = sin(a); return vec3(q.x, q.y * c + q.z * s, -q.y * s + q.z * c); }
// ---- the rig, in 3D (reference px; x right, y down, z towards the viewer)
vec3 rig(vec3 P){
  vec2 n = P.xy / uRef;
  float head = smoothstep(.505, .44, n.y), neck = smoothstep(.62, .5, n.y);
  float sideL = smoothstep(.06, .2, .505 - n.x), sideR = smoothstep(.06, .2, n.x - .505);
  float band = smoothstep(.52, .62, n.y) * (1. - smoothstep(.82, 1., n.y));
  float chest = smoothstep(.56, .7, n.y), upper = 1. - smoothstep(.75, 1.05, n.y);
  float m = uMotion;
  vec3 Cc = vec3(uRef * vec2(.505, .78), 0.);
  // breathing: the chest widens and fills out front-back, the upper body rises, each shoulder lifts in its own way
  P.x = Cc.x + (P.x - Cc.x) * (1. + uRig0.y * .011 * chest * m);
  P.z *= 1. + uRig0.y * .05 * chest * m;
  P.y -= uRig0.x * 3.2 * upper * m;
  P.y -= (uRig0.z * sideL + uRig0.w * sideR) * band * 7. * m;
  // leaning in (listening, the pointer near the face): towards the viewer, the head a little lower
  P.z += uRig2.x * 22. * upper * m; P.y += uRig2.x * 4. * head * m;
  P.y += (uRig1.w * 5. - uRig2.y * 2.4) * head * m;
  // the head turns on the neck in 3D: yaw (relative to the body), pitch, roll
  vec3 Pn = vec3(uRef * vec2(.505, .5), 0.), q = P - Pn;
  q = rotY(q, uRig1.z * head * m);                  // (uRig1.z: the head's turn relative to the body)
  q = rotX(q, uRig3.x * head * m);
  q.xy = rot(q.xy, uRig1.y * (.35 * neck + .65 * head) * m);
  P = Pn + q;
  // the whole bust turns slowly about its vertical axis, and sways about a point below it
  vec3 Pb = vec3(uRef.x * .505, 0., 0.);
  P = Pb + rotY(P - Pb, uRig5.x * m);
  vec3 Pt = vec3(uRef * vec2(.505, 1.2), 0.);
  P = Pt + rotX(P - Pt, uRig5.w * m);                                             // and leans a little forward / back
  vec2 Ps = uRef * vec2(.505, 1.3);
  P.xy = Ps + rot(P.xy - Ps, uRig1.x * m);
  return P;
}
// perspective camera, slowly drifting around the figure; gDepth = depth in view, gScale = perspective size factor
const float CAM_D = ${f(CAM_D)};
vec2 project(vec3 P){
  vec3 C = vec3(uRef * vec2(.505, .62), 0.), Q = P - C;
  Q = rotY(Q, uRig5.y * uMotion); Q = rotX(Q, uRig5.z * uMotion);
  gDepth = Q.z; gScale = CAM_D / (CAM_D - Q.z);
  return C.xy + Q.xy * gScale;
}
// rings of light (the heartbeat from the chest core, thoughts from the forehead) sweeping through the body; they also nudge the particles
float rings(vec2 p, out vec2 push){
  float g = 0.; push = vec2(0.);
  for (int i = 0; i < 4; i++) {
    vec4 w = uWav[i];
    vec2 d = p - w.xy * uRef; float r = length(d) + 1e-3;
    float ring = exp(-pow((r - w.z * uWavSpeed[i]) / 42., 2.)) * w.w * exp(-w.z * 1.1);
    g += ring; push += d / r * ring;
  }
  return g;
}
// clicks / taps: a shock ring, and particles near the click make way for about a second (never on mere pointer movement)
vec2 clicks(vec2 p, out float glow){
  vec2 push = vec2(0.); glow = 0.;
  for (int i = 0; i < 3; i++) {
    vec4 c = uClk[i];
    vec2 d = p - c.xy; float r = length(d) + 1e-3;
    float env = (1. - exp(-c.z * 14.)) * exp(-c.z * 3.2);
    push += d / r * exp(-r * r / (${f(110)} * ${f(110)})) * env * c.w * ${f(26)};
    glow += exp(-pow((r - c.z * ${f(620)}) / 34., 2.)) * exp(-c.z * 2.4) * (step(1e-5, c.w) * .55 + .45 * c.w);
  }
  return push;
}
// k = (dust, onLine, outline, heat)
vec3 living(vec3 P, vec4 s, vec4 k){
  vec3 C = vec3(uRef * vec2(.505, .77), 0.);
  P = C + (P - C) * uSnap;
  P = rig(P);
  vec2 wp; gGlow = rings(P.xy, wp); P.xy += wp * 2.4 * uMotion;
  float cg; P.xy += clicks(P.xy, cg) * max(uMotion, .5); gGlow += cg * 1.4;
  P.xy += field(P.xy, uT * .25) * (.9 + k.x * 2.) * uMotion;                    // coherent: neighbours (and wire vertices) move together
  float r = (.3 + 1.1 * s.w + k.x * (3. + 6. * s.z)) * uMotion * (1. - k.y);
  float a = uT * (.35 + .8 * s.x) * (s.y > .5 ? 1. : -1.) + 6.2832 * s.y;
  P.xy += r * vec2(cos(a), sin(a * 1.3));
  gLife = 1.;
  if (k.y < .5) {
    if (k.x < .5 && k.z < .5 && s.x < .22) {                                     // blood: inner particles stream out from the heart and are born again
      float life = fract(uT * (.07 + .06 * s.y) + s.z);
      P.xy += normalize(P.xy - uRef * vec2(.515, .765) + vec2(.01)) * (life - .5) * 40. * uMotion; gLife = sin(3.14159 * life);
    } else if ((k.z > .5 || k.x > .5) && s.w > .55) {                            // the outline breathes off particles that drift up, fade and are reborn
      float life = fract(uT * (.1 + .1 * s.y) + s.x);
      P.xy += (normalize(P.xy - uRef * vec2(.505, .55) + vec2(.01)) * 9. + vec2((s.z - .5) * 8., -14.)) * life * uMotion;
      gLife = smoothstep(0., .12, life) * pow(1. - life, 1.4) * 1.3;
    }
    if (k.w > .45 && s.z > .7) {                                                 // particles near the orange core orbit it (in depth too)
      vec3 cc = vec3(uRef * vec2(.515, .765), 40.), q = P - cc; float rr = length(q.xy);
      float an = uT * (.25 + .35 * s.y) * (60. / (rr + 40.)) * uMotion * (1. - smoothstep(70., 120., rr));
      q.xz = rot(q.xz, an); P = cc + q;
    }
  }
  P.y -= k.x * uMotion * 4. * sin(uT * .2 + s.x * 6.2832);
  return P;
}
vec2 toScreen(vec2 ref){ return uFit.yz + ref * uFit.x; }
// the particle's place on the screen (reference px): its living 3D position, projected; on its way out of / back into the core along the flight
vec2 placed(vec3 tgt, vec4 s, vec4 k, out float e, out float ex){
  vec2 tp = project(living(tgt, s, k));
  float sT = gScale;
  float ang = 6.2832 * s.z; vec2 st = uCoreRef + uCoreR * .55 * sqrt(s.w) * vec2(cos(ang), sin(ang));
  float ft = uFormT - uLag;
  e = flightEase((ft - (${f(T.emitDelay)} + s.x * ${f(T.stagger)})) / (${f(T.flightMin)} + s.y * ${f(T.flightSpread)}));
  vec2 p = flight(st, tp, e, s);
  float fs = mix(.45 + 1.2 * s.w, sT, e);                                         // some come from far behind, some swing close to the viewer
  ex = 0.;
  if (uExiting > .5) { ex = exitEase((uExitT - uLag - s.y * ${f(T.exitStagger)}) / (${f(T.exitFlight)} + s.x * ${f(T.exitFlightSpread)})); p = flight(p, st, ex, vec4(s.x, s.y, 1. - s.z, s.w)); fs = mix(fs, .45 + 1.2 * s.y, ex); }
  gScale = fs;
  return p;
}
float fog(){ return clamp(.62 + gDepth / 430. * (1. + uShade.w), .16, 1.3); }    // the back of the body is darker (and bluer), the front brighter
// the body's surface direction at an (un-deformed) point: the head an ellipsoid, the neck a cylinder, the torso elliptical cross-sections
float ratio(float y){ return ${f(DEPTH.head)} + (${f(DEPTH.neck)} - ${f(DEPTH.head)}) * smoothstep(.44, .5, y) + (${f(DEPTH.torso)} - ${f(DEPTH.neck)}) * smoothstep(.54, .66, y); }
vec3 normalAt(vec3 P0){
  vec2 n = P0.xy / uRef; float r = ratio(n.y);
  vec3 headN = normalize(vec3((P0.x - uRef.x * .505) / (165. * 165.), (P0.y - uRef.y * .25) / (195. * 195.), P0.z / (190. * 190.)));
  vec3 bodyN = normalize(vec3(P0.x - uRef.x * .505, -smoothstep(.66, .58, n.y) * 120. * (1. - smoothstep(.48, .56, n.y)), P0.z / (r * r)));   // shoulder tops face up a little
  return normalize(mix(bodyN, headN, smoothstep(.5, .44, n.y)));
}
// that direction after the rig's rotations and the camera's (lighting is done in view space)
vec3 viewN(vec3 nrm, vec3 P0){
  vec2 n = P0.xy / uRef; float m = uMotion;
  float head = smoothstep(.505, .44, n.y), neck = smoothstep(.62, .5, n.y);
  nrm = rotY(nrm, uRig1.z * head * m); nrm = rotX(nrm, uRig3.x * head * m); nrm.xy = rot(nrm.xy, uRig1.y * (.35 * neck + .65 * head) * m);
  nrm = rotY(nrm, uRig5.x * m); nrm = rotX(nrm, uRig5.w * m);
  nrm = rotY(nrm, uRig5.y * m); nrm = rotX(nrm, uRig5.z * m);
  return nrm;
}
// light from the upper left front; the far side stays translucent (dimmer), the silhouette edge glows (rim light)
vec2 shading(vec3 P0){
  vec3 nv = viewN(normalAt(P0), P0);
  float diff = max(dot(nv, normalize(vec3(-.35, -.45, .82))), 0.);
  float back = mix(.3, 1., smoothstep(-.45, .35, nv.z));
  float rim = pow(1. - abs(nv.z), 2.5);
  return vec2(mix(1., (.3 + .95 * diff) * back, uShade.x), rim * uShade.y * 1.2);
}
float dof(){ return smoothstep(70., 380., abs(gDepth)) * uShade.z; }                // far from the focus plane: bigger and softer
vec4 clip(vec2 px){ vec2 c = px / uRes * 2. - 1.; return vec4(c.x, -c.y, 0., 1.); }
`;

const PART_VS = COMMON + `
attribute vec2 aTgt; attribute vec4 aCol; attribute vec4 aAttr; attribute vec4 aSeed;
uniform float uSizeK, uAlpha, uLevel, uListen, uThink, uSpeak, uMaxPt, uGhost, uWave, uFlash;
varying vec4 vC;
void main(){
  float flags = floor(aAttr.z * 255. + .5);
  float dust = mod(flags, 2.), outline = mod(floor(flags / 2.), 2.), onLine = mod(floor(flags / 4.), 2.);
  float heat = aAttr.y, voice = heat * uSpeak * uLevel;
  float z = (aAttr.w * 2. - 1.) * ${f(Z_MAX)};
  vec3 P0 = vec3(aTgt * uRef, z);
  float e, ex; vec2 p = placed(P0, aSeed, vec4(dust, onLine, outline, heat), e, ex);
  gl_Position = clip(toScreen(p));
  float fg = fog(), bl = dof() * e;
  vec2 sh = dust > .5 ? vec2(1., 0.) : shading(P0);
  float fl = 4. * e * (1. - e) + 4. * ex * (1. - ex);
  float tw = .76 + .24 * sin(uT * (1.1 + 2.4 * aSeed.y) + 6.2832 * aSeed.x);
  float throat = smoothstep(.44, .5, aTgt.y) * (1. - smoothstep(.6, .66, aTgt.y)) * (1. - smoothstep(.03, .07, abs(aTgt.x - .505)));
  float wave = exp(-pow((aTgt.y - uWave) * 7., 2.)) * (1. - dust);              // a slow light wave rising through the body
  float b = aCol.a * tw * (1. + .2 * uListen + .3 * outline * (.7 + .6 * uRig2.z) + .9 * outline * uFlash + .4 * wave + 1.1 * gGlow) * (1. - .35 * dust) * (1. - .45 * onLine) * gLife * mix(1., fg * sh.x, e) + sh.y * e * (.5 + aCol.a) * .9
          + voice * .45 + throat * uSpeak * uLevel * .5 + heat * .3 * uThink * (.5 + .5 * sin(uT * 4. + aSeed.x * 20.));
  float vis = smoothstep(0., .03, e) * (.35 + .65 * smoothstep(.02, .3, e)) * (1. - smoothstep(.85, 1., ex));
  float size = (.5 + aAttr.x * 2.3) * uFit.x * gScale * (.82 + .2 * fg) * (1. + 1.4 * bl) * (1. + .35 * fl) * (1. + voice * .3 + gGlow * .3) * (outline > .5 ? .8 : 1.) * (1. - .35 * onLine) * uSizeK;
  float a = b * vis * uAlpha * mix(1., fl, uGhost) / (1. + 2.2 * bl);
  float ps = max(size, 2.4); a *= min(1., (size * size) / (ps * ps));              // tiny sprites: keep a smooth 2.4 px disc and fade it instead
  gl_PointSize = min(ps, uMaxPt);
  vec3 c = mix(aCol.rgb, vec3(.72, .94, 1.), .3 * fl);
  c = mix(c, vec3(1., .6, .25), clamp(voice, 0., 1.) * .5);
  c = mix(c * vec3(.62, .78, 1.), c, clamp(fg, 0., 1.));                           // the far side cools towards blue
  c = mix(c, vec3(.72, .95, 1.), clamp(sh.y * e, 0., 1.) * .45);                    // the rim light is cyan-white
  vC = vec4(c * a, a);
}`;
const PART_FS = `precision mediump float; varying vec4 vC;
void main(){ vec2 q = gl_PointCoord - .5; float d2 = dot(q, q) * 4.; float k = exp(-d2 * 4.2) * (1. - smoothstep(.55, 1., d2)); gl_FragColor = vC * k; }`;

// Wire curves: every segment is a quad (6 vertices) expanded across the line in screen space; both ends move with their particles.
const LINE_VS = COMMON + `
attribute vec2 aA; attribute vec2 aB; attribute vec2 aZ; attribute vec4 aSA; attribute vec4 aSB; attribute vec2 aCorner; attribute vec4 aCol; attribute vec4 aLine;
uniform float uAlpha, uThink, uListen, uSpeak, uWidth, uWave, uFlash;
varying vec4 vC; varying float vSide; varying vec3 vP; varying float vT;
void main(){
  float eA, exA, eB, exB;
  vec2 pA = placed(vec3(aA * uRef, aZ.x), aSA, vec4(0., 1., 0., 0.), eA, exA); float gA = gGlow, sA = gScale, dA = gDepth;
  vec2 pB = placed(vec3(aB * uRef, aZ.y), aSB, vec4(0., 1., 0., 0.), eB, exB);
  float glow = mix(gA, gGlow, aCorner.x), sc = mix(sA, gScale, aCorner.x); gDepth = mix(dA, gDepth, aCorner.x);   // the heartbeat runs along the nerves
  pA = toScreen(pA); pB = toScreen(pB);
  vec2 d = pB - pA; float len = max(length(d), 1e-3); vec2 u = d / len, n = vec2(-u.y, u.x);
  float half_ = (.45 + .55 * aLine.x) * uWidth * max(uFit.x, .6) * .7 * sc + .9;   // core half-width + 0.9 px feather
  vec2 p = mix(pA, pB, aCorner.x) + n * aCorner.y * half_ + u * (aCorner.x * 2. - 1.) * .6;
  gl_Position = clip(p);
  float e = min(eA, eB), ex = max(exA, exB);
  float vis = smoothstep(.72, 1., e) * (1. - smoothstep(0., .3, ex));             // no wires while the cloud is still flying
  float s = aLine.y, t = aLine.z;
  float ph = fract(uT * (.12 + .18 * s) * (1. + uThink * 1.8) + s * 17.);
  float on = step(fract(s * 91.7 + floor(uT * .3 + s * 5.) * .618), .05 + .5 * uThink + .1 * uSpeak);
  float taper = .3 + .7 * pow(sin(3.14159 * clamp(t, 0., 1.)), .6);                 // bright in the middle of a curve, fading at its tips
  float wave = exp(-pow((mix(aA.y, aB.y, aCorner.x) - uWave) * 7., 2.));
  vec3 col = mix(aCol.rgb, vec3(.8, .97, 1.), clamp(glow, 0., 1.) * .35);
  float fg = fog(); col = mix(col * vec3(.62, .78, 1.), col, clamp(fg, 0., 1.));
  vec2 sh = shading(mix(vec3(aA * uRef, aZ.x), vec3(aB * uRef, aZ.y), aCorner.x)); col = mix(col, vec3(.72, .95, 1.), clamp(sh.y, 0., 1.) * .4);
  vC = vec4(col, aLine.x * vis * uAlpha * taper * (fg * sh.x + sh.y * .8) * (1. + .4 * wave + .5 * uFlash + 2.4 * glow)); vSide = aCorner.y * half_ / (half_ - .9 + 1e-3);
  vP = vec3(ph, on * (1.4 + uThink), (.55 + .12 * uListen) * (half_ / max(half_ - .9, .5))); vT = t;
}`;
const LINE_FS = `precision mediump float;
varying vec4 vC; varying float vSide; varying vec3 vP; varying float vT;
void main(){
  float edge = 1. - smoothstep(.55, 1., abs(vSide) * .82);                       // anti-aliased, brighter core
  float pulse = exp(-pow((vT - vP.x) * 14., 2.)) * vP.y;
  float a = vC.a * edge * (vP.z + pulse);
  vec3 c = mix(vC.rgb, vec3(1., .9, .72), clamp(pulse, 0., 1.) * .45);
  gl_FragColor = vec4(c * a, a);
}`;

const NODE_VS = COMMON + `
attribute vec2 aPos; attribute vec3 aNode; attribute float aNZ;
uniform float uFig, uSizeK, uAlpha, uLevel, uListen, uSpeak, uThink, uMaxPt;
varying float vA; varying float vStr; varying float vHot;
void main(){
  vec2 p = toScreen(project(living(vec3(aPos * uRef, aNZ), vec4(.5, .5, .5, 0.), vec4(0., 1., 0., 0.))));
  gl_Position = clip(p);
  float fg = fog();
  float slow = .5 + .5 * sin(uT * 1.1 + aNode.z * 6.2832);                         // the slow heartbeat of the orange cores
  float voice = uSpeak * uLevel;
  float main_ = smoothstep(.88, 1., aNode.x);                                      // the chest core: the one big starburst
  float fore = smoothstep(.36, .28, aPos.y), throat = smoothstep(.44, .5, aPos.y) * (1. - smoothstep(.6, .66, aPos.y));
  float pulse = 1. + .1 * slow + voice * (.15 + .35 * aNode.x) + .1 * uListen + uBeat * main_ * .55 + gGlow * .25 + (fore + throat) * voice * .25;
  gl_PointSize = clamp((6. + aNode.y * 1.25) * (1. + .7 * main_) * uFit.x * gScale * pulse * uSizeK, 2., uMaxPt);
  vA = smoothstep(.12, .55, aNode.x) * aNode.x * uFig * uFig * uAlpha * (.75 + .25 * fg) * (.6 + .3 * slow + .5 * voice + uBeat * main_ * .9 + gGlow * .6 + (fore + throat) * voice * 1.1 + fore * uThink * .5); vStr = aNode.x + main_ * .8; vHot = voice;
}`;
const NODE_FS = `precision mediump float; varying float vA; varying float vStr; varying float vHot;
void main(){
  vec2 q = (gl_PointCoord - .5) * 2.; float d = length(q);
  float core = exp(-d * d * 34.), halo = exp(-d * d * 5.) * .4;
  float rays = exp(-abs(q.x) * 42.) * exp(-abs(q.y) * 3.2) + exp(-abs(q.y) * 42.) * exp(-abs(q.x) * 3.2);
  vec2 r = mat2(.7071, -.7071, .7071, .7071) * q;
  rays += (exp(-abs(r.x) * 50.) * exp(-abs(r.y) * 4.8) + exp(-abs(r.y) * 50.) * exp(-abs(r.x) * 4.8)) * .6;
  float k = (core * max(.2, vStr - .3) + halo + rays * .4 * vStr) * (1. - smoothstep(.85, 1., d));
  vec3 col = mix(vec3(1., .46, .12), vec3(1., .86, .6), clamp(core * 1.1, 0., 1.));   // orange → gold; the tone mapping keeps it from going flat white
  col = mix(col, vec3(1., .55, .18), vHot * .3);
  gl_FragColor = vec4(col * k * vA, k * vA);
}`;

// The eyes: two soft cyan-white lights on the front of the hollow face; they turn with the head in 3D, look ahead of it towards the pointer, and blink.
const EYE_VS = COMMON + `
attribute float aSide;
uniform float uFig, uAlpha, uMaxPt, uEyeZ;
varying float vA; varying float vOpen;
void main(){
  vec3 base = vec3(uRef * vec2(${f(0.505)} + aSide * ${f(0.021)}, ${f(0.305)}) + vec2(uRig3.y * 9., uRig3.z * 6.) * uMotion, uEyeZ);
  vec2 p = project(living(base, vec4(.5, .5, .5, 0.), vec4(0., 1., 0., 0.)));
  gl_Position = clip(toScreen(p));
  float fg = fog();
  gl_PointSize = clamp(13. * uFit.x * uRig4.y * gScale, 3., uMaxPt);
  vA = uAlpha * uFig * uFig * uRig4.x * smoothstep(.45, .9, fg); vOpen = max(uRig3.w, .06);   // fades as it turns away
}`;
const EYE_FS = `precision mediump float; varying float vA; varying float vOpen;
void main(){
  vec2 q = (gl_PointCoord - .5) * 2.; q.y /= vOpen * .75;                       // a blink squeezes the light into a thin line
  float d2 = dot(q, q);
  float core = exp(-d2 * 26.), halo = exp(-d2 * 5.) * .22;
  float k = (core + halo) * (1. - smoothstep(.6, 1., d2));
  vec3 col = mix(vec3(.5, .86, 1.), vec3(.92, 1., 1.), core);
  gl_FragColor = vec4(col * k * vA, k * vA);
}`;

// 3D dust floating around the figure (in front of and behind it): seen through the same camera, so it shows the parallax.
const DUST_VS = COMMON + `
attribute vec3 aP; attribute float aS;
uniform float uAlpha, uMaxPt, uFig;
varying vec4 vC;
void main(){
  vec3 P = aP;
  P.x += sin(uT * (.05 + .05 * aS) + aS * 40.) * 26.;
  P.y = mod(P.y - uT * (5. + 9. * aS) + uRef.y * .2, uRef.y * 1.4) - uRef.y * .2;    // drifts slowly upwards, wraps around
  vec3 C = vec3(uRef * vec2(.505, .62), 0.), Q = P - C;
  Q = rotY(Q, uRig5.y * uMotion); Q = rotX(Q, uRig5.z * uMotion);
  float sc = CAM_D / max(CAM_D - Q.z, 150.);
  gl_Position = clip(toScreen(C.xy + Q.xy * sc));
  float near = smoothstep(200., 900., Q.z), far = smoothstep(-200., -1400., Q.z);
  float size = (1.6 + 2.6 * fract(aS * 7.3)) * uFit.x * sc * (1. + 2.5 * near);
  float ps = max(size, 2.4);
  gl_PointSize = min(ps, uMaxPt);
  float a = uAlpha * uFig * (.25 + .75 * fract(aS * 3.1)) * (1. - .6 * far) / (1. + 1.8 * near) * min(1., size * size / (ps * ps));
  vec3 col = mix(vec3(.45, .75, 1.), vec3(.35, .5, 1.), far);
  vC = vec4(col * a, a);
}`;

// Click ripples: a ring of light expanding from where the owner clicked / tapped (also off the figure, faintly).
const RIP_VS = COMMON + `
attribute float aI;
uniform float uMaxPt, uAlpha;
varying float vA; varying float vR;
void main(){
  vec4 c = aI < .5 ? uClk[0] : aI < 1.5 ? uClk[1] : uClk[2];
  gl_Position = clip(toScreen(c.xy));
  float rr = c.z * ${f(620)}, half_ = rr + 40.;
  float str = (step(1e-5, c.w) * .55 + .45 * c.w) * exp(-c.z * 2.4) * step(c.z, 2.4);
  gl_PointSize = str > .002 ? min(half_ * 2. * uFit.x, uMaxPt) : 0.;
  vR = rr / half_; vA = str * uAlpha * min(1., uMaxPt / max(half_ * 2. * uFit.x, 1.));
}`;
const RIP_FS = `precision mediump float; varying float vA; varying float vR;
void main(){ float d = length(gl_PointCoord - .5) * 2.; float k = exp(-pow((d - vR) / .035, 2.)) + .25 * exp(-pow((d - vR * .82) / .08, 2.)); gl_FragColor = vec4(vec3(.55, .9, 1.) * k * vA, k * vA); }`;

const STAR_VS = `precision highp float;
attribute vec2 aPos; attribute vec4 aCol; attribute float aSz; attribute float aSeed;
uniform vec2 uRes; uniform vec3 uBgFit; uniform vec2 uRef; uniform vec2 uPar; uniform float uT, uBgA, uPx, uMaxPt;
varying vec4 vC;
void main(){
  vec2 p = uBgFit.yz + aPos * uRef * uBgFit.x + uPar * (.25 + .6 * fract(aSeed * 3.7));   // stars at different depths shift by different amounts
  vec2 c = p / uRes * 2. - 1.; gl_Position = vec4(c.x, -c.y, 0., 1.);
  float tw = .55 + .45 * sin(uT * (.4 + 2.2 * fract(aSeed * 7.1)) + aSeed * 40.);
  float size = aSz * uPx * (2. + .5 * tw); float ps = max(size, 2.4);
  gl_PointSize = min(ps, uMaxPt);
  float a = uBgA * (.55 + .45 * tw) * min(1., size * size / (ps * ps));
  vC = vec4(aCol.rgb * a * 1.25, a);
}`;
const STAR_FS = `precision mediump float; varying vec4 vC;
void main(){ vec2 q = gl_PointCoord - .5; float d2 = dot(q, q) * 4.; float k = exp(-d2 * 5.) + .22 * exp(-abs(q.x) * 30.) * exp(-abs(q.y) * 3.); gl_FragColor = vC * k * (1. - smoothstep(.6, 1., d2)); }`;

const QUAD_VS = `precision highp float; attribute vec2 aQ; varying vec2 vUv; void main(){ vUv = aQ * .5 + .5; gl_Position = vec4(aQ, 0., 1.); }`;
const BG_FS = `precision highp float;
uniform sampler2D uTex; uniform vec2 uRes; uniform vec3 uBgFit; uniform vec2 uRef; uniform vec2 uPar; uniform float uBgA, uT, uGrain;
varying vec2 vUv;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec2 px = vec2(vUv.x, 1. - vUv.y) * uRes;
  vec2 uv = (px - uBgFit.yz - uPar * .2) / uBgFit.x / uRef;
  uv += vec2(sin(uT * .05), cos(uT * .041)) * .0025;
  uv.x = 1. - abs(1. - mod(uv.x, 2.));   // wider than the artwork (ultrawide): the nebula continues mirrored
  vec3 c = texture2D(uTex, clamp(uv, vec2(.001), vec2(.999))).rgb;
  vec2 v = (vUv - .5) * vec2(1.15, 1.);
  c *= mix(.58, 1.05, smoothstep(.88, .18, length(v)));                            // vignette
  c += vec3(.004, .01, .03);
  c += (hash(gl_FragCoord.xy + fract(uT * 7.) * 91.) - .5) * uGrain / 255.;        // fine film grain (also breaks 8-bit banding)
  gl_FragColor = vec4(c * uBgA, uBgA);
}`;
const DOWN_FS = `precision mediump float; uniform sampler2D uTex; uniform vec2 uTexel; varying vec2 vUv;
void main(){
  vec4 c = texture2D(uTex, vUv) * 4.;
  c += texture2D(uTex, vUv + vec2(-1., -1.) * uTexel) + texture2D(uTex, vUv + vec2(1., -1.) * uTexel) + texture2D(uTex, vUv + vec2(-1., 1.) * uTexel) + texture2D(uTex, vUv + vec2(1., 1.) * uTexel);
  gl_FragColor = c / 8.;
}`;
const UP_FS = `precision mediump float; uniform sampler2D uTex; uniform vec2 uTexel; uniform float uK; varying vec2 vUv;
void main(){
  vec4 c = texture2D(uTex, vUv) * 4.;
  c += (texture2D(uTex, vUv + vec2(uTexel.x, 0.)) + texture2D(uTex, vUv - vec2(uTexel.x, 0.)) + texture2D(uTex, vUv + vec2(0., uTexel.y)) + texture2D(uTex, vUv - vec2(0., uTexel.y))) * 2.;
  c += texture2D(uTex, vUv + uTexel) + texture2D(uTex, vUv - uTexel) + texture2D(uTex, vUv + vec2(uTexel.x, -uTexel.y)) + texture2D(uTex, vUv - vec2(uTexel.x, -uTexel.y));
  gl_FragColor = c / 16. * uK;
}`;
const COMP_FS = `precision highp float;
uniform sampler2D uF; uniform sampler2D uB; uniform float uInvGain, uBloom, uExposure, uCA;
varying vec2 vUv;
void main(){
  vec2 off = (vUv - .5) * uCA;
  vec3 fig = vec3(texture2D(uF, vUv + off).r, texture2D(uF, vUv).g, texture2D(uF, vUv - off).b);   // a faint chromatic fringe towards the edges
  vec3 c = (fig + texture2D(uB, vUv).rgb * uBloom) * uInvGain;
  float L = max(max(c.r, c.g), c.b);
  float m = 1. - exp(-L * uExposure);                                              // tone mapping on the brightest channel: the hue is kept
  vec3 o = c * (m / max(L, 1e-4));
  o = mix(o, vec3(m), smoothstep(.78, 1., m) * .3);                                // only the very hottest points lean towards white (gold-white core)
  gl_FragColor = vec4(o, m);
}`;

// Shader programs are compiled without waiting (KHR_parallel_shader_compile lets the driver do it in the background); the page polls
// for completion between frames instead of blocking on the first status query (a cold compile can take a second or more).
function compileStart(gl, vs, fs) {
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const v = sh(gl.VERTEX_SHADER, vs), f = sh(gl.FRAGMENT_SHADER, fs);
  const p = gl.createProgram(); gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
  return { p, v, f };
}
function compileFinish(gl, { p, v, f }) {
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getShaderInfoLog(v) || gl.getShaderInfoLog(f) || gl.getProgramInfoLog(p);
    throw new Error('shader: ' + log);
  }
  const u = {}, a = {};
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES); i < n; i++) { const info = gl.getActiveAttrib(p, i); a[info.name] = gl.getAttribLocation(p, info.name); }
  return { p, u, a };
}
/** Give the main thread back (input, the HUD's animation) between the heavy steps of preparing the renderer. */
const yieldMain = () => new Promise((r) => (globalThis.scheduler?.yield ? globalThis.scheduler.yield().then(r) : setTimeout(r, 0)));
const nextFrame = () => new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 16)));

/** Wire curves from the segment list: consecutive segments (b of one = a of the next) are one curve; t runs 0..1 along it. */
export function buildCurves(lines, lineCount, pos, keep) {
  const segs = [];
  let start = 0;
  const flush = (end) => {   // segments [start, end)
    if (end <= start) return;
    let total = 0; const len = [];
    for (let i = start; i < end; i++) { const a = lines[i * 2], b = lines[i * 2 + 1]; const l = Math.hypot(pos[b * 2] - pos[a * 2], (pos[b * 2 + 1] - pos[a * 2 + 1]) * 0.5628); len.push(l); total += l; }
    const seed = seeds(start + 7919)[0];
    let acc = 0;
    for (let i = start; i < end; i++) { const l = len[i - start]; if (keep(lines[i * 2]) && keep(lines[i * 2 + 1])) segs.push({ i, t0: total ? acc / total : 0, t1: total ? (acc + l) / total : 1, seed }); acc += l; }
  };
  for (let i = 0; i < lineCount; i++) if (i > 0 && lines[i * 2] !== lines[(i - 1) * 2 + 1]) { flush(i); start = i; }
  flush(lineCount);
  return segs;
}

/** human-rig.js output → what the shaders take (waves packed as 4 × vec4 (x, y, age, strength) + their speeds). */
export function rigUniforms(r) {
  const wavArr = new Float32Array(16), wavSpd = new Float32Array(4);
  (r.waves || []).slice(-4).forEach((w, i) => { wavArr.set([w.x, w.y, w.age, w.str], i * 4); wavSpd[i] = w.speed; });
  const clkArr = new Float32Array(12);
  (r.clicks || []).slice(-3).forEach((c, i) => clkArr.set([c.x, c.y, c.age, Math.max(c.str, 1e-4)], i * 4));
  return { ...r, wavArr, wavSpd, clkArr };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {ReturnType<import('../human-protocol.js').parseHumanData>} data
 * @param {HTMLImageElement|null} bgImage
 * @param {{ count: number, force2d?: boolean }} opts
 */
export async function createRenderer(canvas, data, bgImage, opts) {
  const gl = opts.force2d ? null : canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  if (!gl) return createRenderer2D(canvas, data, bgImage, opts);
  try { return await createRendererGL(gl, canvas, data, bgImage, opts); } catch (e) {
    console.warn('[human] WebGL failed, 2D fallback:', e?.message ?? e);
    try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {}
    const c2 = canvas.cloneNode(false); canvas.replaceWith(c2);   // a canvas that had a WebGL context cannot give a 2D one
    return createRenderer2D(c2, data, bgImage, opts);
  }
}

async function createRendererGL(gl, canvas, data, bgImage, { count }) {
  const T0 = performance.now(), timing = {};
  const K = Math.min(count, data.count);
  const maxPt = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] || 64;
  // compile everything at once, then wait for the driver without blocking (polling between frames)
  const SRC = { dust: [DUST_VS, PART_FS], rip: [RIP_VS, RIP_FS], eye: [EYE_VS, EYE_FS], part: [PART_VS, PART_FS], line: [LINE_VS, LINE_FS], node: [NODE_VS, NODE_FS], star: [STAR_VS, STAR_FS],
    bg: [QUAD_VS, BG_FS], down: [QUAD_VS, DOWN_FS], up: [QUAD_VS, UP_FS], comp: [QUAD_VS, COMP_FS] };
  const pending = Object.fromEntries(Object.entries(SRC).map(([k, [vs, fs]]) => [k, compileStart(gl, vs, fs)]));
  const par = gl.getExtension('KHR_parallel_shader_compile');
  timing.parallelCompile = !!par;
  const prog = {};
  for (const [k, pp] of Object.entries(pending)) {
    if (par) { for (let n = 0; n < 600 && !gl.getProgramParameter(pp.p, par.COMPLETION_STATUS_KHR); n++) await nextFrame(); }
    else await yieldMain();   // without the extension each status query waits for that one program: one per slice
    prog[k] = compileFinish(gl, pp);
  }
  timing.compileMs = Math.round(performance.now() - T0);
  await yieldMain();
  const buf = (arr) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW); return b; };
  let draws = 0;
  const draw = (mode, first, n) => { gl.drawArrays(mode, first, n); draws++; };

  // particles
  const seedArr = new Float32Array(data.count * 4);
  for (let i = 0; i < data.count; i++) seedArr.set(seeds(i), i * 4);
  await yieldMain();
  const P = { tgt: buf(data.pos.subarray(0, K * 2)), col: buf(data.col.subarray(0, K * 4)), attr: buf(data.attr.subarray(0, K * 4)), seed: buf(seedArr.subarray(0, K * 4)) };
  // wire curves → quads
  const segs = buildCurves(data.lines, data.lineCount, data.pos, (pi) => pi < K);
  const nv = segs.length * 6;
  const lZ = new Float32Array(nv * 2), lA = new Float32Array(nv * 2), lB = new Float32Array(nv * 2), lSA = new Float32Array(nv * 4), lSB = new Float32Array(nv * 4), lC = new Float32Array(nv * 2), lCol = new Uint8Array(nv * 4), lL = new Float32Array(nv * 4);
  const CORNERS = [[0, -1], [1, -1], [0, 1], [0, 1], [1, -1], [1, 1]];
  segs.forEach((sg, k) => {
    const a = data.lines[sg.i * 2], b = data.lines[sg.i * 2 + 1];
    for (let c = 0; c < 6; c++) {
      const v = k * 6 + c, [end, side] = CORNERS[c], own = end ? b : a;
      lA[v * 2] = data.pos[a * 2]; lA[v * 2 + 1] = data.pos[a * 2 + 1]; lB[v * 2] = data.pos[b * 2]; lB[v * 2 + 1] = data.pos[b * 2 + 1];
      lZ[v * 2] = zOf(data.attr[a * 4 + 3]); lZ[v * 2 + 1] = zOf(data.attr[b * 4 + 3]);
      lSA.set(seedArr.subarray(a * 4, a * 4 + 4), v * 4); lSB.set(seedArr.subarray(b * 4, b * 4 + 4), v * 4);
      lC[v * 2] = end; lC[v * 2 + 1] = side;
      lCol.set(data.col.subarray(own * 4, own * 4 + 3), v * 4); lCol[v * 4 + 3] = 255;
      lL[v * 4] = data.lineStrength[sg.i] / 255; lL[v * 4 + 1] = sg.seed; lL[v * 4 + 2] = end ? sg.t1 : sg.t0;
    }
  });
  await yieldMain();
  const L = { z: buf(lZ), a: buf(lA), b: buf(lB), sa: buf(lSA), sb: buf(lSB), corner: buf(lC), col: buf(lCol), line: buf(lL), n: nv };
  await yieldMain();
  // hot nodes
  const nn = data.nodeCount, np = new Float32Array(nn * 2), nd = new Float32Array(nn * 3);
  for (let i = 0; i < nn; i++) { np[i * 2] = data.nodes[i * 4]; np[i * 2 + 1] = data.nodes[i * 4 + 1]; nd[i * 3] = data.nodes[i * 4 + 2]; nd[i * 3 + 1] = data.nodes[i * 4 + 3]; nd[i * 3 + 2] = seeds(i + 31)[0]; }
  // depth of a point inside the figure: the mean depth of the particles around it (front ones only for the eyes)
  const depthNear = (x, y, r, frontOnly) => { let sz = 0, c = 0; for (let i = 0; i < data.count; i++) { const dx = (data.pos[i * 2] - x) * data.W, dy = (data.pos[i * 2 + 1] - y) * data.H; if (dx * dx + dy * dy > r * r) continue; const z = zOf(data.attr[i * 4 + 3]); if (frontOnly && z <= 0) continue; sz += z; c++; } return c ? sz / c : 0; };
  const nz = new Float32Array(nn); for (let i = 0; i < nn; i++) nz[i] = depthNear(data.nodes[i * 4], data.nodes[i * 4 + 1], 26, false) * 0.6 + 30;
  const eyeZ = Math.max(depthNear(0.484, 0.305, 40, true), depthNear(0.526, 0.305, 40, true)) * 0.95;
  const N = { pos: buf(np), node: buf(nd), z: buf(nz), n: nn };
  await yieldMain();
  // stars
  const ns = data.starCount, sp = new Float32Array(ns * 2), sz = new Float32Array(ns), ssd = new Float32Array(ns);
  for (let i = 0; i < ns; i++) { sp[i * 2] = data.stars[i * 3]; sp[i * 2 + 1] = data.stars[i * 3 + 1]; sz[i] = data.stars[i * 3 + 2]; ssd[i] = seeds(i + 101)[1]; }
  const S = { pos: buf(sp), col: buf(data.starCol), sz: buf(sz), seed: buf(ssd), n: ns };
  const quad = buf(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));

  // textures / render targets
  const texParams = () => { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); };
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); texParams();
  if (bgImage) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bgImage);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([4, 14, 42, 255]));
  const targets = [];   // [0] = figure buffer (full size), [1..] = bloom levels (1/2, 1/4, …)
  for (let i = 0; i <= BLOOM_LEVELS; i++) { const t = gl.createTexture(), fb = gl.createFramebuffer(); targets.push({ t, fb, w: 0, h: 0 }); }
  function sizeTargets(w, h) {
    targets.forEach((tg, i) => {
      const nw = Math.max(1, Math.round(w / 2 ** i)), nh = Math.max(1, Math.round(h / 2 ** i));
      if (tg.w === nw && tg.h === nh) return; tg.w = nw; tg.h = nh;
      gl.bindTexture(gl.TEXTURE_2D, tg.t); texParams(); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, nw, nh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, tg.fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tg.t, 0);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  const bindTarget = (tg) => { gl.bindFramebuffer(gl.FRAMEBUFFER, tg ? tg.fb : null); };

  const bindAttr = (pr, name, b, size, type = gl.FLOAT, norm = false) => { const loc = pr.a[name]; if (loc === undefined || loc < 0) return; gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, type, norm, 0, 0); };
  const disableAll = () => { for (let i = 0; i < 8; i++) gl.disableVertexAttribArray(i); };
  const common = (pr, F, lag = 0) => {
    const u = pr.u;
    gl.uniform2f(u.uRes, F.w, F.h); gl.uniform3f(u.uFit, F.fit.s, F.fit.ox, F.fit.oy); gl.uniform2f(u.uRef, data.W, data.H);
    gl.uniform1f(u.uT, F.t); gl.uniform1f(u.uFormT, F.formT); gl.uniform1f(u.uExitT, F.exitT); gl.uniform1f(u.uExiting, F.exiting ? 1 : 0); gl.uniform1f(u.uMotion, F.motion);
    gl.uniform2f(u.uCoreRef, (F.core[0] - F.fit.ox) / F.fit.s, (F.core[1] - F.fit.oy) / F.fit.s); gl.uniform1f(u.uCoreR, F.coreR / F.fit.s); gl.uniform1f(u.uLag, lag); gl.uniform1f(u.uSnap, F.snap);
    const R = F.rig;
    if (R) {
      if (u.uRig0) gl.uniform4f(u.uRig0, R.breath, R.chestExp, R.shL, R.shR);
      if (u.uRig1) gl.uniform4f(u.uRig1, R.sway, R.tilt, R.headLocal ?? R.yaw, R.nod);
      if (u.uRig2) gl.uniform4f(u.uRig2, R.lean, R.bob, R.outlinePulse, 0);
      if (u.uRig5) gl.uniform4f(u.uRig5, R.bodyYaw || 0, R.camYaw || 0, R.camPitch || 0, R.torsoPitch || 0);
      if (u.uShade) gl.uniform4f(u.uShade, TUNE.shade, TUNE.rim, TUNE.dof, TUNE.fog);
      if (u['uClk[0]']) gl.uniform4fv(u['uClk[0]'], R.clkArr);
      if (u.uRig3) gl.uniform4f(u.uRig3, R.pitch || 0, R.gazeX || 0, R.gazeY || 0, R.eyeOpen ?? 1);
      if (u.uRig4) gl.uniform4f(u.uRig4, R.eyeGlow ?? 1, R.eyeSize ?? 1, R.near || 0, 0);
      if (u.uBeat) gl.uniform1f(u.uBeat, R.beat);
      if (u['uWav[0]']) gl.uniform4fv(u['uWav[0]'], R.wavArr);
      if (u.uWavSpeed) gl.uniform4fv(u.uWavSpeed, R.wavSpd);
    }
  };
  const live = (u, F) => { for (const [k, v] of [['uLevel', F.level], ['uListen', F.listen], ['uThink', F.think], ['uSpeak', F.speak], ['uMaxPt', maxPt], ['uWave', F.wave], ['uFlash', F.flash]]) if (u[k]) gl.uniform1f(u[k], v); };
  function drawParticles(F, lag, ghost, alpha, part = 1) {
    const pr = prog.part; gl.useProgram(pr.p); common(pr, F, lag); live(pr.u, F);
    gl.uniform1f(pr.u.uSizeK, TUNE.partSize); gl.uniform1f(pr.u.uAlpha, alpha * GAIN); gl.uniform1f(pr.u.uGhost, ghost);
    bindAttr(pr, 'aTgt', P.tgt, 2); bindAttr(pr, 'aCol', P.col, 4, gl.UNSIGNED_BYTE, true); bindAttr(pr, 'aAttr', P.attr, 4, gl.UNSIGNED_BYTE, true); bindAttr(pr, 'aSeed', P.seed, 4);
    draw(gl.POINTS, 0, Math.max(1, Math.round(K * F.share * part))); disableAll();
  }
  function drawLines(F) {
    if (!L.n || F.formT < T.emitDelay + T.flightMin * 0.7) return;   // no wires while the particles are still on their way
    const pr = prog.line; gl.useProgram(pr.p); common(pr, F); live(pr.u, F); gl.uniform1f(pr.u.uAlpha, TUNE.line * GAIN); gl.uniform1f(pr.u.uWidth, TUNE.lineWidth);
    bindAttr(pr, 'aA', L.a, 2); bindAttr(pr, 'aB', L.b, 2); bindAttr(pr, 'aZ', L.z, 2); bindAttr(pr, 'aSA', L.sa, 4); bindAttr(pr, 'aSB', L.sb, 4); bindAttr(pr, 'aCorner', L.corner, 2); bindAttr(pr, 'aCol', L.col, 4, gl.UNSIGNED_BYTE, true); bindAttr(pr, 'aLine', L.line, 4);
    draw(gl.TRIANGLES, 0, L.n); disableAll();
  }
  function drawNodes(F) {
    if (!N.n || F.fig <= 0) return;
    const pr = prog.node; gl.useProgram(pr.p); common(pr, F); live(pr.u, F);
    gl.uniform1f(pr.u.uFig, F.fig); gl.uniform1f(pr.u.uSizeK, TUNE.nodeSize); gl.uniform1f(pr.u.uAlpha, TUNE.node * GAIN);
    bindAttr(pr, 'aPos', N.pos, 2); bindAttr(pr, 'aNode', N.node, 3); bindAttr(pr, 'aNZ', N.z, 1);
    draw(gl.POINTS, 0, N.n); disableAll();
  }
  const eyeBuf = buf(new Float32Array([-1, 1]));
  function drawEyes(F) {
    if (!(TUNE.eye > 0) || F.fig <= 0 || !F.rig) return;
    const pr = prog.eye; gl.useProgram(pr.p); common(pr, F); live(pr.u, F);
    gl.uniform1f(pr.u.uFig, F.fig); gl.uniform1f(pr.u.uAlpha, TUNE.eye * GAIN); gl.uniform1f(pr.u.uEyeZ, eyeZ);
    bindAttr(pr, 'aSide', eyeBuf, 1);
    draw(gl.POINTS, 0, 2); disableAll();
  }
  // dust: a box around the figure, from far behind it to close to the camera
  const ND = 3200, dP = new Float32Array(ND * 3), dS = new Float32Array(ND);
  for (let i = 0; i < ND; i++) { const r = seeds(i + 50000); dP[i * 3] = (-0.35 + 1.7 * r[0]) * data.W; dP[i * 3 + 1] = (-0.2 + 1.4 * r[1]) * data.H; dP[i * 3 + 2] = -1500 + 2500 * Math.pow(r[2], 0.8); dS[i] = r[3]; }
  const D = { p: buf(dP), s: buf(dS), n: ND };
  function drawDust(F) {
    if (!(TUNE.dust > 0) || F.fig <= 0) return;
    const pr = prog.dust; gl.useProgram(pr.p); common(pr, F); live(pr.u, F); gl.uniform1f(pr.u.uAlpha, 0.35 * TUNE.dust * GAIN); gl.uniform1f(pr.u.uFig, Math.min(1, F.fig * 1.5));
    bindAttr(pr, 'aP', D.p, 3); bindAttr(pr, 'aS', D.s, 1);
    draw(gl.POINTS, 0, Math.round(D.n * F.share)); disableAll();
  }
  const ripBuf = buf(new Float32Array([0, 1, 2]));
  function drawRipples(F) {
    if (!F.rig?.clicks?.length) return;
    const pr = prog.rip; gl.useProgram(pr.p); common(pr, F); live(pr.u, F); gl.uniform1f(pr.u.uAlpha, TUNE.ripple * GAIN);
    bindAttr(pr, 'aI', ripBuf, 1);
    draw(gl.POINTS, 0, 3); disableAll();
  }
  function quadPass(pr) { bindAttr(pr, 'aQ', quad, 2); draw(gl.TRIANGLE_STRIP, 0, 4); disableAll(); }
  function texPass(pr, srcTex, texelW, texelH) { gl.useProgram(pr.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex); gl.uniform1i(pr.u.uTex, 0); gl.uniform2f(pr.u.uTexel, texelW, texelH); }

  /** F: { w,h, t, formT, exitT, exiting, fig, bgA, motion, core:[x,y], coreR, level, listen, think, speak, fit, bgFit, snap, flash, wave, par:[x,y], share, rig (rigUniforms()) } */
  function frame(F) {
    draws = 0;
    gl.disable(gl.DEPTH_TEST);
    sizeTargets(F.w, F.h);
    const fig = targets[0];
    // 1. the figure, additive, into its own buffer
    bindTarget(fig); gl.viewport(0, 0, fig.w, fig.h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    drawDust(F);
    drawLines(F);
    const flying = F.formT < T.formTotal + 0.1 || F.exiting;
    // comet trails: a sample of the cloud (the particle order is a fair shuffle) is enough to read as streaks, and keeps the formation's frames as light as the rest
    if (flying && TUNE.trail > 0) { drawParticles(F, 0.11, 1, TUNE.part * TUNE.trail * 0.45 * 1.6, 0.35); drawParticles(F, 0.055, 1, TUNE.part * TUNE.trail * 0.8 * 1.6, 0.35); }
    drawParticles(F, 0, 0, TUNE.part);
    drawNodes(F);
    drawEyes(F);
    drawRipples(F);
    // 2. bloom: down-sample chain, then tent up-sample back (each level adds the one below)
    gl.disable(gl.BLEND);
    for (let i = 1; i <= BLOOM_LEVELS; i++) { const src = targets[i - 1], dst = targets[i]; bindTarget(dst); gl.viewport(0, 0, dst.w, dst.h); texPass(prog.down, src.t, 1 / src.w, 1 / src.h); quadPass(prog.down); }
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = BLOOM_LEVELS - 1; i >= 1; i--) { const src = targets[i + 1], dst = targets[i]; bindTarget(dst); gl.viewport(0, 0, dst.w, dst.h); texPass(prog.up, src.t, 1 / src.w, 1 / src.h); gl.uniform1f(prog.up.u.uK, TUNE.bloomUp); quadPass(prog.up); }
    // 3. screen: background (overwrites: alpha = how far the space has faded in over the HUD), stars, then the figure
    bindTarget(null); gl.viewport(0, 0, F.w, F.h);
    gl.disable(gl.BLEND);
    { const pr = prog.bg; gl.useProgram(pr.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(pr.u.uTex, 0);
      gl.uniform2f(pr.u.uRes, F.w, F.h); gl.uniform3f(pr.u.uBgFit, F.bgFit.s, F.bgFit.ox, F.bgFit.oy); gl.uniform2f(pr.u.uRef, data.W, data.H); gl.uniform2f(pr.u.uPar, F.par[0], F.par[1]);
      gl.uniform1f(pr.u.uBgA, F.bgA); gl.uniform1f(pr.u.uT, F.t); gl.uniform1f(pr.u.uGrain, TUNE.grain); quadPass(pr); }
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // screen: light over space, never past white
    if (S.n && F.bgA > 0) { const pr = prog.star; gl.useProgram(pr.p);
      gl.uniform2f(pr.u.uRes, F.w, F.h); gl.uniform3f(pr.u.uBgFit, F.bgFit.s, F.bgFit.ox, F.bgFit.oy); gl.uniform2f(pr.u.uRef, data.W, data.H); gl.uniform2f(pr.u.uPar, F.par[0], F.par[1]);
      gl.uniform1f(pr.u.uT, F.t); gl.uniform1f(pr.u.uBgA, F.bgA); gl.uniform1f(pr.u.uPx, F.bgFit.s); gl.uniform1f(pr.u.uMaxPt, maxPt);
      bindAttr(pr, 'aPos', S.pos, 2); bindAttr(pr, 'aCol', S.col, 4, gl.UNSIGNED_BYTE, true); bindAttr(pr, 'aSz', S.sz, 1); bindAttr(pr, 'aSeed', S.seed, 1);
      draw(gl.POINTS, 0, S.n); disableAll(); }
    { const pr = prog.comp; gl.useProgram(pr.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fig.t); gl.uniform1i(pr.u.uF, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, targets[1].t); gl.uniform1i(pr.u.uB, 1);
      gl.uniform1f(pr.u.uInvGain, 1 / GAIN); gl.uniform1f(pr.u.uBloom, TUNE.bloom); gl.uniform1f(pr.u.uExposure, TUNE.exposure); gl.uniform1f(pr.u.uCA, TUNE.ca);
      quadPass(pr); gl.activeTexture(gl.TEXTURE0); }
    return draws;
  }
  function destroy() { try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {} }
  timing.totalMs = Math.round(performance.now() - T0);
  /** Draw a few frames off screen so the driver builds every pipeline before the real show (one frame per slice). */
  async function warm(F) { for (const formT of [0.5, 2.6, 6]) { frame({ ...F, formT, t: formT, fig: 1, exiting: false }); await nextFrame(); } timing.warmMs = Math.round(performance.now() - T0 - timing.totalMs); }
  return { kind: 'webgl', canvas, frame, destroy, warm, timing, count: K, lines: segs.length, eyeZ };
}

/** Canvas2D fallback: fewer particles, no wires / bloom. Same timing and paths (computed on the CPU). */
function createRenderer2D(canvas, data, bgImage, { count }) {
  const g = canvas.getContext('2d');
  const K = Math.min(count, 4000, data.count);
  const sd = Array.from({ length: K }, (_, i) => seeds(i));
  function frame(F) {
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, F.w, F.h);
    g.globalAlpha = F.bgA;
    if (bgImage) g.drawImage(bgImage, F.bgFit.ox, F.bgFit.oy, data.W * F.bgFit.s, data.H * F.bgFit.s); else { g.fillStyle = '#04102a'; g.fillRect(0, 0, F.w, F.h); }
    g.globalAlpha = 1; g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < data.starCount; i += 2) { const c = data.starCol; g.fillStyle = `rgba(${c[i * 4]},${c[i * 4 + 1]},${c[i * 4 + 2]},${F.bgA})`; g.fillRect(F.bgFit.ox + data.stars[i * 3] * data.W * F.bgFit.s, F.bgFit.oy + data.stars[i * 3 + 1] * data.H * F.bgFit.s, 1.5, 1.5); }
    const sc = snapScale(F.formT), cx = F.fit.ox + data.W * 0.505 * F.fit.s, cy = F.fit.oy + data.H * 0.77 * F.fit.s;
    for (let k = 0; k < K; k++) {
      const s = sd[k], i = Math.floor((k * data.count) / K);   // an even subsample of the whole cloud
      // pseudo-3D: the depth turns into a sideways shift with the body / camera turn and a perspective size
      const z = zOf(data.attr[i * 4 + 3]), turn = (F.rig?.bodyYaw || 0) + (F.rig?.camYaw || 0), persp = 2600 / (2600 - z);
      const tx = cx + (F.fit.ox + data.pos[i * 2] * data.W * F.fit.s - cx) * sc * persp + Math.sin(turn) * z * F.fit.s, ty = cy + (F.fit.oy + data.pos[i * 2 + 1] * data.H * F.fit.s - cy) * sc * persp;
      const a = (s[2] * 2 * Math.PI), st = [F.core[0] + F.coreR * 0.55 * Math.sqrt(s[3]) * Math.cos(a), F.core[1] + F.coreR * 0.55 * Math.sqrt(s[3]) * Math.sin(a)];
      const e = formProgress(F.formT, s); if (e <= 0) continue;
      let p = flightPoint(st, [tx + Math.cos(F.t * (0.4 + s[0]) + s[1] * 6.28) * 1.2 * F.motion, ty + Math.sin(F.t * (0.5 + s[0]) + s[1] * 6.28) * 1.2 * F.motion], e, s);
      if (F.exiting) { const ex = exitProgress(F.exitT, s); if (ex >= 1) continue; p = flightPoint(p, st, ex, [s[0], s[1], 1 - s[2], s[3]]); }
      const c = data.col, heat = data.attr[i * 4 + 1] / 255;
      const b = Math.min(1, (c[i * 4 + 3] / 255) * (0.8 + 0.2 * Math.sin(F.t * 2 + s[0] * 20)) * Math.min(1.1, Math.max(0.3, 0.62 + z / 430)) + heat * F.speak * F.level * 0.6);
      const r = Math.max(1, (0.6 + (data.attr[i * 4] / 255) * 2.4) * F.fit.s * persp);
      g.fillStyle = `rgba(${c[i * 4]},${c[i * 4 + 1]},${c[i * 4 + 2]},${b.toFixed(3)})`;
      g.fillRect(p[0] - r / 2, p[1] - r / 2, r, r);
    }
    for (let i = 0; i < data.nodeCount; i++) {
      const x = F.fit.ox + data.nodes[i * 4] * data.W * F.fit.s, y = F.fit.oy + data.nodes[i * 4 + 1] * data.H * F.fit.s, r = data.nodes[i * 4 + 3] * F.fit.s * 1.4 * (1 + F.speak * F.level * 0.4);
      const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(255,205,140,${0.8 * F.fig * data.nodes[i * 4 + 2]})`); gr.addColorStop(1, 'rgba(255,110,25,0)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    return 1;
  }
  return { kind: '2d', canvas, frame, destroy() {}, count: K, lines: 0 };
}
