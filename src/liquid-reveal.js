/* ==========================================================================
   @qaziahmad/liquid-reveal

   A zero-dependency, plug-in WebGL "liquid reveal" effect.

   The reveal is driven by a REAL 2D wave simulation running on the GPU.
   Two height buffers are ping-ponged and stepped with the discrete wave
   equation:

       h[n+1] = (2*h[n] - h[n-1]) + C^2 * laplacian(h[n])
       h[n+1] *= damping

   Everything you see (refraction, specular glint, reveal mask, chromatic
   split) is derived from that height field and its gradient. FBM noise only
   perturbs the mask edge.

   Passes per frame:
     1. SIM        grid (long axis 288)  ping-pong  -> height field
     2. NOISE      256x256               single FBO -> fbm edge texture
     3. COMPOSITE  full res                         -> refraction, specular,
                                                      gradient map, mask

   Usage:
     import { LiquidReveal } from '@qaziahmad/liquid-reveal';
     const reveal = new LiquidReveal('#hero', {
       base:   'photo.png',
       chrome: 'chrome.png',
       imgWidth: 1672, imgHeight: 941,
     });

   See the README for the full API.
   ========================================================================== */

"use strict";

export const VERSION = '2.0.0';

/* --------------------------------------------------------------------------
   Defaults — every tunable in one place. Users override any of these via the
   constructor options (keys match the ones here).
   -------------------------------------------------------------------------- */
export const DEFAULT_PARAMS = {

  /* ---- assets ---- */
  base       : null,   // filled with the bundled placeholder when available
  chrome     : null,
  imgWidth   : 1280,
  imgHeight  : 720,
  /* focal point of the cover crop, TOP-LEFT origin. 0.5,0.5 = plain cover. */
  focus      : [0.50, 0.44],

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
  viscosity   : 0.045,  // diffusion term. Lower keeps the ripple edge sharp.
                        // Must stay under 0.25 for stability.
  edgeAbsorb  : 0.90,   // multiplier at the very border (absorbing layer,
                        // stops waves bouncing off the frame)
  edgeCells   : 16,     // width of that absorbing layer, in cells
  hClamp      : 1.10,   // safety clamp on height

  /* ---- cursor impulse ---- */
  impulseBase    : 0.1500,
  impulseGain    : 0.0700,
  impulseMax     : 0.2800,
  impulseMinSpeed: 0.004,
  impulseRadius  : 0.200,
  impulseFallSq  : 3.0,
  splashAmp      : 0.55,

  /* ======================================================================
     VISUALS DRIVEN BY THE HEIGHT FIELD
     ====================================================================== */
  gradTexels    : 1.0,
  refraction    : 0.120,
  refractMax    : 0.0070,
  chromatic     : 0.030,
  chromaEdge    : 1.0,
  chromaMax     : 0.0018,

  normalScale   : 34.0,
  specStrength  : 0.52,
  shininess     : 44.0,
  lightDir      : [-0.42, 0.55, 0.72],
  specTint      : [0.78, 1.00, 0.88],

  maskHeight    : 1.00,
  maskGrad      : 0.85,
  maskLo        : 0.065,
  maskHi        : 0.220,
  maskNoise     : 0.030,
  noiseTile     : 2.4,

  edgeGlow      : 0.18,
  edgeGlowTight : 8.0,

  /* ---- gradient map (how the chrome image is recoloured) ---- */
  gradStops: [
    { t: 0.00, c: '#00120A' },
    { t: 0.30, c: '#183827' },
    { t: 0.55, c: '#2E7A4E' },
    { t: 0.80, c: '#66C08A' },
    { t: 1.00, c: '#DFF7EA' }
  ],
  gradPhase : 0,
  gradScale : 100,
  gradMix   : 100,
  gradWrap  : 'mirror',

  lumLo     : 0.00,
  lumHi     : 0.25,
  lumGamma  : 0.60,

  /* ---- optics / atmosphere ---- */
  bloom         : 0.24,
  bloomRadius   : 2.6,
  bloomThreshold: 0.70,
  vignette      : 0.66,
  vignetteCenter: [0.50, 0.56],
  vignetteInner : 0.26,
  vignetteOuter : 0.92,
  scanlines     : 0.022,
  scanlineFreq  : 1.35,
  grain         : 0.034,

  /* ---- idle behaviour ---- */
  idleDrift     : true,
  idleDelayMs   : 1600,
  idleSpeed     : 0.85,
  idleRadius    : [0.22, 0.15],
  idleCenter    : [0.50, 0.52],
  idleBoost     : 1.0,
  idleDropMs    : 1250,
  idleDropAmp   : 0.00,
  idleDropSpread: [0.30, 0.26],
  narrowScale   : 0.45,

  /* ---- noise field ---- */
  noiseSize     : 256,
  noiseScale    : 9.0,
  noiseDrift    : 0.10,

  /* ---- performance ---- */
  dprCap        : 2.0,
  dprCapMobile  : 1.5,
  idleStopEps   : 0.0015
};

/* fps target used by `kick` until the real frame delta is known */
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const isEl  = (n) => n && typeof n === 'object' &&
             ((typeof Element !== 'undefined' && n instanceof Element) ||
              typeof n.nodeType === 'number');

function hexToRgb(hex){
  const h = hex.replace('#','');
  return [
    parseInt(h.slice(0,2),16)/255,
    parseInt(h.slice(2,4),16)/255,
    parseInt(h.slice(4,6),16)/255
  ];
}

/* Bundled placeholder assets. `new URL(…, import.meta.url)` is honoured both
   by plain browsers and by bundlers (Rollup/Vite/webpack 5+), and lets the
   package work with zero configuration. The CJS + minified builds substitute
   these with inline data: URLs at build time; `placeAt` guards the degenerate
   case where import.meta isn't real. Set { base: null, chrome: null } to
   disable the placeholders. */
const placeAt = (p) => {
  const base = (typeof import.meta !== 'undefined' ? import.meta.url : '') || '';
  if (!base) return p;
  try { return new URL(p, base).href; } catch (e) { return p; }
};
const PLACEHOLDER_BASE   = placeAt('../assets/base-placeholder.png');
const PLACEHOLDER_CHROME = placeAt('../assets/chrome-placeholder.png');

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

/* Height codec. With half-float targets the height lives in .r and the
   previous step in .g. Without them each is packed into two bytes (16-bit
   fixed point over [-hClamp, hClamp]), keeping the sim from quantising. */
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

  /* GLIDING BLOB, not a wave. The wave-equation propagation term is
     deliberately GONE so the reveal follows the cursor instead of flooding
     the whole page. What remains is a decaying, slightly diffused trail
     field: the pointer stamps into it and it fades behind the cursor. */
  float nxt = cur * u_damp;
  nxt += u_visc * l;   /* pure diffusion: softens the blob edge, no propagation */

  /* Monopole dab swept along the pointer path; amplitude tracks speed. */
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

/* Height lookup with C1 (smoothstep-warped) reconstruction so the gradient
   the refraction is built from does not come out faceted. */
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

/* levels stretch + gamma, THEN the gradient lookup. */
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

  /* ---- refraction: the biggest single liquid tell ---- */
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
   LiquidReveal
   ========================================================================== */
export class LiquidReveal {

  /* --- constructor ----------------------------------------------------- */
  constructor(target, options = {}){

    this.container  = null;
    this.canvas     = null;
    this.fallback   = null;
    this.exportBtn  = null;
    this.exportEl   = null;

    this._domOwned  = [];         /* nodes the instance created (destroyed on dispose) */
    this._listeners = [];         /* {el, type, fn, opts} pairs, removed on dispose */

    this.params = { ...DEFAULT_PARAMS };
    if (options) for (const k in options){
      if (options[k] !== undefined) this.params[k] = options[k];
    }
    /* asset defaults: user value > URL override > bundled placeholder */
    this.params.base   = options.base   ?? PLACEHOLDER_BASE;
    this.params.chrome = options.chrome ?? PLACEHOLDER_CHROME;

    /* lifecycle-ish flags */
    this.debug        = !!options.debug;
    this.urlParams    = !!options.urlParams;
    this.exportButton = (options.exportButton !== true && options.exportButton) ? options.exportButton
                     : options.exportButton === true;
    this.autoStart    = options.autoStart !== false;

    this.gl          = null;
    this.isGL2       = false;
    this.running     = false;
    this.paused      = false;
    this.disposed    = false;

    this._ready      = false;
    this._felled     = null;
    this._readyCbs   = [];
    this._errorCbs   = [];
    this.errors      = [];

    this._resolveTarget(target);
    this._buildDom();

    this.REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (this.urlParams) this._applyUrlParams();

    if (this.autoStart) this.start();
  }

  /* --- public state ----------------------------------------------------- */
  get ready(){ return this._ready; }
  get fellBack(){ return this._felled; }
  get mode(){ return (this.isGL2 ? 'WebGL2' : 'WebGL1'); }
  get size(){ return [this.W || 0, this.H || 0]; }
  get simSize(){ return [this.SW || 0, this.SH || 0]; }
  get energy(){ return this.energy_; }
  get steps(){ return this.steps_; }
  get fps(){ return this.fps_; }
  get frameMs(){ return this.frameMs_; }

  onReady(fn){ this._readyCbs.push(fn); if (this._ready) fn(this); return this; }
  onError(fn){ this._errorCbs.push(fn); if (this._felled) fn(this); return this; }

  /* ==========================================================================
     DOM / wiring
     ========================================================================== */
  _resolveTarget(target){
    const t = typeof target === 'string' ? document.querySelector(target) : target;
    if (!isEl(t)) throw new Error('LiquidReveal: target element not found (' + String(target) + ')');
    this.container = t;
    const cs = getComputedStyle(t);
    if (cs.position === 'static') t.style.position = 'relative';
    t.style.overflow = 'hidden';
    t.style.touchAction = 'none';
  }

  _span(tag, styles){
    const el = document.createElement(tag);
    if (styles) Object.assign(el.style, styles);
    return el;
  }

  _on(el, type, fn, opts){
    el.addEventListener(type, fn, opts || { passive: true });
    this._listeners.push({ el, type, fn, opts: opts || { passive: true } });
  }

  _buildDom(){
    const c = this.container;

    this.canvas = this._span('canvas', {
      position: 'absolute', inset: '0',
      width: '100%', height: '100%', display: 'block', zIndex: '0'
    });
    this.canvas.setAttribute('aria-hidden', 'true');

    this.fallback = this._span('div', {
      position: 'absolute', inset: '0', zIndex: '1', display: 'none',
      background: 'radial-gradient(120% 90% at 50% 40%, #3A2412 0%, #120B04 46%, #000 78%)'
    });

    c.append(this.canvas, this.fallback);
    this._domOwned.push(this.canvas, this.fallback);

    /* optional export button */
    if (this.exportButton && typeof this.exportButton === 'string' && this.exportButton){
      const el = document.querySelector(this.exportButton);
      if (el) this.exportEl = el;
    }
    if (!this.exportEl && this.exportButton === true){
      this.exportBtn = this._span('button', {
        position: 'absolute', right: '18px', bottom: '18px', zIndex: '3',
        width: '38px', height: '38px', borderRadius: '50%',
        border: '1px solid rgba(255,255,255,.18)',
        background: 'rgba(0,0,0,.35)', color: 'rgba(255,255,255,.75)',
        fontSize: '15px', lineHeight: '1', cursor: 'pointer',
        opacity: '0', pointerEvents: 'none',
        transition: 'border-color .25s ease, color .25s ease, opacity .4s ease'
      });
      this.exportBtn.textContent = '⤓';
      this.exportBtn.title = 'Export current frame as PNG';
      this.exportBtn.setAttribute('aria-label', 'Export current frame as PNG');
      c.append(this.exportBtn);
      this._domOwned.push(this.exportBtn);
    }
    const expTarget = this.exportEl || this.exportBtn;
    if (expTarget){
      const hov = (e) => { if (e.type === 'mouseenter'){ expTarget.style.borderColor = '#C98247'; expTarget.style.color = '#C98247'; }
                           else { expTarget.style.borderColor = 'rgba(255,255,255,.18)'; expTarget.style.color = 'rgba(255,255,255,.75)'; } };
      const act = () => { expTarget.style.transform = 'scale(.94)'; setTimeout(() => { expTarget.style.transform = ''; }, 120); };
      this._on(expTarget, 'mouseenter', hov);
      this._on(expTarget, 'mouseleave', hov);
      this._on(expTarget, 'click', () => { act(); this.exportFrame(); });
      this.exportTarget = expTarget;
    }

    /* debug overlay */
    if (this.debug){
      const field = this._span('canvas', {
        position: 'absolute', left: '12px', bottom: '12px', zIndex: '5',
        border: '1px solid rgba(157,200,230,.45)', imageRendering: 'pixelated', background: '#000'
      });
      field.width = 200; field.height = 120;
      const dbgText = this._span('div', {
        position: 'absolute', left: '224px', bottom: '12px', zIndex: '5',
        background: 'rgba(0,0,0,.72)', border: '1px solid rgba(157,200,230,.28)',
        padding: '6px 9px', font: '11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
        color: '#9dc8e6', whiteSpace: 'pre'
      });
      dbgText.textContent = 'booting…';
      c.append(field, dbgText);
      this._domOwned.push(field, dbgText);
      this.dbgField = field; this.dbgText = dbgText;
    }
  }

  /* Optional URL overrides (?src=&chrome=&imgw=&imgh=&focusx=&focusy=).
     Enabled with the `urlParams` option. */
  _applyUrlParams(){
    const qs = new URLSearchParams(location.search);
    const v = (k, fb) => { const x = qs.get(k); return (x == null || x === '') ? fb : x; };
    this.params.base    = v('src',    this.params.base);
    this.params.chrome  = v('chrome', this.params.chrome);
    this.params.imgWidth  = Number(v('imgw', this.params.imgWidth)) || this.params.imgWidth;
    this.params.imgHeight = Number(v('imgh', this.params.imgHeight)) || this.params.imgHeight;
    this.params.focus   = [
      Number(v('focusx', this.params.focus[0])) || this.params.focus[0],
      Number(v('focusy', this.params.focus[1])) || this.params.focus[1]
    ];
  }

  /* ==========================================================================
     Init / teardown
     ========================================================================== */
  _bail(reason){
    console.warn('[liquid-reveal] falling back:', reason);
    this._felled = reason;
    this.running = false;
    if (this.fallback) this.fallback.style.display = 'block';
    this.errors.push(String(reason));
    const cbs = this._errorCbs; this._errorCbs = [];
    for (const cb of cbs){ try { cb(this); } catch (e) {} }
  }

  _emitReady(){
    if (this._ready) return;
    this._ready = true;
    if (this.exportBtn){
      this.exportBtn.style.opacity = '1';
      this.exportBtn.style.pointerEvents = 'auto';
    }
    const cbs = this._readyCbs; this._readyCbs = [];
    for (const cb of cbs){ try { cb(this); } catch (e) {} }
  }

  start(){
    if (this.disposed) return;
    if (this._init()) this._boot();
  }

  destroy(){
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    for (const l of this._listeners){
      try { l.el.removeEventListener(l.type, l.fn, l.opts); } catch (e) {}
    }
    this._listeners.length = 0;
    if (this._ro){ try { this._ro.disconnect(); } catch (e) {} this._ro = null; }
    this._deleteGL();
    for (const n of this._domOwned){ try { n.remove(); } catch (e) {} }
    this._domOwned.length = 0;
    this.canvas = this.fallback = this.exportBtn = this.exportTarget = null;
    this.container = null;
  }

  _deleteGL(){
    const gl = this.gl; if (!gl) return;
    try {
      for (const r of [this.texBase, this.texChrome, this.simA, this.simB, this.viewRT, this.noiseRT]){
        if (r && r.tex) gl.deleteTexture(r.tex);
        if (r && r.fbo) gl.deleteFramebuffer(r.fbo);
      }
      if (this.quad) gl.deleteBuffer(this.quad);
      for (const p of [this.progSim, this.progComp, this.progNoise, this.progView]){
        if (p) gl.deleteProgram(p);
      }
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    } catch (e) {}
    this.gl = null;
  }

  /* ==========================================================================
     Core init inside the class context (previously `start()`)
     ========================================================================== */

  _getContext(){
    const opts = { alpha:false, antialias:false, depth:false, stencil:false,
                   premultipliedAlpha:false, powerPreference:'high-performance',
                   preserveDrawingBuffer: true };
    try {
      this.gl = this.canvas.getContext('webgl2', opts);
      this.isGL2 = !!this.gl;
      if (!this.gl) this.gl = this.canvas.getContext('webgl', opts) ||
                               this.canvas.getContext('experimental-webgl', opts);
    } catch (e) {}
    return this.gl;
  }

  _compile(type, src, name){
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
      const log = gl.getShaderInfoLog(s);
      console.error('[liquid-reveal] shader compile failed (' + name + '):\n' + log);
      this.errors.push(name + ': ' + log);
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  _program(fragSrc, name, defines){
    const gl = this.gl;
    const vs = this._compile(gl.VERTEX_SHADER, VERT, name + '.vert');
    const fs = this._compile(gl.FRAGMENT_SHADER, (defines || '') + fragSrc, name + '.frag');
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)){
      const log = gl.getProgramInfoLog(p);
      console.error('[liquid-reveal] link failed (' + name + '):\n' + log);
      this.errors.push(name + ' link: ' + log);
      return null;
    }
    gl.deleteShader(vs); gl.deleteShader(fs);
    return p;
  }

  _uniforms(prog){
    const gl = this.gl;
    const map = Object.create(null);
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++){
      const info = gl.getActiveUniform(prog, i);
      map[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, info.name);
    }
    return map;
  }

  _init(){
    const gl = this._getContext();
    if (!gl){ this._bail('WebGL unavailable'); return false; }

    /* one fullscreen quad */
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    /* float / half-float render target support */
    let simType = gl.UNSIGNED_BYTE, simInternal = gl.RGBA, simMode = 'rgba8-packed';
    let PACKED = true;
    if (this.isGL2){
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

    const defines = () => '#define HRANGE ' + this.params.hClamp.toFixed(1) + '\n' +
                          (PACKED ? '#define PACKED 1\n' : '');

    let progSim  = this._program(FRAG_SIM,   'sim',       defines());
    let progComp = this._program(FRAG_COMP,  'composite', defines());
    let progView = this._program(FRAG_VIEW,  'view',      defines());
    const progNoise = this._program(FRAG_NOISE, 'noise');

    if (!progSim || !progComp || !progNoise || !progView){
      this._bail('shader compilation failed - see console');
      return false;
    }
    let uSim  = this._uniforms(progSim);
    let uComp = this._uniforms(progComp);
    let uView = this._uniforms(progView);
    const uNoise = this._uniforms(progNoise);

    const makeTarget = (w, h, type, internal, filter) => {
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
    };

    /* sim grid */
    const simDimsFor = (w, h) => {
      const L = this.params.simLong;
      if (w >= h) return [L, Math.max(16, Math.round(L * h / w))];
      return [Math.max(16, Math.round(L * w / h)), L];
    };

    this.SW = 1; this.SH = 1;
    this.simA = null; this.simB = null; this.viewRT = null;
    this._read = null; this._write = null;
    const disposeTarget = (t) => { if (!t) return; gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); };

    const clearSim = () => {
      const c = PACKED ? [128/255, 128/255, 128/255, 128/255] : [0, 0, 0, 1];
      for (const t of [this.simA, this.simB]){
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.clearColor(c[0], c[1], c[2], c[3]);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.energy_ = 0;
    };

    const buildSim = (w, h) => {
      const [nw, nh] = simDimsFor(w, h);
      if (nw === this.SW && nh === this.SH && this.simA && this.simB) return false;
      disposeTarget(this.simA); disposeTarget(this.simB); disposeTarget(this.viewRT);
      this.SW = nw; this.SH = nh;
      const filter = PACKED ? gl.NEAREST : gl.LINEAR;
      this.simA = makeTarget(this.SW, this.SH, simType, simInternal, filter);
      this.simB = makeTarget(this.SW, this.SH, simType, simInternal, filter);
      if ((!this.simA || !this.simB) && !PACKED){
        disposeTarget(this.simA); disposeTarget(this.simB);
        PACKED = true; simType = gl.UNSIGNED_BYTE; simInternal = gl.RGBA; simMode = 'rgba8-packed (fallback)';
        this.progSim  = this._program(FRAG_SIM,  'sim',       defines());
        this.progComp = this._program(FRAG_COMP, 'composite', defines());
        this.progView = this._program(FRAG_VIEW, 'view',      defines());
        if (!this.progSim || !this.progComp || !this.progView) return null;
        this.uSim = this._uniforms(this.progSim);
        this.uComp = this._uniforms(this.progComp);
        this.uView = this._uniforms(this.progView);
        this.simA = makeTarget(this.SW, this.SH, simType, simInternal, gl.NEAREST);
        this.simB = makeTarget(this.SW, this.SH, simType, simInternal, gl.NEAREST);
      }
      this.viewRT = makeTarget(this.SW, this.SH, gl.UNSIGNED_BYTE, gl.RGBA, gl.NEAREST);
      if (!this.simA || !this.simB || !this.viewRT) return null;
      this._read = this.simA; this._write = this.simB;
      clearSim();
      return true;
    };

    const noiseRT = makeTarget(this.params.noiseSize, this.params.noiseSize,
                               gl.UNSIGNED_BYTE, gl.RGBA, gl.LINEAR);
    if (!noiseRT){ this._bail('render target creation failed'); return false; }
    this.noiseRT = noiseRT;

    /* image textures */
    const makeImageTexture = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                    new Uint8Array([0,0,0,255]));
      return t;
    };
    this.texBase = makeImageTexture();
    this.texChrome = makeImageTexture();

    this.progSim = progSim; this.progComp = progComp; this.progView = progView; this.progNoise = progNoise;
    this.uSim = uSim; this.uComp = uComp; this.uView = uView; this.uNoise = uNoise;
    this._PACKED = PACKED; this._simType = simType; this._simInternal = simInternal;
    this.simMode_ = simMode;
    this._buildSim = buildSim;
    this._clearSim = clearSim;
    this._disposeTarget = disposeTarget;

    /* derived params */
    const D = {};
    const derive = () => {
      const P = this.params;
      D.c2        = P.waveC * P.waveC;
      D.gradPhase = P.gradPhase / 100;
      D.gradScale = P.gradScale / 100;
      D.gradMix   = P.gradMix / 100;
      D.gradWrap  = P.gradWrap === 'mirror' ? 0 : (P.gradWrap === 'repeat' ? 2 : 1);
      D.gradCols  = P.gradStops.map(s => hexToRgb(s.c));
      D.gradTs    = [P.gradStops[1].t, P.gradStops[2].t, P.gradStops[3].t, P.gradStops[4].t];
      const L = P.lightDir, m = Math.hypot(L[0], L[1], L[2]) || 1;
      D.light = [L[0]/m, L[1]/m, L[2]/m];
    };
    derive();
    this._D = D; this._derive = derive;

    this.steps_ = 0;

    return true;
  }

  /* ---- pointer state ---- */
  _setupInput(){
    const c = this.container;
    const P = this.params;

    const ptr = { x: 0.5, y: 0.55, px: 0.5, py: 0.55, has: false, lastInput: -1e9, accept: true };
    this.ptr = ptr;

    const pointers = new Map();
    const track = (e) => {
      if (!ptr.accept) return;
      const r = c.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = 1.0 - (e.clientY - r.top) / r.height;
      const p = pointers.get(e.pointerId) || { x, y, px: x, py: y };
      p.x = x; p.y = y;
      pointers.set(e.pointerId, p);
      ptr.x = x; ptr.y = y;
      ptr.has = true;
      ptr.lastInput = performance.now();
    };
    const down = (e) => {
      track(e);
      this.pending = { x: ptr.x, y: ptr.y,
                       amp: P.splashAmp * (this.W < this.H ? P.narrowScale : 1) };
      this.needsDraw = true;
    };
    const up = (e) => {
      if (e.pointerType !== 'mouse') pointers.delete(e.pointerId);
      if (pointers.size === 0) ptr.has = false;
    };
    const leave = () => { pointers.clear(); ptr.has = false; };

    this._on(c, 'pointermove', track);
    this._on(c, 'pointerdown', down);
    this._on(c, 'pointerup', up);
    this._on(c, 'pointercancel', up);
    this._on(c, 'pointerleave', leave);

    this.pointers = pointers;
    this._input = { track, down, up, leave };
  }

  _setupSizing(){
    const isMobile = matchMedia('(pointer: coarse)').matches || window.innerWidth < 760;
    this.DPR_CAP = isMobile ? this.params.dprCapMobile : this.params.dprCap;
    this.W = 1; this.H = 1;
    this.sizeDirty = true;

    const markDirtyRel = () => { this.sizeDirty = true; this.needsDraw = true; };
    this._on(window, 'resize', markDirtyRel);
    this._on(window, 'orientationchange', markDirtyRel);
    if (window.ResizeObserver){
      this._ro = new ResizeObserver(markDirtyRel);
      this._ro.observe(this.container);
    }
    this._markDirtyRel = markDirtyRel;
  }

  _resize(){
    if (this.disposed) return false;
    if (!this.sizeDirty) return false;
    this.sizeDirty = false;
    const dpr = Math.min(window.devicePixelRatio || 1, this.DPR_CAP);
    const w = Math.max(1, Math.round(this.container.clientWidth  * dpr));
    const h = Math.max(1, Math.round(this.container.clientHeight * dpr));
    if ((w === this.W && h === this.H) && this.W > 1) return false;
    this.W = w; this.H = h;
    this.canvas.width = w; this.canvas.height = h;
    const ok = this._buildSim(w, h);
    if (ok === null){ this._bail('sim target creation failed'); return false; }
    return true;
  }

  /* ---- passes ---- */
  _bindTex(unit, tex, loc){
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }
  _drawQuad(){ this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4); }

  _simStep(ax, ay, bx, by, amp, dipole){
    const gl = this.gl, P = this.params, D = this._D;
    const { progSim, uSim, SW, SH } = this;
    this._read = this._read || this.simA;
    this._write = this._write || this.simB;
    gl.useProgram(progSim);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._write.fbo);
    gl.viewport(0, 0, SW, SH);
    this._bindTex(0, this._read.tex, uSim.u_prev);
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
    gl.uniform1f(uSim.u_aspect, this.W / this.H);
    gl.uniform1f(uSim.u_dipole, dipole ? 1 : 0);
    this._drawQuad();
    const tmp = this._read; this._read = this._write; this._write = tmp;
    this.steps_++;
  }

  _stepSim(now, dt){
    const P = this.params;
    const ptr = this.ptr;
    const idleFor = now - ptr.lastInput;
    const anyActive = ptr.accept && this.pointers.size > 0;
    let idling = false;
    const idleScale = (this.W < this.H) ? P.narrowScale : 1.0;
    if (P.idleDrift && !this.REDUCED && (!anyActive || idleFor > P.idleDelayMs)){
      idling = true;
      const tt = (now - this.t0) / 1000 * P.idleSpeed;
      ptr.x = P.idleCenter[0] + Math.cos(tt * 1.00) * P.idleRadius[0]
                              + Math.cos(tt * 2.30) * P.idleRadius[0] * 0.28;
      ptr.y = P.idleCenter[1] + Math.sin(tt * 1.37) * P.idleRadius[1]
                              + Math.sin(tt * 0.71) * P.idleRadius[1] * 0.33;
      if (now - this.lastDropAt > P.idleDropMs && !this.pending){
        this.lastDropAt = now;
        this.dropSeed = (this.dropSeed * 9301 + 49297) % 233280;
        const r1 = this.dropSeed / 233280;
        this.dropSeed = (this.dropSeed * 9301 + 49297) % 233280;
        const r2 = this.dropSeed / 233280;
        this.pending = {
          x: P.idleCenter[0] + (r1 - 0.5) * P.idleDropSpread[0],
          y: P.idleCenter[1] + (r2 - 0.5) * P.idleDropSpread[1],
          amp: P.idleDropAmp * (0.7 + 0.6 * r1) * idleScale
        };
      }
    }

    const asp = this.W / this.H;
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
    else if (ptr.accept) for (const p of this.pointers.values()) pushStroke(p);

    this.acc += dt;
    let n = Math.floor(this.acc / this.SIM_DT);
    if (n > P.simMaxSteps){ n = P.simMaxSteps; this.acc = 0; }
    else this.acc -= n * this.SIM_DT;

    if (n === 0 && !this.pending) return false;

    const steps = Math.max(n, this.pending ? 1 : 0);
    let maxAmp = 0;
    for (let k = 0; k < steps; k++){
      if (this.pending && k === 0){
        this._simStep(this.pending.x, this.pending.y, this.pending.x, this.pending.y,
                      this.pending.amp, false);
        maxAmp = Math.max(maxAmp, this.pending.amp);
        this.pending = null;
      }
      for (const s of strokes){
        const a = k / steps, b = (k + 1) / steps;
        this._simStep(s.px + (s.x - s.px) * a, s.py + (s.y - s.py) * a,
                      s.px + (s.x - s.px) * b, s.py + (s.y - s.py) * b,
                      s.amp, true);
        maxAmp = Math.max(maxAmp, s.amp);
      }
    }

    if (maxAmp > 0) this.energy_ = Math.max(this.energy_, maxAmp);
    else this.energy_ *= Math.pow(P.damping, steps);

    if (idling){ ptr.px = ptr.x; ptr.py = ptr.y; }
    else for (const p of this.pointers.values()){ p.px = p.x; p.py = p.y; }
    return true;
  }

  _stepNoise(now){
    const gl = this.gl;
    gl.useProgram(this.progNoise);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.noiseRT.fbo);
    gl.viewport(0, 0, this.params.noiseSize, this.params.noiseSize);
    gl.uniform1f(this.uNoise.u_time, (now - this.t0) / 1000);
    gl.uniform1f(this.uNoise.u_aspect, this.W / this.H);
    gl.uniform1f(this.uNoise.u_scale, this.params.noiseScale);
    gl.uniform1f(this.uNoise.u_drift, this.params.noiseDrift);
    this._drawQuad();
  }

  _stepComposite(now){
    const gl = this.gl, P = this.params, D = this._D;
    const time = (now - this.t0) / 1000;
    const u = this.uComp;

    gl.useProgram(this.progComp);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.W, this.H);

    this._bindTex(0, this.texBase,   u.u_base);
    this._bindTex(1, this.texChrome, u.u_chrome);
    this._bindTex(2, this._read.tex, u.u_sim);
    this._bindTex(3, this.noiseRT.tex, u.u_noise);

    gl.uniform2f(u.u_res, this.W, this.H);
    gl.uniform2f(u.u_grid, this.SW, this.SH);
    gl.uniform2f(u.u_simTexel, 1 / this.SW, 1 / this.SH);
    gl.uniform1f(u.u_time, time);
    gl.uniform1f(u.u_canvasAspect, this.W / this.H);
    gl.uniform1f(u.u_imgAspect, P.imgWidth / P.imgHeight);
    gl.uniform2f(u.u_focus, P.focus[0], P.focus[1]);

    gl.uniform1f(u.u_gradTexels, P.gradTexels);
    gl.uniform1f(u.u_refraction, P.refraction);
    gl.uniform1f(u.u_refractMax, P.refractMax);
    gl.uniform1f(u.u_chromatic, P.chromatic);
    gl.uniform1f(u.u_chromaEdge, P.chromaEdge);
    gl.uniform1f(u.u_chromaMax, P.chromaMax);

    gl.uniform1f(u.u_normalScale, P.normalScale);
    gl.uniform1f(u.u_specStrength, P.specStrength);
    gl.uniform1f(u.u_shininess, P.shininess);
    gl.uniform3f(u.u_lightDir, D.light[0], D.light[1], D.light[2]);
    gl.uniform3f(u.u_specTint, P.specTint[0], P.specTint[1], P.specTint[2]);

    gl.uniform1f(u.u_maskHeight, P.maskHeight);
    gl.uniform1f(u.u_maskGrad, P.maskGrad);
    gl.uniform1f(u.u_maskLo, P.maskLo);
    gl.uniform1f(u.u_maskHi, P.maskHi);
    gl.uniform1f(u.u_maskNoise, P.maskNoise);
    gl.uniform1f(u.u_noiseTile, P.noiseTile);

    gl.uniform1f(u.u_edgeGlow, P.edgeGlow);
    gl.uniform1f(u.u_edgeGlowTight, P.edgeGlowTight);

    gl.uniform3fv(u.u_gc0, D.gradCols[0]);
    gl.uniform3fv(u.u_gc1, D.gradCols[1]);
    gl.uniform3fv(u.u_gc2, D.gradCols[2]);
    gl.uniform3fv(u.u_gc3, D.gradCols[3]);
    gl.uniform3fv(u.u_gc4, D.gradCols[4]);
    gl.uniform4f(u.u_gt, D.gradTs[0], D.gradTs[1], D.gradTs[2], D.gradTs[3]);
    gl.uniform1f(u.u_gradPhase, D.gradPhase);
    gl.uniform1f(u.u_gradScale, D.gradScale);
    gl.uniform1f(u.u_gradMix, D.gradMix);
    gl.uniform1f(u.u_lumLo, P.lumLo);
    gl.uniform1f(u.u_lumHi, P.lumHi);
    gl.uniform1f(u.u_lumGamma, P.lumGamma);
    gl.uniform1i(u.u_gradWrap, D.gradWrap);

    gl.uniform1f(u.u_bloom, P.bloom);
    gl.uniform1f(u.u_bloomRadius, P.bloomRadius);
    gl.uniform1f(u.u_bloomThreshold, P.bloomThreshold);
    gl.uniform1f(u.u_vignette, P.vignette);
    gl.uniform2f(u.u_vigCenter, P.vignetteCenter[0], P.vignetteCenter[1]);
    gl.uniform1f(u.u_vigInner, P.vignetteInner);
    gl.uniform1f(u.u_vigOuter, P.vignetteOuter);
    gl.uniform1f(u.u_scanlines, P.scanlines);
    gl.uniform1f(u.u_scanFreq, P.scanlineFreq);
    gl.uniform1f(u.u_grain, P.grain);

    this._drawQuad();
  }

  /* ---- frame loop ---- */
  _frame(now){
    if (!this.running || this.disposed) return;
    this._raf = requestAnimationFrame((t) => this._frame(t));
    if (document.hidden || this.paused){ this.prevT = now; return; }

    let dt = (now - this.prevT) / 1000;
    const delta = now - this.prevT;
    this.prevT = now;
    if (dt > 0.05) dt = 0.05;
    if (dt <= 0) return;

    const quiet = !this.params.idleDrift
               && this.energy_ < this.params.idleStopEps
               && (now - this.ptr.lastInput) > this.params.idleDelayMs;

    const tStart = performance.now();

    this._resize();
    const stepped = this._stepSim(now, dt);

    if (!stepped && !this.needsDraw && quiet) return;
    this.needsDraw = false;

    this._stepNoise(now);
    this._stepComposite(now);

    this.frameMs_ = performance.now() - tStart;
    this.frameTimes[this.ftHead] = this.frameMs_;
    this.frameDeltas[this.ftHead] = delta;
    this.ftHead = (this.ftHead + 1) % this.FT_N;
    if (this.ftCount < this.FT_N) this.ftCount++;

    this.fpsAcc++;
    if (now - this.lastFpsAt > 500){
      this.fps_ = Math.round(this.fpsAcc * 1000 / (now - this.lastFpsAt));
      this.fpsAcc = 0; this.lastFpsAt = now;
      if (this.debug) this._updateDebug(now);
    }
    if (!this._ready) this._emitReady();
  }

  /* reduced motion: one static frame, no loop */
  _staticFrame(){
    this._resize();
    this._clearSim();
    this._simStep(0.42, 0.60, 0.42, 0.60, 0.26, false);
    for (let i = 0; i < 26; i++) this._simStep(0, 0, 0, 0, 0, false);
    this._simStep(0.60, 0.50, 0.60, 0.50, 0.24, false);
    for (let i = 0; i < 22; i++) this._simStep(0, 0, 0, 0, 0, false);
    this._simStep(0.50, 0.63, 0.50, 0.63, 0.20, false);
    for (let i = 0; i < 40; i++) this._simStep(0, 0, 0, 0, 0, false);
    this._stepNoise(this.t0);
    this._stepComposite(this.t0);
  }

  /* ---- image loading ---- */
  _loadImage(src, tex){
    return new Promise((resolve) => {
      if (!src){ resolve(null); return; }
      const img = new Image();
      img.decoding = 'async';
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const gl = this.gl;
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        } catch (e){ resolve(null); return; }
        resolve(img);
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  _boot(){
    this._setupInput();
    this._setupSizing();
    this.running = true;

    /* frame-time ring */
    this.FT_N = 2048;
    this.frameTimes = new Float32Array(this.FT_N);
    this.frameDeltas = new Float32Array(this.FT_N);
    this.ftHead = 0; this.ftCount = 0;

    this.t0 = this.prevT = this.lastFpsAt = performance.now();
    this.acc = 0; this.SIM_DT = 1 / this.params.simHz;
    this.energy_ = 0; this.frameMs_ = 0; this.fps_ = 0; this.fpsAcc = 0;
    this.needsDraw = true; this.pending = null;
    this.lastDropAt = -1e9; this.dropSeed = 0;
    this.ptr.lastInput = -1e9;

    Promise.all([
      this._loadImage(this.params.base,   this.texBase),
      this._loadImage(this.params.chrome, this.texChrome)
    ]).then(([baseImg, chromeImg]) => {
      if (!baseImg && !chromeImg){
        this._bail('images failed to load');
        return;
      }
      if (this.disposed) return;
      this._resize();
      if (!this.running) return;
      if (this.REDUCED){
        this._staticFrame();
        this._emitReady();
        return;
      }
      this.t0 = this.prevT = this.lastFpsAt = performance.now();
      this.ptr.lastInput = -1e9;
      this._raf = requestAnimationFrame((t) => this._frame(t));
    }).catch((err) => {
      this._bail(err && err.message ? err.message : String(err));
    });
  }

  /* ---- debug readback ---- */
  _updateDebug(now){
    if (!this.debug || !this.dbgField) return;
    const gl = this.gl;
    let hBuf = this._hBuf, hOut = this._hOut;
    const need = this.SW * this.SH;
    if (!hBuf || hBuf.length !== need * 4) hBuf = this._hBuf = new Uint8Array(need * 4);
    if (!hOut || hOut.length !== need) hOut = this._hOut = new Float32Array(need);
    gl.useProgram(this.progView);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.viewRT.fbo);
    gl.viewport(0, 0, this.SW, this.SH);
    this._bindTex(0, this._read.tex, this.uView.u_sim);
    this._drawQuad();
    gl.readPixels(0, 0, this.SW, this.SH, gl.RGBA, gl.UNSIGNED_BYTE, hBuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let i = 0; i < need; i++){
      const v = (hBuf[i*4] * 256 + hBuf[i*4+1]) / 65535;
      hOut[i] = (v * 2 - 1) * this.params.hClamp;
    }
    this._dbgH = hOut;

    if (this.dbgField){
      let t = this._dbgTmp;
      if (!t || t.width !== this.SW || t.height !== this.SH){
        t = this._dbgTmp = document.createElement('canvas');
        t.width = this.SW; t.height = this.SH;
        this._dbgImage = t.getContext('2d').createImageData(this.SW, this.SH);
      }
      const d = this._dbgImage.data;
      for (let i = 0; i < this.SW * this.SH; i++){
        const v = clamp(hOut[i] * 4, -1, 1);
        d[i*4]   = v > 0 ? 40 + v * 215 : 20;
        d[i*4+1] = 30 + Math.abs(v) * 120;
        d[i*4+2] = v < 0 ? 40 - v * 215 : 60;
        d[i*4+3] = 255;
      }
      t.getContext('2d').putImageData(this._dbgImage, 0, 0);
      const ctx = this.dbgField.getContext('2d');
      ctx.save();
      ctx.clearRect(0, 0, this.dbgField.width, this.dbgField.height);
      ctx.translate(0, this.dbgField.height);
      ctx.scale(1, -1);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(t, 0, 0, this.dbgField.width, this.dbgField.height);
      ctx.restore();
    }
    let peak = 0;
    for (let i = 0; i < hOut.length; i++){ const a = Math.abs(hOut[i]); if (a > peak) peak = a; }
    this.dbgText.textContent =
      'renderer  ' + (this.isGL2 ? 'WebGL2' : 'WebGL1') + '\n' +
      'sim grid  ' + this.SW + 'x' + this.SH + '  ' + this.simMode_ + '\n' +
      'sim rate  ' + this.params.simHz + ' Hz   C=' + this.params.waveC + '  damp=' + this.params.damping + '\n' +
      'canvas    ' + this.W + 'x' + this.H + '  dpr<=' + this.DPR_CAP + '\n' +
      'fps       ' + (this.fps_ || 0) + '\n' +
      'frame     ' + this.frameMs_.toFixed(2) + ' ms\n' +
      'peak |h|  ' + peak.toFixed(4) + '\n' +
      'steps     ' + this.steps_;
  }

  /* ==========================================================================
     Public API
     ========================================================================== */

  /* re-point the source images at runtime. Pass { base, chrome } to swap. */
  setImages({ base, chrome } = {}){
    if (base   !== undefined) this.params.base   = base;
    if (chrome !== undefined) this.params.chrome = chrome;
    if (!this.running || this.disposed) return this;
    const jobs = [];
    if (base   !== undefined) jobs.push(this._loadImage(this.params.base,   this.texBase));
    if (chrome !== undefined) jobs.push(this._loadImage(this.params.chrome, this.texChrome));
    Promise.all(jobs).then((imgs) => {
      if (imgs.length && imgs.every(i => !i)) this._bail('images failed to load');
    });
    return this;
  }

  /* apply any subset of the params. Keys match DEFAULT_PARAMS. */
  setParams(patch = {}){
    Object.assign(this.params, patch);
    if (this._derive) this._derive();
    this.needsDraw = true;
    return this;
  }

  getParams(){ return { ...this.params }; }

  /* drop a one-shot impulse (uv space, y-up) */
  impulse(x, y, amp){
    this.pending = { x, y, amp: amp === undefined ? 0.5 : amp };
    this.needsDraw = true;
    return this;
  }

  /* freeze the loop so a still can be captured at an exact moment */
  pause(on){
    this.paused = on !== false;
    this.prevT = performance.now();
    this.acc = 0;
    return this;
  }

  /* kill every source of motion */
  silence(){
    if (!this.ptr) return this;
    const P = this.params;
    P.idleDrift = false;
    this.ptr.accept = false;
    this.ptr.has = false;
    this.ptr.px = this.ptr.x; this.ptr.py = this.ptr.y;
    this.ptr.lastInput = -1e9;
    this.pointers.clear();
    return this;
  }

  setPointer(x, y){
    if (!this.ptr) return this;
    this.ptr.x = x; this.ptr.y = y;
    this.ptr.has = true;
    this.ptr.lastInput = performance.now();
    return this;
  }

  /* download the current canvas frame as a PNG */
  exportFrame(){
    if (!this.running || this.disposed) return;
    const a = document.createElement('a');
    a.download = 'liquid-frame.png';
    a.href = this.canvas.toDataURL('image/png');
    a.click();
    return this;
  }

  /* ----- measurement hooks (mirror of the internal readback) ----- */

  readHeight(){
    const gl = this.gl;
    if (!gl) return null;
    let hBuf = this._hBuf, hOut = this._hOut;
    const need = this.SW * this.SH;
    if (!hBuf || hBuf.length !== need * 4) hBuf = this._hBuf = new Uint8Array(need * 4);
    if (!hOut || hOut.length !== need) hOut = this._hOut = new Float32Array(need);
    gl.useProgram(this.progView);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.viewRT.fbo);
    gl.viewport(0, 0, this.SW, this.SH);
    this._bindTex(0, this._read.tex, this.uView.u_sim);
    this._drawQuad();
    gl.readPixels(0, 0, this.SW, this.SH, gl.RGBA, gl.UNSIGNED_BYTE, hBuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let i = 0; i < need; i++){
      const v = (hBuf[i*4] * 256 + hBuf[i*4+1]) / 65535;
      hOut[i] = (v * 2 - 1) * this.params.hClamp;
    }
    return hOut;
  }

  fieldStats(cx, cy, relThresh){
    const h = this.readHeight();
    if (!h) return null;
    let peak = 0;
    for (let i = 0; i < h.length; i++){ const a = Math.abs(h[i]); if (a > peak) peak = a; }
    const thr = Math.max(peak * (relThresh || 0.12), 1e-4);
    const asp = this.W / this.H;
    let rMax = 0, wSum = 0, wrSum = 0, area = 0, rmsSum = 0;
    for (let y = 0; y < this.SH; y++){
      for (let x = 0; x < this.SW; x++){
        const a = Math.abs(h[y * this.SW + x]);
        rmsSum += a * a;
        if (a < thr) continue;
        const u = (x + 0.5) / this.SW, v = (y + 0.5) / this.SH;
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
      cells: [this.SW, this.SH]
    };
  }

  probe(u, v){
    const h = this.readHeight();
    if (!h) return null;
    const xi = clamp(Math.round(u * this.SW - 0.5), 0, this.SW - 1);
    const yi = clamp(Math.round(v * this.SH - 0.5), 0, this.SH - 1);
    const at = (x, y) => h[clamp(y,0,this.SH-1) * this.SW + clamp(x,0,this.SW-1)];
    const n = [at(xi+1, yi) - at(xi-1, yi), at(xi, yi+1) - at(xi, yi-1)];
    const lim = (vx, vy, m) => {
      const l = Math.hypot(vx, vy);
      if (l < 1e-7) return [vx, vy];
      const k = m * (1 - Math.exp(-l / m)) / l;
      return [vx * k, vy * k];
    };
    const r = lim(n[0] * this.params.refraction, n[1] * this.params.refraction, this.params.refractMax);
    const c = lim(n[0] * this.params.chromatic, n[1] * this.params.chromatic, this.params.chromaMax);
    return {
      h: at(xi, yi),
      grad: n,
      gradLen: Math.hypot(n[0], n[1]),
      refractUV: r,
      refractPx: [r[0] * this.W, r[1] * this.H],
      chromaPx: [c[0] * this.W, c[1] * this.H]
    };
  }

  frameStats(){
    const n = this.ftCount;
    if (!n) return null;
    const a = Array.from(this.frameTimes.slice(0, n)).sort((x, y) => x - y);
    const d = Array.from(this.frameDeltas.slice(0, n));
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
  }

  resetFrameStats(){ this.ftHead = 0; this.ftCount = 0; return this; }

  sampleRegion(x0, y0, x1, y1){
    const gl = this.gl;
    if (!gl) return null;
    const w = Math.max(1, Math.round((x1 - x0) * this.W));
    const h = Math.max(1, Math.round((y1 - y0) * this.H));
    const b = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(Math.round(x0 * this.W), Math.round(y0 * this.H), w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
    let r = 0, g = 0, bl = 0, maxc = 0;
    const n = w * h;
    for (let i = 0; i < n; i++){
      r += b[i*4]; g += b[i*4+1]; bl += b[i*4+2];
      maxc = Math.max(maxc, b[i*4], b[i*4+1], b[i*4+2]);
    }
    return { mean: [r/n, g/n, bl/n], max: maxc, n };
  }
}

export default LiquidReveal;