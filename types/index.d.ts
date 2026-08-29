/**
 * Type definitions for liquid-reveal v2 — WebGL wave-equation reveal effect.
 *
 * Usage (native ESM or any bundler):
 *   import LiquidReveal, { DEFAULT_PARAMS, VERSION } from 'liquid-reveal';
 *
 * Usage (script tag): the class is exposed as `window.LiquidReveal` together
 * with `.DEFAULT_PARAMS` and `.VERSION` statics.
 */

/* ============================================================================
   Configuration
   ========================================================================== */

export interface GradientStop {
  t: number;
  c: string;
}

/**
 * Every tunable of the effect. All keys are optional when creating an
 * instance; anything you omit falls back to `DEFAULT_PARAMS`.
 */
export interface LiquidRevealParams {
  /* ---- assets ---- */
  /** Image shown through the liquid (CSS-url string, or null for the bundled placeholder). */
  base: string | null;
  /** Image revealed by the wave (CSS-url string, or null for the bundled placeholder). */
  chrome: string | null;
  /** Intrinsic width of the source images (used for the cover crop). */
  imgWidth: number;
  /** Intrinsic height of the source images (used for the cover crop). */
  imgHeight: number;
  /** Focal point of the cover crop, top-left origin. `[0.5, 0.5]` = plain cover. */
  focus: [number, number];

  /* ---- wave simulation ---- */
  /** Cells on the long axis. Cells stay square so ripples are circular. */
  simLong: number;
  /** Fixed simulation rate in Hz; accumulator-driven (identical on 60/120 Hz panels). */
  simHz: number;
  /** Catch-up step cap after a stall. */
  simMaxSteps: number;
  /** Courant number. CFL limit for this stencil is 0.707 — do not exceed it. */
  waveC: number;
  /** Per-step decay. Lower = faster. */
  damping: number;
  /** Diffusion term. Must stay under 0.25 for stability. */
  viscosity: number;
  /** Absorbing-layer multiplier at the frame border. */
  edgeAbsorb: number;
  /** Width of the absorbing layer, in cells. */
  edgeCells: number;
  /** Safety clamp on height. */
  hClamp: number;

  /* ---- cursor impulse ---- */
  impulseBase: number;
  impulseGain: number;
  impulseMax: number;
  impulseMinSpeed: number;
  impulseRadius: number;
  impulseFallSq: number;
  splashAmp: number;

  /* ---- visuals driven by the height field ---- */
  gradTexels: number;
  refraction: number;
  refractMax: number;
  chromatic: number;
  chromaEdge: number;
  chromaMax: number;
  normalScale: number;
  specStrength: number;
  shininess: number;
  lightDir: [number, number, number];
  specTint: [number, number, number];
  maskHeight: number;
  maskGrad: number;
  maskLo: number;
  maskHi: number;
  maskNoise: number;
  noiseTile: number;
  edgeGlow: number;
  edgeGlowTight: number;

  /* ---- gradient map (chrome recolour) ---- */
  gradStops: GradientStop[];
  gradPhase: number;
  gradScale: number;
  gradMix: number;
  gradWrap: 'mirror' | 'clamp' | 'repeat';
  lumLo: number;
  lumHi: number;
  lumGamma: number;

  /* ---- optics / atmosphere ---- */
  bloom: number;
  bloomRadius: number;
  bloomThreshold: number;
  vignette: number;
  vignetteCenter: [number, number];
  vignetteInner: number;
  vignetteOuter: number;
  scanlines: number;
  scanlineFreq: number;
  grain: number;

  /* ---- idle behaviour ---- */
  idleDrift: boolean;
  idleDelayMs: number;
  idleSpeed: number;
  idleRadius: [number, number];
  idleCenter: [number, number];
  idleBoost: number;
  idleDropMs: number;
  idleDropAmp: number;
  idleDropSpread: [number, number];
  narrowScale: number;

  /* ---- noise field ---- */
  noiseSize: number;
  noiseScale: number;
  noiseDrift: number;

  /* ---- performance ---- */
  dprCap: number;
  dprCapMobile: number;
  idleStopEps: number;
}

/** Instance-only options accepted by the constructor (not part of params). */
export interface LiquidRevealOptions extends Partial<LiquidRevealParams> {
  /** Enable a small on-screen debug overlay (frame time, energy, pointers). */
  debug?: boolean;
  /** Honour `?src=&chrome=&imgw=&imgh=&focusx=&focusy=` URL params. */
  urlParams?: boolean;
  /** `true` mounts a built-in ⤓ button; a CSS selector mounts the button there. */
  exportButton?: boolean | string;
  /** Automatically start the loop (default `true`). */
  autoStart?: boolean;
}

/* ============================================================================
   Measurement results
   ========================================================================== */

export interface FieldStats {
  peak: number;
  rms: number;
  outerRadius: number;
  meanRadius: number;
  areaFrac: number;
  cells: [number, number];
}

export interface ProbeResult {
  h: number;
  grad: [number, number];
  gradLen: number;
  refractUV: [number, number];
  refractPx: [number, number];
  chromaPx: [number, number];
}

export interface FrameStats {
  n: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  droppedPct: number;
}

export interface RegionStats {
  mean: [number, number, number];
  max: number;
  n: number;
}

/* ============================================================================
   The class
   ========================================================================== */

declare class LiquidReveal {
  constructor(
    target: string | HTMLElement,
    options?: LiquidRevealOptions
  );

  /* ---- instance state ---- */
  readonly container: HTMLElement | null;
  readonly canvas: HTMLCanvasElement | null;
  readonly ready: boolean;
  /** Reason string when the effect fell back to a static panel (or null). */
  readonly fellBack: string | null;
  readonly mode: 'WebGL2' | 'WebGL1';
  /** Backing-store canvas size in device pixels. */
  readonly size: [number, number];
  /** Simulation grid dimensions [width, height]. */
  readonly simSize: [number, number];
  readonly energy: number;
  readonly steps: number;
  /** Rolling frames-per-second. */
  readonly fps: number;
  /** Milliseconds spent in the last render loop. */
  readonly frameMs: number;
  readonly paused: boolean;
  readonly disposed: boolean;
  /** Non-fatal errors collected during boot. */
  readonly errors: unknown[];

  /* ---- lifecycle ---- */
  onReady(fn: (instance: LiquidReveal) => void): this;
  onError(fn: (instance: LiquidReveal) => void): this;
  start(): this;
  destroy(): void;

  /* ---- assets / params ---- */
  /** Replace the base and/or chrome images after construction. */
  setImages(images?: { base?: string | null; chrome?: string | null }): this;
  /** Merge any subset of the params; derived constants are recomputed. */
  setParams(patch: Partial<LiquidRevealParams>): this;
  getParams(): LiquidRevealParams;

  /* ---- interaction ---- */
  /** Inject a one-shot ripple at uv `x,y` (0..1, y-up) with amplitude `amp`. */
  impulse(x: number, y: number, amp?: number): this;
  /** `pause()` toggles; `pause(false)` stops; `pause(true)` resumes. */
  pause(on?: boolean): this;
  /** Kill every source of motion (idle drift + cursor). */
  silence(): this;
  /** Simulate the pointer at uv `x,y`. */
  setPointer(x: number, y: number): this;
  /** Download the current canvas frame as a PNG. */
  exportFrame(): this;

  /* ---- measurement hooks ---- */
  /** Raw height field (length SW*SH, row-major, y-up). */
  readHeight(): Float32Array | null;
  fieldStats(cx: number, cy: number, relThresh?: number): FieldStats | null;
  probe(u: number, v: number): ProbeResult | null;
  frameStats(): FrameStats | null;
  resetFrameStats(): this;
  sampleRegion(
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ): RegionStats | null;
}

declare const DEFAULT_PARAMS: Readonly<LiquidRevealParams>;
declare const VERSION: string;

export { LiquidReveal, DEFAULT_PARAMS, VERSION };
export default LiquidReveal;