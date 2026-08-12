# Liquid Reveal

An interactive hero built on a **real 2D wave-equation height field**. Two framebuffers are ping-ponged on the GPU while a damped wave equation integrates at a fixed 120 Hz — so ripples propagate, interfere, and keep moving long after the cursor stops. Everything visible (refraction, chromatic split, specular glint, reveal mask) is derived from that height field and its gradient.

No npm, no external libraries — one self-contained GLSL pipeline with a WebGL2 / WebGL1 fallback.

Built by [Qazi Farhan Ahmad](https://qaziahmad.vercel.app).

## Run it

The effect must be served over HTTP (Chrome taints local images and WebGL texture uploads fail over `file://`).

```sh
node server.mjs        # -> http://localhost:4000
```

No dependencies. Any static host (Vercel, GitHub Pages, Netlify) works too.

## What makes it more than an effect

- **Real content, not a demo** — the hero is branded for the author and the page continues below it: an "effect" explainer, links to live projects, and contact.
- **Multi-touch + tap-to-splash** — every tracked pointer pushes the same wave field; a tap drops a one-shot splash.
- **Frame export** — the `⤓` button downloads the current frame as PNG.
- **Reusable via URL params** — override the content and assets without touching code:

```
?name=Your Name&tag=Your line&title=Page title
?src=photo.png&chrome=layer.png&imgw=1920&imgh=1080&focusx=0.5&focusy=0.44
```

- **Live tuning** — open `?debug=1` for the sim viewer plus a panel that edits the tuning constants while it runs.
- **Offline** — a service worker precaches the page after the first visit.
- **Hardened** — CSP and security headers set both in the server and as a meta tag, so the policy holds on any host.

## Project layout

```
index.html        page structure, styles, content sections
assets/liquid.js  the WebGL wave-equation effect + page wiring
server.mjs        static file server with security/cache headers
sw.js             offline service worker
favicon.svg       brand favicon (ripple rings)
manifest.webmanifest
```

## Internals worth knowing

- **Sim**: discrete wave equation `h[n+1] = (2h[n] − h[n−1]) + C²·∇²h`, damped per step. Grid is ~288 cells on the long axis; cells stay square so ripples are circular on screen. The current build is tuned to a *gliding blob* (pure diffusion, no propagation) so the reveal follows the cursor instead of flooding the page.
- **Codec**: half-float targets when available; otherwise heights are packed into RGBA8 as 16-bit fixed point to keep the sim from quantising to a standstill.
- **Tuning**: every tunable lives in the `P` object at the top of `assets/liquid.js`, with measured values in the comments.

## Debug / test hooks

`window.__ripple` exposes `readHeight`, `fieldStats`, `impulse(x, y, amp)`, `pause`, `silence`, `setPointer`, `probe`, `frameStats`, `sampleRegion`, `applyParams`, `exportFrame` and the `P` object — used by the included measurement tooling and available from any console.
