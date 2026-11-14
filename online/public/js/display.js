// Draws the game's latest frame (web_present.c: double buffer in shared wasm
// memory) with WebGL at the screen's refresh rate: sharp at any resolution,
// letterboxed into any screen shape, independent of the emulation's pace.
const VS = `#version 300 es
in vec2 p; out vec2 uv;
uniform vec4 rect;   // destination rect in clip space (x0, y0, x1, y1)
uniform vec2 uvmax;  // used part of the texture
void main() {
  vec2 t = (p + 1.0) * 0.5;
  uv = vec2(t.x, 1.0 - t.y) * uvmax;
  gl_Position = vec4(mix(rect.xy, rect.zw, t), 0.0, 1.0);
}`;
const FS = `#version 300 es
precision mediump float;
in vec2 uv; out vec4 o; uniform sampler2D tex;
void main() { o = vec4(texture(tex, uv).bgr, 1.0); }`;

export class Display {
  constructor(canvas, memory, headerPtr, bufferPtr) {
    this.canvas = canvas;
    this.memory = memory;
    this.hdrPtr = headerPtr;
    this.bufPtr = bufferPtr;   // (i) => pointer of buffer i
    this.seq = -1;
    this.frames = 0;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 indisponible');
    this.gl = gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    this.uRect = gl.getUniformLocation(prog, 'rect');
    this.uUv = gl.getUniformLocation(prog, 'uvmax');
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1024, 512, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texW = 1024; this.texH = 512;
    this.copy = new Uint8Array(1024 * 512 * 4);   // WebGL refuses shared views: frames are copied here
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const loop = () => { this.draw(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  stop() { cancelAnimationFrame(this.raf); }

  draw() {
    const buf = this.memory.buffer;
    const hdr = new Uint32Array(buf, this.hdrPtr, 16);
    const s0 = Atomics.load(hdr, 0);
    if (s0 & 1 || s0 === this.seq) { this.present(); return; }
    const [, idx, w, h, logicalW, dstW, dstH, contentH, nearest] = hdr;
    if (!w || !h) return;
    const n = w * h * 4;
    if (w > this.maxTex || h > this.maxTex) return;
    if (this.copy.length < n) this.copy = new Uint8Array(n);
    this.copy.set(new Uint8Array(buf, this.bufPtr(idx), n));
    if (Atomics.load(hdr, 0) !== s0) return;   // overwritten while copying: next frame
    this.seq = s0;
    this.frames++;
    const gl = this.gl;
    if (w > this.texW || h > this.texH) {
      this.texW = Math.max(w, this.texW); this.texH = Math.max(h, this.texH);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.texW, this.texH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.copy.subarray(0, n));
    const f = nearest ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    this.geom = { w, h, logicalW, dstW, dstH, contentH };
    this.present();
  }

  present() {
    const g = this.geom;
    if (!g) return;
    const gl = this.gl;
    const c = this.canvas;
    const dpr = devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(c.clientWidth * dpr));
    const ch = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // The game's frame occupies logicalW x dstH (aspect of the session); its
    // picture is dstW wide inside it (4:3 pillarbox for FMV), contentH/240 tall.
    const frameAspect = g.logicalW / g.dstH;
    let fw = cw, fh = cw / frameAspect;
    if (fh > ch) { fh = ch; fw = ch * frameAspect; }
    const pw = fw * (g.dstW / g.logicalW);
    const ph = fh * (g.contentH / 240);
    const x0 = (cw - pw) / 2, y0 = (ch - ph) / 2;
    const toClip = (x, y) => [x / cw * 2 - 1, 1 - y / ch * 2];
    const [ax, ay] = toClip(x0, y0 + ph);
    const [bx, by] = toClip(x0 + pw, y0);
    gl.uniform4f(this.uRect, ax, ay, bx, by);
    gl.uniform2f(this.uUv, g.w / this.texW, g.h / this.texH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
