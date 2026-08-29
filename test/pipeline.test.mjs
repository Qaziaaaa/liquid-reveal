import { LiquidReveal } from '../src/liquid-reveal.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };

/* --- minimal DOM stubs --------------------------------------------------- */
function makeEl(tag) {
  return {
    tagName: tag, nodeType: 1, style: {}, children: [], width: 0, height: 0,
    _listeners: {},
    setAttribute() {}, remove() { this.removed = true; },
    append(...n) { this.children.push(...n); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    clientWidth: 800, clientHeight: 600,
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) { const a = this._listeners[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
  };
}

/* --- mock WebGL context -------------------------------------------------- */
function mockGL() {
  const tex = () => ({});
  const fbo = () => ({});
  const gl = {
    TEXTURE_2D: 0x0DE1, RGBA: 0x1908, RGBA16F: 0x881A, UNSIGNED_BYTE: 0x1401,
    HALF_FLOAT: 0x140B, NEAREST: 0x2600, LINEAR: 0x2601, CLAMP_TO_EDGE: 0x812F,
    TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803, FRAMEBUFFER: 0x8D40, COLOR_ATTACHMENT0: 0x8CE0,
    FRAMEBUFFER_COMPLETE: 0x8CD5, ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88E4,
    FLOAT: 0x1406, VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30,
    COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82, ACTIVE_UNIFORMS: 0x8B86,
    TRIANGLE_STRIP: 0x0005, COLOR_BUFFER_BIT: 0x4000, TEXTURE0: 0x84C0,
    createBuffer: () => ({}), bufferData() {}, bindBuffer() {}, enableVertexAttribArray() {},
    vertexAttribPointer() {}, deleteBuffer() {},
    createShader: () => ({}), shaderSource() {}, compileShader() {},
    getShaderParameter: () => true, getShaderInfoLog: () => '', deleteShader() {},
    createProgram: () => ({}), attachShader() {}, bindAttribLocation() {},
    linkProgram() {}, getProgramParameter: (p, name) => (name === 0x8B86 ? 0 : true),
    getProgramInfoLog: () => '', deleteProgram() {},
    getActiveUniform: () => null, getUniformLocation: () => ({}),
    getExtension: (n) => n.startsWith('EXT_color_buffer') ? {} : (n.startsWith('WEBGL_lose_context') ? { loseContext() {} } : null),
    useProgram() {}, createTexture: () => ({}), bindTexture() {},
    texParameteri() {}, texImage2D() {}, deleteTexture() {},
    UNPACK_FLIP_Y_WEBGL: 0x9240, pixelStorei() {},
    createFramebuffer: () => ({}), bindFramebuffer() {},
    framebufferTexture2D() {}, checkFramebufferStatus: () => 0x8CD5,
    deleteFramebuffer() {}, clearColor() {}, clear() {}, viewport() {},
    activeTexture() {}, uniform1f() {}, uniform2f() {}, uniform3f() {},
    uniform3fv() {}, uniform4f() {}, uniform1i() {}, uniform2i() {},
    drawArrays() {}, deleteShader() {}, readPixels(_x, _y, w, h, _f, _t, buf) { buf.fill(0); },
    getContext() {},
  };
  return gl;
}

const container = makeEl('section');
let canvasEl = null;
global.document = {
  querySelector: (s) => (s === '#hero' ? container : null),
  createElement: (t) => { if (t === 'canvas') { canvasEl = makeEl('canvas'); canvasEl.getContext = () => mockGL(); return canvasEl; } return makeEl(t); },
  documentElement: makeEl('html'),
  addEventListener() {},
};
global.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, ResizeObserver: undefined, devicePixelRatio: 1, innerWidth: 1200 };
global.location = { search: '', href: 'http://localhost' };
global.getComputedStyle = () => ({ position: 'static' });
global.matchMedia = global.window.matchMedia;

const images = [];
global.Image = class {
  constructor() { images.push(this); }
  set decoding(v) {}
  set crossOrigin(v) {}
  get _() { return undefined; }
  set src(v) { this.srcV = v; queueMicrotask(() => this.onload && this.onload()); }
};

let rafQueue = [];
global.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
global.cancelAnimationFrame = () => { rafQueue.length = 0; };

console.log('full pipeline boot');
const r = new LiquidReveal('#hero', { base: 'a.png', chrome: 'b.png', imgWidth: 1600, imgHeight: 900 });

(async () => {
  /* let images load and a few frames run */
  for (let frame = 0; frame < 60; frame++){
    await new Promise((res) => setTimeout(res, 0));
    const q = rafQueue; rafQueue = [];
    for (const fn of q) fn(performance.now() + frame * 16);
  }
  await new Promise((res) => setTimeout(res, 0));

  ok(r.ready === true, 'ready emitted after first frames');
  ok(r.fellBack === null, 'no fallback');
  ok(r.gl !== null, 'GL context acquired');
  ok(r.SW === 288 && r.SH === 216, 'sim grid 288x216 for 4:3 viewport, got ' + r.SW + 'x' + r.SH);
  ok(r.steps > 0, 'sim steps executed (' + r.steps + ')');
  ok(r.canvas.width === 800, 'canvas at container size, got ' + r.canvas.width);
  ok(images.length === 2, 'both images requested (' + images.length + ')');

  const rA = r._read, wA = r._write;
  console.log('pointer input');
  const move = container._listeners['pointermove'][0];
  move({ clientX: 200, clientY: 150, pointerId: 1 });
  ok(r.ptr.has === true, 'pointer tracked');
  ok(Math.abs(r.ptr.x - 0.25) < 1e-6, 'pointer x mapped to uv, got ' + r.ptr.x);

  console.log('resize rebuilds sim');
  container.clientWidth = 400; container.clientHeight = 600;
  const oldSW = r.SW, oldSH = r.SH;
  container.dispatch = undefined;
  /* simulate ResizeObserver style dirty marking */
  r.sizeDirty = true; r.needsDraw = true;
  await new Promise((res) => setTimeout(res, 0));
  const q = rafQueue; rafQueue = [];
  for (const fn of q) fn(performance.now() + 1000);
  await new Promise((res) => setTimeout(res, 0));
  ok((r.SW === 192 || r.SH === 288) && (r.SW !== oldSW || r.SH !== oldSH),
     'sim rebuilt for portrait ' + r.SW + 'x' + r.SH + ' (was ' + oldSW + 'x' + oldSH + ')');

  console.log('ping-pong still consistent after rebuild');
  const rB = r._read, wB = r._write;
  ok(rA !== rB || wA !== wB, 'targets changed after resize');
  ok(r._read && r._write && r._read !== r._write, 'read/write distinct');

  console.log('destroy()');
  r.destroy();
  ok(rafQueue.length === 0 || r.disposed, 'disposed after destroy');
  ok(r.gl === null, 'GL released');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();