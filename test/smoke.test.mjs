import { LiquidReveal, DEFAULT_PARAMS, VERSION } from '../src/liquid-reveal.js';

/* --- minimal DOM stubs --------------------------------------------------- */
function makeEl(tag) {
  const style = {};
  const el = {
    tagName: tag, nodeType: 1, style,
    children: [],
    _listeners: {},
    setAttribute() {}, remove() { this.removed = true; },
    append(...nodes) { this.children.push(...nodes); for (const n of nodes) n.parent = this; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    clientWidth: 800, clientHeight: 600, width: 0, height: 0,
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) { const a = this._listeners[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
    dispatch(t, e = {}) { for (const fn of this._listeners[t] || []) fn(Object.assign({ pointerType: 'mouse', clientX: 100, clientY: 100, pointerId: 1 }, e)); },
    getContext() { return null; },
    getAttribute() { return null; },
  };
  return el;
}

const container = makeEl('section');
const canvas = makeEl('canvas');
global.document = {
  querySelector: (sel) => sel === '#hero' ? container : null,
  createElement: (tag) => tag === 'canvas' ? canvas : makeEl(tag),
  documentElement: makeEl('html'),
  createEvent: () => ({ initEvent() {} }),
  addEventListener() {},
};
global.window = {
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  ResizeObserver: undefined,
  devicePixelRatio: 1,
  innerWidth: 1200,
};
global.location = { search: '', href: 'http://localhost' };
global.getComputedStyle = () => ({ position: 'static' });
global.Image = class { set src(v) { this._src = v; this.onerror && this.onerror(); } set crossOrigin(v) {} set decoding(v) {} };
global.IntersectionObserver = class {};
global.matchMedia = global.window.matchMedia;
if (!global.performance) global.performance = { now: () => Date.now() };
const rafBackup = global.requestAnimationFrame;
global.requestAnimationFrame = (fn) => { global.__raf = fn; return 1; };
global.cancelAnimationFrame = () => {};

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok   ' + msg); } else { fail++; console.log('  FAIL ' + msg); } };

console.log('version/constants');
ok(VERSION === '2.0.0', 'VERSION export');
ok(DEFAULT_PARAMS.simLong === 288 && 'damping' in DEFAULT_PARAMS, 'DEFAULT_PARAMS exported');

console.log('constructor + WebGL-unavailable fallback');
const r = new LiquidReveal('#hero', { debug: true });
ok(r.container === container, 'resolved container');
ok(r.canvas && r.canvas.style.position === 'absolute', 'created canvas');
ok(r.fallback && r.fallback.style.display === 'block', 'fallback shown on WebGL unavailable');
ok(r.fellBack === 'WebGL unavailable', 'fellBack reason recorded');
ok(r.errors.length >= 1, 'errors array populated');
ok(r.ready === false, 'not ready');

console.log('querySelector miss throws');
let threw = false;
try { new LiquidReveal('#nope'); } catch (e) { threw = true; }
ok(threw, 'throws on missing target');

console.log('autoStart:false leaves pipeline asleep');
const r2 = new LiquidReveal('#hero', { autoStart: false });
ok(r2.canvas && r2.fellBack === null, 'no bail before start()');
r2.destroy();

console.log('destroy() cleans up');
r.destroy();
ok(r.disposed === true, 'disposed flag');
ok(r.canvas === null, 'canvas unset');
ok(r.container === null, 'container unset');

console.log('setImages/setParams/frameStats guards');
const r3 = new LiquidReveal('#hero', { autoStart: false });
r3.setParams({ damping: 0.9, refraction: 0.2 });
ok(r3.params.damping === 0.9 && r3.params.refraction === 0.2, 'setParams merged');
ok(r3.getParams().damping === 0.9, 'getParams returns params');
ok(r3.frameStats() === null, 'frameStats null when no frames');
r3.impulse(0.5, 0.5, 0.3);
ok('pending' in r3, 'impulse queues');
r3.silence();
ok(r3.silence() === r3, 'silence no-ops before boot');
r3.pause();
ok(r3.paused === true, 'pause set');
r3.destroy();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);