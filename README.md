# liquid-reveal

[![npm](https://img.shields.io/npm/v/liquid-reveal?color=C98247&label=npm)](https://www.npmjs.com/package/liquid-reveal)
[![downloads](https://img.shields.io/npm/dm/liquid-reveal?color=C98247&label=downloads)](https://www.npmjs.com/package/liquid-reveal)
[![license](https://img.shields.io/badge/license-MIT-C98247)](LICENSE)
[![live demo](https://img.shields.io/badge/live-demo-000000?labelColor=000&color=fff&style=flat)](https://liquid-reveal.vercel.app)

**Zero-dependency WebGL liquid-reveal effect.** A real 2D wave-equation height field runs on the GPU, and the liquid it creates reveals one image through another — refraction, chromatic aberration, specular highlights, and a gradient-mapped chrome treatment are all derived from that single simulation. Drag, tap (splash), or just let it drift. **~60 kB ESM (gzip ≈ 15 kB), no build step, no dependencies.**

> Live demo: **https://liquid-reveal.vercel.app** — move your cursor over the hero.

```js
import LiquidReveal from "liquid-reveal";

const reveal = new LiquidReveal("#hero", {
  base: "photo.jpg",    // image shown through the liquid
  chrome: "chrome.png", // image revealed by the wave
  imgWidth: 4000,
  imgHeight: 2250,
});

reveal.onReady(() => reveal.impulse(0.5, 0.5, 0.8));
```

---

## Install

```bash
npm install liquid-reveal
# or
pnpm add liquid-reveal
# or
yarn add liquid-reveal
```

### Script tag (no bundler)

```html
<script src="https://unpkg.com/liquid-reveal@2/dist/index.min.js"></script>
<script>
  const reveal = new LiquidReveal("#hero", { base: "a.jpg", chrome: "b.png" });
  reveal.onReady(() => reveal.impulse(0.5, 0.5));
</script>
```

The minified build is fully self-contained (placeholders included) and exposes the class as the global `LiquidReveal`, plus `.DEFAULT_PARAMS` and `.VERSION`.

---

## Quick start

```html
<div id="hero" style="position:relative;width:100%;height:60vh"></div>

<script type="module">
  import LiquidReveal from "liquid-reveal";

  const reveal = new LiquidReveal("#hero", {
    base: "base.jpg",        // shown initially
    chrome: "chrome.png",    // revealed by the wave
    imgWidth: 1672,          // intrinsic width  of the images
    imgHeight: 941,          // intrinsic height of the images
    focus: [0.5, 0.44],      // cover-crop focal point (top-left origin)
  });
</script>
```

The library mounts its own canvas, handles pointer input (mouse + multi-touch),
idle drift, resize, prefers-reduced-motion, and cleanup. You only provide a
container and two images.

- **No images?** Bundled placeholders are used automatically — the effect still works out of the box.
- **`prefers-reduced-motion: reduce`** or no WebGL → a static fallback panel is shown instead of failing.
- **Works from `file://`?** No — WebGL needs textures served over HTTP. Use a dev server (the README demo included).

---

## API

### `new LiquidReveal(target, options?)`

| Argument | Type | Description |
|---|---|---|
| `target` | `string \| HTMLElement` | CSS selector or element the effect mounts into. |
| `options` | `Partial<LiquidRevealOptions>` | Any subset of the config below. |

Instance-only options (not params):

| Option | Type | Default | Description |
|---|---|---|---|
| `debug` | `boolean` | `false` | Small on-screen overlay: fps, frame ms, energy, grid, pointers. |
| `urlParams` | `boolean` | `false` | Honour `?src=&chrome=&imgw=&imgh=&focusx=&focusy=`. |
| `exportButton` | `boolean \| string` | `false` | `true` mounts a built-in ⤓ button; a selector mounts it onto that element. |
| `autoStart` | `boolean` | `true` | Set `false` and call `.start()` yourself. |

### Methods (all chainable unless noted)

| Method | Returns | Description |
|---|---|---|
| `onReady(fn)` | `this` | Fires once when the GL context is up and images are bound. |
| `onError(fn)` | `this` | Fires if the effect cannot start (WebGL unavailable, images 404, …). |
| `start()` | `this` | Start/restart the animation loop. |
| `setImages({ base, chrome })` | `this` | Hot-swap the base and/or chrome image. |
| `setParams(partial)` | `this` | Merge any subset of the config; derived constants recompute. |
| `getParams()` | config | Snapshot of the current effective params. |
| `impulse(x, y, amp?)` | `this` | Drop a one-shot ripple at uv `x,y` (0..1, y-up). `amp` default `0.5`. |
| `pause(on?)` | `this` | `pause()` toggles, `pause(false)` stops, `pause(true)` resumes. |
| `silence()` | `this` | Kill every source of motion (idle drift + cursor). |
| `setPointer(x, y)` | `this` | Simulate the pointer at uv `x,y`. |
| `exportFrame()` | `this` | Download the current canvas frame as PNG. |
| `readHeight()` | `Float32Array \| null` | Raw height field, length `SW×SH`, row-major, y-up. |
| `fieldStats(cx, cy, relThresh?)` | object | Peak/RMS height, radius, area fraction of the active wave. |
| `probe(u, v)` | object | Height, gradient, and refraction/chromatic pixel offsets at uv. |
| `frameStats()` | object \| null | Median / p95 / max frame ms and dropped-frame %. |
| `resetFrameStats()` | `this` | Clear the frame-time ring buffer. |
| `sampleRegion(x0, y0, x1, y1)` | object | Mean / max colour of a canvas region (reads back the frame). |
| `destroy()` | `void` | Remove DOM, free GL resources, unbind listeners. Call from effect-cleanup/unmount. |

### Getters

| Getter | Type | Description |
|---|---|---|
| `ready` | `boolean` | Whether the animation loop is running. |
| `fellBack` | `string \| null` | Reason when a static fallback is shown instead. |
| `mode` | `"WebGL2" \| "WebGL1"` | Which renderer was chosen. |
| `size` | `[number, number]` | Backing-store canvas size in device pixels. |
| `simSize` | `[number, number]` | Simulation grid `[width, height]`. |
| `energy` | `number` | Current peak wave amplitude. |
| `fps` | `number` | Rolling frames-per-second. |
| `frameMs` | `number` | Milliseconds in the last render loop. |
| `paused` / `disposed` | `boolean` | Lifecycle flags. |

### Events

The lib has no DOM events; use the promise-style hooks `onReady` / `onError` instead. Both re-fire immediately if the state already happened. `onError`'s instance carries an `errors` array with the failure reasons.

---

## Configuration (highlights)

Every tunable has a sensible default — pass a partial object. Full list is in
`DEFAULT_PARAMS` (exported) and TS types.

| Group | Keys |
|---|---|
| Assets | `base`, `chrome`, `imgWidth`, `imgHeight`, `focus` |
| Wave sim | `simLong`, `simHz`, `simMaxSteps`, `waveC`, `damping`, `viscosity`, `edgeAbsorb`, `edgeCells`, `hClamp` |
| Cursor | `impulseBase`, `impulseGain`, `impulseMax`, `impulseMinSpeed`, `impulseRadius`, `impulseFallSq`, `splashAmp` |
| Visuals | `gradTexels`, `refraction`, `refractMax`, `chromatic`, `chromaEdge`, `chromaMax`, `normalScale`, `specStrength`, `shininess`, `lightDir`, `specTint` |
| Mask | `maskHeight`, `maskGrad`, `maskLo`, `maskHi`, `maskNoise`, `noiseTile`, `edgeGlow`, `edgeGlowTight` |
| Gradient map | `gradStops`, `gradPhase`, `gradScale`, `gradMix`, `gradWrap`, `lumLo`, `lumHi`, `lumGamma` |
| Atmosphere | `bloom`, `bloomRadius`, `bloomThreshold`, `vignette`, `vignetteCenter`, `vignetteInner`, `vignetteOuter`, `scanlines`, `scanlineFreq`, `grain` |
| Idle | `idleDrift`, `idleDelayMs`, `idleSpeed`, `idleRadius`, `idleCenter`, `idleBoost`, `idleDropMs`, `idleDropAmp`, `idleDropSpread`, `narrowScale` |
| Noise | `noiseSize`, `noiseScale`, `noiseDrift` |
| Performance | `dprCap`, `dprCapMobile`, `idleStopEps` |

Useful starting tweaks:

```js
reveal.setParams({
  damping: 0.96,        // longer-lasting ripples
  refraction: 0.18,     // stronger lensing
  chromatic: 0.05,      // more colour fringing
  bloom: 0.4,
  gradStops: [
    { t: 0.0, c: "#05070c" },
    { t: 0.6, c: "#1e3a5f" },
    { t: 1.0, c: "#7ec8ff" },
  ],
});
```

### Gradient map

The chrome image is mapped through a colour LUT. `gradStops` is an array of
`{ t, c }` stops (0..1). `gradWrap` is `"mirror"` (default), `"clamp"`, or
`"repeat"`. `lumLo`/`lumHi`/`lumGamma` remap the chrome image's luminance before the lookup, and `gradMix` (0–100) blends the mapped result with the raw chrome image.

---

## Recipes

### React

```tsx
import { useEffect, useRef } from "react";
import LiquidReveal from "liquid-reveal";

export function Hero() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reveal = new LiquidReveal(ref.current!, {
      base: "/img/base.jpg",
      chrome: "/img/chrome.png",
      imgWidth: 4000,
      imgHeight: 2250,
    });
    return () => reveal.destroy(); // strict-mode safe
  }, []);

  return <div ref={ref} style={{ position: "relative", width: "100%", height: "60vh" }} />;
}
```

### Vue

```vue
<script setup>
import { ref, onMounted, onBeforeUnmount } from "vue";
import LiquidReveal from "liquid-reveal";

const el = ref(null);
let reveal;
onMounted(() => {
  reveal = new LiquidReveal(el.value, { base: "a.jpg", chrome: "b.png", imgWidth: 1672, imgHeight: 941 });
});
onBeforeUnmount(() => reveal?.destroy());
</script>

<template><div ref="el" style="position:relative;width:100%;height:60vh" /></template>
```

### Svelte

```svelte
<script>
  import { onMount } from "svelte";
  import LiquidReveal from "liquid-reveal";
  let el, reveal;
  onMount(() => { reveal = new LiquidReveal(el, { base: "a.jpg", chrome: "b.png" }); return () => reveal.destroy(); });
</script>

<div bind:this={el} style="position:relative;width:100%;height:60vh" />
```

---

## How it works

1. A **simulation pass** solves the discrete wave equation `u_next = u + c²·∇²u − damping` on a small grid (default ~288 cells on the long axis) into a float/half-float texture. Two framebuffers are **ping-ponged** so waves propagate and interfere.
2. A **noise pass** generates animated FBM noise for organic mask edges.
3. A **composite pass** samples the wave height to compute a surface normal, then refracts + chromatic-aberrates the base image, gradient-maps the chrome image, and adds specular highlights, edge glow, bloom, vignette, scanlines and grain.

The simulation runs entirely on the GPU, is accumulator-driven at a fixed rate
(identical behaviour on 60 Hz and 120 Hz panels), and only recomputes while
there is activity — a still page costs almost nothing.

## Browser support

WebGL1 + `OES_texture_half_float`, or WebGL2 + float colour buffers. Everything
modern: Chrome/Edge/Firefox/Safari (macOS & iOS). If WebGL is missing, or
`prefers-reduced-motion: reduce` is set, a static CSS fallback panel is shown
instead of failing.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Blank/invisible effect | Textures can't load from `file://`. Serve the page over HTTP (any static server). |
| Fallback panel shown | No WebGL, images 404'd, or reduced-motion is active. Check `reveal.fellBack` and `reveal.errors`. |
| Ripples explode | `waveC` exceeded the CFL limit `1/√2 ≈ 0.707`. Lower it. |
| Image cropped oddly | Set `imgWidth`/`imgHeight` to the images' real intrinsic size and adjust `focus`. |
| Library imported in Node | `document`/`window` are script-globals; this is a browser-only package. |

## Unmounting

Always `destroy()` when the container leaves the DOM (route change, HMR, React
unmount). It removes its own nodes, cancels rAF, disconnects ResizeObserver and
releases GL resources — no leaks.

## Development

```bash
npm run demo    # serves the demo site (with live hero) at http://localhost:4000
npm test        # headless Node tests (DOM/WebGL stubbed) — no browser needed
npm run build   # rebuilds dist/index.mjs, index.cjs, index.min.js (+ sourcemaps)
npm pack        # dry-run and inspect the publishable tarball
```

## License

MIT © Qazi Farhan Ahmad