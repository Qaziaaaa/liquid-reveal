
"use strict";
/* ==========================================================================
   Liquid reveal  -  wave-equation build

   Single self-contained file. No npm, no external libraries.

   The reveal is driven by a REAL 2D wave simulation, not a painted trail.
   Two height buffers are ping-ponged and stepped with the discrete wave
   equation:

       h[n+1] = (2*h[n] - h[n-1]) + C^2 * laplacian(h[n])
       h[n+1] *= damping

   which means disturbances PROPAGATE outward, interfere with each other and
   keep moving after the cursor stops. Everything you see (refraction,
   specular glint, reveal mask, chromatic split) is derived from that height
   field and its gradient. FBM noise only perturbs the mask edge.

   Passes per frame:
     1. SIM        grid (long axis 288)  ping-pong  -> height field, N substeps
     2. NOISE      256x256               single FBO -> fbm edge texture
     3. COMPOSITE  full res                         -> refraction, specular,
                                                       gradient map, mask
   ========================================================================== */

/* --------------------------------------------------------------------------
   P - every tunable in one place.
   -------------------------------------------------------------------------- */
const P = {

  /* ---- assets ---- */
  BASE_SRC   : 'img.png',
  CHROME_SRC : 'helmet.png',
  IMG_W      : 1672,
  IMG_H      : 941,
  /* focal point of the cover crop, TOP-LEFT origin. 0.5,0.5 = plain cover.
     The source is landscape and the hero is landscape, so on desktop the crop
     is almost an identity. y slightly above centre keeps the head framed when
     the viewport gets taller than 16:9. */
  imgFocus   : [0.50, 0.44],

  /* ======================================================================
     WAVE SIMULATION  (this is the effect)
     ====================================================================== */
  simLong     : 288,    // cells on the long axis. cells stay square, so
                        // ripples are circular in screen space.
  simHz       : 120,    // fixed sim rate. accumulator-driven, so identical
                        // behaviour on 60Hz and 120Hz displays.
  simMaxSteps : 4,      // catch-up cap after a stall
  waveC       : 0.5,    // Courant number. CFL limit for this stencil is
                        // 1/sqrt(2) = 0.707. Do not exceed it or it explodes.
  damping     : 0.9450, // per sim STEP. Faster decay for a cleaner, less
                        // syrupy trail.
  viscosity   : 0.045,  // diffusion term. Lower value keeps the ripple edge
                        // sharp and the waves more glass-like.
                        // Must stay under 0.25 for stability.
  edgeAbsorb  : 0.90,   // multiplier at the very border (absorbing layer,
                        // stops waves bouncing off the frame)
  edgeCells   : 16,     // width of that absorbing layer, in cells
  hClamp      : 1.10,   // safety clamp on height. The tuning below keeps the
                        // peak near 0.6, so this is headroom, not a limiter.

  /* ---- cursor impulse ----
     Injected EVERY sim step while the pointer moves, so the per-step figure
     is small: energy builds over the ~15 steps a wave needs to leave the
     dab. amp = base + speed * gain, so a flick throws a big wave and a slow
     drag makes a small one, while the base keeps slow movement from being
     invisible. A stationary pointer injects nothing, so the water stills. */
  impulseBase   : 0.1500, // MEASURED: at 0.040 a gliding cursor only reached
                          // 0.040 saturates the blob to ~0.9 while gliding
  impulseGain   : 0.0700, // peak 0.165, because it moves on before energy builds.
  impulseMax    : 0.2800,
  impulseMinSpeed: 0.004, // uv/s below which the pointer counts as parked
  impulseRadius : 0.200,  // dab radius, uv units (aspect corrected). Widened
                          // from 0.090 on request. The gaussian peak is `amp`
                          // regardless of radius, so this grows the reveal
                          // DIAMETER without brightening the core.
  impulseFallSq : 3.0,    // exp(-d^2 * this). 3.0 -> 5% at d = radius
  splashAmp     : 0.55,   // tap-to-splash one-shot monopole amplitude

  /* ======================================================================
     VISUALS DRIVEN BY THE HEIGHT FIELD
     ====================================================================== */
  gradTexels    : 1.0,    // gradient stencil offset, in sim texels
  refraction    : 0.120,  // uv displacement per unit of height gradient.
                          // Slightly stronger for a clearer ripple shape,
                          // still capped to avoid portrait distortion.
  refractMax    : 0.0070, // hard cap on the displacement
  chromatic     : 0.030,  // R/B split along the gradient
  chromaEdge    : 1.0,    // extra split where the gradient is steep
  chromaMax     : 0.0018, // present at the wavefront, not garish

  normalScale   : 34.0,   // z-scale for the surface normal
  specStrength  : 0.52,   // a glint, not a blown patch
  shininess     : 44.0,
  lightDir      : [-0.42, 0.55, 0.72],
  specTint      : [0.78, 1.00, 0.88],

  /* Reveal mask, derived from wave energy. Weighted heavily toward the
     SLOPE rather than the raw height: slope is what actually refracts, and
     keying on height alone makes a droplet's flat dome read as a hard disc
     instead of an expanding ring. */
  maskHeight    : 1.00,   // weight on |h|. Now HEIGHT-dominant: with no waves
                          // there is no wavefront to key off, and a
                          // slope-weighted mask would only reveal the blob's
                          // rim instead of filling it.
  maskGrad      : 0.85,   // small slope term, just to crisp the edge
  maskLo        : 0.065,  // MEASURED against a real glide, not guessed.
  maskHi        : 0.220,  // Core reveals fully, trailing edge fades out.
  maskNoise     : 0.030,  // FBM perturbation ON THE EDGE ONLY
  noiseTile     : 2.4,

  edgeGlow      : 0.18,   // luminous rim where the surface is steep
  edgeGlowTight : 8.0,

  /* ======================================================================
     GRADIENT MAP  -  "green metallic"
     Overlay luminance is levels-stretched, gamma shaped, then remapped.
     Greens selected to complement the helmet and keep highlights clean.
     ====================================================================== */
  gradStops: [
    { t: 0.00, c: '#00120A' },
    { t: 0.30, c: '#183827' },
    { t: 0.55, c: '#2E7A4E' },  // mid green
    { t: 0.80, c: '#66C08A' },  // bright green highlight
    { t: 1.00, c: '#DFF7EA' }
  ],
  gradPhase : 0,         // 0-100
  gradScale : 100,       // 0-100
  gradMix   : 100,       // 0-100 blend of gradient-mapped vs raw overlay
  gradWrap  : 'mirror',  // 'mirror' | 'clamp' | 'repeat'

  /* levels stretch BEFORE the lookup. The reveal image is dark
     (median luminance ~0.05, most of the frame is black) so a straight
     luminance map produces almost nothing. [lo, hi] -> [0, 1]
     then pow(, gamma) puts the panel lines and gloss in the mid-to-upper
     part of the gradient. */
  lumLo     : 0.00,
  lumHi     : 0.25,
  lumGamma  : 0.60,

  /* ---- optics / atmosphere ---- */
  bloom         : 0.24,
  bloomRadius   : 2.6,
  bloomThreshold: 0.70,
  vignette      : 0.66,
  vignetteCenter: [0.50, 0.56],   // GL space: y is bottom-up
  vignetteInner : 0.26,
  vignetteOuter : 0.92,
  scanlines     : 0.022,
  scanlineFreq  : 1.35,
  grain         : 0.034,

  /* ---- idle behaviour ----
     With nobody touching it the hero still has to look like water, so the
     idle state runs a drifting current PLUS periodic droplets. Both go
     through the same wave sim, so they interfere with each other and with
     the cursor exactly like real ripples. */
  idleDrift     : true,
  idleDelayMs   : 1600,   // ms of no input before the drift takes over
  idleSpeed     : 0.85,
  idleRadius    : [0.22, 0.15],
  idleCenter    : [0.50, 0.52],
  idleBoost     : 1.0,    // impulse multiplier while drifting
  idleDropMs    : 1250,   // droplet interval
  idleDropAmp   : 0.00,   // droplets OFF. They spawned blobs away from the
                          // cursor, which read as "the whole page is
                          // rippling". Idle is now a single gliding blob.
  idleDropSpread: [0.30, 0.26],
  /* A portrait viewport is narrow, so the same energy floods the whole frame
     and buries the photo. Damp all injection down when taller than wide. */
  narrowScale   : 0.45,

  /* ---- noise field ---- */
  noiseSize     : 256,
  noiseScale    : 9.0,
  noiseDrift    : 0.10,

  /* ---- performance ---- */
  dprCap        : 2.0,
  dprCapMobile  : 1.5,
  idleStopEps   : 0.0015  // energy below this + no input -> stop drawing
};

/* ==========================================================================
   Helpers
   ========================================================================== */
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const qs = new URLSearchParams(location.search);
const DEBUG = qs.get('debug') === '1';

function hexToRgb(hex){
  const h = hex.replace('#','');
  return [
    parseInt(h.slice(0,2),16)/255,
    parseInt(h.slice(2,4),16)/255,
    parseInt(h.slice(4,6),16)/255
  ];
}

const canvas   = document.getElementById('gl');
const hero     = document.getElementById('hero');
const fallback = document.getElementById('fallback');
const hintEl   = document.getElementById('hint');
const exportBtn = document.getElementById('exportBtn');
const dbgEl    = document.getElementById('dbg');
const dbgText  = document.getElementById('dbgText');
const dbgField = document.getElementById('dbgField');

document.documentElement.classList.add('js');

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ==========================================================================
   URL customization
   Every content value and asset can be overridden from the query string,
   which turns this hero into a reusable template:
     ?name=…&tag=…&title=…&src=img.png&chrome=img.png&imgw=1672&imgh=941
   ========================================================================== */
const DEFAULT_BASE   = P.BASE_SRC;
const DEFAULT_CHROME = P.CHROME_SRC;
function urlParam(key, fallback, coerce){
  const v = qs.get(key);
  if (v == null || v === '') return fallback;
  return coerce ? coerce(v) : v;
}
const nameEl = document.getElementById('wordmarkName');
const tagEl  = document.getElementById('tagline');

P.BASE_SRC   = urlParam('src',    P.BASE_SRC);
P.CHROME_SRC = urlParam('chrome', P.CHROME_SRC);
P.IMG_W      = urlParam('imgw',   P.IMG_W, Number);
P.IMG_H      = urlParam('imgh',   P.IMG_H, Number);
P.imgFocus   = [ urlParam('focusx', P.imgFocus[0], Number),
                 urlParam('focusy', P.imgFocus[1], Number) ];

const customName  = urlParam('name',  null);
const customTag   = urlParam('tag',   null);
const customTitle = urlParam('title', null);
if (customName  && nameEl) nameEl.textContent = customName;
if (customTag   && tagEl)  tagEl.textContent  = customTag;
if (customTitle) document.title = customTitle;

window.__rippleErrors = [];

function bail(reason){
  console.warn('[ripple] falling back:', reason);
  canvas.style.display = 'none';
  fallback.classList.add('on');
  if (hintEl) hintEl.classList.add('gone');
  if (DEBUG){ dbgEl.classList.add('on'); dbgText.textContent = 'FALLBACK\n' + reason; }
  window.__ripple = window.__ripple || {};
  window.__ripple.fellBack = reason;
  window.__ripple.ready = true;
}

/* ==========================================================================
   Shaders (GLSL ES 1.00 - valid under both WebGL1 and WebGL2)
   ========================================================================== */

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/* Height codec.
   With half-float targets the height lives in .r and the previous step in .g.
   Without them we pack each into two bytes (16-bit fixed point over
   [-hClamp, hClamp]), which keeps the sim from quantising to a standstill. */
const CODEC = `
#ifdef PACKED
vec2 packH(float h){
  float v = clamp(h / HRANGE * 0.5 + 0.5, 0.0, 1.0) * 65535.0;
  float hi = floor(v / 256.0);
  return vec2(hi / 255.0, (v - hi * 256.0) / 255.0);
}
float unpackH(vec2 p){
  return ((p.x * 255.0 * 256.0 + p.y * 255.0) / 65535.0 * 2.0 - 1.0) * HRANGE;
}
vec4 encode(float cur, float prv){ return vec4(packH(cur), packH(prv)); }
float curOf(vec4 t){ return unpackH(t.rg); }
float prvOf(vec4 t){ return unpackH(t.ba); }
#else
vec4 encode(float cur, float prv){ return vec4(cur, prv, 0.0, 1.0); }
float curOf(vec4 t){ return t.r; }
float prvOf(vec4 t){ return t.g; }
#endif
`;

/* ---- PASS 1: the wave simulation -----------------------------------------
   next = (2*cur - prev) + C^2 * laplacian(cur),  then damped and absorbed
   at the borders. The pointer injects a gaussian dab swept along its path,
   with amplitude proportional to pointer SPEED.
--------------------------------------------------------------------------- */
const FRAG_SIM = `
precision highp float;
varying vec2 v_uv;

uniform sampler2D u_prev;
uniform vec2  u_texel;
uniform vec2  u_grid;
uniform float u_c2;
uniform float u_visc;
uniform float u_damp;
uniform float u_edgeAbsorb;
uniform float u_edgeCells;
uniform float u_clamp;

uniform vec2  u_p;
uniform vec2  u_pPrev;
uniform float u_amp;
uniform float u_radius;
uniform float u_fallSq;
uniform float u_aspect;
uniform float u_dipole;

${CODEC}

float hAt(vec2 uv){ return curOf(texture2D(u_prev, uv)); }

/* distance to the swept pointer segment, aspect corrected so the dab is
   round on screen rather than round in uv */
float segDist(vec2 p, vec2 a, vec2 b, float asp){
  vec2 pa = (p - a) * vec2(asp, 1.0);
  vec2 ba = (b - a) * vec2(asp, 1.0);
  float d = dot(ba, ba);
  float h = (d > 1e-9) ? clamp(dot(pa, ba) / d, 0.0, 1.0) : 0.0;
  return length(pa - ba * h);
}

void main(){
  vec4 s   = texture2D(u_prev, v_uv);
  float cur = curOf(s);
  float prv = prvOf(s);

  float l = hAt(v_uv + vec2(u_texel.x, 0.0))
          + hAt(v_uv - vec2(u_texel.x, 0.0))
          + hAt(v_uv + vec2(0.0, u_texel.y))
          + hAt(v_uv - vec2(0.0, u_texel.y))
          - 4.0 * cur;

  /* GLIDING BLOB, not a wave.

     The wave equation term (2*cur - prv) + C^2*laplacian is deliberately
     GONE. That term is what makes energy radiate outward, and radiating
     energy is exactly the "ripples across the whole page" problem. A reveal
     that follows the cursor must not propagate at all.

     What is left is a decaying trail field: the pointer stamps into it, the
     field decays everywhere, and a small amount of diffusion softens the
     edge so it reads as liquid rather than as a hard circle. The reveal
     therefore exists only where the cursor has recently been, and closes
     behind it. */
  float nxt = cur * u_damp;
  nxt += u_visc * l;   /* pure diffusion: softens the blob edge, no propagation */

  /* Impulse, amplitude proportional to pointer speed.

     The pointer injects a DIPOLE: a crest just ahead of the travel direction
     and an equal trough just behind, exactly like something dragged through
     water. That matters because the dab is applied on EVERY sim step, and a
     plain gaussian has a non-zero mean, so a slow-moving pointer integrates
     it into a static dome, which is precisely the painted-blob look this
     build exists to kill. A dipole is zero-mean, so it can only radiate
     waves, never pile up.

     A one-shot droplet (u_dipole = 0) stays a monopole, which is what a
     falling drop physically is: it does push a dome, but it is applied once
     and radiates away. */
  /* Always a MONOPOLE dab swept along the pointer path. The dipole was there
     to radiate waves; with propagation removed we want the opposite, a dab
     that accumulates into a smooth blob along the stroke. */
  if (u_amp != 0.0){
    float d = segDist(v_uv, u_pPrev, u_p, u_aspect) / max(u_radius, 1e-5);
    nxt += u_amp * exp(-d * d * u_fallSq);
  }

  /* absorbing border: gentle per-step attenuation over edgeCells, so waves
     die at the frame instead of reflecting back in */
  vec2 cell  = v_uv * u_grid;
  vec2 dEdge = min(cell, u_grid - cell);
  float fade = mix(u_edgeAbsorb, 1.0,
                   smoothstep(0.0, u_edgeCells, min(dEdge.x, dEdge.y)));
  nxt *= fade;

  nxt = clamp(nxt, -u_clamp, u_clamp);
  gl_FragColor = encode(nxt, cur);
}`;

/* ---- PASS 2: FBM field ---------------------------------------------------
   R = edge detail, G = a slower second octave. Used ONLY to rough up the
   mask edge so the reveal is not glassy-perfect.
--------------------------------------------------------------------------- */
const FRAG_NOISE = `
precision highp float;
varying vec2 v_uv;

uniform float u_time;
uniform float u_aspect;
uniform float u_scale;
uniform float u_drift;

vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec2 mod289(vec2 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec3 permute(vec3 x){ return mod289(((x*34.0)+1.0)*x); }

float snoise(vec2 v){
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0))
                          + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
  m = m*m; m = m*m;
  vec3 x  = 2.0 * fract(p * C.www) - 1.0;
  vec3 h  = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float fbm3(vec2 p){
  float s = 0.0;
  float a = 0.5;
  for(int i = 0; i < 3; i++){
    s += a * snoise(p);
    p  = p * 2.02 + vec2(17.3, 9.1);
    a *= 0.5;
  }
  return s;
}

void main(){
  vec2 p = vec2(v_uv.x * u_aspect, v_uv.y) * u_scale;
  float a = fbm3(p - vec2(u_time * u_drift, u_time * u_drift * 0.6));
  float b = fbm3(p * 0.41 + vec2(11.3, 4.9) + vec2(0.0, u_time * u_drift * 0.4));
  gl_FragColor = vec4(a * 0.5 + 0.5, b * 0.5 + 0.5, 0.0, 1.0);
}`;

/* ---- PASS 3: composite --------------------------------------------------- */
const FRAG_COMP = `
precision highp float;
varying vec2 v_uv;

uniform sampler2D u_base;
uniform sampler2D u_chrome;
uniform sampler2D u_sim;
uniform sampler2D u_noise;

uniform vec2  u_res;
uniform vec2  u_grid;
uniform vec2  u_simTexel;
uniform float u_time;
uniform float u_canvasAspect;
uniform float u_imgAspect;
uniform vec2  u_focus;

uniform float u_gradTexels;
uniform float u_refraction;
uniform float u_refractMax;
uniform float u_chromatic;
uniform float u_chromaEdge;
uniform float u_chromaMax;

uniform float u_normalScale;
uniform float u_specStrength;
uniform float u_shininess;
uniform vec3  u_lightDir;
uniform vec3  u_specTint;

uniform float u_maskHeight;
uniform float u_maskGrad;
uniform float u_maskLo;
uniform float u_maskHi;
uniform float u_maskNoise;
uniform float u_noiseTile;

uniform float u_edgeGlow;
uniform float u_edgeGlowTight;

uniform vec3  u_gc0, u_gc1, u_gc2, u_gc3, u_gc4;
uniform vec4  u_gt;
uniform float u_gradPhase, u_gradScale, u_gradMix;
uniform float u_lumLo, u_lumHi, u_lumGamma;
uniform int   u_gradWrap;

uniform float u_bloom, u_bloomRadius, u_bloomThreshold;
uniform float u_vignette, u_vigInner, u_vigOuter;
uniform vec2  u_vigCenter;
uniform float u_scanlines, u_scanFreq, u_grain;

${CODEC}

float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

/* magnitude soft limiter: v for small |v|, asymptotic to m. Keeps steep
   wavefronts from tearing the image. (tanh is GLSL ES 3.00 only.) */
vec2 softLimit(vec2 v, float m){
  float l = length(v);
  if (l < 1e-7 || m <= 0.0) return v;
  return v * (m * (1.0 - exp(-l / m)) / l);
}

/* Height lookup.

   The sim grid is far coarser than the screen, and plain bilinear
   reconstruction is only C0: its derivative is piecewise constant, so the
   gradient we build the refraction from comes out faceted and you can see
   the sim texels as blocks. Both paths therefore reconstruct with a
   smoothstep-warped fraction, which is C1 and removes the facets for a
   couple of ALU ops. */
#ifdef PACKED
float hRaw(vec2 uv){ return curOf(texture2D(u_sim, uv)); }
float hSample(vec2 uv){
  vec2 t = uv * u_grid - 0.5;
  vec2 f = fract(t);
  f = f * f * (3.0 - 2.0 * f);
  vec2 b = (floor(t) + 0.5) * u_simTexel;
  float h00 = hRaw(b);
  float h10 = hRaw(b + vec2(u_simTexel.x, 0.0));
  float h01 = hRaw(b + vec2(0.0, u_simTexel.y));
  float h11 = hRaw(b + u_simTexel);
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}
#else
float hSample(vec2 uv){
  vec2 t = uv * u_grid - 0.5;
  vec2 f = fract(t);
  f = f * f * (3.0 - 2.0 * f);
  return texture2D(u_sim, (floor(t) + 0.5 + f) * u_simTexel).r;
}
#endif

/* object-fit: cover, in-shader, with a focal point (top-left origin). */
vec2 coverUV(vec2 uv){
  vec2 s = (u_canvasAspect > u_imgAspect)
         ? vec2(1.0, u_imgAspect / u_canvasAspect)
         : vec2(u_canvasAspect / u_imgAspect, 1.0);
  vec2 p = (uv - 0.5) * s + 0.5;
  p += (vec2(0.5) - u_focus) * (vec2(1.0) - s) * vec2(-1.0, 1.0);
  return p;
}

float wrapT(float t){
  if (u_gradWrap == 0) return 1.0 - abs(mod(t, 2.0) - 1.0);   // mirror
  if (u_gradWrap == 2) return fract(t);                        // repeat
  return clamp(t, 0.0, 1.0);                                   // clamp
}

vec3 gradient(float t){
  t = wrapT(t);
  if      (t < u_gt.x) return mix(u_gc0, u_gc1,  t / max(u_gt.x, 1e-5));
  else if (t < u_gt.y) return mix(u_gc1, u_gc2, (t - u_gt.x) / max(u_gt.y - u_gt.x, 1e-5));
  else if (t < u_gt.z) return mix(u_gc2, u_gc3, (t - u_gt.y) / max(u_gt.z - u_gt.y, 1e-5));
  return mix(u_gc3, u_gc4, (t - u_gt.z) / max(u_gt.w - u_gt.z, 1e-5));
}

float lumOf(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

/* levels stretch + gamma, THEN the gradient lookup. Without the stretch the
   helmet (median luminance 0.047) never leaves the black end of the ramp. */
vec3 mapChrome(vec3 raw){
  float l = clamp((lumOf(raw) - u_lumLo) / max(u_lumHi - u_lumLo, 1e-4), 0.0, 1.0);
  l = pow(l, u_lumGamma);
  vec3 g = gradient(l * u_gradScale + u_gradPhase);
  return mix(raw, g, u_gradMix);
}

void main(){
  vec2 uv = v_uv;
  vec2 px = 1.0 / u_res;

  /* ---- the height field and its gradient ---- */
  vec2 e = u_simTexel * u_gradTexels;
  float h  = hSample(uv);
  float hL = hSample(uv - vec2(e.x, 0.0));
  float hR = hSample(uv + vec2(e.x, 0.0));
  float hD = hSample(uv - vec2(0.0, e.y));
  float hU = hSample(uv + vec2(0.0, e.y));

  vec2 n = vec2(hR - hL, hU - hD);
  float glen = length(n);

  /* ---- refraction: the single biggest liquid tell ----
     Soft-limited: the offset grows linearly with the gradient, then rolls
     off, so a steep wavefront bends the image instead of tearing it. */
  vec2 refr = softLimit(n * u_refraction, u_refractMax);

  /* ---- chromatic split along the gradient, strongest where it is steep ---- */
  vec2 ca = softLimit(n * u_chromatic * (1.0 + u_chromaEdge * smoothstep(0.0, 0.06, glen)),
                      u_chromaMax);

  vec2 cuv = coverUV(uv + refr);
  vec2 cR  = coverUV(uv + refr + ca);
  vec2 cB  = coverUV(uv + refr - ca);

  vec2 z = vec2(0.0), o = vec2(1.0);

  vec3 base = vec3(
    texture2D(u_base, clamp(cR,  z, o)).r,
    texture2D(u_base, clamp(cuv, z, o)).g,
    texture2D(u_base, clamp(cB,  z, o)).b
  );

  vec3 chRaw = vec3(
    texture2D(u_chrome, clamp(cR,  z, o)).r,
    texture2D(u_chrome, clamp(cuv, z, o)).g,
    texture2D(u_chrome, clamp(cB,  z, o)).b
  );
  vec3 helmet = mapChrome(chRaw);

  if (u_bloom > 0.001){
    vec3 bl = vec3(0.0);
    for (int i = 0; i < 6; i++){
      float a = float(i) * 1.0471975 + u_time * 0.12;
      vec2 off = vec2(cos(a), sin(a)) * u_bloomRadius * px * vec2(1.0, u_canvasAspect);
      vec3 s = mapChrome(texture2D(u_chrome, clamp(cuv + off, z, o)).rgb);
      bl += s * smoothstep(u_bloomThreshold, 1.0, lumOf(s));
    }
    helmet += (bl / 6.0) * u_bloom;
  }

  /* ---- reveal mask from wave energy, roughed up at the edge only ---- */
  vec2 nz = texture2D(u_noise, uv * u_noiseTile).rg;
  float energy = abs(h) * u_maskHeight + glen * u_maskGrad;
  float raw = smoothstep(u_maskLo, u_maskHi, energy);
  energy += (nz.r - 0.5) * u_maskNoise * (1.0 - abs(raw * 2.0 - 1.0));
  float mask = clamp(smoothstep(u_maskLo, u_maskHi, energy), 0.0, 1.0);

  /* ---- specular glint off the surface normal ---- */
  vec3 nrm = normalize(vec3(-n * u_normalScale, 1.0));
  float spec = pow(max(dot(nrm, normalize(u_lightDir)), 0.0), u_shininess);

  /* ---- composite ---- */
  vec3 col = mix(base, helmet, mask);
  col += u_specTint * spec * u_specStrength * mask;
  col += mix(u_gc2, u_gc3, 0.6) * (1.0 - exp(-glen * u_edgeGlowTight)) * u_edgeGlow;

  /* ---- atmosphere ---- */
  float vd = length((uv - u_vigCenter) * vec2(u_canvasAspect, 1.0)) / max(u_canvasAspect, 1.0);
  col *= 1.0 - u_vignette * smoothstep(u_vigInner, u_vigOuter, vd);

  float sl = sin(uv.y * u_res.y * u_scanFreq * 3.14159265);
  col *= 1.0 - u_scanlines * (0.5 + 0.5 * sl);

  col += (hash21(uv * u_res + fract(u_time) * 91.7) - 0.5) * u_grain;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;

/* ---- PASS 4 (debug/tests only): height field -> 16-bit RGBA8 ------------- */
const FRAG_VIEW = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_sim;
${CODEC}
void main(){
  float h = curOf(texture2D(u_sim, v_uv));
  float v = clamp(h / HRANGE * 0.5 + 0.5, 0.0, 1.0) * 65535.0;
  float hi = floor(v / 256.0);
  gl_FragColor = vec4(hi / 255.0, (v - hi * 256.0) / 255.0, 0.0, 1.0);
}`;

/* ==========================================================================
   Context
   ========================================================================== */
let gl = null, isGL2 = false;
try{
   const opts = { alpha:false, antialias:false, depth:false, stencil:false,
                  premultipliedAlpha:false, powerPreference:'high-performance',
                  preserveDrawingBuffer: true };   /* kept so a frame can be exported to PNG anytime */
  gl = canvas.getContext('webgl2', opts);
  isGL2 = !!gl;
  if (!gl) gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
}catch(e){ /* handled below */ }

function compile(type, src, name){
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
    const log = gl.getShaderInfoLog(s);
    console.error('[ripple] shader compile failed (' + name + '):\n' + log);
    window.__rippleErrors.push(name + ': ' + log);
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function program(fragSrc, name, defines){
  const pre = (defines || '');
  const vs = compile(gl.VERTEX_SHADER, VERT, name + '.vert');
  const fs = compile(gl.FRAGMENT_SHADER, pre + fragSrc, name + '.frag');
  if (!vs || !fs) return null;
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)){
    const log = gl.getProgramInfoLog(p);
    console.error('[ripple] link failed (' + name + '):\n' + log);
    window.__rippleErrors.push(name + ' link: ' + log);
    return null;
  }
  gl.deleteShader(vs); gl.deleteShader(fs);
  return p;
}

function uniforms(prog){
  const map = Object.create(null);
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++){
    const info = gl.getActiveUniform(prog, i);
    const nm = info.name.replace(/\[0\]$/, '');
    map[nm] = gl.getUniformLocation(prog, info.name);
  }
  return map;
}

/* ==========================================================================
   Main
   ========================================================================== */
function start(){

/* ---- geometry: one fullscreen quad ---- */
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

/* ---- float / half-float render target support ---- */
let simType = gl.UNSIGNED_BYTE, simInternal = gl.RGBA, simMode = 'rgba8-packed', PACKED = true;
(function detectFloat(){
  if (isGL2){
    if (gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float')){
      simType = gl.HALF_FLOAT; simInternal = gl.RGBA16F; simMode = 'rgba16f'; PACKED = false;
    }
  } else {
    const hf = gl.getExtension('OES_texture_half_float');
    if (hf){
      gl.getExtension('OES_texture_half_float_linear');
      simType = hf.HALF_FLOAT_OES; simInternal = gl.RGBA; simMode = 'half-float'; PACKED = false;
    }
  }
})();

function defines(){
  return '#define HRANGE ' + P.hClamp.toFixed(1) + '\n' + (PACKED ? '#define PACKED 1\n' : '');
}

/* ---- programs ---- */
let progSim  = program(FRAG_SIM,   'sim',       defines());
let progComp = program(FRAG_COMP,  'composite', defines());
let progView = program(FRAG_VIEW,  'view',      defines());
const progNoise = program(FRAG_NOISE, 'noise');

if (!progSim || !progComp || !progNoise || !progView){
  bail('shader compilation failed - see console');
  return;
}
let uSim  = uniforms(progSim);
let uComp = uniforms(progComp);
let uView = uniforms(progView);
const uNoise = uniforms(progNoise);

function makeTarget(w, h, type, internal, filter){
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return ok ? { tex, fbo, w, h } : null;
}

/* ==========================================================================
   Sim grid. Cells are kept square so ripples stay circular on screen.
   ========================================================================== */
let SW = 1, SH = 1;
let simA = null, simB = null, viewRT = null;

function simDimsFor(w, h){
  const L = P.simLong;
  if (w >= h) return [L, Math.max(16, Math.round(L * h / w))];
  return [Math.max(16, Math.round(L * w / h)), L];
}

function disposeTarget(t){
  if (!t) return;
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fbo);
}

function buildSim(w, h){
  const [nw, nh] = simDimsFor(w, h);
  if (nw === SW && nh === SH && simA && simB) return false;
  disposeTarget(simA); disposeTarget(simB); disposeTarget(viewRT);
  SW = nw; SH = nh;
  const filter = PACKED ? gl.NEAREST : gl.LINEAR;
  simA = makeTarget(SW, SH, simType, simInternal, filter);
  simB = makeTarget(SW, SH, simType, simInternal, filter);
  if ((!simA || !simB) && !PACKED){
    /* half-float target refused: fall back to the packed byte path */
    disposeTarget(simA); disposeTarget(simB);
    PACKED = true; simType = gl.UNSIGNED_BYTE; simInternal = gl.RGBA; simMode = 'rgba8-packed (fallback)';
    progSim  = program(FRAG_SIM,  'sim',       defines());
    progComp = program(FRAG_COMP, 'composite', defines());
    progView = program(FRAG_VIEW, 'view',      defines());
    if (!progSim || !progComp || !progView) return null;
    uSim = uniforms(progSim); uComp = uniforms(progComp); uView = uniforms(progView);
    simA = makeTarget(SW, SH, simType, simInternal, gl.NEAREST);
    simB = makeTarget(SW, SH, simType, simInternal, gl.NEAREST);
  }
  viewRT = makeTarget(SW, SH, gl.UNSIGNED_BYTE, gl.RGBA, gl.NEAREST);
  if (!simA || !simB || !viewRT) return null;
  read = simA; write = simB;
  clearSim();
  return true;
}

/* height 0 encodes to 0.5 in the packed path, and to 0 in the float path */
function clearSim(){
  const c = PACKED ? [128/255, 128/255, 128/255, 128/255] : [0, 0, 0, 1];
  [simA, simB].forEach(t => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.clearColor(c[0], c[1], c[2], c[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
  });
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  energy = 0;
}

const NS = P.noiseSize;
const noiseRT = makeTarget(NS, NS, gl.UNSIGNED_BYTE, gl.RGBA, gl.LINEAR);
if (!noiseRT){ bail('render target creation failed'); return; }

/* ---- image textures ---- */
function makeImageTexture(){
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                new Uint8Array([0,0,0,255]));
  return t;
}
const texBase   = makeImageTexture();
const texChrome = makeImageTexture();

function loadImage(src, tex, fallback){
  return new Promise((resolve) => {
    const attempt = (s) => {
      const img = new Image();
      img.decoding = 'async';
      img.crossOrigin = 'anonymous';        /* allow cross-origin textures */
      img.onload = () => {
        try{
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        }catch(e){ resolve(null); return; }
        resolve(img);
      };
      img.onerror = () => {
        if (fallback && s !== fallback) attempt(fallback);
        else resolve(null);
      };
      img.src = s;
    };
    attempt(src);
  });
}

/* ==========================================================================
   Derived parameters
   ========================================================================== */
const D = {};
function derive(){
  D.c2       = P.waveC * P.waveC;
  D.gradPhase = P.gradPhase / 100;
  D.gradScale = P.gradScale / 100;
  D.gradMix   = P.gradMix / 100;
  D.gradWrap  = P.gradWrap === 'mirror' ? 0 : (P.gradWrap === 'repeat' ? 2 : 1);
  D.gradCols  = P.gradStops.map(s => hexToRgb(s.c));
  D.gradTs    = [P.gradStops[1].t, P.gradStops[2].t, P.gradStops[3].t, P.gradStops[4].t];
  const L = P.lightDir, m = Math.hypot(L[0], L[1], L[2]) || 1;
  D.light = [L[0]/m, L[1]/m, L[2]/m];
}
derive();

const IMG_ASPECT = P.IMG_W / P.IMG_H;

/* ==========================================================================
   Pointer
   ========================================================================== */
const ptr = {
  x: 0.5, y: 0.55,   // current, uv (GL space, y up)
  px: 0.5, py: 0.55, // previous frame
  has: false,
  lastInput: -1e9,
  accept: true       // tests can switch input off
};
let interacted = false;

/* one-shot impulse queued by tests / reduced-motion / tap-to-splash */
let pending = null;

/* every live pointer, keyed by pointerId. A pointer is tracked while it
   hovers (mouse) or stays on screen (touch), so two fingers push the same
   wave field and interfere exactly like real ripples. */
const pointers = new Map();
function track(e){
  if (!ptr.accept) return;
  const r = hero.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = 1.0 - (e.clientY - r.top) / r.height;   /* flip into GL space */
  const p = pointers.get(e.pointerId) || { x, y, px: x, py: y };
  p.x = x; p.y = y;
  pointers.set(e.pointerId, p);
  ptr.x = x; ptr.y = y;
  ptr.has = true;
  ptr.lastInput = performance.now();
  if (!interacted){
    interacted = true;
    if (hintEl) hintEl.classList.add('gone');
  }
}
function onPointerDown(e){
  track(e);
  /* a tap is a one-shot monopole splash, bigger than a glide dab */
  pending = { x: ptr.x, y: ptr.y, amp: P.splashAmp * (W < H ? P.narrowScale : 1) };
  needsDraw = true;
}
function onPointerUp(e){
  if (e.pointerType !== 'mouse') pointers.delete(e.pointerId);
  if (pointers.size === 0) ptr.has = false;
}
hero.addEventListener('pointermove', track, { passive: true });
hero.addEventListener('pointerdown', onPointerDown, { passive: true });
hero.addEventListener('pointerup', onPointerUp, { passive: true });
hero.addEventListener('pointercancel', onPointerUp, { passive: true });
hero.addEventListener('pointerleave', (e) => {
  pointers.delete(e.pointerId);
  ptr.has = false;
}, { passive: true });

/* ==========================================================================
   Sizing
   ========================================================================== */
const isMobile = matchMedia('(pointer: coarse)').matches || innerWidth < 760;
const DPR_CAP  = isMobile ? P.dprCapMobile : P.dprCap;
let W = 1, H = 1;

/* sizeDirty keeps clientWidth/clientHeight out of the render loop, so the
   loop never forces a layout read. */
let sizeDirty = true;
function resize(){
  if (!sizeDirty) return false;
  sizeDirty = false;
  const dpr = Math.min(devicePixelRatio || 1, DPR_CAP);
  const w = Math.max(1, Math.round(hero.clientWidth  * dpr));
  const h = Math.max(1, Math.round(hero.clientHeight * dpr));
  if (w === W && h === H) return false;
  W = w; H = h;
  canvas.width = W; canvas.height = H;
  if (buildSim(W, H) === null){ bail('sim target creation failed'); running = false; }
  return true;
}
const markDirty = () => { sizeDirty = true; needsDraw = true; };
addEventListener('resize', markDirty, { passive: true });
addEventListener('orientationchange', markDirty, { passive: true });
if (window.ResizeObserver) new ResizeObserver(markDirty).observe(hero);

/* ==========================================================================
   Passes
   ========================================================================== */
function bindTex(unit, tex, loc){
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(loc, unit);
}
function drawQuad(){ gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }

let read = null, write = null;
let t0 = performance.now();
let prevT = t0;
let energy = 0;
let needsDraw = true;
let acc = 0;
let simSteps = 0;
let fpsAcc = 0, fps = 0, lastFpsAt = t0, frameMs = 0;
let running = true;
let paused = false;   /* test hook only, never set by the page itself */

/* preallocated frame-time ring, no per-frame allocation */
const FT_N = 2048;   /* ~17s at 120Hz before the ring wraps */
const frameTimes = new Float32Array(FT_N);
const frameDeltas = new Float32Array(FT_N);
let ftHead = 0, ftCount = 0;

/* one simulation step */
function simStep(ax, ay, bx, by, amp, dipole){
  gl.useProgram(progSim);
  gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
  gl.viewport(0, 0, SW, SH);
  bindTex(0, read.tex, uSim.u_prev);
  gl.uniform2f(uSim.u_texel, 1 / SW, 1 / SH);
  gl.uniform2f(uSim.u_grid, SW, SH);
  gl.uniform1f(uSim.u_c2, D.c2);
  gl.uniform1f(uSim.u_visc, P.viscosity);
  gl.uniform1f(uSim.u_damp, P.damping);
  gl.uniform1f(uSim.u_edgeAbsorb, P.edgeAbsorb);
  gl.uniform1f(uSim.u_edgeCells, P.edgeCells);
  gl.uniform1f(uSim.u_clamp, P.hClamp);
  gl.uniform2f(uSim.u_pPrev, ax, ay);
  gl.uniform2f(uSim.u_p, bx, by);
  gl.uniform1f(uSim.u_amp, amp);
  gl.uniform1f(uSim.u_radius, P.impulseRadius);
  gl.uniform1f(uSim.u_fallSq, P.impulseFallSq);
  gl.uniform1f(uSim.u_aspect, W / H);
  gl.uniform1f(uSim.u_dipole, dipole ? 1 : 0);
  drawQuad();
  const tmp = read; read = write; write = tmp;
  simSteps++;
}

const SIM_DT = 1 / P.simHz;

let lastDropAt = -1e9, dropSeed = 0;

function stepSim(now, dt){
  /* idle drift generates a virtual pointer once every real pointer is
     quiet (no movement, no live touch) for idleDelayMs */
  const idleFor = now - ptr.lastInput;
  const anyActive = ptr.accept && pointers.size > 0;
  let idling = false;
  const idleScale = (W < H) ? P.narrowScale : 1.0;
  if (P.idleDrift && !REDUCED && (!anyActive || idleFor > P.idleDelayMs)){
    idling = true;
    const tt = (now - t0) / 1000 * P.idleSpeed;
    ptr.x = P.idleCenter[0] + Math.cos(tt * 1.00) * P.idleRadius[0]
                            + Math.cos(tt * 2.30) * P.idleRadius[0] * 0.28;
    ptr.y = P.idleCenter[1] + Math.sin(tt * 1.37) * P.idleRadius[1]
                            + Math.sin(tt * 0.71) * P.idleRadius[1] * 0.33;

    /* an occasional droplet keeps the surface alive and interfering */
    if (now - lastDropAt > P.idleDropMs && !pending){
      lastDropAt = now;
      dropSeed = (dropSeed * 9301 + 49297) % 233280;
      const r1 = dropSeed / 233280;
      dropSeed = (dropSeed * 9301 + 49297) % 233280;
      const r2 = dropSeed / 233280;
      pending = {
        x: P.idleCenter[0] + (r1 - 0.5) * P.idleDropSpread[0],
        y: P.idleCenter[1] + (r2 - 0.5) * P.idleDropSpread[1],
        amp: P.idleDropAmp * (0.7 + 0.6 * r1) * idleScale
      };
    }
  }

  /* one stroke per live pointer (plus the idle virtual pointer), each with
     an amplitude proportional to its OWN pointer speed in uv/second, aspect
     corrected so vertical and horizontal flicks inject the same amount */
  const asp = W / H;
  const strokes = [];
  const pushStroke = (p) => {
    const dx = (p.x - p.px) * asp, dy = p.y - p.py;
    const speed = Math.hypot(dx, dy) / Math.max(dt, 1e-4);
    let amp = 0;
    if (speed > P.impulseMinSpeed){
      amp = Math.min(P.impulseBase + speed * P.impulseGain, P.impulseMax);
      if (idling) amp *= P.idleBoost;
      amp *= idleScale;
    }
    strokes.push({ px: p.px, py: p.py, x: p.x, y: p.y, amp });
  };
  if (idling) pushStroke(ptr);
  else if (ptr.accept) for (const p of pointers.values()) pushStroke(p);

  acc += dt;
  let n = Math.floor(acc / SIM_DT);
  if (n > P.simMaxSteps){ n = P.simMaxSteps; acc = 0; }
  else acc -= n * SIM_DT;

  if (n === 0 && !pending) return false;

  /* every pointer path is split across the substeps so a fast flick leaves
     a continuous wake instead of a dotted line */
  const steps = Math.max(n, pending ? 1 : 0);
  let maxAmp = 0;
  for (let k = 0; k < steps; k++){
    if (pending && k === 0){
      simStep(pending.x, pending.y, pending.x, pending.y, pending.amp, false);
      maxAmp = Math.max(maxAmp, pending.amp);
      pending = null;             /* a splash is a monopole */
    }
    for (const s of strokes){
      const a = k / steps, b = (k + 1) / steps;
      simStep(s.px + (s.x - s.px) * a, s.py + (s.y - s.py) * a,
              s.px + (s.x - s.px) * b, s.py + (s.y - s.py) * b,
              s.amp, true);
      maxAmp = Math.max(maxAmp, s.amp);
    }
  }

  if (maxAmp > 0) energy = Math.max(energy, maxAmp);
  else energy *= Math.pow(P.damping, steps);

  if (idling){ ptr.px = ptr.x; ptr.py = ptr.y; }
  else for (const p of pointers.values()){ p.px = p.x; p.py = p.y; }
  return true;
}

function stepNoise(now){
  gl.useProgram(progNoise);
  gl.bindFramebuffer(gl.FRAMEBUFFER, noiseRT.fbo);
  gl.viewport(0, 0, NS, NS);
  gl.uniform1f(uNoise.u_time, (now - t0) / 1000);
  gl.uniform1f(uNoise.u_aspect, W / H);
  gl.uniform1f(uNoise.u_scale, P.noiseScale);
  gl.uniform1f(uNoise.u_drift, P.noiseDrift);
  drawQuad();
}

function stepComposite(now){
  const time = (now - t0) / 1000;

  gl.useProgram(progComp);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, W, H);

  bindTex(0, texBase,     uComp.u_base);
  bindTex(1, texChrome,   uComp.u_chrome);
  bindTex(2, read.tex,    uComp.u_sim);
  bindTex(3, noiseRT.tex, uComp.u_noise);

  gl.uniform2f(uComp.u_res, W, H);
  gl.uniform2f(uComp.u_grid, SW, SH);
  gl.uniform2f(uComp.u_simTexel, 1 / SW, 1 / SH);
  gl.uniform1f(uComp.u_time, time);
  gl.uniform1f(uComp.u_canvasAspect, W / H);
  gl.uniform1f(uComp.u_imgAspect, IMG_ASPECT);
  gl.uniform2f(uComp.u_focus, P.imgFocus[0], P.imgFocus[1]);

  gl.uniform1f(uComp.u_gradTexels, P.gradTexels);
  gl.uniform1f(uComp.u_refraction, P.refraction);
  gl.uniform1f(uComp.u_refractMax, P.refractMax);
  gl.uniform1f(uComp.u_chromatic, P.chromatic);
  gl.uniform1f(uComp.u_chromaEdge, P.chromaEdge);
  gl.uniform1f(uComp.u_chromaMax, P.chromaMax);

  gl.uniform1f(uComp.u_normalScale, P.normalScale);
  gl.uniform1f(uComp.u_specStrength, P.specStrength);
  gl.uniform1f(uComp.u_shininess, P.shininess);
  gl.uniform3f(uComp.u_lightDir, D.light[0], D.light[1], D.light[2]);
  gl.uniform3f(uComp.u_specTint, P.specTint[0], P.specTint[1], P.specTint[2]);

  gl.uniform1f(uComp.u_maskHeight, P.maskHeight);
  gl.uniform1f(uComp.u_maskGrad, P.maskGrad);
  gl.uniform1f(uComp.u_maskLo, P.maskLo);
  gl.uniform1f(uComp.u_maskHi, P.maskHi);
  gl.uniform1f(uComp.u_maskNoise, P.maskNoise);
  gl.uniform1f(uComp.u_noiseTile, P.noiseTile);

  gl.uniform1f(uComp.u_edgeGlow, P.edgeGlow);
  gl.uniform1f(uComp.u_edgeGlowTight, P.edgeGlowTight);

  gl.uniform3fv(uComp.u_gc0, D.gradCols[0]);
  gl.uniform3fv(uComp.u_gc1, D.gradCols[1]);
  gl.uniform3fv(uComp.u_gc2, D.gradCols[2]);
  gl.uniform3fv(uComp.u_gc3, D.gradCols[3]);
  gl.uniform3fv(uComp.u_gc4, D.gradCols[4]);
  gl.uniform4f(uComp.u_gt, D.gradTs[0], D.gradTs[1], D.gradTs[2], D.gradTs[3]);
  gl.uniform1f(uComp.u_gradPhase, D.gradPhase);
  gl.uniform1f(uComp.u_gradScale, D.gradScale);
  gl.uniform1f(uComp.u_gradMix, D.gradMix);
  gl.uniform1f(uComp.u_lumLo, P.lumLo);
  gl.uniform1f(uComp.u_lumHi, P.lumHi);
  gl.uniform1f(uComp.u_lumGamma, P.lumGamma);
  gl.uniform1i(uComp.u_gradWrap, D.gradWrap);

  gl.uniform1f(uComp.u_bloom, P.bloom);
  gl.uniform1f(uComp.u_bloomRadius, P.bloomRadius);
  gl.uniform1f(uComp.u_bloomThreshold, P.bloomThreshold);
  gl.uniform1f(uComp.u_vignette, P.vignette);
  gl.uniform2f(uComp.u_vigCenter, P.vignetteCenter[0], P.vignetteCenter[1]);
  gl.uniform1f(uComp.u_vigInner, P.vignetteInner);
  gl.uniform1f(uComp.u_vigOuter, P.vignetteOuter);
  gl.uniform1f(uComp.u_scanlines, P.scanlines);
  gl.uniform1f(uComp.u_scanFreq, P.scanlineFreq);
  gl.uniform1f(uComp.u_grain, P.grain);

  drawQuad();
}

/* ==========================================================================
   Loop
   ========================================================================== */
function frame(now){
  if (!running) return;
  requestAnimationFrame(frame);
  if (document.hidden || paused){ prevT = now; return; }

  let dt = (now - prevT) / 1000;
  const delta = now - prevT;
  prevT = now;
  if (dt > 0.05) dt = 0.05;      /* clamp after a stall */
  if (dt <= 0) return;

  const quiet = !P.idleDrift
             && energy < P.idleStopEps
             && (now - ptr.lastInput) > P.idleDelayMs;

  const tStart = performance.now();

  resize();
  const stepped = stepSim(now, dt);

  if (!stepped && !needsDraw && quiet) return;
  needsDraw = false;

  stepNoise(now);
  stepComposite(now);

  frameMs = performance.now() - tStart;
  frameTimes[ftHead] = frameMs;
  frameDeltas[ftHead] = delta;
  ftHead = (ftHead + 1) % FT_N;
  if (ftCount < FT_N) ftCount++;

  fpsAcc++;
  if (now - lastFpsAt > 500){
    fps = Math.round(fpsAcc * 1000 / (now - lastFpsAt));
    fpsAcc = 0; lastFpsAt = now;
    if (DEBUG) updateDebug();
  }
}

/* ---- reduced motion: one static frame, no rAF ---- */
function staticFrame(){
  resize();
  clearSim();
  /* Three droplets, propagated out to a calm interfering pattern. Spreading
     the energy over several sources (rather than one deep dome) keeps the
     refraction map from folding at a single focal centre. */
  simStep(0.42, 0.60, 0.42, 0.60, 0.26, false);
  for (let i = 0; i < 26; i++) simStep(0, 0, 0, 0, 0, false);
  simStep(0.60, 0.50, 0.60, 0.50, 0.24, false);
  for (let i = 0; i < 22; i++) simStep(0, 0, 0, 0, 0, false);
  simStep(0.50, 0.63, 0.50, 0.63, 0.20, false);
  for (let i = 0; i < 40; i++) simStep(0, 0, 0, 0, 0, false);
  stepNoise(t0);
  stepComposite(t0);
}

/* ==========================================================================
   Debug / measurement
   ========================================================================== */
const dbgCtx  = DEBUG ? dbgField.getContext('2d') : null;
let dbgTmp = null, dbgImage = null;

/* Render the height field into an RGBA8 target as 16-bit fixed point, then
   read it back. Always works, unlike readPixels on a half-float attachment.
   Debug and tests only, never in the render path. */
let hBuf = null, hOut = null;
function readHeight(){
  const need = SW * SH;
  if (!hBuf || hBuf.length !== need * 4) hBuf = new Uint8Array(need * 4);
  if (!hOut || hOut.length !== need) hOut = new Float32Array(need);
  gl.useProgram(progView);
  gl.bindFramebuffer(gl.FRAMEBUFFER, viewRT.fbo);
  gl.viewport(0, 0, SW, SH);
  bindTex(0, read.tex, uView.u_sim);
  drawQuad();
  gl.readPixels(0, 0, SW, SH, gl.RGBA, gl.UNSIGNED_BYTE, hBuf);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  for (let i = 0; i < need; i++){
    const v = (hBuf[i*4] * 256 + hBuf[i*4+1]) / 65535;
    hOut[i] = (v * 2 - 1) * P.hClamp;
  }
  return hOut;
}

/* Radius of the disturbed region around a point, in uv-x units.
   Used to prove the wave PROPAGATES rather than being painted. */
function fieldStats(cx, cy, relThresh){
  const h = readHeight();
  let peak = 0;
  for (let i = 0; i < h.length; i++){ const a = Math.abs(h[i]); if (a > peak) peak = a; }
  const thr = Math.max(peak * (relThresh || 0.12), 1e-4);
  const asp = W / H;
  let rMax = 0, wSum = 0, wrSum = 0, area = 0, rmsSum = 0;
  for (let y = 0; y < SH; y++){
    for (let x = 0; x < SW; x++){
      const a = Math.abs(h[y * SW + x]);
      rmsSum += a * a;
      if (a < thr) continue;
      const u = (x + 0.5) / SW, v = (y + 0.5) / SH;
      const r = Math.hypot((u - cx) * asp, v - cy);
      if (r > rMax) rMax = r;
      wSum += a; wrSum += a * r;
      area++;
    }
  }
  return {
    peak,
    rms: Math.sqrt(rmsSum / h.length),
    outerRadius: rMax,
    meanRadius: wSum > 0 ? wrSum / wSum : 0,
    areaFrac: area / h.length,
    cells: [SW, SH]
  };
}

function updateDebug(){
  const h = readHeight();
  if (dbgCtx){
    if (!dbgTmp || dbgTmp.width !== SW || dbgTmp.height !== SH){
      dbgTmp = document.createElement('canvas');
      dbgTmp.width = SW; dbgTmp.height = SH;
      dbgImage = dbgTmp.getContext('2d').createImageData(SW, SH);
    }
    const d = dbgImage.data;
    for (let i = 0; i < SW * SH; i++){
      const v = clamp(h[i] * 4, -1, 1);
      /* orange = crest, blue = trough */
      d[i*4]   = v > 0 ? 40 + v * 215 : 20;
      d[i*4+1] = 30 + Math.abs(v) * 120;
      d[i*4+2] = v < 0 ? 40 - v * 215 : 60;
      d[i*4+3] = 255;
    }
    dbgTmp.getContext('2d').putImageData(dbgImage, 0, 0);
    dbgCtx.save();
    dbgCtx.clearRect(0, 0, dbgField.width, dbgField.height);
    dbgCtx.translate(0, dbgField.height);
    dbgCtx.scale(1, -1);   /* GL origin is bottom-left */
    dbgCtx.imageSmoothingEnabled = false;
    dbgCtx.drawImage(dbgTmp, 0, 0, dbgField.width, dbgField.height);
    dbgCtx.restore();
  }
  let peak = 0;
  for (let i = 0; i < h.length; i++){ const a = Math.abs(h[i]); if (a > peak) peak = a; }
  dbgText.textContent =
    'renderer  ' + (isGL2 ? 'WebGL2' : 'WebGL1') + '\n' +
    'sim grid  ' + SW + 'x' + SH + '  ' + simMode + '\n' +
    'sim rate  ' + P.simHz + ' Hz   C=' + P.waveC + '  damp=' + P.damping + '\n' +
    'canvas    ' + W + 'x' + H + '  dpr<=' + DPR_CAP + '\n' +
    'fps       ' + fps + '\n' +
    'frame     ' + frameMs.toFixed(2) + ' ms\n' +
    'peak |h|  ' + peak.toFixed(4) + '\n' +
    'steps     ' + simSteps;
}

/* ==========================================================================
   Test / inspection hooks (never used by the render loop)
   ========================================================================== */
window.__ripple = {
  P,
  get fps(){ return fps; },
  get frameMs(){ return frameMs; },
  get mode(){ return (isGL2 ? 'WebGL2' : 'WebGL1') + ' / ' + simMode; },
  get size(){ return [W, H]; },
  get simSize(){ return [SW, SH]; },
  get energy(){ return energy; },
  get steps(){ return simSteps; },
  errors: window.__rippleErrors,

  readHeight,
  fieldStats,
  clearSim,

  /* drop a single impulse without touching the pointer */
  impulse(x, y, amp){ pending = { x, y, amp: amp === undefined ? 0.5 : amp }; needsDraw = true; },

  /* freeze the loop so a still can be captured at an exact moment */
  pause(on){ paused = on !== false; prevT = performance.now(); acc = 0; },

  /* kill every source of motion so persistence can be measured cleanly */
  silence(){
    P.idleDrift = false;
    ptr.accept = false;
    ptr.has = false;
    ptr.px = ptr.x; ptr.py = ptr.y;
    ptr.lastInput = -1e9;
    pointers.clear();
  },
  setPointer(nx, ny){
    ptr.x = nx; ptr.y = ny; ptr.has = true; ptr.lastInput = performance.now();
  },

  /* what the composite pass actually sampled, at a uv point */
  probe(u, v){
    const h = readHeight();
    const xi = clamp(Math.round(u * SW - 0.5), 0, SW - 1);
    const yi = clamp(Math.round(v * SH - 0.5), 0, SH - 1);
    const at = (x, y) => h[clamp(y,0,SH-1) * SW + clamp(x,0,SW-1)];
    const n = [at(xi+1, yi) - at(xi-1, yi), at(xi, yi+1) - at(xi, yi-1)];
    /* mirror of the shader's softLimit(), so this reports what is really
       sampled rather than the unclamped ideal */
    const lim = (vx, vy, m) => {
      const l = Math.hypot(vx, vy);
      if (l < 1e-7) return [vx, vy];
      const k = m * (1 - Math.exp(-l / m)) / l;
      return [vx * k, vy * k];
    };
    const r = lim(n[0] * P.refraction, n[1] * P.refraction, P.refractMax);
    const c = lim(n[0] * P.chromatic, n[1] * P.chromatic, P.chromaMax);
    return {
      h: at(xi, yi),
      grad: n,
      gradLen: Math.hypot(n[0], n[1]),
      /* the uv offset the refraction actually applies, in uv and in px */
      refractUV: r,
      refractPx: [r[0] * W, r[1] * H],
      chromaPx: [c[0] * W, c[1] * H]
    };
  },

  frameStats(){
    const n = ftCount;
    if (!n) return null;
    const a = Array.from(frameTimes.slice(0, n)).sort((x, y) => x - y);
    const d = Array.from(frameDeltas.slice(0, n));
    const budget = 1000 / 60 * 1.5;
    let dropped = 0;
    for (let i = 0; i < d.length; i++) if (d[i] > budget) dropped++;
    return {
      n,
      medianMs: a[Math.floor(n * 0.5)],
      p95Ms: a[Math.floor(n * 0.95)],
      maxMs: a[n - 1],
      droppedPct: dropped * 100 / d.length
    };
  },
  resetFrameStats(){ ftHead = 0; ftCount = 0; },

  /* sample the composited framebuffer (needs preserveDrawingBuffer -> ?debug=1) */
  sampleRegion(x0, y0, x1, y1){
    const w = Math.max(1, Math.round((x1 - x0) * W));
    const h = Math.max(1, Math.round((y1 - y0) * H));
    const b = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(Math.round(x0 * W), Math.round(y0 * H), w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
    let r = 0, g = 0, bl = 0, maxc = 0;
    const n = w * h;
    for (let i = 0; i < n; i++){
      r += b[i*4]; g += b[i*4+1]; bl += b[i*4+2];
      maxc = Math.max(maxc, b[i*4], b[i*4+1], b[i*4+2]);
    }
    return { mean: [r/n, g/n, bl/n], max: maxc, n };
  },

  applyParams(){ derive(); needsDraw = true; },
  exportFrame
};

/* ==========================================================================
   Page affordances: frame export + content reveal
   ========================================================================== */
function exportFrame(){
  if (!running) return;
  const a = document.createElement('a');
  a.download = 'liquid-frame.png';
  a.href = canvas.toDataURL('image/png');
  a.click();
}
if (exportBtn){
  exportBtn.classList.add('ready');
  exportBtn.addEventListener('click', exportFrame);
}

/* fade the sections below the hero in as they scroll into view */
if (window.IntersectionObserver && !REDUCED){
  const secs = document.querySelectorAll('.section');
  const io = new IntersectionObserver((entries) => {
    for (const en of entries){
      if (en.isIntersecting){ en.target.classList.add('on'); io.unobserve(en.target); }
    }
  }, { threshold: 0.15 });
  secs.forEach(s => io.observe(s));
}

/* ==========================================================================
   Go
   ========================================================================== */
Promise.all([
  loadImage(P.BASE_SRC, texBase, DEFAULT_BASE),
  loadImage(P.CHROME_SRC, texChrome, DEFAULT_CHROME)
]).then(([baseImg, chromeImg]) => {
  if (!baseImg && !chromeImg){
    bail('images failed to load');
    return;
  }
  if (DEBUG) dbgEl.classList.add('on');
  resize();
  if (!running) return;
  if (REDUCED){
    staticFrame();
    if (DEBUG) updateDebug();
    window.__ripple.ready = true;
    return;
  }
  t0 = prevT = lastFpsAt = performance.now();
  ptr.lastInput = -1e9;
  requestAnimationFrame(frame);
  window.__ripple.ready = true;
}).catch(err => {
  running = false;
  bail(err && err.message ? err.message : String(err));
});

document.addEventListener('visibilitychange', () => { prevT = performance.now(); });

}

if (!gl){
  bail('WebGL unavailable');
} else {
  start();
}
