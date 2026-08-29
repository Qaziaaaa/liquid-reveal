/* Demo page wiring for the liquid-reveal package.
   Not part of the published library — this file only runs the demo at the
   repo root so the README examples can be seen live. */
import { LiquidReveal } from '../src/liquid-reveal.js';

const qs = new URLSearchParams(location.search);

/* URL overrides for content (demo convenience, mirrors the old hero) */
const name  = qs.get('name');
const tag   = qs.get('tag');
const title = qs.get('title');
if (name)  document.querySelector('.wordmark').textContent = name + '.';
if (tag)   document.querySelector('.tagline').textContent  = tag;
if (title) document.title = title;

document.documentElement.classList.add('js');

/* effect: mount into the #stage element */
const reveal = new LiquidReveal('#stage', {
  urlParams:    true,              /* allow ?src=&chrome=&imgw=&imgh=&focusx=&focusy= */
  debug:        qs.get('debug') === '1',
  exportButton: true,
  base:         'img.png',
  chrome:       'helmet.png',
  imgWidth:     1672,
  imgHeight:    941,
  focus:        [0.50, 0.44],
});

/* poke from the console: __ripple.impulse(.5,.5), __ripple.pause(), … */
window.__ripple = reveal;

/* quick-start "splash it" button */
document.querySelectorAll('[data-poke="quiet"]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (reveal.paused) reveal.pause(true);
    reveal.impulse(0.5, 0.5, 0.9);
  });
});

/* hide the hint on first interaction */
const hint = document.getElementById('hint');
if (hint){
  const once = () => hint.classList.add('gone');
  addEventListener('pointerdown', once, { once: true, passive: true });
  addEventListener('keydown', once, { once: true, passive: true });
}

/* fade sections in as they scroll into view */
if (window.IntersectionObserver && !window.matchMedia('(prefers-reduced-motion: reduce)').matches){
  const secs = document.querySelectorAll('.section');
  const io = new IntersectionObserver((entries) => {
    for (const en of entries){
      if (en.isIntersecting){ en.target.classList.add('on'); io.unobserve(en.target); }
    }
  }, { threshold: 0.15 });
  secs.forEach((s) => io.observe(s));
}